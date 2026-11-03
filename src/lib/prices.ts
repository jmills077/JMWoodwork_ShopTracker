// Reads Parkerville Wood Products' public lumber price lists into the database. Runs weekly from
// the Worker's cron trigger (wrangler.jsonc). The browser app then updates the price of every
// species linked to a Parkerville item in Settings. If a price list can't be read, this throws
// and the previous prices stay in place.
// (Carried over from the former scripts/update_prices.py, which ran as a GitHub Action.)
import type { PriceItem, Prices } from '../shared/types';

const PAGES = {
  domestic: 'https://parkervillewoodproducts.com/domestic-pricing/',
  exotic: 'https://parkervillewoodproducts.com/exotic-pricing/',
};
const MIN_ROWS = { domestic: 60, exotic: 15 };   // fewer than this means the page changed, not the prices
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; ShopTracker weekly price check)' };

async function fetchText(url: string, referer?: string) {
  const res = await fetch(url, { headers: { ...HEADERS, ...(referer ? { Referer: referer } : {}) }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

function clean(value: unknown) {
  const text = String(value ?? '').replace(/<[^>]+>/g, '');
  return ['--', '-'].includes(text.trim()) ? '' : text.split(/\s+/).filter(Boolean).join(' ');
}

async function readList(name: keyof typeof PAGES, pageUrl: string): Promise<PriceItem[]> {
  // The price table is filled in by the page from a data address embedded in it.
  const match = /"data_request_url":"([^"]+)"/.exec(await fetchText(pageUrl));
  if (!match) throw new Error(`${name}: no price table found on ${pageUrl}`);
  const rows: any[] = JSON.parse(await fetchText(JSON.parse(`"${match[1]}"`), pageUrl));
  const items: PriceItem[] = [];
  for (const row of rows) {
    const value = row.value ?? row;
    const price = String(value.price ?? '').replace(/[^0-9.]/g, '');
    const species = clean(value.species);
    if (!species || !/^\d+(\.\d+)?$/.test(price) || parseFloat(price) <= 0) continue;
    items.push({
      id: `${name[0]}${value.___id___}`,
      list: name,
      species,
      size: clean(value.size || value.sizes),   // the two lists name this column differently
      wide: clean(value.extra_wide),
      spec: clean(value.specifications),
      price: Math.round(parseFloat(price) * 100) / 100,
    });
  }
  if (items.length < MIN_ROWS[name]) throw new Error(`${name}: only ${items.length} priced rows found, expected at least ${MIN_ROWS[name]}`);
  return items;
}

export async function readPriceLists(): Promise<Prices> {
  const items: PriceItem[] = [];
  for (const [name, url] of Object.entries(PAGES) as [keyof typeof PAGES, string][]) {
    const found = await readList(name, url);
    console.log(`${name}: ${found.length} prices`);
    items.push(...found);
  }
  return { source: 'Parkerville Wood Products', checked: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'), items };
}
