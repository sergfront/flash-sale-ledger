import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError, pool, transaction } from './db.js';

type Item = { sku: string; quantity: number };
type PaymentResult = { status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; occurred_at?: string; provider_key?: string };

function itemsFrom(input: unknown): Item[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10) throw new HttpError(400, 'items must contain 1–10 SKUs');
  const quantities = new Map<string, number>();
  for (const raw of input) {
    if (!raw || typeof raw.sku !== 'string' || !/^[a-z0-9-]{1,64}$/.test(raw.sku) ||
        !Number.isInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > 10) {
      throw new HttpError(400, 'invalid item');
    }
    quantities.set(raw.sku, (quantities.get(raw.sku) ?? 0) + raw.quantity);
  }
  const items = [...quantities].map(([sku, quantity]) => ({ sku, quantity })).sort((a, b) => a.sku.localeCompare(b.sku));
  if (items.some(i => i.quantity > 10)) throw new HttpError(400, 'quantity exceeds 10');
  return items;
}

async function movement(client: PoolClient, sku: string, orderId: string | null, kind: string, available: number, reserved: number, sold: number) {
  await client.query(
    'INSERT INTO inventory_movements(id,sku,order_id,kind,available_delta,reserved_delta,sold_delta) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), sku, orderId, kind, available, reserved, sold],
  );
}

async function event(client: PoolClient, kind: string, orderId: string, payload: object = {}) {
  await client.query('INSERT INTO outbox(id,kind,aggregate_id,payload) VALUES($1,$2,$3,$4)', [randomUUID(), kind, orderId, JSON.stringify(payload)]);
}

export async function createOrder(userId: string, key: string, input: unknown) {
  if (!key || key.length > 128) throw new HttpError(400, 'Idempotency-Key required');
  const items = itemsFrom(input);
  const hash = createHash('sha256').update(JSON.stringify(items)).digest('hex');
  return transaction(async client => {
    const inserted = await client.query(
      'INSERT INTO idempotency_keys(user_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',
      [userId, key, hash],
    );
    if (!inserted.rowCount) {
      const prior = await client.query('SELECT request_hash,response_code,response_body FROM idempotency_keys WHERE user_id=$1 AND key=$2 FOR UPDATE', [userId, key]);
      if (prior.rows[0].request_hash !== hash) throw new HttpError(409, 'idempotency key reused with different items');
      return { code: prior.rows[0].response_code as number, body: prior.rows[0].response_body };
    }
    await client.query('SAVEPOINT order_attempt');
    try {
      const skus = items.map(i => i.sku);
      const products = await client.query('SELECT sku,name,price_cents,currency FROM products WHERE active=true AND sku=ANY($1::text[])', [skus]);
      if (products.rowCount !== items.length) throw new HttpError(400, 'unknown or inactive SKU');
      const bySku = new Map(products.rows.map(row => [row.sku as string, row]));
      const currencies = new Set(products.rows.map(row => row.currency));
      if (currencies.size !== 1) throw new HttpError(400, 'mixed currency order');
      const amount = items.reduce((sum, i) => sum + bySku.get(i.sku).price_cents * i.quantity, 0);
      const orderId = randomUUID();
      await client.query('INSERT INTO orders(id,user_id,status,amount_cents,currency) VALUES($1,$2,$3,$4,$5)',
        [orderId, userId, 'PENDING_PAYMENT', amount, products.rows[0].currency]);
      for (const item of items) {
        const changed = await client.query(
          'UPDATE inventory SET available=available-$2,reserved=reserved+$2 WHERE sku=$1 AND available >= $2 RETURNING sku',
          [item.sku, item.quantity],
        );
        if (!changed.rowCount) throw new HttpError(409, 'OUT_OF_STOCK:' + item.sku);
        await movement(client, item.sku, orderId, 'RESERVE', -item.quantity, item.quantity, 0);
        const product = bySku.get(item.sku);
        await client.query('INSERT INTO order_items(order_id,sku,name,unit_price_cents,quantity) VALUES($1,$2,$3,$4,$5)',
          [orderId, item.sku, product.name, product.price_cents, item.quantity]);
      }
      const reservation = await client.query(
        "INSERT INTO reservations(order_id,status,expires_at) VALUES($1,'HELD',clock_timestamp() + interval '5 minutes') RETURNING expires_at",
        [orderId],
      );
      for (const item of items) {
        await client.query('INSERT INTO reservation_items(order_id,sku,quantity) VALUES($1,$2,$3)', [orderId, item.sku, item.quantity]);
      }
      await client.query(
        "INSERT INTO payment_operations(id,order_id,kind,provider_key,amount_cents,status) VALUES($1,$2,'CAPTURE',$3,$4,'QUEUED')",
        [randomUUID(), orderId, 'capture:' + orderId, amount],
      );
      await event(client, 'CAPTURE', orderId);
      const body = { id: orderId, status: 'PENDING_PAYMENT', amount_cents: amount, currency: products.rows[0].currency, expires_at: reservation.rows[0].expires_at };
      await client.query('UPDATE idempotency_keys SET order_id=$3,response_code=201,response_body=$4 WHERE user_id=$1 AND key=$2',
        [userId, key, orderId, JSON.stringify(body)]);
      return { code: 201, body };
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 409 || !error.message.startsWith('OUT_OF_STOCK:')) throw error;
      await client.query('ROLLBACK TO SAVEPOINT order_attempt');
      const body = { error: error.message };
      await client.query('UPDATE idempotency_keys SET response_code=409,response_body=$3 WHERE user_id=$1 AND key=$2',
        [userId, key, JSON.stringify(body)]);
      return { code: 409, body };
    }
  });
}

