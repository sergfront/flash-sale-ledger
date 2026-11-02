import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { HttpError, pool, transaction } from './db.js';
import { adjustStock, cancelOrder, createOrder, settleCapture, settleRefund } from './domain.js';

const app = Fastify({ logger: true, bodyLimit: 128 * 1024 });
await app.register(cors, { origin: true });
const admittedCheckouts = new WeakSet<object>();
let activeCheckouts = 0;
const maxCheckouts = Number(process.env.MAX_IN_FLIGHT_CHECKOUTS ?? 200);
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'POST' || request.url !== '/orders') return;
  if (activeCheckouts >= maxCheckouts) {
    reply.header('Retry-After', '1').code(429).send({ error: 'checkout busy, retry with the same Idempotency-Key' });
    return;
  }
  activeCheckouts += 1;
  admittedCheckouts.add(request);
});
app.addHook('onResponse', async request => {
  if (admittedCheckouts.delete(request)) activeCheckouts -= 1;
});

function userId(headers: Record<string, unknown>) {
  const value = headers['x-user-id'];
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new HttpError(401, 'x-user-id required in demo mode');
  return value;
}
function operator(headers: Record<string, unknown>) {
  if (headers['x-operator-token'] !== (process.env.OPERATOR_TOKEN ?? 'local-operator-token')) throw new HttpError(403, 'operator token required');
}
function key(headers: Record<string, unknown>) {
  return typeof headers['idempotency-key'] === 'string' ? headers['idempotency-key'] : '';
}

app.setErrorHandler((error, _request, reply) => {
  const status = error instanceof HttpError ? error.statusCode : 500;
  if (status === 500) app.log.error(error);
  reply.code(status).send({ error: error instanceof Error ? error.message : 'internal error' });
});

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});
app.get<{ Querystring: { limit?: string; offset?: string } }>('/products', async (request) => {
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 24));
  const offset = Math.max(0, Number(request.query.offset) || 0);
  const result = await pool.query(
    'SELECT p.sku,p.name,p.description,p.price_cents,p.currency,p.image_url,i.available FROM products p JOIN inventory i USING(sku) WHERE p.active=true ORDER BY p.sku LIMIT $1 OFFSET $2',
    [limit, offset],
  );
  return result.rows;
});
app.get<{ Params: { sku: string } }>('/products/:sku', async (request) => {
  const result = await pool.query(
    'SELECT p.sku,p.name,p.description,p.price_cents,p.currency,p.image_url,i.available FROM products p JOIN inventory i USING(sku) WHERE p.sku=$1 AND p.active=true',
    [request.params.sku],
  );
  if (!result.rowCount) throw new HttpError(404, 'product not found');
  return result.rows[0];
});
app.get('/cart', async (request) => {
  const user = userId(request.headers);
  const result = await pool.query('SELECT ci.sku,ci.quantity,p.name,p.price_cents,p.image_url FROM cart_items ci JOIN products p USING(sku) WHERE ci.user_id=$1 ORDER BY ci.sku', [user]);
  return { items: result.rows };
});
app.put<{ Params: { sku: string }; Body: { quantity: number } }>('/cart/items/:sku', async (request) => {
  const user = userId(request.headers);
  const quantity = request.body?.quantity;
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10) throw new HttpError(400, 'quantity must be 0–10');
  await transaction(async client => {
    await client.query('INSERT INTO carts(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user]);
    if (quantity === 0) await client.query('DELETE FROM cart_items WHERE user_id=$1 AND sku=$2', [user, request.params.sku]);
    else await client.query(
      'INSERT INTO cart_items(user_id,sku,quantity) VALUES($1,$2,$3) ON CONFLICT(user_id,sku) DO UPDATE SET quantity=EXCLUDED.quantity',
      [user, request.params.sku, quantity],
    );
    await client.query('UPDATE carts SET version=version+1 WHERE user_id=$1', [user]);
  });
  return { ok: true };
});
app.post<{ Body: { items: unknown } }>('/orders', async (request, reply) => {
  const result = await createOrder(userId(request.headers), key(request.headers), request.body?.items);
  return reply.code(result.code).send(result.body);
});
app.get<{ Params: { id: string } }>('/orders/:id', async (request) => {
  const order = await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [request.params.id, userId(request.headers)]);
  if (!order.rowCount) throw new HttpError(404, 'order not found');
  const [items, reservation, payments] = await Promise.all([
    pool.query('SELECT sku,name,unit_price_cents,quantity FROM order_items WHERE order_id=$1 ORDER BY sku', [request.params.id]),
    pool.query('SELECT status,expires_at FROM reservations WHERE order_id=$1', [request.params.id]),
    pool.query('SELECT kind,status,occurred_at FROM payment_operations WHERE order_id=$1 ORDER BY created_at', [request.params.id]),
  ]);
  return { ...order.rows[0], items: items.rows, reservation: reservation.rows[0], payments: payments.rows };
});
app.post<{ Params: { id: string } }>('/orders/:id/cancel', async (request) => {
  if (!key(request.headers)) throw new HttpError(400, 'Idempotency-Key required');
  return cancelOrder(request.params.id, userId(request.headers));
});

