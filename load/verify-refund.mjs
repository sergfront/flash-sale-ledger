import { randomUUID } from 'node:crypto';

const base = process.env.PAYMENT_URL ?? 'http://localhost:3001';
const token = process.env.PAYMENT_INTERNAL_TOKEN ?? 'local-payment-token';
async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-token': token },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const orderId = randomUUID();
const captureKey = 'capture:' + orderId;
const capture = await post('/capture', {
  order_id: orderId, provider_key: captureKey, amount_cents: 100,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});
if (capture.status !== 200 || capture.body.status !== 'SUCCEEDED') throw new Error('capture failed: ' + JSON.stringify(capture));

const refunds = await Promise.all(Array.from({ length: 20 }, (_, index) => post('/refund', {
  order_id: orderId, provider_key: `refund:${orderId}:${index}`,
  original_key: captureKey, amount_cents: 100,
})));
const succeeded = refunds.filter(result => result.status === 200 && result.body.status === 'SUCCEEDED');
const rejected = refunds.filter(result => result.status === 409);
if (succeeded.length !== 1 || rejected.length !== 19) {
  throw new Error('refund cap violated: ' + JSON.stringify(refunds));
}
const replay = await post('/refund', {
  order_id: orderId, provider_key: succeeded[0].body.provider_key,
  original_key: captureKey, amount_cents: 100,
});
if (replay.status !== 200 || replay.body.status !== 'SUCCEEDED') throw new Error('refund replay failed');
console.log('20 concurrent full refunds: one succeeded, 19 rejected; winning key replayed safely');