async function release(client: PoolClient, orderId: string, orderStatus: string) {
  const reservation = await client.query('SELECT status FROM reservations WHERE order_id=$1 FOR UPDATE', [orderId]);
  if (!reservation.rowCount || reservation.rows[0].status !== 'HELD') return false;
  const items = await client.query('SELECT sku,quantity FROM reservation_items WHERE order_id=$1 ORDER BY sku', [orderId]);
  for (const item of items.rows) {
    await client.query('UPDATE inventory SET available=available+$2,reserved=reserved-$2 WHERE sku=$1 AND reserved >= $2', [item.sku, item.quantity]);
    await movement(client, item.sku, orderId, 'RELEASE', item.quantity, -item.quantity, 0);
  }
  await client.query("UPDATE reservations SET status='RELEASED',updated_at=clock_timestamp() WHERE order_id=$1", [orderId]);
  await client.query('UPDATE orders SET status=$2,updated_at=clock_timestamp() WHERE id=$1', [orderId, orderStatus]);
  return true;
}

async function queueRefund(client: PoolClient, orderId: string, amount: number) {
  const providerKey = 'refund:' + orderId;
  const op = await client.query(
    "INSERT INTO payment_operations(id,order_id,kind,provider_key,amount_cents,status) VALUES($1,$2,'REFUND',$3,$4,'QUEUED') ON CONFLICT(provider_key) DO NOTHING RETURNING id",
    [randomUUID(), orderId, providerKey, amount],
  );
  if (op.rowCount) await event(client, 'REFUND', orderId);
  await client.query("UPDATE orders SET status='REFUND_PENDING',updated_at=clock_timestamp() WHERE id=$1", [orderId]);
}

