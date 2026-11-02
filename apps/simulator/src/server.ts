import { createHmac, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import pg from 'pg';

const app = Fastify({ logger: true });
const pool = new pg.Pool({ connectionString: process.env.PAYMENT_DATABASE_URL ?? 'postgres://pay:pay@localhost:5433/pay' });
await pool.query(await readFile('db/simulator.sql', 'utf8'));

type Request = { order_id: string; provider_key: string; amount_cents: number; expires_at?: string; original_key?: string };
const fraction = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0) / 0xffffffff;

async function webhook(body: object, key: string) {
  const dropRate = Number(process.env.SIM_DROP_WEBHOOK_RATE ?? 0);
  if (!process.env.API_WEBHOOK_URL || fraction('drop:' + key) < dropRate) return;
  const payload = JSON.stringify(body);
  const signature = createHmac('sha256', process.env.WEBHOOK_SECRET ?? 'local-demo-secret').update(payload).digest('hex');
  try {
    await fetch(process.env.API_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-simulator-signature': signature }, body: payload, signal: AbortSignal.timeout(3000) });
  } catch (error) {
    app.log.warn({ error }, 'webhook delivery failed');
  }
}

async function operation(kind: 'CAPTURE' | 'REFUND', body: Request, reply: any) {
  if (!body || typeof body.order_id !== 'string' || typeof body.provider_key !== 'string' ||
      !Number.isInteger(body.amount_cents) || body.amount_cents < 0) {
    return reply.code(400).send({ error: 'invalid payment request' });
  }
  const failRate = Number(process.env.SIM_FAIL_RATE ?? 0);
  const expired = kind === 'CAPTURE' && (!body.expires_at || Date.parse(body.expires_at) <= Date.now());
  const failed = expired || fraction('fail:' + body.provider_key) < failRate;
  if (kind === 'REFUND') {
    const original = await pool.query("SELECT * FROM payment_ledger WHERE provider_key=$1 AND kind='CAPTURE'", [body.original_key]);
    if (!original.rowCount || original.rows[0].status !== 'SUCCEEDED' || original.rows[0].amount_cents < body.amount_cents) {
      return reply.code(409).send({ error: 'capture missing or refund exceeds captured amount' });
    }
  }
  await pool.query(
    'INSERT INTO payment_ledger(provider_key,kind,order_id,amount_cents,status,original_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider_key) DO NOTHING',
    [body.provider_key, kind, body.order_id, body.amount_cents, failed ? 'FAILED' : 'SUCCEEDED', body.original_key ?? null],
  );
  const stored = (await pool.query('SELECT * FROM payment_ledger WHERE provider_key=$1', [body.provider_key])).rows[0];
  if (stored.kind !== kind || stored.order_id !== body.order_id || stored.amount_cents !== body.amount_cents) {
    return reply.code(409).send({ error: 'payment key reused with different request' });
  }
  const result = { order_id: body.order_id, kind, provider_key: body.provider_key, status: stored.status, occurred_at: stored.occurred_at };
  const event = { ...result, event_id: 'evt:' + createHash('sha256').update(body.provider_key).digest('hex').slice(0, 32) };
  void webhook(event, body.provider_key);
  if (fraction('timeout:' + body.provider_key) < Number(process.env.SIM_TIMEOUT_AFTER_COMMIT_RATE ?? 0)) {
    return reply.code(504).send({ error: 'simulated timeout after durable result' });
  }
  return result;
}

app.post<{ Body: Request }>('/capture', (request, reply) => operation('CAPTURE', request.body, reply));
app.post<{ Body: Request }>('/refund', (request, reply) => operation('REFUND', request.body, reply));
app.get<{ Params: { key: string } }>('/operations/:key', async (request, reply) => {
  const result = await pool.query('SELECT provider_key,kind,order_id,amount_cents,status,occurred_at FROM payment_ledger WHERE provider_key=$1', [request.params.key]);
  if (!result.rowCount) return reply.code(404).send({ error: 'operation not found' });
  return result.rows[0];
});
app.get('/health', async () => ({ ok: true }));
await app.listen({ host: '0.0.0.0', port: Number(process.env.SIMULATOR_PORT ?? 3001) });
