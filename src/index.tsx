// Shop Tracker on Cloudflare Workers.
//
//   GET  /                the app page, with the shop's data embedded (src/views/app.tsx)
//   /api/*                JSON the browser script saves and reloads through
//   /api/shop-products    the jmwood.work shop's small-batch products and variants
//   /api/shop-orders      its unfulfilled orders (with the Shopify app connected)
//   /api/new-orders       orders placed since the bell was last opened (POST /seen marks them read)
//   /api/receipts/scan    keeps a receipt photo and reads it into line items (Workers AI)
//   /api/receipts         every receipt kept (POST saves what one says; /:id/photo, /:id/delete)
//   /app.css, /app.js     static files from public/ (served by Workers Static Assets)
//   cron (weekly)         refreshes the supplier price list
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { App, Env } from './env';
import { endSession, isSignedIn, passwordMatches, startSession } from './lib/auth';
import { BadRequest, createProject, getPrices, getState, importBackup, replacePrices, saveChanges } from './lib/db';
import { readPriceLists } from './lib/prices';
import { deleteReceipt, keepPhoto, listReceipts, removePhoto, readPhoto, ReceiptError, saveReceipt, scanReceipt } from './lib/receipts';
import { orderAdminUrl, readOpenOrders, readProducts, readRecentOrders, shopifyConnected } from './lib/shopify';
import { AppPage } from './views/app';
import { LoginPage, SetupPage } from './views/login';

// The products on the Small Batch Projects page of the shop (jmwood.work/pages/small-batch-projects),
// from Shopify's public storefront feed. No sign-in is needed: it's what any visitor to the shop sees.
const SHOP_PRODUCTS = 'https://jmwood.work/collections/all-products-collection/products.json?limit=250';

const app = new Hono<App>();

// The shop's data for the browser, plus whether the Shopify secrets are set (never the secrets themselves).
const appState = async (env: Env) => ({ ...await getState(env.DB), shopifyConnected: shopifyConnected(env) });

// Form posts must come from this site.
app.use(csrf());

// ---------- signing in ----------
app.use(async (c, next) => {
  if (!c.env.APP_PASSWORD) return c.html(<SetupPage />, 503);
  const path = c.req.path;
  if (path === '/login' || await isSignedIn(c)) return next();
  return path.startsWith('/api/') ? c.json({ error: 'Signed out' }, 401) : c.redirect('/login');
});

app.get('/login', c => c.html(<LoginPage />));
app.post('/login', async c => {
  const form = await c.req.parseBody();
  if (!await passwordMatches(c.env.APP_PASSWORD!, String(form.password ?? ''))) return c.html(<LoginPage error="That password isn't right." />, 401);
  await startSession(c);
  return c.redirect('/');
});
app.post('/logout', c => { endSession(c); return c.redirect('/login'); });

// ---------- the app ----------
app.get('/', async c => {
  c.header('Cache-Control', 'no-store');
  return c.html(<AppPage state={await appState(c.env)} />);
});

// ---------- data ----------
app.get('/api/state', async c => c.json(await appState(c.env)));
app.post('/api/save', async c => { await saveChanges(c.env.DB, await c.req.json()); return c.json({ ok: true }); });
app.post('/api/projects', async c => c.json(await createProject(c.env.DB, await c.req.json())));
app.post('/api/import', async c => { await importBackup(c.env.DB, await c.req.json()); return c.json(await appState(c.env)); });

app.get('/api/prices', async c => {
  const prices = await getPrices(c.env.DB);
  return prices ? c.json(prices) : c.json({ error: 'No price list yet' }, 404);
});

// ---------- the jmwood.work shop ----------
// What was last read from the shop is kept in the settings table under `key` and reused for `maxAge`,
// so page loads don't each ask the shop. If the shop can't be read, the kept copy is used and the shop
// is left alone for a few minutes before being asked again.
async function cached<T>(db: D1Database, key: string, maxAge: number, read: () => Promise<T>) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  const kept: { checked: string } & T | null = row ? JSON.parse(row.value) : null;
  if (kept && Date.now() - Date.parse(kept.checked) < maxAge) return kept;
  const store = (value: object) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
  try {
    const fresh = { ...await read(), checked: new Date().toISOString() };
    await store(fresh);
    return fresh;
  } catch (error) {
    console.error(`${key}: ${error}`);
    if (!kept) throw error;
    await store({ ...kept, checked: new Date(Date.now() - maxAge + Math.min(maxAge, 10 * 60 * 1000)).toISOString() });
    return { ...kept, stale: String(error) };
  }
}

// The shop's products and variants, for the batch-run form on the Product line tab. With the Shopify
// app connected they come from the Admin API; without it, from the public storefront feed (which
// answers "too many requests" when read often, hence the hour-long copy).
app.get('/api/shop-products', async c => {
  try {
    return c.json(await cached(c.env.DB, 'shop_products', 60 * 60 * 1000, async () => ({
      products: shopifyConnected(c.env) ? await readProducts(c.env) : await readStorefront(),
    })));
  } catch (error) {
    return c.json({ error: String(error) }, 502);
  }
});
async function readStorefront() {
  const res = await fetch(SHOP_PRODUCTS, { headers: { Accept: 'application/json', 'User-Agent': 'ShopTracker (jmwood.work)' } });
  if (!res.ok) throw new Error(`The shop returned ${res.status}`);
  const { products } = await res.json<{ products: { handle: string; title: string; variants: { title: string; price: string }[] }[] }>();
  return products.map(p => ({
    handle: p.handle, title: p.title,
    variants: p.variants.map(v => ({ name: v.title === 'Default Title' ? '' : v.title, price: Number(v.price) || 0 })),
  }));
}

