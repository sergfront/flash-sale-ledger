import { pool } from './db.js';

const items = [
  ['camera', 'Nocturne Camera', 'A compact camera for quiet hours.', 27900, 100, 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=1200&q=85'],
  ['speaker', 'Forma Speaker', 'Sound with a smaller footprint.', 14900, 100, 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=1200&q=85'],
  ['headphones', 'Arc Headphones', 'A focused listening space.', 18900, 100, 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=1200&q=85'],
];

for (const [sku, name, description, price, count, image] of items) {
  await pool.query(
    'INSERT INTO products(sku,name,description,price_cents,image_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(sku) DO NOTHING',
    [sku, name, description, price, image],
  );
  await pool.query(
    'INSERT INTO inventory(sku,total,available,reserved,sold) VALUES($1,$2,$2,0,0) ON CONFLICT(sku) DO NOTHING',
    [sku, count],
  );
}
await pool.end();
console.log('demo catalog ready');
