import { pool } from './db.js';

const products: { sku: string; stock: number }[] = [
  ...[1, 2, 3].map(n => ({ sku: 'load-hot-' + n, stock: 100 })),
  ...Array.from({ length: 997 }, (_, n) => ({ sku: 'load-' + String(n + 1).padStart(4, '0'), stock: 50 })),
];
for (const product of products) {
  await pool.query(
    "INSERT INTO products(sku,name,description,price_cents,currency) VALUES($1,$2,'Load fixture',1000,'USD') ON CONFLICT(sku) DO NOTHING",
    [product.sku, product.sku],
  );
  await pool.query(
    'INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,$2,$2,0,0) ON CONFLICT(sku) DO NOTHING',
    [product.sku, product.stock],
  );
}
console.log('seeded 1,000 load SKUs');
await pool.end();
