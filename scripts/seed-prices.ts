// Writes .wrangler/seed-prices.sql, which loads seed/lumber-prices.json (the last price list the
// old GitHub Action saved) into the database, so prices work before the first weekly check runs.
// It never replaces a newer list already in the database. Run through `npm run db:seed:local`
// or `npm run db:seed:remote`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Prices } from '../src/shared/types.ts';

const root = new URL('..', import.meta.url);
const prices: Prices = JSON.parse(readFileSync(new URL('seed/lumber-prices.json', root), 'utf8'));
const q = (v: string | number) => typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;
const older = `NOT EXISTS (SELECT 1 FROM settings WHERE key = 'price_feed' AND json_extract(value, '$.checked') > ${q(prices.checked)})`;

const sql = [
  `DELETE FROM price_items WHERE ${older};`,
  ...prices.items.map((i, n) =>
    `INSERT INTO price_items (id, position, list, species, size, wide, spec, price) SELECT ${[i.id, n, i.list, i.species, i.size, i.wide, i.spec, i.price].map(q).join(', ')} WHERE ${older};`),
  `INSERT INTO settings (key, value) SELECT 'price_feed', ${q(JSON.stringify({ source: prices.source, checked: prices.checked }))} WHERE ${older}
   ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
].join('\n');

mkdirSync(new URL('.wrangler', root), { recursive: true });
writeFileSync(new URL('.wrangler/seed-prices.sql', root), sql + '\n');
console.log(`Prepared ${prices.items.length} prices checked ${prices.checked}.`);
