import { readFile } from 'node:fs/promises';
import { pool } from './db.js';

const sql = await readFile('../../db/schema.sql', 'utf8');
await pool.query(sql);
await pool.end();
console.log('schema ready');
