// Shop Tracker on Cloudflare Workers.
//
//   GET  /                the app page, with the shop's data embedded (src/views/app.tsx)
//   /api/*                JSON the browser script saves and reloads through
//   /api/shop-products    the jmwood.work shop's small-batch products and variants
//   /app.css, /app.js     static files from public/ (served by Workers Static Assets)
//   cron (weekly)         refreshes the supplier price list
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { App, Env } from './env';
import { endSession, isSignedIn, passwordMatches, startSession } from './lib/auth';
import { BadRequest, createProject, getPrices, getState, importBackup, replacePrices, saveChanges } from './lib/db';
import { readPriceLists } from './lib/prices';
import { AppPage } from './views/app';
import { LoginPage, SetupPage } from './views/login';

const TODOIST_API = 'https://api.todoist.com/api/v1';
// The products on the Small Batch Projects page of the shop (jmwood.work/pages/small-batch-projects),
// from Shopify's public storefront feed. No sign-in is needed: it's what any visitor to the shop sees.
const SHOP_PRODUCTS = 'https://jmwood.work/collections/all-products-collection/products.json?limit=250';

const app = new Hono<App>();

// The shop's data for the browser, plus whether the TODOIST_TOKEN secret is set (never the token itself).
const appState = async (env: Env) => ({ ...await getState(env.DB), todoistConnected: !!env.TODOIST_TOKEN });

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

// The shop's products and variants, for the quick batch-run form on the Product line tab.
app.get('/api/shop-products', async c => {
  const res = await fetch(SHOP_PRODUCTS, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 300 } } as RequestInit);
  if (!res.ok) return c.json({ error: `The shop returned ${res.status}` }, 502);
  const { products } = await res.json<{ products: ShopProduct[] }>();
  return c.json({
    products: products.map(p => ({
      handle: p.handle, title: p.title,
      // A product without options has one variant called "Default Title".
      variants: p.variants.map(v => ({ name: v.title === 'Default Title' ? '' : v.title, price: Number(v.price) || 0 })),
    })),
  });
});
interface ShopProduct { handle: string; title: string; variants: { title: string; price: string }[] }

// ---------- Todoist ----------
// Passes the browser's Todoist requests on with the TODOIST_TOKEN secret, and Todoist's answers back as they are.
app.all('/api/todoist/*', async c => {
  const token = c.env.TODOIST_TOKEN;
  if (!token) return c.text('The TODOIST_TOKEN secret is not set.', 401);
  const url = new URL(c.req.url);
  const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text();
  const res = await fetch(TODOIST_API + url.pathname.slice('/api/todoist'.length) + url.search, {
    method: c.req.method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body,
  });
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'text/plain' } });
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
