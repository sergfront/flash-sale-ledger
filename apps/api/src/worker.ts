import { pool, transaction } from './db.js';
import { beginPayment, expireDue, settleCapture, settleRefund } from './domain.js';

const paymentUrl = process.env.PAYMENT_URL ?? 'http://localhost:3001';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function claim() {
  return transaction(async client => {
    const rows = await client.query(
      "SELECT id,kind,aggregate_id FROM outbox WHERE (status='READY' AND available_at <= clock_timestamp()) OR (status='LEASED' AND lease_until <= clock_timestamp()) ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED",
    );
    for (const row of rows.rows) {
      await client.query("UPDATE outbox SET status='LEASED',lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1 WHERE id=$1", [row.id]);
    }
    return rows.rows as { id: string; kind: string; aggregate_id: string }[];
  });
}

async function processOne(row: { id: string; kind: string; aggregate_id: string }) {
  if (row.kind !== 'CAPTURE' && row.kind !== 'REFUND') {
    await pool.query("UPDATE outbox SET status='DONE',lease_until=NULL WHERE id=$1", [row.id]);
    return;
  }
  const orderId = row.aggregate_id;
  const op = await beginPayment(orderId, row.kind);
  if (!op) {
    await pool.query("UPDATE outbox SET status='DONE',lease_until=NULL WHERE id=$1", [row.id]);
    return;
  }
  const body = {
    order_id: orderId,
    provider_key: op.provider_key,
    amount_cents: op.amount_cents,
    ...(row.kind === 'CAPTURE' ? { expires_at: op.expires_at } : { original_key: 'capture:' + orderId }),
  };
  const response = await fetch(paymentUrl + (row.kind === 'CAPTURE' ? '/capture' : '/refund'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 504) {
    if (row.kind === 'CAPTURE') await settleCapture(orderId, { status: 'UNKNOWN' });
    throw new Error('provider timeout after possible commit');
  }
  if (!response.ok) throw new Error('payment service returned ' + response.status);
  const result = await response.json() as { status: 'SUCCEEDED' | 'FAILED'; occurred_at: string };
  if (row.kind === 'CAPTURE') await settleCapture(orderId, result);
  else await settleRefund(orderId, { ...result, provider_key: op.provider_key });
  await pool.query("UPDATE outbox SET status='DONE',lease_until=NULL WHERE id=$1", [row.id]);
}

async function loop() {
  while (true) {
    try {
      const batch = await claim();
      for (const row of batch) {
        try {
          await processOne(row);
        } catch (error) {
          console.error('outbox event failed', row.id, error);
          await pool.query(
            "UPDATE outbox SET status='READY',lease_until=NULL,available_at=clock_timestamp()+make_interval(secs => LEAST(30, power(2, LEAST(attempts, 5))::int)) WHERE id=$1",
            [row.id],
          );
        }
      }
      await expireDue();
      if (batch.length === 0) await delay(300);
    } catch (error) {
      console.error('worker loop failed', error);
      await delay(1000);
    }
  }
}
void loop();