export async function settleCapture(orderId: string, result: PaymentResult, eventId?: string) {
  return transaction(async client => {
    if (eventId) {
      const receipt = await client.query('INSERT INTO provider_events(provider,event_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',
        ['simulator', eventId, JSON.stringify(result)]);
      if (!receipt.rowCount) return { duplicate: true };
    }
    const orderResult = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!orderResult.rowCount) throw new HttpError(404, 'order not found');
    const order = orderResult.rows[0];
    const opResult = await client.query("SELECT * FROM payment_operations WHERE order_id=$1 AND kind='CAPTURE' FOR UPDATE", [orderId]);
    const op = opResult.rows[0];
    if (result.status !== 'UNKNOWN') await client.query("UPDATE reconciliation_cases SET resolved_at=clock_timestamp() WHERE order_id=$1 AND kind='PAYMENT_NOT_FOUND' AND resolved_at IS NULL", [orderId]);
    if (op.status === 'SUCCEEDED' && ['CONFIRMED','REFUND_PENDING','REFUNDED'].includes(order.status)) return { status: order.status };
    if (result.status === 'UNKNOWN') {
      if (order.status === 'PENDING_PAYMENT') await client.query("UPDATE orders SET status='PAYMENT_REVIEW',updated_at=clock_timestamp() WHERE id=$1", [orderId]);
      await client.query("UPDATE payment_operations SET status='UNKNOWN' WHERE id=$1 AND status NOT IN ('SUCCEEDED','FAILED')", [op.id]);
      return { status: 'PAYMENT_REVIEW' };
    }
    if (result.status === 'FAILED') {
      if (op.status === 'SUCCEEDED') return { status: order.status };
      await client.query("UPDATE payment_operations SET status='FAILED' WHERE id=$1", [op.id]);
      await release(client, orderId, order.cancel_requested ? 'CANCELLED' : order.status === 'EXPIRED' ? 'EXPIRED' : 'PAYMENT_FAILED');
      return { status: 'PAYMENT_FAILED' };
    }
    if (!result.occurred_at || Number.isNaN(Date.parse(result.occurred_at))) throw new HttpError(400, 'payment timestamp required');
    await client.query("UPDATE payment_operations SET status='SUCCEEDED',occurred_at=$2 WHERE id=$1", [op.id, result.occurred_at]);
    const reservation = await client.query('SELECT status,expires_at,expires_at <= clock_timestamp() AS expired FROM reservations WHERE order_id=$1 FOR UPDATE', [orderId]);
    const canConfirm = reservation.rows[0].status === 'HELD' &&
      Date.parse(result.occurred_at) <= new Date(reservation.rows[0].expires_at).getTime() &&
      !order.cancel_requested;
    if (canConfirm) {
      const items = await client.query('SELECT sku,quantity FROM reservation_items WHERE order_id=$1 ORDER BY sku', [orderId]);
      for (const item of items.rows) {
        await client.query('UPDATE inventory SET reserved=reserved-$2,sold=sold+$2 WHERE sku=$1 AND reserved >= $2', [item.sku, item.quantity]);
        await movement(client, item.sku, orderId, 'CONFIRM', 0, -item.quantity, item.quantity);
      }
      await client.query("UPDATE reservations SET status='CONSUMED',updated_at=clock_timestamp() WHERE order_id=$1", [orderId]);
      await client.query("UPDATE orders SET status='CONFIRMED',updated_at=clock_timestamp() WHERE id=$1", [orderId]);
      await event(client, 'ORDER_CONFIRMED', orderId);
      return { status: 'CONFIRMED' };
    }
    if (reservation.rows[0].status === 'HELD') await release(client, orderId, 'EXPIRED');
    await queueRefund(client, orderId, order.amount_cents);
    return { status: 'REFUND_PENDING' };
  });
}