// Unfulfilled orders, which keep each product's open batch run up to date. Needs the Shopify app.
app.get('/api/shop-orders', async c => {
  if (!shopifyConnected(c.env)) return c.json({ connected: false, orders: [] });
  try {
    return c.json({ connected: true, ...await cached(c.env.DB, 'shop_orders', 5 * 60 * 1000, async () => ({ orders: await readOpenOrders(c.env) })) });
  } catch (error) {
    return c.json({ connected: true, error: String(error) }, 502);
  }
});

// ---------- new-order bell ----------
// The header's bell counts orders placed since it was last opened, on any device: the time of the newest
// order seen is kept in the settings table as 'orders_seen'. The first time, it starts from now, so
// orders from before the bell existed don't all show up as new.
app.get('/api/new-orders', async c => {
  if (!shopifyConnected(c.env)) return c.json({ connected: false, seen: '', orders: [] });
  const db = c.env.DB;
  let seen = (await db.prepare("SELECT value FROM settings WHERE key = 'orders_seen'").first<{ value: string }>())?.value;
  if (!seen) {
    seen = new Date().toISOString();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('orders_seen', ?) ON CONFLICT (key) DO NOTHING").bind(seen).run();
  }
  try {
    const { orders, stale } = await cached(db, 'recent_orders', 2 * 60 * 1000, async () => ({ orders: await readRecentOrders(c.env) })) as any;
    return c.json({
      connected: true, seen, ...(stale ? { stale } : {}),
      orders: orders.map((o: any) => ({ ...o, url: orderAdminUrl(o.id), new: Date.parse(o.created_at) > Date.parse(seen!) })),
    });
  } catch (error) {
    return c.json({ connected: true, seen, error: String(error), orders: [] }, 502);
  }
});
// Marks every order up to `upTo` (the newest one the bell showed) as seen. Never moves backwards,
// so a phone that was open on an old list can't bring back orders already seen on the computer.
app.post('/api/new-orders/seen', async c => {
  const { upTo } = await c.req.json<{ upTo?: string }>();
  if (typeof upTo !== 'string' || isNaN(Date.parse(upTo))) return c.json({ error: 'upTo must be a date' }, 400);
  await c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('orders_seen', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE excluded.value > settings.value`).bind(new Date(upTo).toISOString()).run();   // one format, so the text comparison above is by time
  return c.json({ ok: true });
});

// ---------- receipts ----------
// The browser sends a shrunken photo as a data URL with an id it made for the receipt. The photo is
// kept first (for taxes and audits, even if it can't be read), then the line items come back for
// checking over. The items picked are added to a project's purchases by the browser, which then
// saves the store, date and total here.
app.post('/api/receipts/scan', async c => {
  const { id, image } = await c.req.json<{ id?: string; image?: string }>();
  try {
    let kept = false;
    if (id !== undefined) {
      try { await keepPhoto(c.env.DB, id, String(image ?? '')); kept = true; }
      catch (error) { if (error instanceof ReceiptError) throw error; console.error(`Keeping receipt photo failed: ${error}`); }
    }
    return c.json({ ...await scanReceipt(c.env, String(image ?? '')), kept });
  } catch (error) {
    if (error instanceof ReceiptError) return c.json({ error: error.message }, 400);
    console.error(`Receipt scan failed: ${error}`);
    return c.json({ error: "Couldn't read the receipt just now. Try again in a minute." }, 502);
  }
});
// A photo kept without reading it (when reading failed and the lines are typed in instead, it's already kept).
app.post('/api/receipts/photo', async c => {
  const { id, image } = await c.req.json<{ id?: string; image?: string }>();
  try { await keepPhoto(c.env.DB, id, String(image ?? '')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.get('/api/receipts', async c => c.json({ receipts: await listReceipts(c.env.DB) }));
app.post('/api/receipts', async c => {
  try { await saveReceipt(c.env.DB, await c.req.json()); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.get('/api/receipts/:id/photo', async c => {
  const photo = await readPhoto(c.env.DB, c.req.param('id'));
  if (!photo) return c.text('No photo was kept for this receipt.', 404);
  // A photo can be replaced, so the page asks for it with ?v= (its size) and only that address is kept for good.
  const cache = c.req.query('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache';
  return c.body(photo.bytes, 200, { 'Content-Type': photo.mime, 'Cache-Control': cache });
});
app.post('/api/receipts/:id/photo/delete', async c => {
  try { await removePhoto(c.env.DB, c.req.param('id')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});
app.post('/api/receipts/:id/delete', async c => {
  try { await deleteReceipt(c.env.DB, c.req.param('id')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof ReceiptError) return c.json({ error: error.message }, 400); throw error; }
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof BadRequest || err instanceof SyntaxError) return c.text(err.message, 400);
  console.error(err);
  return c.text('Something went wrong on the server.', 500);
});

// ---------- weekly price check ----------
async function updatePrices(env: Env) {
  try {
    await replacePrices(env.DB, await readPriceLists());
  } catch (error) {   // keep last week's prices rather than publish a broken list
    console.error(`Price update failed: ${error}`);
    throw error;
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => ctx.waitUntil(updatePrices(env)),
} satisfies ExportedHandler<Env>;