app.post<{ Body: { event_id: string; order_id: string; kind: 'CAPTURE' | 'REFUND'; status: 'SUCCEEDED' | 'FAILED'; occurred_at: string } }>(
  '/payment-webhooks/simulator',
  async (request) => {
    const signature = request.headers['x-simulator-signature'];
    const expected = createHmac('sha256', process.env.WEBHOOK_SECRET ?? 'local-demo-secret')
      .update(JSON.stringify(request.body)).digest('hex');
    if (typeof signature !== 'string' || signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new HttpError(401, 'invalid signature');
    const body = request.body;
    if (!body?.event_id || !body?.order_id || !['CAPTURE','REFUND'].includes(body.kind) || !['SUCCEEDED','FAILED'].includes(body.status)) {
      throw new HttpError(400, 'invalid event');
    }
    return body.kind === 'CAPTURE'
      ? settleCapture(body.order_id, body, body.event_id)
      : settleRefund(body.order_id, body, body.event_id);
  },
);

app.post<{ Body: { order_id: string; kind: 'CAPTURE' | 'REFUND'; status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; occurred_at?: string } }>(
  '/internal/settle',
  async (request) => {
    operator(request.headers);
    const body = request.body;
    if (!body?.order_id || !['CAPTURE','REFUND'].includes(body.kind) || !['SUCCEEDED','FAILED','UNKNOWN'].includes(body.status)) {
      throw new HttpError(400, 'invalid settlement');
    }
    return body.kind === 'CAPTURE' ? settleCapture(body.order_id, body) : settleRefund(body.order_id, body);
  },
);

app.get('/operator/inventory', async (request) => {
  operator(request.headers);
  return (await pool.query('SELECT i.*,p.name FROM inventory i JOIN products p USING(sku) ORDER BY i.sku')).rows;
});
app.post<{ Params: { sku: string }; Body: { delta: number } }>('/operator/inventory/:sku/adjust', async (request) => {
  operator(request.headers);
  return adjustStock(request.params.sku, request.body?.delta);
});
app.get('/operator/reconciliation', async (request) => {
  operator(request.headers);
  const [cases, review, queue] = await Promise.all([
    pool.query('SELECT * FROM reconciliation_cases WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100'),
    pool.query("SELECT id,status,updated_at FROM orders WHERE status IN ('PAYMENT_REVIEW','REFUND_PENDING') ORDER BY updated_at LIMIT 100"),
    pool.query("SELECT count(*)::int AS pending FROM outbox WHERE status <> 'DONE'"),
  ]);
  return { cases: cases.rows, review: review.rows, outbox_pending: queue.rows[0].pending };
});
app.post<{ Params: { id: string } }>('/operator/orders/:id/refund', async (request) => {
  operator(request.headers);
  const result = await pool.query('SELECT user_id FROM orders WHERE id=$1', [request.params.id]);
  if (!result.rowCount) throw new HttpError(404, 'order not found');
  return cancelOrder(request.params.id, result.rows[0].user_id);
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.API_PORT ?? 3000) });
