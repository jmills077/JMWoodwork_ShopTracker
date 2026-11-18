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

// ---------- keeping the photos ----------
// Each receipt is a row in the receipts table (migrations/0006_receipts.sql): what was printed on it
// and the photo. Which project each line went to is in that project's data.purchases.

/** A receipt as listed: everything but the photo itself. */
export interface GeneralLine { id: string; item: string; qty: number; amount: number }
export interface ReceiptRecord { id: string; store: string; date: string; total: number; tax: number; notes: string; general: GeneralLine[]; has_photo: boolean; photo_v: number; created_at: string }

const ID = /^r[0-9a-z]{4,30}$/;
// What a D1 row can hold, less room for the other columns.
const MAX_STORED_CHARS = 1_900_000;
const checkId = (id: unknown) => { if (typeof id !== 'string' || !ID.test(id)) throw new ReceiptError('Not a receipt id.'); return id; };

/** Keeps a receipt photo (sent as a data URL), creating the receipt if it's new. */
export async function keepPhoto(db: D1Database, id: unknown, image: string) {
  const m = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new ReceiptError('That photo could not be read. Try taking it again.');
  if (m[2].length > MAX_STORED_CHARS) throw new ReceiptError('That photo is too large to keep. Try taking it again.');
  await db.prepare(`INSERT INTO receipts (id, mime, image, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET mime = excluded.mime, image = excluded.image`)
    .bind(checkId(id), m[1], m[2], new Date().toISOString()).run();
}

/** Saves what a receipt says (store, date, total, tax, notes), creating it without a photo if it's new.
 *  `general` (its lines that are general business expenses) is replaced only when it's sent. */
export async function saveReceipt(db: D1Database, r: any) {
  const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r?.date)) ? String(r.date) : '';
  let general: string | null = null;
  if (r?.general !== undefined) {
    if (!Array.isArray(r.general) || r.general.length > 300) throw new ReceiptError('Malformed general expense lines.');
    general = JSON.stringify(r.general.map((l: any) => ({ id: text(l?.id, 40), item: text(l?.item, 300), qty: money(l?.qty) || 1, amount: money(l?.amount) }))
      .filter((l: GeneralLine) => l.id && l.item));
  }
  await db.prepare(`INSERT INTO receipts (id, store, date, total, tax, notes, general, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET store = excluded.store, date = excluded.date, total = excluded.total, tax = excluded.tax, notes = excluded.notes,
      general = CASE WHEN ? THEN excluded.general ELSE receipts.general END`)
    .bind(checkId(r?.id), text(r?.store, 200), date, money(r?.total), money(r?.tax), text(r?.notes, 4000), general ?? '[]', new Date().toISOString(), general !== null ? 1 : 0).run();
}

export async function listReceipts(db: D1Database): Promise<ReceiptRecord[]> {
  const rows = await db.prepare(`SELECT id, store, date, total, tax, notes, general, mime != '' AS has_photo, length(image) AS photo_v, created_at FROM receipts ORDER BY date DESC, created_at DESC`)
    .all<Omit<ReceiptRecord, 'has_photo' | 'general'> & { has_photo: number; general: string }>();
  return rows.results.map(r => ({ ...r, general: JSON.parse(r.general || '[]'), has_photo: !!r.has_photo }));
}

/** Takes a receipt's photo off (the wrong one was kept); its store, date, total and lines stay. */
export async function removePhoto(db: D1Database, id: unknown) {
  await db.prepare(`UPDATE receipts SET mime = '', image = '' WHERE id = ?`).bind(checkId(id)).run();
}

export async function readPhoto(db: D1Database, id: string) {
  if (!ID.test(id)) return null;
  const row = await db.prepare(`SELECT mime, image FROM receipts WHERE id = ? AND mime != ''`).bind(id).first<{ mime: string; image: string }>();
  if (!row) return null;
  return { mime: row.mime, bytes: Uint8Array.from(atob(row.image), c => c.charCodeAt(0)) };
}

/** Deletes a receipt, but only one no project's purchases point to (so nothing filed for taxes goes missing). */
export async function deleteReceipt(db: D1Database, id: unknown) {
  checkId(id);
  const used = await db.prepare(`SELECT 1 FROM projects, json_each(projects.data, '$.purchases') AS x
    WHERE json_extract(x.value, '$.receipt') = ? LIMIT 1`).bind(id).first();
  if (used) throw new ReceiptError('Lines from this receipt are still on a project. Remove them from the project first.');
  const general = await db.prepare(`SELECT 1 FROM receipts WHERE id = ? AND general != '[]'`).bind(id).first();
  if (general) throw new ReceiptError('This receipt has general business expenses on it. Remove them first.');
  await db.prepare('DELETE FROM receipts WHERE id = ?').bind(id).run();
}
