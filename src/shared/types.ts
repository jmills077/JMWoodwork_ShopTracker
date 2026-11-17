// The shapes the server stores and the browser app works with. The browser owns the details of
// a project's `data` and the settings; the server only needs the parts named here.

export interface Settings { species: unknown[]; [key: string]: unknown }

export interface Project {
  id: number; quote_number: string;
  stream: string;                     // 'client' (custom work for a client), 'product' (product line) or 'gallery' (not for sale)
  status: string; stage: string;
  data: Record<string, unknown>;      // client, spec, rates, phases, lumber, design notes, due dates; `frozen` while on hold
  calc: Record<string, unknown>;      // priced totals
  todoist: Record<string, unknown>;   // left over from the old Todoist hand-off; no longer used, kept so old data isn't lost
  history: { status?: string; stage?: string; at: string }[];
  created_at: string; updated_at: string;
}

export interface PriceItem { id: string; list: string; species: string; size: string; wide: string; spec: string; price: number }
/** The supplier price list, as the browser app has always read it. */
export interface Prices { source: string; checked: string; items: PriceItem[] }

/** What a receipt photo was read as (src/lib/receipts.ts). The browser lets you check items over before saving. */
export interface ScannedReceipt {
  store: string; date: string;        // date as YYYY-MM-DD, '' if it couldn't be read
  items: { description: string; quantity: number; amount: number }[];
  tax: number; total: number;
}
