// Reading the JM Woodwork Shopify store's products and unfulfilled orders through the Admin API.
// The Worker signs in as the "Shop Tracker" app from Shopify's Dev Dashboard (client credentials
// grant): SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are Worker secrets, and the app only has the
// read_products and read_orders scopes, so nothing here can change the shop.
import type { Env } from '../env';

const STORE = 'vtza5i-0a.myshopify.com';   // jmwood.work's Shopify address
const API_VERSION = '2026-10';
// The collection shown on jmwood.work/pages/small-batch-projects.
const COLLECTION = 'all-products-collection';

export const shopifyConnected = (env: Env) => !!(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);

// Tokens last about a day; one is kept per Worker instance until shortly before it runs out.
let token: { value: string; expires: number } | null = null;

async function accessToken(env: Env) {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID!, client_secret: env.SHOPIFY_CLIENT_SECRET! }),
  });
  if (!res.ok) throw new Error(`Shopify sign-in failed (${res.status}). Check the SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET secrets and that the app is installed on the store.`);
  const { access_token, expires_in } = await res.json<{ access_token: string; expires_in?: number }>();
  token = { value: access_token, expires: Date.now() + (expires_in ?? 3600) * 1000 };
  return token.value;
}

async function admin<T>(env: Env, query: string): Promise<T> {
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await accessToken(env) },
    body: JSON.stringify({ query }),
  });
  if (res.status === 401) token = null;
  if (!res.ok) throw new Error(`Shopify returned ${res.status}`);
  const { data, errors } = await res.json<{ data: T; errors?: { message: string }[] }>();
  if (errors?.length) throw new Error(`Shopify: ${errors.map(e => e.message).join('; ')}`);
  return data;
}

export interface ShopVariant { name: string; price: number }
export interface ShopItem { handle: string; title: string; variants: ShopVariant[] }
// A product without options has one variant called "Default Title".
const variantName = (title: string | null) => !title || title === 'Default Title' ? '' : title;

export async function readProducts(env: Env): Promise<ShopItem[]> {
  const data = await admin<any>(env, `{ collectionByIdentifier(identifier: { handle: "${COLLECTION}" }) {
    products(first: 100) { nodes { handle title variants(first: 100) { nodes { title price } } } } } }`);
  return (data.collectionByIdentifier?.products.nodes ?? []).map((p: any) => ({
    handle: p.handle, title: p.title,
    variants: p.variants.nodes.map((v: any) => ({ name: variantName(v.title), price: Number(v.price) || 0 })),
  }));
}

/** Open orders with something still to ship: the order number, when it was placed and what is owed. */
export interface OpenOrder { name: string; created_at: string; items: { handle: string; variant: string; qty: number }[] }

export async function readOpenOrders(env: Env): Promise<OpenOrder[]> {
  const data = await admin<any>(env, `{ orders(first: 100, sortKey: CREATED_AT, query: "status:open AND (fulfillment_status:unshipped OR fulfillment_status:partial)") {
    nodes { name createdAt cancelledAt lineItems(first: 100) { nodes { variantTitle unfulfilledQuantity product { handle } } } } } }`);
  return data.orders.nodes
    .filter((o: any) => !o.cancelledAt)
    .map((o: any) => ({
      name: o.name, created_at: o.createdAt,
      items: o.lineItems.nodes.filter((i: any) => i.unfulfilledQuantity > 0 && i.product)
        .map((i: any) => ({ handle: i.product.handle, variant: variantName(i.variantTitle), qty: i.unfulfilledQuantity })),
    }))
    .filter((o: OpenOrder) => o.items.length);
}
