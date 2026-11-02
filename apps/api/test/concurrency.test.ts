import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const testUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://sale:sale@localhost:5435/sale_test');
const databaseName = testUrl.pathname.slice(1);
if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) throw new Error('invalid test database name');
const maintenanceUrl = new URL(testUrl);
maintenanceUrl.pathname = '/postgres';
const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
await maintenance.connect();
const exists = await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
if (!exists.rowCount) await maintenance.query('CREATE DATABASE "' + databaseName + '"');
await maintenance.end();
process.env.DATABASE_URL = testUrl.toString();
const { pool } = await import('../src/db.js');
const { createOrder, beginPayment, cancelOrder, retryRefund, settleCapture, settleRefund, expireDue } = await import('../src/domain.js');
await pool.query(await readFile('../../db/schema.sql', 'utf8'));

test('5,000 buyers cannot reserve more than 100 units', { timeout: 120_000 }, async () => {
  const sku = 'race-' + randomUUID().slice(0, 8);
  const runId = randomUUID().slice(0, 8);
  await pool.query("INSERT INTO products(sku,name,price_cents,active) VALUES($1,'Race fixture',100,true)", [sku]);
  await pool.query('INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,100,100,0,0)', [sku]);
  const attempts = await Promise.all(Array.from({ length: 5000 }, (_, n) =>
    createOrder('buyer-' + runId + '-' + n, 'attempt-' + runId + '-' + n, [{ sku, quantity: 1 }])));
  const winners = attempts.filter(result => result.code === 201).map(result => result.body.id as string);
  const losers = attempts.filter(result => result.code === 409);
  assert.equal(winners.length, 100);
  assert.equal(losers.length, 4900);
  assert.ok(losers.every(result => result.body.error === 'OUT_OF_STOCK:' + sku));
  const held = await pool.query('SELECT available,reserved,sold,total FROM inventory WHERE sku=$1', [sku]);
  assert.deepEqual(held.rows[0], { available: 0, reserved: 100, sold: 0, total: 100 });
  const capturedAt = new Date().toISOString();
  await Promise.all(winners.map(id => settleCapture(id, { status: 'SUCCEEDED', occurred_at: capturedAt })));
  await Promise.all(winners.map(id => settleCapture(id, { status: 'SUCCEEDED', occurred_at: capturedAt })));
  const final = await pool.query('SELECT available,reserved,sold,total FROM inventory WHERE sku=$1', [sku]);
  assert.deepEqual(final.rows[0], { available: 0, reserved: 0, sold: 100, total: 100 });
  await pool.query('UPDATE products SET active=false WHERE sku=$1', [sku]);
});

test('same idempotency key creates one order; late capture after cancellation schedules refund', { timeout: 30_000 }, async () => {
  const sku = 'idem-' + randomUUID().slice(0, 8);
  await pool.query("INSERT INTO products(sku,name,price_cents,active) VALUES($1,'Idempotency fixture',100,true)", [sku]);
  await pool.query('INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,1,1,0,0)', [sku]);
  const calls = await Promise.all(Array.from({ length: 30 }, () => createOrder('same-buyer', sku, [{ sku, quantity: 1 }])));
  assert.equal(new Set(calls.map(result => result.body.id)).size, 1);
  const id = calls[0].body.id;
  await assert.rejects(createOrder('same-buyer', sku, [{ sku, quantity: 2 }]), (error: any) => error.statusCode === 409);
  await cancelOrder(id, 'same-buyer');
  await settleCapture(id, { status: 'SUCCEEDED', occurred_at: new Date().toISOString() });
  const stock = await pool.query('SELECT available,reserved,sold FROM inventory WHERE sku=$1', [sku]);
  assert.deepEqual(stock.rows[0], { available: 1, reserved: 0, sold: 0 });
  const order = await pool.query('SELECT status FROM orders WHERE id=$1', [id]);
  assert.equal(order.rows[0].status, 'REFUND_PENDING');
  const refunds = await pool.query("SELECT count(*)::int AS n FROM payment_operations WHERE order_id=$1 AND kind='REFUND'", [id]);
  assert.equal(refunds.rows[0].n, 1);
  await pool.query('UPDATE products SET active=false WHERE sku=$1', [sku]);
});