export async function settleRefund(orderId: string, result: PaymentResult, eventId?: string) {
  return transaction(async client => {
    if (eventId) {
      const receipt = await client.query('INSERT INTO provider_events(provider,event_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',
        ['simulator', eventId, JSON.stringify(result)]);
      if (!receipt.rowCount) return { duplicate: true };
    }
    const order = await client.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!order.rowCount) throw new HttpError(404, 'order not found');
    const prior = await client.query("SELECT id,status,provider_key FROM payment_operations WHERE order_id=$1 AND kind='REFUND' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE", [orderId]);
    if (!prior.rowCount) throw new HttpError(404, 'refund not found');
    if (result.provider_key && result.provider_key !== prior.rows[0].provider_key) return { stale: true };
    if (prior.rows[0].status === 'SUCCEEDED' && order.rows[0].status === 'REFUNDED') return { status: 'REFUNDED' };
    const status = result.status === 'SUCCEEDED' ? 'SUCCEEDED' : result.status === 'FAILED' ? 'FAILED' : 'UNKNOWN';
    await client.query("UPDATE payment_operations SET status=$2,occurred_at=COALESCE($3,occurred_at) WHERE id=$1",
      [prior.rows[0].id, status, result.occurred_at ?? null]);
    if (status === 'SUCCEEDED') {
      await client.query("UPDATE orders SET status='REFUNDED',updated_at=clock_timestamp() WHERE id=$1", [orderId]);
      await client.query("UPDATE reconciliation_cases SET resolved_at=clock_timestamp() WHERE order_id=$1 AND kind='REFUND_FAILED' AND resolved_at IS NULL", [orderId]);
    }
    if (status === 'FAILED') {
      await client.query("INSERT INTO reconciliation_cases(id,order_id,kind,details) SELECT $1,$2,'REFUND_FAILED',$3 WHERE NOT EXISTS (SELECT 1 FROM reconciliation_cases WHERE order_id=$2 AND kind='REFUND_FAILED' AND resolved_at IS NULL)",
        [randomUUID(), orderId, JSON.stringify({ provider_key: prior.rows[0].provider_key })]);
    }
    return { status: status === 'SUCCEEDED' ? 'REFUNDED' : 'REFUND_PENDING' };
  });
}

export async function retryRefund(orderId: string) {
  return transaction(async client => {
    const order = await client.query('SELECT status,amount_cents FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!order.rowCount) throw new HttpError(404, 'order not found');
    if (order.rows[0].status !== 'REFUND_PENDING') throw new HttpError(409, 'refund is not pending');
    const prior = await client.query("SELECT status,provider_key FROM payment_operations WHERE order_id=$1 AND kind='REFUND' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE", [orderId]);
    if (!prior.rowCount) throw new HttpError(409, 'refund attempt is missing');
    if (['QUEUED','IN_FLIGHT','UNKNOWN'].includes(prior.rows[0].status)) return { status: 'REFUND_PENDING', provider_key: prior.rows[0].provider_key };
    if (prior.rows[0].status !== 'FAILED') throw new HttpError(409, 'refund attempt is not failed');
    const providerKey = 'refund:' + orderId + ':' + randomUUID();
    await client.query("INSERT INTO payment_operations(id,order_id,kind,provider_key,amount_cents,status) VALUES($1,$2,'REFUND',$3,$4,'QUEUED')",
      [randomUUID(), orderId, providerKey, order.rows[0].amount_cents]);
    await event(client, 'REFUND', orderId);
    return { status: 'REFUND_PENDING', provider_key: providerKey };
  });
}

export async function beginPayment(orderId: string, kind: 'CAPTURE' | 'REFUND') {
  return transaction(async client => {
    const order = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!order.rowCount) return null;
    const op = await client.query('SELECT * FROM payment_operations WHERE order_id=$1 AND kind=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE', [orderId, kind]);
    if (!op.rowCount || !['QUEUED','IN_FLIGHT','UNKNOWN'].includes(op.rows[0].status)) return null;
    if (kind === 'CAPTURE') {
      const res = await client.query('SELECT status,expires_at,expires_at <= clock_timestamp() AS expired FROM reservations WHERE order_id=$1 FOR UPDATE', [orderId]);
      if (res.rows[0].status !== 'HELD') return null;
      if (res.rows[0].expired) {
        if (op.rows[0].status === 'QUEUED') await release(client, orderId, 'EXPIRED');
        return null;
      }
    }
    await client.query("UPDATE payment_operations SET status='IN_FLIGHT' WHERE id=$1", [op.rows[0].id]);
    return { provider_key: op.rows[0].provider_key as string, amount_cents: op.rows[0].amount_cents as number, expires_at: kind === 'CAPTURE' ? (await client.query('SELECT expires_at FROM reservations WHERE order_id=$1', [orderId])).rows[0].expires_at : null };
  });
}

