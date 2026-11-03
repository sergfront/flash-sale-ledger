import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const api = process.env.PAYMENT_URL ?? 'http://localhost:3001';
const token = process.env.PAYMENT_INTERNAL_TOKEN ?? 'local-payment-token';
const count = Number(process.env.RACES ?? 100);
async function post(path, body, extra = {}) {
  const response = await fetch(api + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
for (let index = 0; index < count; index++) {
  const orderId = randomUUID();
  const key = 'capture:' + orderId;
  const capture = () => post('/capture', {
    order_id: orderId,
    provider_key: key,
    amount_cents: 100,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const close = () => post('/operations/' + key + '/close',
    { order_id: orderId, amount_cents: 100 }, { 'x-payment-token': token });
  const [a, b] = await Promise.all([capture(), close()]);
  assert.equal(a.status, b.status);
  assert.equal((await capture()).status, a.status);
  assert.equal((await close()).status, a.status);
}
console.log(`${count} capture/close races preserved one result per provider key`);