test('multi-SKU stock failure rolls back the entire reservation', async () => {
  const prefix = randomUUID().slice(0, 8);
  const first = 'atomic-a-' + prefix;
  const second = 'atomic-b-' + prefix;
  for (const [sku, count] of [[first, 1], [second, 0]] as const) {
    await pool.query("INSERT INTO products(sku,name,price_cents,active) VALUES($1,'Atomic fixture',100,true)", [sku]);
    await pool.query('INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,$2,$2,0,0)', [sku, count]);
  }
  const failed = await createOrder('atomic-buyer', prefix, [{ sku: first, quantity: 1 }, { sku: second, quantity: 1 }]);
  assert.equal(failed.code, 409);
  const stock = await pool.query('SELECT sku,available,reserved,sold FROM inventory WHERE sku=ANY($1::text[]) ORDER BY sku', [[first, second]]);
  assert.deepEqual(stock.rows, [
    { sku: first, available: 1, reserved: 0, sold: 0 },
    { sku: second, available: 0, reserved: 0, sold: 0 },
  ]);
  await pool.query('UPDATE inventory SET total=1,available=1 WHERE sku=$1', [second]);
  const replay = await createOrder('atomic-buyer', prefix, [{ sku: first, quantity: 1 }, { sku: second, quantity: 1 }]);
  assert.deepEqual(replay, failed);
  const fresh = await createOrder('atomic-buyer', prefix + '-new', [{ sku: first, quantity: 1 }, { sku: second, quantity: 1 }]);
  assert.equal(fresh.code, 201);
  await pool.query('UPDATE products SET active=false WHERE sku=ANY($1::text[])', [[first, second]]);
});

test('capture arriving after reserve release creates a refund, not a sale', async () => {
  const sku = 'expiry-' + randomUUID().slice(0, 8);
  await pool.query("INSERT INTO products(sku,name,price_cents,active) VALUES($1,'Expiry fixture',100,true)", [sku]);
  await pool.query('INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,1,1,0,0)', [sku]);
  const created = await createOrder('expiry-buyer', sku, [{ sku, quantity: 1 }]);
  const id = created.body.id;
  await pool.query("UPDATE reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE order_id=$1", [id]);
  await expireDue();
  await settleCapture(id, { status: 'SUCCEEDED', occurred_at: new Date(Date.now() - 2000).toISOString() });
  const stock = await pool.query('SELECT available,reserved,sold FROM inventory WHERE sku=$1', [sku]);
  assert.deepEqual(stock.rows[0], { available: 1, reserved: 0, sold: 0 });
  const status = await pool.query('SELECT status FROM orders WHERE id=$1', [id]);
  assert.equal(status.rows[0].status, 'REFUND_PENDING');
  await settleRefund(id, { status: 'SUCCEEDED', occurred_at: new Date().toISOString() });
  const refunded = await pool.query('SELECT status FROM orders WHERE id=$1', [id]);
  assert.equal(refunded.rows[0].status, 'REFUNDED');
  await pool.query('UPDATE products SET active=false WHERE sku=$1', [sku]);
});

test('failed refund can be retried with a new provider key; stale event cannot settle the new attempt', async () => {
  const sku = 'refund-' + randomUUID().slice(0, 8);
  await pool.query("INSERT INTO products(sku,name,price_cents,active) VALUES($1,'Refund fixture',100,true)", [sku]);
  await pool.query('INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,1,1,0,0)', [sku]);
  const created = await createOrder('refund-buyer', sku, [{ sku, quantity: 1 }]);
  const id = created.body.id;
  await settleCapture(id, { status: 'SUCCEEDED', occurred_at: new Date().toISOString() });
  const firstCancel = await cancelOrder(id, 'refund-buyer', 'cancel-' + sku);
  assert.equal(firstCancel.status, 'REFUND_PENDING');
  await settleRefund(id, { status: 'FAILED', provider_key: 'refund:' + id });
  const retried = await retryRefund(id);
  assert.notEqual(retried.provider_key, 'refund:' + id);
  assert.deepEqual(await settleRefund(id, { status: 'FAILED', provider_key: 'refund:' + id }), { stale: true });
  await settleRefund(id, { status: 'SUCCEEDED', provider_key: retried.provider_key, occurred_at: new Date().toISOString() });
  const replay = await cancelOrder(id, 'refund-buyer', 'cancel-' + sku);
  assert.deepEqual(replay, firstCancel);
  const order = await pool.query('SELECT status FROM orders WHERE id=$1', [id]);
  assert.equal(order.rows[0].status, 'REFUNDED');
  const operations = await pool.query("SELECT count(*)::int AS n FROM payment_operations WHERE order_id=$1 AND kind='REFUND'", [id]);
  assert.equal(operations.rows[0].n, 2);
  await pool.query('UPDATE products SET active=false WHERE sku=$1', [sku]);
});

test('API process clock skew does not expire a new reservation', async () => {
  const sku = 'clock-' + randomUUID().slice(0, 8);
  await pool.query("INSERT INTO products(sku,name,price_cents,active) VALUES($1,'Clock fixture',100,true)", [sku]);
  await pool.query('INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,1,1,0,0)', [sku]);
  const created = await createOrder('clock-buyer', sku, [{ sku, quantity: 1 }]);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10 * 60_000;
    const payment = await beginPayment(created.body.id, 'CAPTURE');
    assert.equal(payment?.provider_key, 'capture:' + created.body.id);
  } finally {
    Date.now = realNow;
  }
  const reservation = await pool.query('SELECT status FROM reservations WHERE order_id=$1', [created.body.id]);
  assert.equal(reservation.rows[0].status, 'HELD');
  await pool.query('UPDATE products SET active=false WHERE sku=$1', [sku]);
});

test.after(async () => { await pool.end(); });