export async function cancelOrder(orderId: string, userId: string, key?: string) {
  if (key && key.length > 128) throw new HttpError(400, 'Idempotency-Key too long');
  return transaction(async client => {
    const selected = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!selected.rowCount || selected.rows[0].user_id !== userId) throw new HttpError(404, 'order not found');
    if (key) {
      const inserted = await client.query('INSERT INTO idempotency_keys(user_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key', [userId, key, 'cancel:' + orderId]);
      if (!inserted.rowCount) {
        const prior = await client.query('SELECT request_hash,response_body FROM idempotency_keys WHERE user_id=$1 AND key=$2 FOR UPDATE', [userId, key]);
        if (prior.rows[0].request_hash !== 'cancel:' + orderId) throw new HttpError(409, 'idempotency key reused with different request');
        return prior.rows[0].response_body;
      }
    }
    const finish = async (status: string) => {
      const body = { status };
      if (key) await client.query('UPDATE idempotency_keys SET order_id=$3,response_code=200,response_body=$4 WHERE user_id=$1 AND key=$2', [userId, key, orderId, JSON.stringify(body)]);
      return body;
    };
    const order = selected.rows[0];
    if (['CANCELLED','EXPIRED','PAYMENT_FAILED','REFUNDED','REFUND_PENDING'].includes(order.status)) return finish(order.status);
    if (order.status === 'CONFIRMED') {
      await queueRefund(client, orderId, order.amount_cents);
      return finish('REFUND_PENDING');
    }
    const op = await client.query("SELECT status FROM payment_operations WHERE order_id=$1 AND kind='CAPTURE' FOR UPDATE", [orderId]);
    await client.query('UPDATE orders SET cancel_requested=true WHERE id=$1', [orderId]);
    if (op.rows[0].status === 'QUEUED' || op.rows[0].status === 'FAILED') {
      await release(client, orderId, 'CANCELLED');
      return finish('CANCELLED');
    }
    await client.query("UPDATE orders SET status='PAYMENT_REVIEW',updated_at=clock_timestamp() WHERE id=$1", [orderId]);
    return finish('PAYMENT_REVIEW');
  });
}

export async function expireDue(limit = 100) {
  const due = await pool.query(
    "SELECT r.order_id FROM reservations r JOIN orders o ON o.id=r.order_id WHERE r.status='HELD' AND o.status='PENDING_PAYMENT' AND r.expires_at <= clock_timestamp() ORDER BY r.expires_at LIMIT $1",
    [limit],
  );
  for (const row of due.rows) {
    await transaction(async client => {
      const order = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [row.order_id]);
      const res = await client.query('SELECT *,expires_at > clock_timestamp() AS still_valid FROM reservations WHERE order_id=$1 FOR UPDATE', [row.order_id]);
      if (res.rows[0].status !== 'HELD' || res.rows[0].still_valid) return;
      const op = await client.query("SELECT status FROM payment_operations WHERE order_id=$1 AND kind='CAPTURE' FOR UPDATE", [row.order_id]);
      if (['IN_FLIGHT','UNKNOWN','SUCCEEDED'].includes(op.rows[0].status)) {
        if (order.rows[0].status === 'PENDING_PAYMENT') await client.query("UPDATE orders SET status='PAYMENT_REVIEW',updated_at=clock_timestamp() WHERE id=$1", [row.order_id]);
      } else {
        await release(client, row.order_id, op.rows[0].status === 'FAILED' ? 'PAYMENT_FAILED' : 'EXPIRED');
      }
    });
  }
}

export async function adjustStock(sku: string, delta: number) {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) throw new HttpError(400, 'invalid delta');
  return transaction(async client => {
    const changed = await client.query(
      'UPDATE inventory SET total=total+$2,available=available+$2 WHERE sku=$1 AND available+$2 >= 0 RETURNING *',
      [sku, delta],
    );
    if (!changed.rowCount) throw new HttpError(409, 'SKU missing or insufficient available stock');
    await movement(client, sku, null, 'ADJUST', delta, 0, 0);
    return changed.rows[0];
  });
}
