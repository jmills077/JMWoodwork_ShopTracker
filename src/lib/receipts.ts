// Reads a photo of a store receipt with Workers AI (a vision model on the shop's Cloudflare account,
// so there is no separate API key) and returns its line items for the browser to check over.
import type { Env } from '../env';
import type { ScannedReceipt } from '../shared/types';

const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
// Photos are shrunk in the browser before they're sent, so anything near this is not a receipt photo.
const MAX_IMAGE_CHARS = 6_000_000;

const SCHEMA = {
  type: 'object',
  properties: {
    store: { type: 'string' },
    date: { type: 'string', description: 'Purchase date as YYYY-MM-DD (a printed 10/28/26 is 2026-10-28), or empty if not printed' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          quantity: { type: 'number' },
          amount: { type: 'number', description: 'Line total in dollars, after any discount on that line' },
        },
        required: ['description', 'amount'],
      },
    },
    tax: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['store', 'date', 'items', 'tax', 'total'],
};

const PROMPT = `This is a photo of a store receipt (often a lumber yard, hardware or home-improvement store).
List every purchased line item. For each item give a readable description (expand cryptic abbreviations
where you are confident, e.g. "2X4X8 SPF" stays as is, "TB III WD GLU" becomes "Titebond III wood glue"),
the quantity, and the line's total price in dollars. Apply any discount printed under an item to that item.
Do not list subtotal, tax, total, payment, change, savings summaries or loyalty lines as items.
Also give the store name, the purchase date as YYYY-MM-DD, the sales tax and the receipt total.
Reply with JSON only.`;

export class ReceiptError extends Error {}

const money = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

// The date as YYYY-MM-DD. The model sometimes passes on the receipt's own US format (10/28/26) instead.
function readDate(text: string) {
  const pad = (n: string) => n.padStart(2, '0');
  let m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (!m || +m[1] > 12 || +m[2] > 31) return '';
  return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[1])}-${pad(m[2])}`;
}

export async function scanReceipt(env: Env, image: string): Promise<ScannedReceipt> {
  if (!env.AI) throw new ReceiptError('Receipt scanning needs the Workers AI binding (see DEPLOYMENT.md).');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_IMAGE_CHARS) throw new ReceiptError('That photo could not be read. Try taking it again.');
  const result: any = await env.AI.run(MODEL as any, {
    messages: [
      { role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: image } }] },
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    max_tokens: 2048,
    temperature: 0,
  } as any);
  let parsed = result?.response ?? result;  if (typeof parsed === 'string') {
    const json = parsed.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(json ? json[0] : parsed); } catch { throw new ReceiptError("Couldn't read the receipt. Try a sharper, flatter photo in good light."); }
  }
  const items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((i: any) => ({ description: String(i?.description ?? '').trim(), quantity: money(i?.quantity) || 1, amount: money(i?.amount) }))
    .filter((i: { description: string; amount: number }) => i.description && i.amount);
  const date = readDate(String(parsed?.date ?? ''));
  return { store: String(parsed?.store ?? '').trim(), date, items, tax: money(parsed?.tax), total: money(parsed?.total) };
}
