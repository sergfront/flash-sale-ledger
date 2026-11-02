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
const { createOrder, cancelOrder, settleCapture } = await import('../src/domain.js');
await pool.query(await readFile('../../db/schema.sql', 'utf8'));

test('5,000 buyers cannot reserve more than 100 units', { timeout: 120_000 }, async () => {
  const sku = 'race-' + randomUUID().slice(0, 8);
  await pool.query("INSERT INTO products(sku,name,price_cents,active) VALUES($1,'Race fixture',100,true)", [sku]);
  await pool.query('INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,100,100,0,0)', [sku]);
  const attempts = await Promise.allSettled(Array.from({ length: 5000 }, (_, n) =>
    createOrder('buyer-' + n, 'attempt-' + n, [{ sku, quantity: 1 }])));
  const winners = attempts.filter(result => result.status === 'fulfilled').map(result => (result as PromiseFulfilledResult<any>).value.body.id as string);
  const losers = attempts.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 100);
  assert.equal(losers.length, 4900);
  assert.ok(losers.every(result => (result as PromiseRejectedResult).reason.statusCode === 409));
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

test.after(async () => { await pool.end(); });
