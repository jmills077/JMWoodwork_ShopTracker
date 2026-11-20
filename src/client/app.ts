// Shop Tracker in the browser: every page is drawn here from the shop's data, which the server
// embeds in the page and saves to the database. See README.md for how the pieces fit together.
import { workbook, type Cell, type Sheet } from './xlsx';
import { readSkp, readCutCsv, readPieceLine, fmtInches, type Piece } from './skp';

// ---------- estimating model ----------
// Baseline hours per phase at a reference size (inches, L x W x H). Hours are
// scaled by the piece's size, species, joinery complexity and finish. Tune
// these to how long things take in your shop, or use "Shop speed" in Settings
// to scale everything at once. "solid" is the share of the bounding box that
// is actual lumber, used for the board-foot estimate.
const TYPES = {
  dining_table: { name: 'Dining table', ref: [72, 38, 30], design: 2, milling: 5, joinery: 8, sanding: 4, finishing: 5, solid: 0.085 },
  coffee_table: { name: 'Coffee table', ref: [48, 24, 18], design: 1.5, milling: 3, joinery: 5, sanding: 2.5, finishing: 3, solid: 0.12 },
  end_table: { name: 'End table / nightstand', ref: [22, 22, 24], design: 1, milling: 2, joinery: 4, sanding: 1.5, finishing: 2, solid: 0.12 },
  desk: { name: 'Desk', ref: [60, 30, 30], design: 2, milling: 4.5, joinery: 8, sanding: 3.5, finishing: 4, solid: 0.10 },
  bookshelf: { name: 'Bookshelf', ref: [36, 12, 72], design: 1.5, milling: 4, joinery: 6, sanding: 3.5, finishing: 4, solid: 0.15 },
  cabinet: { name: 'Cabinet / sideboard', ref: [36, 20, 34], design: 2, milling: 4, joinery: 8, sanding: 3, finishing: 4, solid: 0.22 },
  dresser: { name: 'Dresser', ref: [60, 20, 34], design: 2.5, milling: 6, joinery: 10, sanding: 4, finishing: 5, solid: 0.22 },
  bed_frame: { name: 'Bed frame', ref: [82, 62, 40], design: 2, milling: 5, joinery: 8, sanding: 4, finishing: 5, solid: 0.035 },
  bench: { name: 'Bench', ref: [48, 14, 18], design: 1, milling: 2.5, joinery: 4, sanding: 2, finishing: 2.5, solid: 0.20 },
  chair: { name: 'Chair', ref: [18, 18, 36], design: 2, milling: 3, joinery: 9, sanding: 3, finishing: 2.5, solid: 0.12 },
  cutting_board: { name: 'Cutting board', ref: [18, 12, 1.5], design: 0.25, milling: 1, joinery: 1, sanding: 1, finishing: 0.75, solid: 1.1 },
  custom: { name: 'Other / custom', ref: [48, 24, 30], design: 2, milling: 4, joinery: 6, sanding: 3, finishing: 3.5, solid: 0.12 },
};
const COMPLEXITY = {
  simple: { name: 'Simple (pocket screws, dominos, straight lines)', factor: 0.8 },
  standard: { name: 'Standard (mortise & tenon, dados)', factor: 1.0 },
  complex: { name: 'Complex (dovetails, curves, tapers)', factor: 1.35 },
  heirloom: { name: 'Heirloom (hand-cut joinery, inlay, carving)', factor: 1.75 },
};
const FINISHES = {
  none: { name: 'Unfinished', factor: 0 },
  oil: { name: 'Oil', factor: 0.7 },
  hardwax: { name: 'Hardwax oil', factor: 0.8 },
  poly: { name: 'Polyurethane', factor: 1.0 },
  lacquer: { name: 'Sprayed lacquer', factor: 1.1 },
  stain_topcoat: { name: 'Stain + topcoat', factor: 1.3 },
  paint: { name: 'Paint', factor: 1.3 },
};
const HOURS_PER_DRAWER = 2.5, HOURS_PER_DOOR = 2.0, HOURS_PER_SHELF = 0.4;
const PHASES = [
  ['design', 'Design & shop drawings'],
  ['milling', 'Milling & stock prep'],
  ['joinery', 'Joinery & assembly'],
  ['fitted', 'Drawers, doors & shelves'],
  ['sanding', 'Sanding & surface prep'],
  ['finishing', 'Finishing'],
  ['delivery', 'Delivery & install'],
];
const STATUSES = [
  ['draft', 'Draft'], ['sent', 'Quote sent'], ['accepted', 'Accepted'], ['in_progress', 'In progress'],
  ['complete', 'Complete'], ['delivered', 'Delivered & paid'], ['declined', 'Declined'],
];
// Product-line and gallery pieces have no client or quote, so their status is just where the work is.
const OWN_STATUSES = [['planned', 'Planned'], ['in_progress', 'In progress'], ['complete', 'Complete']];
const STATUS_NAME = Object.fromEntries([...STATUSES, ...OWN_STATUSES]);
// The three streams of work. Projects from before streams existed are client work.
const STREAMS = [
  ['client', 'Client custom', 'A piece quoted for a client.'],
  ['product', 'Product line', 'One of your own products, priced for sale.'],
  ['gallery', 'Gallery', 'A piece made for the business, not for sale.'],
];
const STREAM_NAME = Object.fromEntries(STREAMS);
// Shorter tab names for the Projects page on phones.
const STREAM_SHORT = { all: 'All', client: 'Client', product: 'Product', gallery: 'Gallery' };
const streamOf = p => STREAM_NAME[p.stream] ? p.stream : 'client';
const isClient = p => streamOf(p) === 'client';
const statusesFor = stream => stream === 'client' ? STATUSES : OWN_STATUSES;
// Delivered and declined client projects, and finished product and gallery pieces, leave the board for the archive.
const archived = p => isClient(p) ? ['delivered', 'declined'].includes(p.status) : p.status === 'complete';
// A frozen project is on hold: the client went quiet but may come back, or the job hit a long delay.
// It keeps its status, phase and dates, but leaves the board and calendar for the Frozen list
// until it is unfrozen. data.frozen is { at, reason }.
const isFrozen = p => !!p.data?.frozen;
// A status from one stream carried over to another when a project changes stream.
const STATUS_IN_STREAM = {
  client: { planned: 'draft' },
  own: { draft: 'planned', sent: 'planned', declined: 'planned', accepted: 'planned', delivered: 'complete' },
};
// The phase of the work itself, tracked separately from the quote/job status above.
// Client and gallery pieces go through all five phases. Product-line pieces are already designed, so they
// go Building, Finishing, Packaging, and then Shipped, which closes the project out (status Complete).
const STAGES = [['ideation', 'Ideation'], ['design', 'Design'], ['build', 'Build'], ['finishing', 'Finishing'], ['ready', 'Delivery']];
const PRODUCT_STAGES = [['building', 'Building'], ['finishing', 'Finishing'], ['packaging', 'Packaging'], ['shipped', 'Shipped']];
const STAGE_NAME = Object.fromEntries([...STAGES, ...PRODUCT_STAGES]);
const isProduct = p => streamOf(p) === 'product';
const stagesFor = p => isProduct(p) ? PRODUCT_STAGES : STAGES;
// The phase whose due date is the project's target date: delivery, or for a product the ship-by date.
const lastPhase = p => isProduct(p) ? 'packaging' : 'ready';
// A phase from the other kind of stream, carried to the nearest one this stream has (old product-line
// projects were in the five client phases, and a project can be moved between streams).
const STAGE_IN_STREAM = {
  product: { ideation: 'building', design: 'building', build: 'building', ready: 'packaging' },
  other: { building: 'build', packaging: 'ready', shipped: 'ready' },
};
const stageOf = p => {
  const list = stagesFor(p);
  if (list.some(([key]) => key === p.stage)) return p.stage;
  return STAGE_IN_STREAM[isProduct(p) ? 'product' : 'other'][p.stage] || list[0][0];
};
const stageIndex = p => stagesFor(p).findIndex(([key]) => key === stageOf(p));
// Each phase after ideation has its own due date (Shipped has none: it is the ship-by date being met).
// The last dated phase's is the project's target completion date.
const stageDue = (p, key) => (key === lastPhase(p) ? p.data.due_date : key === 'ideation' || key === 'shipped' ? '' : p.data.stage_due?.[key]) || '';
const NEXT_STEP = {
  draft: ['sent', 'Mark quote as sent'], sent: ['accepted', 'Quote accepted'], accepted: ['in_progress', 'Start work'],
  in_progress: ['complete', 'Mark complete'], complete: ['delivered', 'Delivered & paid'],
};
const OWN_NEXT_STEP = { planned: ['in_progress', 'Start work'], in_progress: ['complete', 'Mark complete'] };
const STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'],
  ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'],
  ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
const STATE_NAME = Object.fromEntries(STATES);
const DEFAULT_SETTINGS = {
  // Statewide sales tax rates (%), without city or county add-ons. Starting values only: edit them in Settings.
  state_tax: {
    AL: 4, AK: 0, AZ: 5.6, AR: 6.5, CA: 7.25, CO: 2.9, CT: 6.35, DE: 0, DC: 6, FL: 6, GA: 4, HI: 4, ID: 6, IL: 6.25, IN: 7, IA: 6, KS: 6.5,
    KY: 6, LA: 5, ME: 5.5, MD: 6, MA: 6.25, MI: 6, MN: 6.875, MS: 7, MO: 4.225, MT: 0, NE: 5.5, NV: 6.85, NH: 0, NJ: 6.625, NM: 4.875,
    NY: 4, NC: 4.75, ND: 5, OH: 5.75, OK: 4.5, OR: 0, PA: 6, RI: 7, SC: 6, SD: 4.2, TN: 7, TX: 6.25, UT: 6.1, VT: 6, VA: 5.3, WA: 6.5,
    WV: 6, WI: 5, WY: 4,
  },
  business_name: '', business_contact: '',
  quote_terms: '50% deposit to begin work, balance due on completion. Wood is a natural material; grain and color will vary.',
  prices_checked: '',   // date of the supplier price list last applied to linked species
  // The product line's catalog, for quick small-batch runs. Names, variants and prices are copied from the
  // jmwood.work shop (see loadShopProducts); cost, time and materials per unit are filled in here.
  // { id, handle, name, listed, variants: [{ name, price }], unit_cost, unit_hours, materials }
  products: [],
  hourly_rate: 65, design_retainer: 300, contingency_pct: 10, markup_pct: 20, tax_pct: 0, deposit_pct: 50, waste_pct: 25, shop_speed: 1, quote_valid_days: 30,
  income_tax_pct: 7,   // share of a project's profit to set aside for taxes, on its Summary
  // price is $ per board foot; labor is how much slower (or faster) the species is to work than cherry or walnut
  species: [
    { name: 'Pine', price: 4, labor: 0.9 }, { name: 'Poplar', price: 5, labor: 0.9 }, { name: 'Red oak', price: 7, labor: 1 },
    { name: 'White oak', price: 10, labor: 1.1 }, { name: 'Ash', price: 7, labor: 1.05 }, { name: 'Cherry', price: 9, labor: 1 },
    { name: 'Hard maple', price: 8, labor: 1.15 }, { name: 'Walnut', price: 14, labor: 1 }, { name: 'African mahogany', price: 8.62, labor: 1 }, { name: 'South American mahogany', price: 10.99, labor: 1 },
    { name: 'Hickory', price: 7, labor: 1.25 }, { name: 'Teak', price: 35, labor: 1.2 },
  ],
};

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const pos = v => Math.max(num(v), 0);
const quarter = h => Math.round(Math.max(h, 0) * 4) / 4;
const cents = n => Math.round(n * 100) / 100;
const findSpecies = name => store.settings.species.find(s => s.name === name) || { name: name || '', price: 0, labor: 1 };

function estimate(spec) {
  const t = TYPES[spec.type] || TYPES.custom;
  const [rl, rw, rh] = t.ref;
  const l = pos(spec.length) || rl, w = pos(spec.width) || rw, h = pos(spec.height) || rh;
  // Work grows with surface area, but not linearly: setup time is fixed.
  const size = Math.min(Math.max(((l * w + l * h + w * h) / (rl * rw + rl * rh + rw * rh)) ** 0.6, 0.4), 3.5);
  const sp = num(findSpecies(spec.species).labor, 1) || 1;
  const cx = (COMPLEXITY[spec.complexity] || COMPLEXITY.standard).factor;
  const fin = (FINISHES[spec.finish] || FINISHES.oil).factor;
  const speed = num(store.settings.shop_speed, 1) || 1;
  const fitted = pos(spec.drawers) * HOURS_PER_DRAWER * (1 + (cx - 1) * 0.5)
    + pos(spec.doors) * HOURS_PER_DOOR * (1 + (cx - 1) * 0.5)
    + pos(spec.shelves) * HOURS_PER_SHELF;
  const hours = {
    design: t.design * cx * (0.7 + 0.3 * size) * speed,
    milling: t.milling * size * sp * (1 + (cx - 1) * 0.3) * speed,
    joinery: t.joinery * Math.sqrt(size) * cx * sp * speed,
    fitted: fitted * sp * speed,
    sanding: t.sanding * size * (1 + (sp - 1) * 0.5) * speed,
    finishing: t.finishing * size * fin * speed,
    delivery: pos(spec.delivery_hours),
  };
  const waste = 1 + pos(store.settings.waste_pct) / 100;
  return {
    phases: PHASES.map(([key, name]) => ({ key, name, est_hours: quarter(hours[key]) })),
    boardFeet: Math.round(l * w * h / 144 * t.solid * waste * 10) / 10,
  };
}

// Refresh estimated phases while keeping hand-edited hours and custom tasks.
function mergePhases(existing = [], estimated) {
  const merged = [];
  for (const est of estimated) {
    const old = existing.find(p => p.key === est.key);
    if (old && old.manual) merged.push({ ...est, hours: pos(old.hours), manual: true });
    else if (est.est_hours > 0) merged.push({ ...est, hours: est.est_hours });
  }
  return merged.concat(existing.filter(p => p.custom));
}

// The price agreed with the client (or set for a product), or null to use the estimate.
const agreedPrice = (data, stream) => stream === 'gallery' || data.final_price === '' || data.final_price == null ? null : pos(data.final_price);

// Re-estimates data.phases in place and returns the priced totals. Only client work has sales tax,
// a retainer and a deposit; a gallery piece is priced at cost, so its materials carry no markup.
// An agreed final price replaces the estimated total (sales tax included); the estimate is kept
// alongside it as estimate_total.
function price(data, stream = 'client') {
  const est = estimate(data.spec);
  data.phases = mergePhases(data.phases, est.phases);
  const r = data.rates;
  const laborHours = data.phases.reduce((sum, p) => sum + pos(p.hours), 0);
  const contingencyHours = cents(laborHours * pos(r.contingency_pct) / 100);
  const laborCost = (laborHours + contingencyHours) * pos(r.hourly_rate);
  // Lumber is bought as whole boards, so the cost is for what has to be purchased, not just what is used.
  const lumber = lumberNeeds(data, est.boardFeet);
  const materialsEst = lumber.buyBf * pos(findSpecies(data.spec.species).price);
  const materialsBase = data.materials_override === '' || data.materials_override == null ? materialsEst : pos(data.materials_override);
  const otherCosts = pos(data.other_costs);
  const client = stream === 'client', markup = stream === 'gallery' ? 0 : pos(r.markup_pct);
  const estSubtotal = laborCost + materialsBase * (1 + markup / 100) + otherCosts;
  const estTotal = estSubtotal + (client ? estSubtotal * pos(r.tax_pct) / 100 : 0);
  const agreed = agreedPrice(data, stream);
  const total = agreed ?? estTotal;
  // With an agreed price, the tax shown is the part of that price that is sales tax.
  const subtotal = agreed == null ? estSubtotal : client ? total / (1 + pos(r.tax_pct) / 100) : total;
  const tax = total - subtotal;
  const retainer = client ? Math.min(pos(data.retainer), total) : 0;
  const balance = total - retainer;
  return {
    board_feet: est.boardFeet, lumber, labor_hours: cents(laborHours), contingency_hours: contingencyHours, labor_cost: cents(laborCost),
    materials_est: cents(materialsEst), materials_cost: cents(materialsBase * (1 + markup / 100)), other_costs: cents(otherCosts),
    cost: cents(laborCost + materialsBase + otherCosts),   // what the piece costs the shop: time, lumber and hardware
    subtotal: cents(subtotal), tax: cents(tax), total: cents(total),
    estimate_total: cents(estTotal), agreed: agreed != null,
    retainer: cents(retainer), balance: cents(balance), deposit: client ? cents(balance * pos(r.deposit_pct) / 100) : 0,
  };
}

// ---------- storage (the shop's database, through the server) ----------
// The page arrives with the shop's data embedded in it; changes are sent back to the server.
let store = loadStore(JSON.parse(document.getElementById('initialState').textContent));

function loadStore(saved: any) {
  return {
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...(saved.settings || {}) },
    projects: Array.isArray(saved.projects) ? saved.projects : [],
    shopifyConnected: !!saved.shopifyConnected,   // whether the server can read the shop's orders (the SHOPIFY_* secrets)
    settingsUpdatedAt: saved.settingsUpdatedAt || '',
  };
}
// Save a change to the shop's data.
let changeSeq = 0;
function persist() {
  changeSeq++;
  scheduleSave();
}
function settingsChanged() {
  store.settingsUpdatedAt = new Date().toISOString();
  persist();
}

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
// The Reset button in an iPhone's date picker puts a date box back to the date it was drawn with (its
// value attribute), not to empty. So once a date box is on the page, its date is moved from the
// attribute to the box itself, leaving nothing for Reset to bring back.
function clearDateDefaults(root) {
  const boxes = root.matches?.('input[type=date][value]') ? [root] : [...(root.querySelectorAll?.('input[type=date][value]') || [])];
  for (const box of boxes) { const date = box.value; box.removeAttribute('value'); box.value = date; }
}
new MutationObserver(changes => changes.forEach(c => c.addedNodes.forEach(clearDateDefaults)))
  .observe(document.body, { childList: true, subtree: true });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const hrs = n => `${+num(n).toFixed(2)} h`;
const shortDay = iso => new Date(iso + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDate = iso => iso ? new Date(iso.length === 10 ? iso + 'T00:00' : iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.'), last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}
const inputValue = el => el.type === 'number' ? (el.value === '' ? '' : num(el.value)) : el.value;
const projectName = p => p.data.batch ? `${p.data.title} × ${batchUnits(p.data.batch)}` : p.data.title || TYPES[p.data.spec.type].name;

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ---------- supplier lumber prices ----------
// A weekly job on the server reads Parkerville Wood Products' price lists into the database.
// A species linked to one of its items in Settings takes that item's price per board foot.
const PRICE_FEED = '/api/prices';
const AUTO_LINK = {
  'Pine': 'Pine, Eastern White (Clear)', 'Poplar': 'Poplar', 'Red oak': 'Oak, Red', 'White oak': 'Oak, White (PS)', 'Ash': 'Ash',
  'Cherry': 'Cherry', 'Hard maple': 'Maple, Hard', 'Walnut': 'Walnut, Black', 'Hickory': 'Hickory', 'Teak': 'Teak',
  'African mahogany': 'Mahogany, African', 'South American mahogany': 'Mahogany, South American',
};
let feed = null;

async function loadPrices() {
  try {
    const res = await fetch(PRICE_FEED, { cache: 'no-cache' });
    const data = res.ok ? await res.json() : null;
    if (!data || !Array.isArray(data.items)) return;
    feed = data;
  } catch { return; }
  if (applyPrices() && !(ed && !ed.project)) route();
}

// The standard pick for a species: 4/4, regular width, top grade where one is listed.
function defaultItem(species) {
  const items = feed.items.filter(i => i.species === species);
  const regular = items.filter(i => i.size === '4/4' && !i.wide);
  return regular.find(i => i.spec.includes('FAS')) || regular[0] || items[0];
}

// Returns true if any setting changed. Prices only move forward to a newer list, so a device
// still holding last week's list can't undo an update another device has already saved.
function applyPrices() {
  if (!feed) return false;
  const settings = store.settings, fresh = feed.checked > (settings.prices_checked || '');
  let changed = false;
  if (!(settings.species_rev >= 1)) {
    // One-time change to species lists saved earlier: the generic "Mahogany" becomes African and South American.
    const old = settings.species.findIndex(sp => sp.name === 'Mahogany');
    const added = [['African mahogany', 8.62], ['South American mahogany', 10.99]]
      .filter(([name]) => !settings.species.some(sp => sp.name === name)).map(([name, price]) => ({ name, price, labor: 1 }));
    settings.species.splice(old < 0 ? settings.species.length : old, old < 0 ? 0 : 1, ...added);
    // Quotes that used the generic entry move to South American, the closer of the two in price.
    for (const p of store.projects.filter(p => old >= 0 && p.data.spec.species === 'Mahogany')) {
      p.data.spec.species = 'South American mahogany';
      p.updated_at = new Date().toISOString();
    }
    settings.species_rev = 1;
    changed = true;
  }
  for (const sp of settings.species) {
    let linkedNow = false;
    if (sp.source === undefined) {   // first time: link the species that have an obvious match
      sp.source = (AUTO_LINK[sp.name] && defaultItem(AUTO_LINK[sp.name])?.id) || '';
      linkedNow = changed = true;
    }
    const item = feed.items.find(i => i.id === sp.source);
    if (item && (fresh || linkedNow) && sp.price !== item.price) { sp.price = item.price; changed = true; }
  }
  if (fresh) { settings.prices_checked = feed.checked; changed = true; }
  if (changed) settingsChanged();
  return changed;
}

// ---------- saving to the server (shared by every device) ----------
// Only what changed is sent: each project on its own, and the settings if they changed. When two
// devices edit the same project, the most recently edited copy wins.
const unbusy = (key, value) => key === 'busy' ? undefined : value;
let saveTimer, saving = false, saveAgain = false, saveMessage = '';
let saved = snapshot();   // the data as the server last had it

function snapshot() {
  return {
    settings: JSON.stringify(store.settings),
    projects: new Map<number, string>(store.projects.map(p => [p.id, JSON.stringify(p, unbusy)])),
  };
}
function pendingChanges() {
  const now = snapshot();
  const projects = [...now.projects].filter(([id, text]) => saved.projects.get(id) !== text).map(([, text]) => JSON.parse(text));
  const deleted = [...saved.projects.keys()].filter(id => !now.projects.has(id));
  const settings = now.settings !== saved.settings;
  return { now, projects, deleted, settings, any: !!(projects.length || deleted.length || settings) };
}

function scheduleSave(ms = 800) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, ms);
}

function setSyncState(state, message = '') {
  saveMessage = message;
  const el = $('#syncState');
  el.className = state;
  el.title = message;
  el.textContent = { busy: 'Saving…', ok: 'Saved', offline: 'Offline · not saved yet', error: 'Not saved' }[state] || '';
}

async function api(path, body?, keepalive = false) {
  let res;
  try {
    res = await fetch(path, body === undefined ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });
  } catch {
    throw Object.assign(new Error('Could not reach the server.'), { offline: true });
  }
  if (res.status === 401) throw Object.assign(new Error('You have been signed out. Sign in again to save.'), { signedOut: true });
  if (!res.ok) throw new Error(`The server returned ${res.status}${res.status < 500 ? `: ${(await res.text()).slice(0, 200)}` : '.'}`);
  return res.json();
}

// keepalive lets a save finish while the page is closing.
async function save(keepalive = false) {
  if (saving) { saveAgain = true; return; }
  clearTimeout(saveTimer);
  const changes = pendingChanges();
  if (!changes.any) return;
  saving = true;
  setSyncState('busy');
  try {
    await api('/api/save', {
      projects: changes.projects, deleted: changes.deleted,
      ...(changes.settings ? { settings: store.settings, settingsUpdatedAt: store.settingsUpdatedAt } : {}),
    }, keepalive);
    saved = changes.now;
    setSyncState('ok');
  } catch (e) {
    if (e.message !== saveMessage) toast(`Not saved: ${e.message}`);
    setSyncState(e.offline ? 'offline' : 'error', e.message);
    saveTimer = setTimeout(save, 10000);   // keep trying; the changes stay on this page meanwhile
  }
  saving = false;
  if (saveAgain) { saveAgain = false; scheduleSave(200); }
}

// Pick up changes made on other devices.
async function refresh() {
  await save();
  const seq = changeSeq;
  let remote;
  try { remote = await api('/api/state'); } catch (e) {
    // Nothing is waiting to be saved, so go straight to sign-in. A home-screen app has no reload button.
    if (e.signedOut && !pendingChanges().any) location.assign('/login');
    return;
  }
  // Something was edited while the request was out: leave it for the next refresh.
  if (seq !== changeSeq || saving || pendingChanges().any) return;
  const next = loadStore(remote);
  store.shopifyConnected = next.shopifyConnected;
  if (JSON.stringify([next.settings, next.projects], unbusy) === JSON.stringify([store.settings, store.projects], unbusy)) return;
  store = next;
  saved = snapshot();
  applyPrices();
  backfillTodos();
  // Redraw from the new data, unless a not-yet-saved quote is being written.
  if (!(ed && !ed.project)) route();
}

// ---------- routing ----------
let ed = null;          // editor state: { project (null while new), data, dirty }
let currentHash = '';

// Section pages: the lists you open a project from. A project's pages lead back to the one you came from
// ("← Calendar"), and coming back puts you where you were on it.
function sectionOf(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === '' || parts[0] === 's') return 'Projects';
  if (parts[0] === 'calendar') return 'Calendar';
  if (parts[0] === 'frozen') return 'Frozen projects';
  if (parts[0] === 'receipts') return 'All receipts';
  if (parts[0] === 'products') return 'Shop products';
  if (parts[0] === 'tasks') return parts[1] === 'shopping' ? 'Shopping list' : parts[1] === 'todos' ? 'All to-dos' : parts[1] ? null : 'Tasks';
  return null;
}
const keep = (key, value?) => {
  try { if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || 'null'); sessionStorage.setItem(key, JSON.stringify(value)); } catch {}
  return null;
};
let cameFrom = keep('cameFrom');                 // { hash, label }: the last section page shown
const scrollSpots = keep('scrollSpots') || {};   // section page -> how far down it was
/** The "← back" link for a page opened from a list: back to the list it was opened from, else `href`. */
function backLink(href, label) {
  const to = cameFrom && cameFrom.hash !== currentHash ? cameFrom : { hash: href, label };
  return `<a href="${esc(to.hash)}" class="back">&larr; ${esc(to.label)}</a>`;
}

let prevHash = '';
function route() {
  const before = currentHash;
  if (before !== (location.hash || '#/')) prevHash = before;
  currentHash = location.hash || '#/';
  if (before && sectionOf(before)) { scrollSpots[before] = window.scrollY; keep('scrollSpots', scrollSpots); }
  const section = sectionOf(currentHash);
  if (section) { cameFrom = { hash: currentHash, label: section }; keep('cameFrom', cameFrom); }
  ed = null;
  const parts = currentHash.replace(/^#\/?/, '').split('/');
  const project = parts[0] === 'p' ? store.projects.find(p => p.id === Number(parts[1])) : null;
  let nav = 'board';
  if (parts[0] === 'new') { nav = 'new'; STREAM_NAME[parts[1]] ? showEditor(null, parts[1]) : showNewPicker(); }
  else if (parts[0] === 's' && (STREAM_NAME[parts[1]] || parts[1] === 'all')) { boardStream = parts[1]; remember(); showBoard(); }
  else if (parts[0] === 'settings') { nav = 'settings'; showSettings(); }
  else if (parts[0] === 'products') { nav = 'settings'; showProducts(); }
  else if (parts[0] === 'calendar') { nav = 'calendar'; showCalendar(parts[1]); }
  else if (parts[0] === 'frozen') showFrozen();
  else if (parts[0] === 'receipt') { nav = 'receipts'; showReceipt(Number(parts[1]) || null); }
  else if (parts[0] === 'receipts') { nav = 'receipts'; showReceiptLog(/^\d{4}$/.test(parts[1]) ? parts[1] : ''); }
  else if (parts[0] === 'tasks') {
    nav = 'tasks';
    const listed = store.projects.find(p => p.id === Number(parts[1]));
    if (parts[1] === 'shopping') { nav = 'shopping'; showShopping(); } else if (parts[1] === 'todos') showAllTodos(); else if (listed) showTodo(listed); else showTasks();
  }
  else if (project && parts[2] === 'quote' && isClient(project)) showQuote(project);
  else if (project && parts[2] === 'design') showDesign(project);
  else if (project && parts[2] === 'cuts') showCuts(project);
  else if (project && parts[2] === 'todo') showTodo(project);
  else if (project && parts[2] === 'dates') { phaseDatesOpen = true; isBatch(project) ? showBatch(project) : showEditor(project); setTimeout(openPhaseDates, 80); }
  else if (project && parts[2] === 'summary') showSummary(project);
  else if (project && isBatch(project)) showBatch(project);
  else if (project) showEditor(project);
  else showBoard();
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav.split(' ').includes(nav)));
  $('header.top .newbtn')?.setAttribute('href', newLink());   // + starts the kind of project the board is showing
  // Redrawing the same page (new data from another device) stays put; a section page you come back to
  // opens where you left it; anything else starts at the top.
  if (before === currentHash) return;
  const spot = section ? scrollSpots[currentHash] || 0 : 0;
  window.scrollTo(0, spot);
  if (spot) [60, 250, 700].forEach(ms => setTimeout(() => {   // pages that finish drawing a moment later
    if (currentHash === location.hash && window.scrollY < spot - 2) window.scrollTo(0, spot);
  }, ms));
}
window.addEventListener('hashchange', () => {
  if (ed && !ed.project && ed.dirty && !confirm('Discard this unsaved quote?')) {
    history.replaceState(null, '', currentHash);
    return;
  }
  route();
});
// ---------- quick find ----------
// The magnifier in the header (or "/" on a computer) finds any project by its name, client or quote
// number, frozen and finished ones too.
const finder = $('#finder'), findInput = $('#findInput') as HTMLInputElement, findResults = $('#findResults');
function findMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = p => [projectName(p), p.data.client_name, p.quote_number, STREAM_NAME[streamOf(p)], p.data.spec?.species].join(' ').toLowerCase();
  const rank = p => isFrozen(p) ? 1 : archived(p) ? 2 : 0;
  return store.projects.filter(p => words.every(w => text(p).includes(w)))
    .sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
}
function drawFind() {
  const q = findInput.value.trim(), list = q ? findMatches(q) : prioritized().slice(0, 6);
  findResults.innerHTML = (q ? '' : '<li class="findhead muted">Active projects</li>') + (list.map((p, i) => `<li><a href="#/p/${p.id}" class="${i === 0 && q ? 'first' : ''}">
      <b>${esc(projectName(p))}</b><span class="muted">${isClient(p) ? esc([p.data.client_name, p.quote_number].filter(Boolean).join(' \u00b7 ')) : STREAM_NAME[streamOf(p)]}${isFrozen(p) ? ' \u00b7 frozen' : ''}</span>
      <span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></a></li>`).join('') || '<li class="findnone muted">No project matches that.</li>');
}
function openFind(open = true) {
  finder.hidden = !open;
  document.body.classList.toggle('finding', open);
  if (!open) return;
  findInput.value = '';
  drawFind();
  findInput.focus();
}
$('#findBtn').addEventListener('click', () => openFind(finder.hidden));
findInput.addEventListener('input', drawFind);
findInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') openFind(false);
  if (e.key === 'Enter') { const a = findResults.querySelector('a') as HTMLAnchorElement; if (a) { location.hash = a.getAttribute('href'); openFind(false); } }
});
finder.addEventListener('click', e => { if ((e.target as Element).closest('a') || e.target === finder) openFind(false); });
document.addEventListener('keydown', e => {
  const el = e.target as Element;
  if (e.key === '/' && finder.hidden && !el.closest('input, textarea, select, [contenteditable]')) { e.preventDefault(); openFind(); }
  if (e.key === 'Escape' && !finder.hidden) openFind(false);
});

// Tapping the menu or tab bar link for the page you're already on takes you to its top.
document.addEventListener('click', e => {
  const a = (e.target as Element).closest<HTMLAnchorElement>('header.top a, nav.tabbar a');
  if (a && a.getAttribute('href') === (location.hash || '#/')) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
// The tab bar steps aside while typing on a phone, so it doesn't sit on top of the keyboard.
document.addEventListener('focusin', e => { if ((e.target as Element).matches('input:not([type=checkbox]):not([type=radio]), textarea, select')) document.body.classList.add('typing'); });
document.addEventListener('focusout', () => setTimeout(() => {
  if (!document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]), textarea, select')) document.body.classList.remove('typing');
}, 50));

// ---------- projects board ----------
// The board shows one stream at a time, or all of them; the choice is remembered on this device.
let boardStream = (() => { try { return localStorage.getItem('boardStream') || 'all'; } catch { return 'all'; } })();
if (!STREAM_NAME[boardStream]) boardStream = 'all';
function remember() { try { localStorage.setItem('boardStream', boardStream); } catch {} }
const boardLink = () => boardStream === 'all' ? '#/' : `#/s/${boardStream}`;
const newLink = () => STREAM_NAME[boardStream] ? `#/new/${boardStream}` : '#/new';
// What a card shows as the piece's value: a client's quote, a product's price, a gallery piece's cost.
const valueOf = p => streamOf(p) === 'gallery' ? p.calc.cost ?? p.calc.total : p.calc.total;

function showBoard() {
  const tab = STREAM_NAME[boardStream] ? boardStream : 'all';
  const shown = store.projects.filter(p => !isFrozen(p) && (tab === 'all' || streamOf(p) === tab));
  const frozenCount = store.projects.filter(isFrozen).length;
  const by = (...statuses) => shown.filter(p => statuses.includes(p.status)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const sum = (list, f) => list.reduce((total, p) => total + f(p), 0);
  const shopHours = p => p.calc.labor_hours + p.calc.contingency_hours;
  // On phones the tabs are one row of pills with the short names; if they still don't fit, the row swipes sideways.
  const tabs = `<nav class="tabs streams">${[['all', 'All projects'], ...STREAMS].map(([key, name]) =>
    `<a href="${key === 'all' ? '#/s/all' : `#/s/${key}`}" class="${key === tab ? 'on' : ''}"${key === tab ? ' aria-current="page"' : ''}><span class="tlong">${name}</span><span class="tshort">${STREAM_SHORT[key]}</span>
      <small>${store.projects.filter(p => key === 'all' || streamOf(p) === key).filter(p => !archived(p) && !isFrozen(p)).length}</small></a>`).join('')}
    <span class="spacer"></span><a href="#/frozen" class="frozenlink">Frozen <small>${frozenCount}</small></a></nav>`;
  // Keep the chosen pill in view when the phone row has to scroll.
  const tabInView = () => {
    const nav = $('.tabs.streams'), on = nav?.querySelector('a.on');
    if (nav && on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
  };
  const newLabel = tab === 'client' ? 'New quote' : 'New project';
  const head = `<div class="pagehead"><h1>Projects</h1><span class="spacer"></span>${tab === 'product' ? '<a class="btn" href="#/products">Shop products</a>' : ''}<a class="btn wideonly" href="#/receipt">Scan a receipt</a><a class="btn primary wideonly" href="${newLink()}">${newLabel}</a></div>${tabs}`;
  const quick = tab === 'product' ? '<div class="card" id="quickBatch"></div>' : '';
  if (!shown.length) {
    view.innerHTML = `${head}${quick}<div class="card empty"><h1>Nothing here yet</h1>
      <p class="muted">${tab === 'all' ? 'Start by pricing a piece for a client, or plan one of your own.' : esc(STREAMS.find(x => x[0] === tab)[2])}</p>
      <p><a class="btn primary" href="${newLink()}">${newLabel}</a></p></div>`;
    if (quick) renderQuickBatch();
    return;
  }
  const active = by('accepted', 'in_progress');
  const statLists = [];
  const stat = (label, value, note, list = []) => {
    statLists.push({ label, list });
    return `<button type="button" class="card stat" data-stat="${statLists.length - 1}" aria-expanded="false" ${list.length ? '' : 'disabled'}><span class="muted">${label}</span><b>${value}</b><span class="muted">${note}</span></button>`;
  };
  let stats;
  if (tab === 'client' || tab === 'all') {
    const open = by('sent'), done = by('complete', 'delivered');
    // Booked work: client quotes that were accepted (and not yet finished), plus everything sitting in a
    // phase of the product line, at retail value. Gallery pieces aren't for sale, so they're left out.
    const booked = active.filter(isClient), products = shown.filter(p => isProduct(p) && !archived(p));
    const bookedNote = tab === 'all' ? `${booked.length} client \u00b7 ${products.length} product` : `${booked.length} active`;
    stats = stat('Quotes awaiting answer', money(sum(open, p => p.calc.total)), `${open.length} sent`, open)
      + stat(tab === 'all' ? 'Booked Work' : 'Booked client work', money(sum([...booked, ...products], valueOf)), bookedNote, [...booked, ...products])
      + stat('Shop hours booked', hrs(sum(active, shopHours)), tab === 'all' ? 'all active work' : 'accepted + in progress', active)
      + (tab === 'all' ? stat('Completed', String(done.length), 'pieces finished', done)
        : stat('Completed', money(sum(done, p => p.calc.total)), `${done.length} finished`, done));
  } else {
    const planned = by('planned'), done = by('complete');
    const valueLabel = tab === 'product' ? 'retail value' : 'cost';
    stats = stat('Planned', String(planned.length), `${money(sum(planned, valueOf))} ${valueLabel}`, planned)
      + stat('In progress', String(active.length), `${money(sum(active, valueOf))} ${valueLabel}`, active)
      + stat('Shop hours booked', hrs(sum(active, shopHours)), 'in progress', active)
      + stat('Completed', String(done.length), `${money(sum(done, valueOf))} ${valueLabel}`, done);
  }
  const jobCard = p => `<a class="job" href="#/p/${p.id}" draggable="true" data-id="${p.id}">
      <b>${esc(projectName(p))}</b>
      <div class="row"><span>${isClient(p) ? esc(p.data.client_name || 'No client yet') : streamOf(p) === 'gallery' ? 'Cost' : 'Retail price'}</span><span class="amt">${money(valueOf(p))}</span></div>
      <div class="row"><span>${isClient(p) ? esc(p.quote_number) : ''}</span><span>${hrs(shopHours(p))}</span></div>
      <div class="row foot"><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span>${isBatch(p) && p.data.due_date ? `<span>Ship by ${esc(fmtDate(p.data.due_date))}</span>` : stageDue(p, stageOf(p)) ? `<span>Phase due ${esc(fmtDate(stageDue(p, stageOf(p))))}</span>` : ''}</div>
    </a>`;
  const archive = shown.filter(archived).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const inStage = (key, list = shown) => list.filter(p => !archived(p) && stageOf(p) === key).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  // The product line's Shipped column is where a run goes once it's in the mail: dropping it there
  // closes it out to the archive, so the column itself stays empty.
  const boardStages = stream => stream === 'product' ? PRODUCT_STAGES : STAGES;
  const boardHtml = (list = shown, stream = tab) => `<div class="board ${stream === 'product' ? 'b-product' : ''}">
      ${boardStages(stream).map(([key, name]) => key === 'shipped'
        ? `<section class="col shipcol" data-stage="${key}"><h2><span>${name}</span><span></span></h2><p class="muted">Drop a run here once it ships. It closes out and moves to the archive.</p></section>`
        : `<section class="col" data-stage="${key}">
        <h2><span>${name}</span><span>${inStage(key, list).length}</span></h2>${inStage(key, list).map(jobCard).join('')}</section>`).join('')}
    </div>`;
  // On a phone the board's five wide columns show little, so it becomes a compact list instead: a strip
  // of phase counts, then one row per project, grouped by phase, with empty phases left out. Each row
  // shows the name, who it's for, its status, value and the next date it's due. CSS picks which of the
  // two layouts shows, so turning the phone or resizing a window needs no redraw.
  const today = ymd(new Date());
  const nextDue = p => isBatch(p) && p.data.due_date ? ['Ship by', p.data.due_date]
    : stageDue(p, stageOf(p)) ? [`${STAGE_NAME[stageOf(p)]} due`, stageDue(p, stageOf(p))]
    : p.data.due_date ? ['Target', p.data.due_date] : null;
  const dueLine = p => {
    const due = nextDue(p);
    if (!due) return '<span class="muted">No date set</span>';
    const n = Math.round((+new Date(due[1] + 'T00:00') - +new Date(today + 'T00:00')) / 86400000);
    const left = n < 0 ? `${-n}d late` : n === 0 ? 'today' : `${n}d`;
    return `<span class="${n < 0 ? 'late' : n <= 7 ? 'soon' : ''}">${due[0]} ${esc(shortDay(due[1]))} &middot; ${left}</span>`;
  };
  const who = p => isClient(p) ? esc([p.data.client_name || 'No client yet', p.quote_number].filter(Boolean).join(' \u00b7 '))
    : isBatch(p) ? 'Small batch' : esc([TYPES[p.data.spec?.type]?.name, p.data.spec?.species].filter(Boolean).join(' \u00b7 ') || STREAM_NAME[streamOf(p)]);
  const byDue = (a, b) => (nextDue(a)?.[1] || '9999').localeCompare(nextDue(b)?.[1] || '9999') || b.updated_at.localeCompare(a.updated_at);
  const listRow = p => `<a class="prow" href="#/p/${p.id}">
      <span class="pmain"><b>${esc(projectName(p))}</b><span class="muted">${who(p)}</span></span>
      <span class="pside"><span class="amt">${money(valueOf(p))}</span><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></span>
      <span class="pdue">${dueLine(p)}<span class="muted">${hrs(shopHours(p))}</span></span>
    </a>`;
  const listHtml = (list = shown, stream = tab) => {
    const counts = boardStages(stream).filter(([key]) => key !== 'shipped').map(([key, name]) => [key, name, inStage(key, list).length]);
    const open = counts.reduce((n, c) => n + c[2], 0);
    return `<div class="plist s-${tab}">
      <div class="pstrip">${counts.map(([key, name, n]) => `<span class="${n ? '' : 'zero'}"><i class="st-${key}"></i>${name} <b>${n}</b></span>`).join('')}</div>
      ${open ? counts.filter(c => c[2]).map(([key, name, n]) => `<div class="pgroup">
        <h3><i class="st-${key}"></i>${name} <span>${n}</span></h3>${inStage(key, list).sort(byDue).map(listRow).join('')}</div>`).join('')
        : '<p class="muted pnone">Nothing in the works.</p>'}
    </div>`;
  };
  // "All projects" shows each stream as its own section, one above the other. Every section keeps its
  // columns, even when empty, so a card can be dragged into another stream.
  const lanes = () => STREAMS.map(([key, name]) => {
    const list = shown.filter(p => streamOf(p) === key), open = list.filter(p => !archived(p));
    return `<section class="lane ${key}" data-stream="${key}">
      <div class="lanehead"><h2>${name} <span>${open.length}</span></h2>${key === 'product' ? '<a href="#/products" class="lprod">Products</a>' : ''}<a href="#/s/${key}">Open<span class="lopen"> ${name.toLowerCase()}</span> &rarr;</a></div>
      ${boardHtml(list, key)}${listHtml(list, key)}
    </section>`;
  }).join('');
  view.innerHTML = `
    ${head}
    ${quick}
    <div class="stats">${stats}</div><div id="statList" hidden></div>
    <div class="boards">${tab === 'all' ? lanes() : boardHtml() + listHtml()}</div>
    ${archive.length ? `<div class="card" style="margin-top:20px"><h2>Archive</h2><table class="list">
      <tr><th>Project</th><th>${tab === 'client' ? 'Client' : tab === 'all' ? 'Stream' : ''}</th><th>${tab === 'client' ? 'Quote' : ''}</th><th>${tab === 'gallery' ? 'Cost' : 'Total'}</th><th>Status</th></tr>
      ${archive.map(p => `<tr><td><a href="#/p/${p.id}">${esc(projectName(p))}</a></td>
        <td>${tab === 'client' ? esc(p.data.client_name) : tab === 'all' ? STREAM_NAME[streamOf(p)] : ''}</td>
        <td>${tab === 'client' ? esc(p.quote_number) : ''}</td><td>${money(valueOf(p))}</td><td><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></td></tr>`).join('')}
      </table></div>` : ''}`;

  tabInView();
  requestAnimationFrame(markStuckBands);
  $('.stats').addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLElement>('[data-stat]');
    if (!b) return;
    const box = $('#statList'), was = b.getAttribute('aria-expanded') === 'true';
    view.querySelectorAll('[data-stat]').forEach(x => x.setAttribute('aria-expanded', 'false'));
    box.hidden = was;
    if (was) return;
    b.setAttribute('aria-expanded', 'true');
    const { label, list } = statLists[Number(b.dataset.stat)];
    box.innerHTML = `<div class="card statlist"><h2>${label} <span class="muted">${list.length}</span></h2><ul>${list.map(p => `<li><a href="#/p/${p.id}">${esc(projectName(p))}</a>
      <span class="muted">${isClient(p) ? esc(p.data.client_name || p.quote_number) : STREAM_NAME[streamOf(p)]}</span><span class="amt">${money(valueOf(p))}</span><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></li>`).join('')}</ul></div>`;
  });
  if (quick) renderQuickBatch();
  // Drag a card to another column to change its phase, or (on "All projects") into another stream's section.
  const board = $('.boards');
  let dragged = null;
  const clearOver = () => board.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
  board.addEventListener('dragstart', e => {
    const card = e.target.closest('.job');
    if (!card) return;
    dragged = store.projects.find(p => p.id === Number(card.dataset.id));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', projectName(dragged));
    card.classList.add('dragging');
  });
  board.addEventListener('dragend', e => {
    e.target.closest('.job')?.classList.remove('dragging');
    clearOver();
    dragged = null;
  });
  board.addEventListener('dragover', e => {
    const col = e.target.closest('.col');
    if (!dragged || !col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!col.classList.contains('over')) { clearOver(); col.classList.add('over'); }
  });
  board.addEventListener('drop', e => {
    const col = e.target.closest('.col');
    if (!dragged || !col) return;
    e.preventDefault();
    const p = dragged, stream = col.closest('.lane')?.dataset.stream;
    const move = stream && stream !== streamOf(p);
    if (move && !confirm(`Move ${projectName(p)} to ${STREAM_NAME[stream]}?`)) { clearOver(); return; }
    if (move) setStream(p, stream, col.dataset.stage);
    else { setStage(p, col.dataset.stage); showBoard(); }
  });
}

// ---------- calendar of accepted projects ----------
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function showCalendar(month) {
  const today = ymd(new Date());
  const [year, mon] = (/^\d{4}-\d{2}$/.test(month || '') ? month : today.slice(0, 7)).split('-').map(Number);
  const monthLink = offset => `#/calendar/${ymd(new Date(year, mon - 1 + offset, 1)).slice(0, 7)}`;

  // A job goes on the calendar once its quote is accepted (or, for the shop's own pieces, once work
  // starts) and comes off when it is delivered.
  // Its bar is split at each phase's due date, one colored stretch per phase; phases already
  // finished are faded. With no phase dates it is one bar in the color of the current phase.
  const nextDay = date => { const d = new Date(date + 'T00:00'); d.setDate(d.getDate() + 1); return ymd(d); };
  // A product run comes off as soon as it ships.
  const jobs = store.projects.filter(p => !isFrozen(p) && ['accepted', 'in_progress', 'complete'].includes(p.status) && !(isProduct(p) && p.status === 'complete')).map(p => {
    const began = (isClient(p) && p.history.findLast(h => h.status === 'accepted')) || p.history.findLast(h => h.status === 'in_progress');
    const start = ymd(new Date(began?.at || p.updated_at));
    const current = stageIndex(p);
    const dated = stagesFor(p).map(([key], i) => ({ key, i, due: stageDue(p, key) })).filter(x => x.due);
    let segs = [];
    if (dated.some(x => x.key !== lastPhase(p))) {
      let from = start;
      for (const x of dated) {
        if (x.due < from) continue;   // already past when the job started, or dated out of order
        segs.push({ key: x.key, from, to: x.due, past: x.i < current });
        from = nextDay(x.due);
      }
    }
    if (!segs.length) segs = [{ key: stageOf(p), from: start, to: p.data.due_date > start ? p.data.due_date : start, past: false }];
    return { p, segs, start, end: segs.at(-1).to };
  }).sort((a, b) => a.start.localeCompare(b.start));

  // What each job should be doing today going by its phase dates, the phase it's marked at on the
  // board, and the next phase change still to come.
  const plan = j => {
    const seg = j.segs.find(x => today >= x.from && today <= x.to);
    const expected = seg ? seg.key : today < j.start ? '' : j.segs.at(-1).key;
    const marked = stageOf(j.p);
    const order = stagesFor(j.p).map(([k]) => k);
    const behind = !!expected && order.indexOf(marked) < order.indexOf(expected);
    const next = j.segs.find(x => x.from > today);
    return { expected, marked, behind, next, late: today > j.end };
  };
  const shortDate = date => new Date(date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  if (calView === 'timeline') return showTimeline({ year, mon, today, jobs, plan, shortDate, monthLink });

  let cells = '';
  const day = new Date(year, mon - 1, 1);
  day.setDate(1 - day.getDay());   // back up to the Sunday that starts the first week
  do {
    const week = Array.from({ length: 7 }, (_, i) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + i));
    // Jobs keep the same row all week so their bars line up from day to day.
    const active = jobs.filter(j => j.start <= ymd(week[6]) && j.end >= ymd(week[0]));
    for (const d of week) {
      const key = ymd(d);
      cells += `<div class="day ${d.getMonth() === mon - 1 ? '' : 'other'} ${key === today ? 'today' : ''}"><span class="num">${d.getDate()}</span>${active.map(j => {
        if (key < j.start || key > j.end) return '<span class="bar gap"></span>';
        const seg = j.segs.find(x => key >= x.from && key <= x.to);
        const named = key === seg.from || d.getDay() === 0, due = key === stageDue(j.p, seg.key) || key === j.p.data.due_date;
        const text = key === seg.from && key !== j.start ? `\u25b8 ${STAGE_NAME[seg.key]} starts \u00b7 ${projectName(j.p)}` : named ? `${projectName(j.p)} \u00b7 ${STAGE_NAME[seg.key]}${due ? ' (due)' : ''}` : due ? 'Due' : '';
        const turn = key === seg.from && key !== j.start;
        return `<a class="bar st-${seg.key} ${seg.past ? 'past' : ''} ${named ? 'label' : ''} ${turn ? 'turn' : ''} ${key === j.start ? 's' : ''} ${key === j.end ? 'e' : ''}" href="#/p/${j.p.id}"
          title="${esc(projectName(j.p))} \u2013 ${esc(isClient(j.p) ? j.p.data.client_name || STREAM_NAME.client : STREAM_NAME[streamOf(j.p)])}">${esc(text)}</a>`;
      }).join('')}</div>`;
    }
    day.setDate(day.getDate() + 7);
  } while (day.getMonth() === mon - 1 && day.getFullYear() === year);

  const daysLeft = due => Math.round((+new Date(due + 'T00:00') - +new Date(today + 'T00:00')) / 86400000);
  const dueText = (j, due) => {
    if (!due) return `<a href="#/p/${j.p.id}/dates">Set a date</a>`;
    const n = daysLeft(due);
    return `${esc(fmtDate(due))} <span class="${n < 0 ? 'late' : 'muted'}">(${n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'} left`})</span>`;
  };
  view.innerHTML = `
    <div class="pagehead">
      <h1>${new Date(year, mon - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1><span class="spacer"></span>
      ${calHeadButtons(monthLink)}
    </div>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(n => `<div class="dow">${n}</div>`).join('')}${cells}</div>
    <div class="legend">${calLegend(jobs)}</div>
    <div class="card" style="margin-top:16px"><h2>Scheduled projects</h2>
      ${jobs.length ? `<table class="list"><tr><th>Project</th><th>Client or stream</th><th>Should be in</th><th>Marked</th><th>Phase due</th><th>Target completion</th></tr>
        ${jobs.map(j => `<tr><td><span class="swatch st-${plan(j).expected || stageOf(j.p)}"></span><a href="#/p/${j.p.id}">${esc(projectName(j.p))}</a></td>
          <td>${isClient(j.p) ? esc(j.p.data.client_name) : STREAM_NAME[streamOf(j.p)]}</td><td>${shouldBe(plan(j))}</td><td>${STAGE_NAME[stageOf(j.p)]}</td><td>${dueText(j, stageDue(j.p, stageOf(j.p)))}</td><td>${dueText(j, j.p.data.due_date)}</td></tr>`).join('')}</table>`
        : '<p class="muted" style="margin:0">Nothing is scheduled. A project appears here once its quote is marked accepted (or work starts on a product or gallery piece), from that day to its target completion date.</p>'}
    </div>`;
}

// The calendar opens on the timeline (one row per project) unless Month was picked last time.
let calView = (() => { try { return localStorage.getItem('calView') || 'timeline'; } catch { return 'timeline'; } })();
document.addEventListener('click', e => {
  if ((e.target as Element).closest('[data-caltoday]')) { tlScrollDate = ''; if (currentHash === '#/calendar') route(); }
  const b = (e.target as Element).closest('[data-calview]') as HTMLElement | null;
  if (!b) return;
  calView = b.dataset.calview;
  try { localStorage.setItem('calView', calView); } catch {}
  route();
});
const calHeadButtons = monthLink => `
      <span class="seg" role="group" aria-label="Calendar view">
        <button type="button" class="${calView === 'timeline' ? 'on' : ''}" data-calview="timeline">Timeline</button><button type="button" class="${calView === 'month' ? 'on' : ''}" data-calview="month">Month</button>
      </span>
      ${monthLink ? `<a class="btn" href="${monthLink(-1)}" aria-label="Previous month">&larr;</a>` : ''}
      <a class="btn" href="#/calendar" data-caltoday>Today</a>
      ${monthLink ? `<a class="btn" href="${monthLink(1)}" aria-label="Next month">&rarr;</a>` : ''}`;
// The calendar's color key: the client phases, plus the product line's when a product run is on it.
const calLegend = jobs => [...STAGES.map(([key, name]) => key === 'build' && jobs.some(j => isProduct(j.p)) ? [key, 'Build / Building'] : [key, name]), ...(jobs.some(j => isProduct(j.p)) ? PRODUCT_STAGES.filter(([key]) => key === 'packaging') : [])]
  .map(([key, name]) => `<span><span class="swatch st-${key}"></span>${name}</span>`).join('');
// "Build", or "Build — still marked Design" in red when the board is behind the dates.
const shouldBe = pl => !pl.expected ? '<span class="muted">Not started yet</span>'
  : `<span class="stagechip st-${pl.expected}">${STAGE_NAME[pl.expected]}</span>${pl.late ? ' <span class="late">past target date</span>' : pl.behind ? ` <span class="late">still marked ${STAGE_NAME[pl.marked]}</span>` : ''}`;

// Timeline: each project on its own row across the month, its bar split into one chevron per phase,
// so a phase change shows as a step from one color to the next with the new phase's start date. A
// line marks today, and each row says which phase the project should be in now and what comes next.
// On a phone the timeline isn't cut into months: it runs from the earliest active project's start to
// the furthest-out finish, and you swipe through it, with a little rebound past either end.
const phoneTimeline = () => window.matchMedia('(max-width: 600px)').matches;
let tlScrollDate = '';   // the date at the left edge of the phone timeline, kept when the page redraws
window.matchMedia('(max-width: 600px)').addEventListener('change', () => { if (currentHash.startsWith('#/calendar')) route(); });

function showTimeline({ year, mon, today, jobs: all, plan, shortDate, monthLink }) {
  // Projects with no dates yet get a short "Needs dates" list under the timeline instead of a one-day bar.
  const undated = all.filter(j => !j.p.data.due_date && !Object.values(j.p.data.stage_due || {}).some(Boolean));
  const jobs = all.filter(j => !undated.includes(j));
  const swipe = phoneTimeline() && jobs.length > 0;
  const addDays = (date, n) => { const d = new Date(date + 'T00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const between = (a, b) => Math.round((+new Date(b + 'T00:00') - +new Date(a + 'T00:00')) / 86400000);
  const first = swipe ? jobs.reduce((m, j) => j.start < m ? j.start : m, jobs[0].start) : ymd(new Date(year, mon - 1, 1));
  const last = swipe ? jobs.reduce((m, j) => j.end > m ? j.end : m, jobs[0].end) : ymd(new Date(year, mon, 0));
  const days = between(first, last) + 1;
  const col = date => between(first, date) + 1;   // column of a date, 1 = first
  const dateAt = n => addDays(first, n - 1);
  const dows = Array.from({ length: days }, (_, i) => new Date(dateAt(i + 1) + 'T00:00').getDay());
  const shown = jobs.filter(j => j.start <= last && j.end >= first);
  const todayCol = today >= first && today <= last ? col(today) : 0;
  const todayLine = todayCol ? `<span class="tl-today" style="left:calc(${todayCol - 1} * 100% / ${days});width:calc(100% / ${days})"></span>` : '';
  const weekends = dows.map((wk, i) => wk % 6 === 0 ? `<span class="tl-wkend" style="grid-column:${i + 1}"></span>` : '').join('');
  const weekLines = dows.map((wk, i) => i > 0 && wk === 0 ? `<span class="tl-wkline" style="grid-column:${i + 1}"></span>` : '').join('');

  const row = j => {
    const pl = plan(j);
    const segs = j.segs.filter(x => x.from <= last && x.to >= first);
    const bars = segs.map(x => {
      const a = x.from < first ? 1 : col(x.from), b = x.to > last ? days : col(x.to);
      const cls = [`st-${x.key}`, x.past ? 'past' : '', x === j.segs[0] && x.from >= first ? 'first' : '', x === j.segs.at(-1) && x.to <= last ? 'last' : '',
        today >= x.from && today <= x.to ? 'now' : ''].join(' ');
      return `<a class="tl-seg ${cls}" href="#/p/${j.p.id}/dates" style="grid-column:${a} / ${b + 1}"
        title="${esc(STAGE_NAME[x.key])}: ${esc(fmtDate(x.from))} \u2013 ${esc(fmtDate(x.to))}"><span>${STAGE_NAME[x.key]}</span></a>`;
    }).join('');
    const marks = segs.filter(x => x !== j.segs[0] && x.from >= first)
      // A label near the end sits to the left of its line so it stays on the page.
      .map(x => { const c = col(x.from), text = `${STAGE_NAME[x.key]} from ${esc(shortDate(x.from).replace(/,.*$/, ''))} ${Number(x.from.slice(8))}`;
        return c > days - 6 ? `<span class="tl-mark end" style="grid-column:${Math.max(1, c - 7)} / ${c}">${text}</span>`
          : `<span class="tl-mark" style="grid-column:${c} / span 7">${text}</span>`; }).join('');
    const nextText = pl.next ? `${STAGE_NAME[pl.next.key]} from ${esc(shortDate(pl.next.from))}`
      : `Due ${esc(shortDate(j.end))}`;
    return `<div class="tl-row">
      <div class="tl-name"><a href="#/p/${j.p.id}/dates">${esc(projectName(j.p))}</a>
        <span class="tl-now">${pl.expected ? 'Now:' : ''} ${shouldBe(pl)} <span class="muted">\u00b7 ${pl.expected || !pl.next ? nextText : `Starts ${esc(shortDate(j.start))}`}</span></span></div>
      <div class="tl-track">${weekends}${weekLines}${bars}${todayLine}</div>
      ${marks ? `<div class="tl-marks">${marks}</div>` : ''}
    </div>`;
  };

  const dayNums = dows.map((wk, i) => `<span class="${i + 1 === todayCol ? 'today' : ''} ${wk % 6 === 0 ? 'wkend' : ''}">${Number(dateAt(i + 1).slice(8))}<small>${'SMTWTFS'[wk]}</small></span>`).join('');
  // Above the days: each week labeled by the date it starts ("Nov 8"), and a "Today" tag over today.
  const weekStarts = dows.map((wk, i) => i === 0 || wk === 0 ? i + 1 : 0).filter(Boolean);
  const weekLabels = weekStarts.map((n, i) => {
    const end = weekStarts[i + 1] || days + 1, date = new Date(dateAt(n) + 'T00:00');   // a stub of a week just gets the number
    return `<span style="grid-column:${n} / ${end}">${end - n < 3 ? date.getDate() : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`;
  }).join('');
  const todayTag = todayCol ? `<span class="tl-todaytag" style="left:calc(${todayCol - 0.5} * 100% / ${days})">Today</span>` : '';
  const monthTitle = date => new Date(date + 'T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  view.innerHTML = `
    <div class="pagehead">
      <h1 id="tlTitle">${monthTitle(swipe ? (todayCol ? today : first) : first)}</h1><span class="spacer"></span>
      ${swipe ? calHeadButtons(null) : calHeadButtons(monthLink)}
    </div>
    <div class="tl card ${swipe ? 'swipe' : ''}">
      <div class="tl-scroll"><div class="tl-canvas">
      <div class="tl-head">${todayTag}<div class="tl-weeks">${weekLabels}</div>
      <div class="tl-days">${dayNums}</div></div>
      ${shown.length ? shown.map(row).join('') : '<p class="muted" style="margin:12px 0 0">Nothing is scheduled this month. A project appears once its quote is accepted (or work starts on a product or gallery piece), from that day to its target completion date.</p>'}
      </div></div>
    </div>
    <div class="legend">${calLegend(jobs)}<span><span class="swatch tl-todaykey"></span>Today</span></div>
    ${undated.length ? `<div class="card needdates"><h2>Needs dates <span class="muted">${undated.length}</span></h2>
      <p class="muted">Under way, but with no phase or delivery dates yet, so they can't go on the timeline.</p>
      <ul>${undated.map(j => `<li><span><b>${esc(projectName(j.p))}</b> <span class="muted">${isClient(j.p) ? esc(j.p.data.client_name || j.p.quote_number) : STREAM_NAME[streamOf(j.p)]} &middot; ${STAGE_NAME[stageOf(j.p)]}</span></span>
        <a class="btn small" href="#/p/${j.p.id}/dates">Set dates</a></li>`).join('')}</ul></div>` : ''}`;
  view.querySelector('.tl-canvas').style.setProperty('--days', days);
  if (swipe) swipeTimeline({ days, first, dateAt, col, todayCol, monthTitle });
}

// Sizes the phone timeline so about a month shows at once, starts it at today (or where it was before
// the page redrew), keeps the title on the month in view, and adds the rebound at the ends.
function swipeTimeline({ days, first, dateAt, col, todayCol, monthTitle }) {
  const scroller = view.querySelector('.tl-scroll'), canvas = view.querySelector('.tl-canvas'), title = $('#tlTitle');
  const width = scroller.clientWidth, dayPx = width / 30;
  canvas.style.width = `${Math.max(width, days * dayPx)}px`;
  canvas.style.setProperty('--view', `${width}px`);
  const max = () => scroller.scrollWidth - scroller.clientWidth;
  const saved = tlScrollDate && tlScrollDate >= first ? col(tlScrollDate) : 0;
  scroller.scrollLeft = saved ? (saved - 1) * dayPx : todayCol ? (todayCol - 1) * dayPx - width / 3 : 0;
  const onScroll = () => {
    const leftCol = Math.min(days, Math.max(1, Math.round(scroller.scrollLeft / dayPx) + 1));
    tlScrollDate = dateAt(leftCol);
    title.textContent = monthTitle(dateAt(Math.min(days, leftCol + 15)));
  };
  onScroll();

  // Pulling past an end stretches the timeline a little (less the further you pull), and it springs
  // back when you let go. A fling that runs into an end gets a small bump instead.
  let x0 = 0, y0 = 0, s0 = 0, pull = 0, touching = false, edge = scroller.scrollLeft <= 0 ? 'l' : scroller.scrollLeft >= max() - 1 ? 'r' : '';
  const stretch = px => { canvas.style.transform = px ? `translateX(${px}px)` : ''; };
  scroller.addEventListener('touchstart', e => {
    touching = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; s0 = scroller.scrollLeft; pull = 0;
    canvas.style.transition = 'none';
  }, { passive: true });
  scroller.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - x0;
    if (Math.abs(dx) < Math.abs(e.touches[0].clientY - y0)) return;   // scrolling the page up or down
    const want = s0 - dx, over = want < 0 ? -want : want > max() ? max() - want : 0;
    pull = Math.sign(over) * Math.min(70, Math.abs(over) * 0.35);
    stretch(pull);
  }, { passive: true });
  const release = () => {
    touching = false;
    if (!pull) return;
    canvas.style.transition = 'transform .45s cubic-bezier(.25, 1.6, .45, 1)';   // overshoots a touch, then settles
    stretch(0); pull = 0;
  };
  scroller.addEventListener('touchend', release);
  scroller.addEventListener('touchcancel', release);
  scroller.addEventListener('scroll', () => {
    onScroll();
    const now = scroller.scrollLeft <= 0 ? 'l' : scroller.scrollLeft >= max() - 1 ? 'r' : '';
    if (now && now !== edge && !touching) {
      canvas.classList.remove('bump-l', 'bump-r');
      void canvas.offsetWidth;   // restart the animation
      canvas.classList.add(`bump-${now}`);
    }
    edge = now;
  }, { passive: true });
}

// ---------- type-ahead dropdowns ----------
// Replaces a <select> with a box you can type in to narrow the choices. The select stays in the
// page, hidden, as the value the form reads, and gets an "input" event when the choice changes.
// While open, the list sits on the page body (so a scrolling table can't clip it), placed in page
// coordinates right under the box. On a phone the keyboard shrinks the visible area without changing
// the layout, so the room around the box is measured against what's actually on screen, and the list
// follows the box when the page scrolls or the keyboard moves things. Scrolling a table closes it.
let comboCount = 0, closeOpenCombo = null, placeOpenCombo = null;
window.addEventListener('scroll', e => {
  if (!closeOpenCombo) return;
  if (e.target === document || e.target === document.documentElement) placeOpenCombo?.();
  else if (!(e.target instanceof Element && e.target.closest('.combo-list'))) closeOpenCombo();
}, true);
window.addEventListener('resize', () => placeOpenCombo?.());
window.visualViewport?.addEventListener('resize', () => placeOpenCombo?.());
window.visualViewport?.addEventListener('scroll', () => placeOpenCombo?.());

function typeAhead(select, minWidth = 0) {
  const id = `combo${++comboCount}`;
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  wrap.innerHTML = `<input type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}" autocomplete="off" spellcheck="false"><ul id="${id}" class="combo-list" role="listbox" hidden></ul>`;
  wrap.style.minWidth = select.style.minWidth;
  select.hidden = true;
  select.before(wrap);
  const input = wrap.firstChild as HTMLInputElement, list = wrap.lastChild as HTMLUListElement;
  const options = [...select.options].map(o => ({ value: o.value, label: o.textContent }));
  const current = () => options.find(o => o.value === select.value) || options[0];
  let shown = [], active = -1;

  const setActive = i => {
    active = i;
    list.querySelectorAll('li[data-i]').forEach((li, n) => li.classList.toggle('active', n === i));
    const li = list.querySelector(`li[data-i="${i}"]`);
    if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const open = query => {
    const q = query.trim().toLowerCase(), words = q.split(/\s+/);
    // A choice matches if it contains every word typed, in any order ("walnut 8/4").
    // Choices that start with what was typed come first.
    const matches = options.filter(o => words.every(word => o.label.toLowerCase().includes(word)));
    const starts = o => o.label.toLowerCase().startsWith(words[0]);
    shown = q ? [...matches.filter(starts), ...matches.filter(o => !starts(o))] : options;
    list.innerHTML = shown.length
      ? shown.map((o, i) => `<li role="option" id="${id}-${i}" data-i="${i}" aria-selected="${o.value === select.value}">${esc(o.label)}</li>`).join('')
      : '<li class="none">No matches</li>';
    if (list.parentNode !== document.body) document.body.append(list);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    closeOpenCombo = close;
    placeOpenCombo = place;
    place();
    setActive(q ? (shown.length ? 0 : -1) : shown.indexOf(current()));
  };
  // Line the list up under the box, or above it when there's more room there, sized to fit on screen.
  const place = () => {
    if (!input.isConnected) return close();
    const vv = window.visualViewport;
    const viewTop = vv ? vv.offsetTop : 0, viewLeft = vv ? vv.offsetLeft : 0;
    const viewHeight = vv ? vv.height : window.innerHeight, viewWidth = vv ? vv.width : window.innerWidth;
    const box = input.getBoundingClientRect(), width = Math.min(Math.max(box.width, minWidth), viewWidth - 16);
    const below = viewTop + viewHeight - box.bottom - 11, above = box.top - viewTop - 11;
    const want = Math.min(list.scrollHeight, 264);
    const flip = below < Math.min(want, 120) && above > below;
    const height = Math.max(Math.min(want, flip ? above : below), 44);
    const left = Math.max(viewLeft + 8, Math.min(box.left, viewLeft + viewWidth - width - 8));
    const top = flip ? box.top - 3 - height : box.bottom + 3;
    Object.assign(list.style, {
      width: `${width}px`,
      maxHeight: `${height}px`,
      left: `${left + window.scrollX}px`,
      top: `${top + window.scrollY}px`,
    });
  };
  const close = () => {
    if (closeOpenCombo === close) closeOpenCombo = placeOpenCombo = null;
    list.hidden = true;
    if (list.parentNode !== wrap) wrap.append(list);
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const pick = option => {
    input.value = option.label;
    close();
    if (option.value === select.value) return;
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
  };

  input.value = current().label;
  input.addEventListener('focus', () => { input.select(); open(''); });
  input.addEventListener('click', () => { if (list.hidden) open(''); });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) open('');
      else if (shown.length) setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!list.hidden && shown[active]) pick(shown[active]);
    } else if (e.key === 'Tab') {
      // Tabbing away after typing takes the highlighted match.
      if (!list.hidden && shown[active] && input.value !== current().label) pick(shown[active]);
    } else if (e.key === 'Escape') {
      input.value = current().label;
      close();
    }
  });
  input.addEventListener('blur', () => { input.value = current().label; close(); });
  list.addEventListener('mousedown', e => {
    e.preventDefault();   // keep focus in the box
    const li = (e.target as Element).closest<HTMLElement>('li[data-i]');
    if (li) pick(shown[li.dataset.i]);
  });
}

// ---------- choosing a stream for a new project ----------
function showNewPicker() {
  view.innerHTML = `<a href="${boardLink()}" class="back">&larr; Projects</a><div class="pagehead"><h1>New project</h1></div>
    <p class="muted">Which kind of project is this?</p>
    <div class="picker">${STREAMS.map(([key, name, about]) => `<a class="card pick" href="#/new/${key}"><b>${name}</b><span class="muted">${about}</span></a>`).join('')}</div>`;
}

// ---------- quote editor / project page ----------
function blankData() {
  const s = store.settings, [length, width, height] = TYPES.dining_table.ref;
  return {
    title: '', client_name: '', client_email: '', client_phone: '', client_state: '', due_date: '', notes: '',
    spec: { type: 'dining_table', description: '', species: (s.species.find(x => x.name === 'Walnut') || s.species[0] || {}).name || '',
      length, width, height, complexity: 'standard', finish: 'hardwax', drawers: 0, doors: 0, shelves: 0, delivery_hours: 0 },
    rates: { hourly_rate: s.hourly_rate, contingency_pct: s.contingency_pct, markup_pct: s.markup_pct, tax_pct: s.tax_pct, deposit_pct: s.deposit_pct },
    phases: [], materials_override: '', other_costs: 0, retainer: s.design_retainer, final_price: '',
  };
}

// Heading and tabs shared by a project's Details and Client quote views.
function projectHeader(p, tab, side) {
  return `<div class="noprint projheadwrap">
    ${backLink(boardLink(), 'Projects')}
    <div class="projhead">
      <div class="name"><h1 id="projTitle">${esc(projectName(p))}</h1><span class="pill ${p.status}" id="statusPill">${STATUS_NAME[p.status]}</span></div>
      <div class="sub">${isClient(p) ? `${esc(p.quote_number)} &middot; ` : ''}${STREAM_NAME[streamOf(p)]}</div>
    </div>
    ${isFrozen(p) ? `<div class="note frozen"><span><b>Frozen since ${esc(fmtDate(p.data.frozen.at))}</b>${p.data.frozen.reason ? `: ${esc(p.data.frozen.reason)}` : ''}.
      It's off the board and calendar until you unfreeze it.</span><button type="button" class="btn small" data-unfreeze="${p.id}">Unfreeze</button></div>` : ''}
    <nav class="tabs projtabs">
      <a href="#/p/${p.id}" class="${tab === 'details' ? 'on' : ''}">Details</a>
      <a href="#/p/${p.id}/todo" class="${tab === 'todo' ? 'on' : ''}">To-do list${todoLeft(p) ? ` <small>${todoLeft(p)}</small>` : ''}</a>
      <a href="#/p/${p.id}/cuts" class="${tab === 'cuts' ? 'on' : ''}">Cut list${cutsLeft(p) ? ` <small title="pieces left to cut">${cutsLeft(p)}</small>` : ''}</a>
      <a href="#/p/${p.id}/design" class="${tab === 'design' ? 'on' : ''}">Design notes</a>
      ${isClient(p) ? `<a href="#/p/${p.id}/quote" class="${tab === 'quote' ? 'on' : ''}">Client quote</a>` : ''}
      <a href="#/p/${p.id}/summary" class="${tab === 'summary' ? 'on' : ''}">Summary</a>
      <span class="spacer"></span><span class="side">${side}</span>
    </nav>
    ${/<button/.test(side) ? `<div class="sidem">${side}</div>` : ''}
  </div>`;
}
const todoLeft = p => (p.data.todo?.items || []).filter(t => !t.done_at).length;
const cutsLeft = p => (p.data.cutlist?.items || []).filter(t => !t.done_at).reduce((n, t) => n + (t.qty || 1), 0);

// ---------- the Now strip ----------
// At the top of a project that's under way: the next status step, the next date it's due, its next few
// to-dos (tick them right there) and quick ways to scan a receipt or add to its shopping list.
// Drafts and quotes waiting on an answer don't get one: the quote itself is what's being worked on then.
const showsNow = p => !archived(p) && !(isClient(p) && ['draft', 'sent'].includes(p.status));
const nextStepOf = p => p.status === 'in_progress' && isProduct(p) ? ['complete', 'Mark shipped'] : (isClient(p) ? NEXT_STEP : OWN_NEXT_STEP)[p.status];
// The next date coming up: the current phase's due date, else the next phase that has one.
function nextDue(p) {
  const stages = stagesFor(p), i = Math.max(0, stageIndex(p));
  for (const [key] of stages.slice(i)) {
    const due = stageDue(p, key);
    if (due) return { key, due, last: key === lastPhase(p) };
  }
  return null;
}
let focusShopping = false;   // the to-do tab opens with the shopping list's add box ready
function renderNow(p) {
  const el = $('#nowStrip');
  if (!el) return;
  if (!showsNow(p)) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const today = ymd(new Date()), next = nextStepOf(p), due = nextDue(p);
  const left = due ? Math.round((+new Date(due.due + 'T00:00') - +new Date(today + 'T00:00')) / 86400000) : 0;
  const dueLabel = due ? (due.last ? (isProduct(p) ? 'Ship by' : 'Delivery due') : `${STAGE_NAME[due.key]} due`) : '';
  const open = (p.data.todo?.items || []).filter(t => !t.done_at), firstFew = open.slice(0, 3);
  el.innerHTML = `<div class="card now">
    <div class="nowtop">
      <div class="nowdue ${due ? left < 0 ? 'late' : left <= 7 ? 'soon' : '' : ''}">${due
        ? `<span class="muted">${dueLabel}</span><b>${esc(new Date(due.due + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</b>
           <span>${left < 0 ? `${-left} day${left === -1 ? '' : 's'} late` : left === 0 ? 'today' : `${left} day${left === 1 ? '' : 's'} left`}</span>`
        : `<span class="muted">No due dates yet</span><button type="button" class="link" data-setdates>Set dates</button>`}</div>
      <div class="actions">${next ? `<button type="button" class="btn primary" data-status="${next[0]}">${next[1]}</button>` : ''}
        ${isFrozen(p) ? '' : `<button type="button" class="btn" data-freeze="${p.id}">Freeze</button>`}</div>
    </div>
    ${firstFew.length ? `<ul class="tasks nowtasks">${firstFew.map(t => `<li class="task" data-id="${esc(t.id)}">
      <input type="checkbox" aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span></li>`).join('')}</ul>` : '<p class="muted nownone">Nothing left on the to-do list.</p>'}
    <div class="nowlinks">
      <a href="#/p/${p.id}/todo">${open.length > firstFew.length ? `All ${open.length} to-dos` : 'To-do list'} &rarr;</a>
      <span class="spacer"></span>
      <a class="btn small" href="#/receipt/${p.id}">Scan a receipt</a>
      <a class="btn small" href="#/p/${p.id}/todo" data-addshop>Add to shopping list</a>
    </div>
  </div>`;
  el.querySelector('[data-status]')?.addEventListener('click', e => setStatus(p, (e.currentTarget as HTMLElement).dataset.status));
  el.querySelector('[data-addshop]')?.addEventListener('click', () => { focusShopping = true; });
  el.querySelector('[data-setdates]')?.addEventListener('click', () => openPhaseDates());
  (el.querySelectorAll("li.task") as NodeListOf<HTMLElement>).forEach(li => li.addEventListener('click', e => {
    e.preventDefault();
    const t = p.data.todo.items.find(x => x.id === li.dataset.id);
    if (!t) return;
    t.done_at = new Date().toISOString();
    todoChanged(p, { what: 'done', text: t.text, list: 'items' });
    li.classList.add('done');
    (li.querySelector('input') as HTMLInputElement).checked = true;
    setTimeout(() => renderNow(p), 450);   // a moment to see it ticked before the next one moves up
    toast(`Done: ${t.text}`);
  }));
}
// Opens the phase dates (folded away on a phone) and brings them into view.
function openPhaseDates() {
  phaseDatesOpen = true;
  const d = $('#stages details') as HTMLDetailsElement | null;
  if (d) d.open = true;
  const el = $('#stages');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

function showEditor(project, newStream = 'client') {
  const stream = project ? streamOf(project) : newStream, client = stream === 'client';
  ed = { project, stream, data: project ? project.data : blankData(), dirty: false };
  const d = ed.data;
  d.lumber ??= { bf: '', quarters: '', width: '' };
  const inp = (label, path, type = 'text', cls = '', attrs = '') =>
    `<label class="f ${cls}"><span>${label}</span><input data-path="${path}" type="${type}" value="${esc(getPath(d, path) ?? '')}" ${attrs}></label>`;
  const numInp = (label, path, step: number | string = 'any', cls = '', attrs = '') => inp(label, path, 'number', cls, `min="0" step="${step}" ${attrs}`);
  const sel = (label, path, options, cls = '') =>
    `<label class="f ${cls}"><span>${label}</span><select data-path="${path}">${options.map(([v, n]) =>
      `<option value="${esc(v)}" ${getPath(d, path) === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
  const speciesNames = store.settings.species.map(s => s.name);
  if (d.spec.species && !speciesNames.includes(d.spec.species)) speciesNames.push(d.spec.species);
  // Once a job is accepted (or a piece of your own is started) the quote form folds up, so the page leads
  // with what's needed day to day. It opens with a tap, and stays open for that project until you leave.
  const foldable = !!project && (client ? !['draft', 'sent'].includes(project.status) : project.status !== 'planned');
  const folded = foldable && !quoteOpen.has(project.id);

  view.innerHTML = `
    ${project ? projectHeader(project, 'details', '<span class="muted">Changes save automatically</span>')
      : `<a href="${boardLink()}" class="back">&larr; Projects</a><div class="pagehead"><h1>${client ? 'New quote' : `New ${STREAM_NAME[stream].toLowerCase()} piece`}</h1>
        <span class="spacer"></span><a href="#/new">Change kind of project</a></div>`}
    ${project ? '<div id="nowStrip" hidden></div><div class="stages" id="stages" role="group" aria-label="Project phase"></div>' : ''}
    <div class="cols ${folded ? 'folded' : ''}" id="cols">
      <form class="card" id="form" autocomplete="off">
        ${foldable ? `<button type="button" class="foldbar" id="foldBar" aria-expanded="${!folded}" aria-controls="form">
          <span><b>${client ? 'Quote details' : 'Piece details'}</b><span class="muted" id="foldSum"></span></span><span class="foldword">${folded ? 'Show' : 'Hide'}</span></button>` : ''}
        ${client ? `<fieldset><h2>Client</h2><div class="grid">
          ${inp('Name', 'client_name')}${inp('Email', 'client_email', 'email')}${inp('Phone', 'client_phone', 'tel')}
          ${sel('State (sets the sales tax)', 'client_state', [['', 'Not set'], ...STATES], 'w3')}
        </div></fieldset>` : ''}
        <fieldset><h2>What's being built</h2><div class="grid">
          ${inp('Project name', 'title', 'text', 'w6', 'placeholder="e.g. Live-edge dining table"')}
          ${sel('Furniture type', 'spec.type', Object.entries(TYPES).map(([k, t]) => [k, t.name]), 'w3')}
          ${sel('Wood species', 'spec.species', speciesNames.map(n => [n, n]), 'w3')}
          ${numInp('Length (in)', 'spec.length')}${numInp('Width / depth (in)', 'spec.width')}${numInp('Height (in)', 'spec.height')}
          <label class="f w6"><span>Description${client ? ' (shown on the quote)' : ''}</span><textarea data-path="spec.description">${esc(d.spec.description)}</textarea></label>
        </div></fieldset>
        <fieldset><h2>Build details</h2><div class="grid">
          ${sel('Joinery & complexity', 'spec.complexity', Object.entries(COMPLEXITY).map(([k, c]) => [k, c.name]), 'w3')}
          ${sel('Finish', 'spec.finish', Object.entries(FINISHES).map(([k, f]) => [k, f.name]), 'w3')}
          ${numInp('Drawers', 'spec.drawers', 1)}${numInp('Doors', 'spec.doors', 1)}${numInp('Shelves', 'spec.shelves', 1)}
          ${numInp('Delivery & install (hours)', 'spec.delivery_hours', 0.25, 'w3')}
        </div></fieldset>
        <fieldset><h2>${stream === 'gallery' ? 'Cost' : 'Pricing'}</h2><div class="grid">
          ${numInp('Hourly rate ($)', 'rates.hourly_rate')}${numInp('Contingency (%)', 'rates.contingency_pct')}
          ${stream === 'gallery' ? '' : numInp('Materials markup (%)', 'rates.markup_pct')}
          ${client ? `${numInp('Sales tax (%)', 'rates.tax_pct')}${numInp('Deposit (%)', 'rates.deposit_pct')}` : ''}${numInp('Hardware & other costs ($)', 'other_costs')}
          ${client ? numInp('Design retainer ($)', 'retainer', 'any', 'w3') : ''}
          ${numInp('Lumber cost override ($)', 'materials_override', 'any', 'w3', 'id="override"')}
          ${stream === 'gallery' ? '' : `${numInp(client ? 'Agreed final price ($, with tax)' : 'Retail price ($)', 'final_price', 'any', 'w3', 'id="finalPrice"')}
          <p class="muted" style="grid-column:1/-1;margin:0;font-size:13px">${client
            ? 'Leave blank to use the estimate. Once you and the client agree on a price, enter it here: it becomes the quote total everywhere, including the client quote, deposit and the totals on the board.'
            : 'Leave blank to use the suggested retail price.'}</p>`}
        </div></fieldset>
        <fieldset><h2>Notes</h2><div class="grid">
          <label class="f w6"><span>${client ? 'Internal notes (not shown on the quote)' : 'Notes'}</span><textarea data-path="notes">${esc(d.notes)}</textarea></label>
        </div></fieldset>
      </form>
      <aside>
        <div class="card" id="panel"></div>
        <div class="card" id="lumberCard">
          <h2>Lumber pickup</h2>
          <div class="grid">
            <label class="f"><span>Board feet needed</span><input type="number" min="0" step="any" data-lumber="bf" value="${esc(d.lumber.bf)}"></label>
            <label class="f"><span>Board thickness</span><select data-lumber="quarters">
              ${[4, 5, 6, 8, 10, 12, 16].map(q => `<option value="${q}" ${q === lumberNeeds(d, 0).quarters ? 'selected' : ''}>${q}/4 (${q / 4}")</option>`).join('')}</select></label>
            <label class="f"><span>Board width (in)</span><input type="number" min="0" step="any" data-lumber="width" value="${esc(d.lumber.width)}"></label>
          </div>
          <p id="lumberOut" style="margin:12px 0 0"></p>
          ${project ? `<div class="shopmini"><h3>Shopping list</h3><ul class="tasks" id="shopMini"></ul>
            <form class="addtask" id="shopAdd" autocomplete="off"><input placeholder="Add something to buy" aria-label="Add to this project's shopping list"><button class="btn small">Add</button></form>
            <p class="muted hint">Also on the To-do list tab and the Shopping list for every project.</p></div>` : ''}
        </div>
        ${project ? '<div class="card" id="purchasesCard"></div><div class="card" id="statusCard"></div>' : ''}
        ${project ? '<p class="noprint" style="text-align:right"><button class="link" id="delete" style="color:var(--bad)">Delete this project</button></p>' : ''}
      </aside>
    </div>`;

  const form = $('#form');
  form.querySelectorAll('select').forEach(typeAhead);
  form.addEventListener('submit', e => e.preventDefault());
  form.addEventListener('input', e => {
    const el = e.target;
    if (!el.dataset.path) return;
    if (el.dataset.path === 'client_state') {
      // Choosing the client's state applies that state's sales tax; the rate can still be adjusted below.
      d.rates.tax_pct = pos(el.value ? store.settings.state_tax[el.value] : store.settings.tax_pct);
      $('[data-path="rates.tax_pct"]', form).value = d.rates.tax_pct;
    }
    if (el.dataset.path === 'spec.type') {
      // Swap in the new type's typical size unless the dimensions were customised.
      const oldRef = TYPES[d.spec.type].ref, newRef = TYPES[el.value].ref;
      if (['length', 'width', 'height'].every((k, i) => num(d.spec[k]) === oldRef[i])) {
        ['length', 'width', 'height'].forEach((k, i) => { d.spec[k] = newRef[i]; $(`[data-path="spec.${k}"]`, form).value = newRef[i]; });
      }
    }
    setPath(d, el.dataset.path, inputValue(el));
    changed();
  });

  const panel = $('#panel');
  panel.addEventListener('change', e => {
    const el = e.target, phase = d.phases[el.dataset.i];
    if (!phase) return;
    if (el.dataset.k === 'name') phase.name = el.value;
    else {
      phase.hours = pos(el.value);
      if (!phase.custom) phase.manual = phase.hours !== phase.est_hours;
    }
    // Re-render after focus has moved, then put focus back where the user went.
    setTimeout(() => {
      const focusId = (document.activeElement as HTMLElement)?.dataset?.fid;
      changed();
      if (focusId) $(`[data-fid="${focusId}"]`, panel)?.focus();
    });
  });
  panel.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (el.dataset.act === 'reset') d.phases[i].manual = false;
    else if (el.dataset.act === 'remove') d.phases.splice(i, 1);
    else if (el.dataset.act === 'add') d.phases.push({ key: `custom-${Date.now()}`, name: '', hours: 1, custom: true });
    else if (el.dataset.act === 'create') return createProject();
    changed();
    if (el.dataset.act === 'add') $(`[data-fid="n${d.phases.length - 1}"]`, panel)?.focus();
  });

  $('#lumberCard').addEventListener('input', e => {
    if (!e.target.dataset.lumber) return;
    d.lumber[e.target.dataset.lumber] = inputValue(e.target);
    changed();
  });
  if (project) {
    $('#delete').addEventListener('click', () => {
      const what = isClient(project) ? `${project.quote_number} (${projectName(project)})` : projectName(project);
      if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
      store.projects = store.projects.filter(p => p !== project);
      persist();
      location.hash = boardLink();
    });
    renderStages();
    renderStatusCard();
    $('#foldBar')?.addEventListener('click', () => {
      const open = $('#cols').classList.toggle('folded') === false;
      if (open) quoteOpen.add(project.id); else quoteOpen.delete(project.id);
      $('#foldBar').setAttribute('aria-expanded', String(open));
      $('#foldBar .foldword').textContent = open ? 'Hide' : 'Show';
    });
    const shopForm = $('#shopAdd');
    shopForm.addEventListener('submit', e => {
      e.preventDefault();
      const input = shopForm.querySelector('input'), text = input.value.trim();
      if (!text) return;
      project.data.todo ??= defaultTodo(project);
      project.data.todo.lumber.push(newTask(text));
      todoChanged(project, { what: 'added', text, list: 'lumber' });
      input.value = '';
      renderShopMini(project);
    });
    $('#shopMini').addEventListener('click', e => {
      const li = (e.target as Element).closest<HTMLElement>('li.task'), t = li && project.data.todo?.lumber.find(x => x.id === li.dataset.id);
      if (!t) return;
      if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
      t.done_at = t.done_at ? null : new Date().toISOString();
      if (t.done_at) delete t.auto;
      todoChanged(project, { what: t.done_at ? 'done' : 'undone', text: t.text, list: 'lumber' });
      renderShopMini(project);
    });
  }
  renderPanel();
  if (project) { renderPurchasesCard(project); renderNow(project); }
}
const quoteOpen = new Set();   // projects whose folded quote form was opened

// The project's own shopping list, under the lumber calculator: what's left to buy, plus what was bought this week.
function renderShopMini(p) {
  const ul = $('#shopMini');
  if (!ul) return;
  const since = new Date(Date.now() - SHOPPING_KEEP_DAYS * 86400000).toISOString();
  const lumber = p.data.todo?.lumber || [];
  for (const t of lumber) if (t.auto && !t.done_at) t.text = lumberLine(p);
  const shown = lumber.filter(t => !t.done_at || t.done_at >= since);
  ul.innerHTML = shown.map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
      <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span>
      ${t.done_at ? `<span class="when">Bought ${esc(fmtDate(t.done_at))}</span>` : ''}</li>`).join('')
    || '<li class="none muted">Nothing to buy.</li>';
}

function changed() {
  ed.dirty = true;
  renderPanel();
  if (ed.project) {
    $('#projTitle').textContent = projectName(ed.project);
    ed.project.updated_at = new Date().toISOString();
    persist();
  }
}

function renderPanel() {
  const d = ed.data, stream = ed.stream, calc = price(d, stream);
  if (ed.project) ed.project.calc = calc;
  const override = $('#override');
  if (override) override.placeholder = `Estimate: ${money(calc.materials_est)}`;
  const finalPrice = $('#finalPrice');
  if (finalPrice) finalPrice.placeholder = `Estimate: ${money(calc.estimate_total)}`;
  const estLine = calc.agreed ? `<div class="tot"><span class="muted">Estimate <small>from pricing and time</small></span><span class="muted">${money(calc.estimate_total)}</span></div>` : '';
  const overridden = !(d.materials_override === '' || d.materials_override == null);
  $('#panel').innerHTML = `
    <h2>Labor estimate</h2>
    ${d.phases.map((p, i) => `<div class="ph">
      ${p.custom ? `<input data-i="${i}" data-k="name" data-fid="n${i}" value="${esc(p.name)}" placeholder="Task name" aria-label="Task name">` : `<span>${esc(p.name)}</span>`}
      <input type="number" min="0" step="0.25" data-i="${i}" data-k="hours" data-fid="h${i}" value="${p.hours}" aria-label="${esc(p.name || 'Task')} hours">
      <span class="hint">${p.custom ? `<button type="button" class="link" data-act="remove" data-i="${i}">remove</button>`
        : p.manual ? `est. ${p.est_hours} &middot; <button type="button" class="link" data-act="reset" data-i="${i}">reset</button>` : 'estimated'}</span>
    </div>`).join('')}
    <button type="button" class="link" data-act="add">+ Add a task</button>
    <hr class="rule">
    <div class="tot"><span>Labor</span><span>${hrs(calc.labor_hours)}</span></div>
    <div class="tot"><span>Contingency <small>${+pos(d.rates.contingency_pct)}%</small></span><span>+ ${hrs(calc.contingency_hours)}</span></div>
    <div class="tot"><span>Labor cost <small>${hrs(calc.labor_hours + calc.contingency_hours)} @ ${money(pos(d.rates.hourly_rate))}/h</small></span><b>${money(calc.labor_cost)}</b></div>
    <div class="tot"><span>Materials <small>${overridden ? 'your lumber cost' : `${calc.lumber.feet ? `${calc.lumber.boards} \u00d7 ${BOARD_LENGTH_FT} ft boards, ` : '~'}${+calc.lumber.buyBf} bf ${esc(d.spec.species)}`}${stream === 'gallery' ? '' : ` + ${+pos(d.rates.markup_pct)}% markup`}</small></span><b>${money(calc.materials_cost)}</b></div>
    ${calc.other_costs ? `<div class="tot"><span>Hardware & other</span><b>${money(calc.other_costs)}</b></div>` : ''}
    ${calc.tax && !calc.agreed ? `<div class="tot"><span>Sales tax <small>${d.client_state ? `${esc(d.client_state)} ` : ''}${+pos(d.rates.tax_pct)}%</small></span><b>${money(calc.tax)}</b></div>` : ''}
    ${stream === 'gallery' ? `<div class="tot grand"><span>Total cost</span><span>${money(calc.cost)}</span></div>`
      : stream === 'product' ? `${estLine}<div class="tot grand"><span>${calc.agreed ? 'Retail price' : 'Suggested retail price'}</span><span>${money(calc.total)}</span></div>
        <div class="tot"><span class="muted">Cost to make <small>time, lumber and hardware</small></span><span class="muted">${money(calc.cost)}</span></div>`
      : `${estLine}<div class="tot grand"><span>${calc.agreed ? 'Agreed price' : 'Quote total'}</span><span>${money(calc.total)}</span></div>
        ${calc.agreed && calc.tax ? `<div class="tot"><span class="muted">Includes sales tax <small>${+pos(d.rates.tax_pct)}%</small></span><span class="muted">${money(calc.tax)}</span></div>` : ''}`}
    ${calc.retainer ? `<div class="tot"><span>Design retainer <small>already paid</small></span><span>&minus; ${money(calc.retainer)}</span></div>
    <div class="tot"><b>Balance due</b><b>${money(calc.balance)}</b></div>` : ''}
    ${stream === 'client' ? `<div class="tot"><span class="muted">Deposit <small>${+pos(d.rates.deposit_pct)}%${calc.retainer ? ' of balance' : ''}</small></span><span class="muted">${money(calc.deposit)}</span></div>` : ''}
    ${ed.project ? '' : `<hr class="rule"><button type="button" class="btn primary" data-act="create" style="width:100%">${stream === 'client' ? 'Save quote' : 'Save project'}</button>`}`;
  renderLumber(calc);
}

// ---------- lumber pickup: board feet to linear feet ----------
// A board foot is 1" thick x 12" wide x 1 ft long, so linear feet = board feet x 12 / (thickness x width).
// The yard sells whole boards, so linear feet are rounded up to full board lengths.
const BOARD_LENGTH_FT = 10;

function lumberNeeds(data, estimatedBf) {
  const l = data.lumber || {};
  const bf = l.bf === '' || l.bf == null ? estimatedBf : pos(l.bf);
  // Until a thickness is chosen, assume the one the species' linked supplier item is sold in.
  const linked = feed?.items.find(i => i.id === findSpecies(data.spec.species).source);
  const quarters = pos(l.quarters) || parseInt(linked?.size) || 4;
  const width = pos(l.width);
  if (!width) return { bf, quarters, width, feet: 0, boards: 0, buyBf: bf };
  const exactFeet = bf * 12 / (quarters / 4 * width);
  const boards = Math.ceil(exactFeet / BOARD_LENGTH_FT - 1e-9), feet = boards * BOARD_LENGTH_FT;
  return { bf, quarters, width, exactFeet, feet, boards, buyBf: Math.round(feet * (quarters / 4) * width / 12 * 10) / 10 };
}

const lumberSummary = (data, n) =>
  `${n.feet} linear ft of ${n.quarters}/4 ${data.spec.species || 'lumber'}, ${+n.width}" wide (${n.boards} \u00d7 ${BOARD_LENGTH_FT} ft board${n.boards === 1 ? '' : 's'})`;

function renderLumber(calc) {
  const d = ed.data, n = calc.lumber;
  const sum = $('#foldSum');
  if (sum) sum.textContent = [TYPES[d.spec.type]?.name, d.spec.species, [d.spec.length, d.spec.width, d.spec.height].every(x => num(x)) ? `${+d.spec.length} \u00d7 ${+d.spec.width} \u00d7 ${+d.spec.height} in` : '',
    `${ed.stream === 'gallery' ? 'cost' : calc.agreed ? 'agreed' : ed.stream === 'client' ? 'quote' : 'retail'} ${money(ed.stream === 'gallery' ? calc.cost : calc.total)}`].filter(Boolean).join(' \u00b7 ');
  if (ed.project) renderShopMini(ed.project);
  $('[data-lumber="bf"]').placeholder = `Estimate: ${calc.board_feet}`;
  $('[data-lumber="quarters"]').value = n.quarters;
  $('#lumberOut').innerHTML = n.feet
    ? `<b>About ${esc(lumberSummary(d, n))}</b><br><span class="muted" style="font-size:13px">${+n.bf} board feet &times; 12 &divide; (${n.quarters / 4}" &times; ${+n.width}") = ${+n.exactFeet.toFixed(1)} ft,
        rounded up to full ${BOARD_LENGTH_FT} ft boards. That is ${+n.buyBf} board feet to buy, which the materials cost above is based on.</span>`
    : `<span class="muted">Enter the width of the boards available to see how many linear feet to buy, in full ${BOARD_LENGTH_FT} ft boards.</span>`;
}

async function createProject() {
  if (ed.creating) return;
  const stamp = new Date().toISOString(), stream = ed.stream, status = stream === 'client' ? 'draft' : 'planned';
  if (stream !== 'client') Object.assign(ed.data, { client_name: '', client_email: '', client_phone: '', client_state: '', retainer: 0 });
  const draft = {
    stream, status,
    stage: stream === 'product' ? 'building' : 'ideation', data: ed.data, calc: price(ed.data, stream), history: [{ status, at: stamp }], created_at: stamp, updated_at: stamp,
  };
  // Every project gets its to-do list the moment it is created.
  draft.data.todo = defaultTodo(draft);
  // The server gives the project its id and quote number.
  let project;
  ed.creating = true;
  try { project = await api('/api/projects', draft); }
  catch (e) { ed.creating = false; return toast(`Not saved: ${e.message}`); }
  store.projects.push(project);
  saved.projects.set(project.id, JSON.stringify(project, unbusy));
  ed.dirty = false;
  toast(stream === 'client' ? `Saved as ${project.quote_number}` : 'Project saved');
  location.hash = `#/p/${project.id}`;
}

function renderStatusCard() {
  const p = ed.project, client = isClient(p);
  // A product run is finished when it ships, so its last step says so (and moves it to the Shipped phase).
  const next = nextStepOf(p);
  $('#statusPill').className = `pill ${p.status}`;
  $('#statusPill').textContent = STATUS_NAME[p.status];
  const card = $('#statusCard');
  card.innerHTML = `
    <h2>Status</h2>
    <div class="actions">
      ${next ? `<button class="btn primary" data-status="${next[0]}">${next[1]}</button>` : ''}
      ${p.status === 'sent' ? '<button class="btn danger" data-status="declined">Declined</button>' : ''}
      <select id="statusSelect" style="width:auto" aria-label="Change status">
        ${statusesFor(streamOf(p)).map(([k, n]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>
    <div class="actions" style="margin-top:10px">${isFrozen(p)
      ? `<button class="btn" data-unfreeze="${p.id}">Unfreeze</button><span class="muted" style="font-size:13px">Frozen since ${esc(fmtDate(p.data.frozen.at))}</span>`
      : archived(p) ? '' : `<button class="btn" data-freeze="${p.id}">Freeze project</button><span class="muted" style="font-size:13px">For a client who's gone quiet, or a long delay</span>`}</div>
    <label class="f" style="margin-top:12px"><span>Kind of project</span><select id="streamSelect">
      ${STREAMS.map(([k, n]) => `<option value="${k}" ${k === streamOf(p) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <ul class="history">${p.history.map(h => `<li><span>${'frozen' in h ? (h.frozen ? `Frozen${h.note ? `: ${esc(h.note)}` : ''}` : 'Unfrozen') : h.stage ? `Phase: ${STAGE_NAME[h.stage]}` : STATUS_NAME[h.status]}</span><span>${esc(fmtDate(h.at))}</span></li>`).join('')}</ul>`;
  card.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', () => setStatus(p, b.dataset.status)));
  renderNow(p);
  $('#statusSelect').addEventListener('change', e => setStatus(p, e.target.value));
  $('#streamSelect').addEventListener('change', e => setStream(p, e.target.value));
}

// Moves a project to another stream, carrying its status over to the nearest one that stream has.
// Its phase carries over the same way, unless a board drop names the phase it lands in.
function setStream(p, stream, stage = '') {
  if (stream === streamOf(p)) return;
  const status = STATUS_IN_STREAM[stream === 'client' ? 'client' : 'own'][p.status] || p.status;
  p.stream = stream;
  const carried = stage || stageOf(p);
  if (carried !== p.stage) { p.stage = carried; p.history.push({ stage: carried, at: new Date().toISOString() }); }
  p.calc = priceProject(p, stream);
  p.updated_at = new Date().toISOString();
  if (status !== p.status) { p.status = status; p.history.push({ status, at: p.updated_at }); }
  // Landing in Shipped closes a product run, and a run moved out of Shipped is open again. A finished
  // piece moved into the product line counts as shipped.
  if (isProduct(p) && !stage && p.status === 'complete') p.stage = 'shipped';
  else if (isProduct(p)) syncShipped(p);
  persist();
  toast(`Moved to ${STREAM_NAME[stream]}`);
  route();
}

const STAGE_SHORT = { ideation: 'Idea', design: 'Design', build: 'Build', finishing: 'Finish', ready: 'Deliver', building: 'Build', packaging: 'Pack', shipped: 'Shipped' };
let phaseDatesOpen = false;

function renderStages() {
  const p = ed.project, current = stageIndex(p), today = ymd(new Date()), stages = stagesFor(p), last = lastPhase(p);
  const undated = key => key === 'ideation' || key === 'shipped';
  const el = $('#stages');
  const late = (key, i) => i === current && stageDue(p, key) && stageDue(p, key) < today;
  // Desktop: one button per phase with its due date under it.
  const grid = stages.map(([key, name], i) => {
    const due = stageDue(p, key);
    return `<div>
      <button type="button" data-stage="${key}" class="${i < current ? 'done' : i === current ? 'on' : ''}" ${i === current ? 'aria-current="step"' : ''}>${i < current ? '&#10003; ' : ''}${name}</button>
      ${undated(key) ? '' : `<label class="due ${late(key, i) ? 'late' : ''}"><span>${late(key, i) ? 'Overdue' : 'Due'}</span>
        <input type="date" data-due="${key}" value="${esc(due)}" aria-label="${name} due date"></label>`}
    </div>`;
  }).join('');
  // Phone: a tap-to-set stepper, then the current phase's due date and delivery, other dates tucked away.
  const dateRow = (key, i, label) => `<label class="pdate ${late(key, i) ? 'late' : ''}"><span>${label}${late(key, i) ? ' <b>Overdue</b>' : ''}</span>
    <input type="date" data-due="${key}" value="${esc(stageDue(p, key))}" aria-label="${STAGE_NAME[key]} due date"></label>`;
  const main = stages.map(([key], i) => ({ key, i })).filter(({ key, i }) => !undated(key) && (i === current || key === last));
  const rest = stages.map(([key], i) => ({ key, i })).filter(({ key }) => !undated(key) && !main.some(m => m.key === key));
  const phone = `<ol class="stepper" style="--steps:${stages.length}">${stages.map(([key, name], i) => `<li class="${i < current ? 'done' : i === current ? 'on' : ''}">
      <button type="button" data-stage="${key}" ${i === current ? 'aria-current="step"' : ''} aria-label="${name}"><span class="dot">${i < current ? '&#10003;' : i + 1}</span><span class="lbl">${STAGE_SHORT[key]}</span></button></li>`).join('')}</ol>
    <div class="pdates">
      ${main.map(({ key, i }) => dateRow(key, i, i === current && key !== last ? `${STAGE_NAME[key]} due` : isProduct(p) ? 'Ship by' : 'Delivery due')).join('')}
      ${rest.length ? `<details ${phaseDatesOpen ? 'open' : ''}><summary>Other phase dates${rest.some(({ key }) => stageDue(p, key)) ? '' : ' (none set)'}</summary>
        ${rest.map(({ key, i }) => dateRow(key, i, STAGE_NAME[key])).join('')}</details>` : ''}
    </div>`;
  el.innerHTML = `<div class="stagegrid" style="--steps:${stages.length}">${grid}</div><div class="phasem">${phone}</div>
    ${phaseDateError.p === p ? `<p class="phase-err" role="alert">${esc(phaseDateError.text)}</p>` : ''}`;
  // Each date box only offers days that keep the phases in order.
  el.querySelectorAll('input[data-due]').forEach(input => {
    const { min, max } = phaseDateBounds(p, input.dataset.due);
    if (min) input.min = min;
    if (max) input.max = max;
  });
  el.querySelector('details')?.addEventListener('toggle', e => { phaseDatesOpen = e.target.open; });
  el.querySelectorAll('button[data-stage]').forEach(b => b.addEventListener('click', () => {
    setStage(p, b.dataset.stage);
    renderStages();
    renderStatusCard();
  }));
  el.querySelectorAll('input').forEach(input => onDatePicked(input, () => {
    const key = input.dataset.due;
    if (!setPhaseDue(p, key, input.value)) { input.value = stageDue(p, key); renderStages(); return; }
    p.updated_at = new Date().toISOString();
    persist();
    renderStages();
    renderNow(p);
    el.dispatchEvent(new Event('phasedate'));
  }));
}

// An iPhone fills an empty date box with today's date, and says it changed, the moment its calendar
// opens. Acting on that straight away (redrawing the box) would close the calendar before a day is
// picked, so on touch screens wait until the calendar is closed and act on the day it ends up on.
const touchScreen = () => window.matchMedia('(pointer: coarse)').matches;
function onDatePicked(input, done) {
  let waiting = false;
  const picked = e => {
    if (!touchScreen() || document.activeElement !== input) return e.type === 'change' && done();
    if (waiting) return;
    waiting = true;
    input.addEventListener('blur', () => { waiting = false; done(); }, { once: true });
  };
  input.addEventListener('change', picked);
  // A phone's Reset button can clear the box without a change event, so listen for that too.
  input.addEventListener('input', picked);
}

// Phase due dates run in order: a phase can't be due before the one ahead of it, or after the one
// that follows. Two phases due the same day is fine.
const datedPhases = p => stagesFor(p).map(([key]) => key).filter(key => key !== 'ideation' && key !== 'shipped');
const dueLabelOf = (p, key) => key === lastPhase(p) ? (isProduct(p) ? 'Ship by' : 'Delivery due') : `${STAGE_NAME[key]} due`;
function phaseDateBounds(p, key) {
  const keys = datedPhases(p), i = keys.indexOf(key);
  const before = keys.slice(0, i).map(k => ({ key: k, due: stageDue(p, k) })).filter(x => x.due);
  const after = keys.slice(i + 1).map(k => ({ key: k, due: stageDue(p, k) })).filter(x => x.due);
  const lo = before.reduce((a, x) => (!a || x.due > a.due ? x : a), null);
  const hi = after.reduce((a, x) => (!a || x.due < a.due ? x : a), null);
  return { min: lo?.due || '', max: hi?.due || '', lo, hi };
}
let phaseDateError = { p: null, text: '' };
// Sets a phase's due date (the last phase's is the project's due date) unless it would put the phases
// out of order. Says why when it won't.
function setPhaseDue(p, key, value) {
  const { lo, hi } = phaseDateBounds(p, key);
  const clash = value && lo && value < lo.due ? `can't be before ${dueLabelOf(p, lo.key)} (${fmtDate(lo.due)})`
    : value && hi && value > hi.due ? `can't be after ${dueLabelOf(p, hi.key)} (${fmtDate(hi.due)})` : '';
  if (clash) {
    phaseDateError = { p, text: `${dueLabelOf(p, key)} ${clash}. Pick another day, or move that date first.` };
    return false;
  }
  phaseDateError = { p: null, text: '' };
  if (key === lastPhase(p)) p.data.due_date = value;
  else (p.data.stage_due ??= {})[key] = value;
  return true;
}

function setStage(p, stage) {
  if (stage === stageOf(p)) return;
  p.stage = stage;
  p.updated_at = new Date().toISOString();
  p.history.push({ stage, at: p.updated_at });
  if (isProduct(p)) syncShipped(p);
  persist();
}

// For the product line, Shipped and Complete are the same thing: reaching one sets the other, which
// closes the run out to the archive. Taking a run back out of Shipped (or Complete) reopens it.
function syncShipped(p) {
  const at = p.updated_at || new Date().toISOString();
  if (stageOf(p) === 'shipped' && p.status !== 'complete') {
    p.status = 'complete';
    p.history.push({ status: 'complete', at });
    finishTodo(p);
    toast(`${projectName(p)} shipped and closed out`);
  } else if (stageOf(p) !== 'shipped' && p.status === 'complete') {
    p.status = 'in_progress';
    p.history.push({ status: 'in_progress', at });
  }
}

async function setStatus(p, status) {
  if (status === p.status) return;
  p.status = status;
  p.updated_at = new Date().toISOString();
  p.history.push({ status, at: p.updated_at });
  // The to-do list follows along: a quote marked sent ticks "Send the quote", and an accepted one asks
  // whether the deposit is in.
  const tick = text => {
    const t = p.data.todo?.items.find(x => !x.done_at && x.text === text);
    if (!t) return false;
    t.done_at = p.updated_at;
    p.data.todo.log.push({ at: p.updated_at, what: 'done', text, list: 'items' });
    return true;
  };
  if (isClient(p) && status !== 'draft' && status !== 'declined') tick('Send the quote');
  if (isClient(p) && status === 'accepted' && p.data.todo?.items.some(x => !x.done_at && x.text === 'Collect deposit')
    && confirm(`Has the deposit for ${projectName(p)} come in?\n\nOK ticks "Collect deposit" on its to-do list.`)) tick('Collect deposit');
  if (isProduct(p) && (status === 'complete') !== (stageOf(p) === 'shipped')) {
    p.stage = status === 'complete' ? 'shipped' : 'packaging';
    p.history.push({ stage: p.stage, at: p.updated_at });
  }
  if (isFinished(p)) finishTodo(p);
  persist();
  if (ed?.project === p) renderStatusCard();
  else showBoard();
}

// ---------- frozen projects ----------
function freezeProject(p) {
  const reason = prompt(`Freeze ${projectName(p)}? It leaves the board and calendar until you unfreeze it.\n\nWhy is it on hold? (optional)`, '');
  if (reason === null) return;
  const at = new Date().toISOString();
  p.data.frozen = { at, reason: reason.trim() };
  p.updated_at = at;
  p.history.push({ frozen: true, at, ...(reason.trim() ? { note: reason.trim() } : {}) });
  persist();
  toast(`${projectName(p)} is frozen. It's under Frozen on the Projects page.`);
  route();
}

// Puts a frozen project back where it left off. The time it spent frozen can be added to its due dates.
function unfreezeProject(p) {
  const f = p.data.frozen;
  if (!f) return;
  const days = Math.round((+new Date(ymd(new Date()) + 'T00:00') - +new Date(ymd(new Date(f.at)) + 'T00:00')) / 86400000);
  const dated = [['due_date', p.data.due_date], ...Object.entries(p.data.stage_due || {})].filter(([, d]) => d);
  if (days > 0 && dated.length && confirm(`${projectName(p)} was frozen for ${days} day${days === 1 ? '' : 's'}. Push its due dates back ${days} day${days === 1 ? '' : 's'} as well?`)) {
    const later = d => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() + days); return ymd(x); };
    if (p.data.due_date) p.data.due_date = later(p.data.due_date);
    for (const [k, d] of Object.entries(p.data.stage_due || {})) if (d) p.data.stage_due[k] = later(d);
    if (isBatch(p)) p.data.batch.ship_manual = true;
  }
  delete p.data.frozen;
  const at = new Date().toISOString();
  p.updated_at = at;
  p.history.push({ frozen: false, at });
  persist();
  toast(`${projectName(p)} is back on the board.`);
  route();
}

// Every frozen project, to look over and unfreeze.
function showFrozen() {
  const list = store.projects.filter(isFrozen).sort((a, b) => b.data.frozen.at.localeCompare(a.data.frozen.at));
  const today = new Date(ymd(new Date()) + 'T00:00');
  const since = p => {
    const n = Math.round((+today - +new Date(ymd(new Date(p.data.frozen.at)) + 'T00:00')) / 86400000);
    return `${esc(fmtDate(p.data.frozen.at))} <span class="muted">(${n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'}`})</span>`;
  };
  view.innerHTML = `<a href="${boardLink()}" class="back">&larr; Projects</a>
    <div class="pagehead"><h1>Frozen projects</h1></div>
    <p class="muted">Projects on hold: a client who's gone quiet but may come back, or a job with a long delay. They stay off the board and calendar.
      Unfreezing one puts it back on the board where it left off.</p>
    ${list.length ? `<div class="card"><table class="list frozenlist">
      <tr><th>Project</th><th>Client or stream</th><th>Where it was</th><th>Frozen since</th><th>Why</th><th></th></tr>
      ${list.map(p => `<tr><td><a href="#/p/${p.id}">${esc(projectName(p))}</a>${isClient(p) ? `<br><small class="muted">${esc(p.quote_number)}</small>` : ''}</td>
        <td>${isClient(p) ? esc(p.data.client_name || 'No client yet') : STREAM_NAME[streamOf(p)]}</td>
        <td><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span> <span class="muted">${STAGE_NAME[stageOf(p)]}</span></td>
        <td>${since(p)}</td><td>${esc(p.data.frozen.reason)}</td>
        <td><button class="btn small" data-unfreeze="${p.id}">Unfreeze</button></td></tr>`).join('')}
    </table></div>`
    : '<div class="card empty"><p class="muted" style="margin:0">Nothing is frozen. To put a project on hold, open it and choose <b>Freeze project</b> in its Status box.</p></div>'}`;
}

// The Freeze and Unfreeze buttons, wherever they are on the page.
view.addEventListener('click', e => {
  const el = (e.target as Element).closest<HTMLElement>('[data-freeze], [data-unfreeze]');
  const p = el && store.projects.find(x => x.id === Number(el.dataset.freeze ?? el.dataset.unfreeze));
  if (!p) return;
  if (el.dataset.freeze !== undefined) freezeProject(p);
  else unfreezeProject(p);
});

// ---------- to-do lists ----------
// Every project has its own to-do list and lumber store shopping list, made when the project is
// created and kept in its data as data.todo = { items, lumber, log }. Each entry is { id, text, done_at }
// (done_at is null while open); the log records every task added, checked off, unchecked or removed.
// Checked-off tasks stay where they are, struck through, so they can be unchecked later. When a project
// is finished (marked Complete, or for a client job Delivered & paid if it skipped Complete) everything is checked off.
const TODO_LISTS = { items: 'To-do list', lumber: 'Shopping list' };
let taskSeq = 0;
const newTask = (text, extra = {}) => ({ id: `t${Date.now().toString(36)}${(taskSeq++).toString(36)}`, text, done_at: null, ...extra });
const isFinished = p => p.status === 'complete' || (isClient(p) && p.status === 'delivered');

// The shopping list's first line: the lumber to buy, worked out from the project's size and species.
function lumberLine(p) {
  if (isBatch(p)) {
    const b = p.data.batch;
    return `Materials for ${batchUnits(b)} × ${b.product}${b.materials ? ` (each: ${b.materials})` : ''}`;
  }
  const n = p.calc?.lumber, species = p.data.spec?.species || 'lumber';
  return n?.feet ? `${lumberSummary(p.data, n)}` : `About ${+(n?.buyBf ?? p.calc?.board_feet ?? 0)} board feet of ${species}`;
}

// The starting list for a project: the steps of the job, from quote (or materials) to final payment.
function defaultTodo(p) {
  const d = p.data, client = isClient(p);
  let steps;
  if (isBatch(p)) {
    const b = d.batch, units = batchUnits(b);
    steps = [`Buy materials for ${units} × ${b.product}`,
      ...b.variants.filter(v => pos(v.qty) > 0).map(v => `Make ${pos(v.qty)} × ${variantLabel(b, v)}`),
      `Ship ${units} × ${b.product}`];
  } else {
    steps = [
      ...(client ? ['Send the quote', 'Collect deposit'] : []),
      'Buy lumber & hardware',
      ...(d.phases || []).filter(ph => pos(ph.hours) > 0 && ph.name).map(ph => ph.name),
      ...(client ? ['Collect final payment'] : []),
    ];
  }
  return {
    items: steps.map(text => newTask(text)),
    lumber: [newTask(lumberLine(p), { auto: true })],   // auto: follows the estimate until it is checked off
    log: [{ at: new Date().toISOString(), what: 'created' }],
  };
}

// Projects from before to-do lists existed get one, checked off as far as the project has got.
function backfillTodos() {
  let any = false;
  for (const p of store.projects) {
    if (p.data.todo) continue;
    const todo = defaultTodo(p);
    if (isClient(p) && p.status !== 'draft') todo.items[0].done_at = p.history.find(h => h.status === 'sent')?.at || p.updated_at;
    if (isFinished(p) || archived(p)) {
      const at = p.history.findLast(h => h.status)?.at || p.updated_at;
      for (const t of [...todo.items, ...todo.lumber]) t.done_at ??= at;
    }
    p.data.todo = todo;
    any = true;
  }
  if (any) persist();
}

function todoChanged(p, entry?) {
  if (entry) p.data.todo.log.push({ at: new Date().toISOString(), ...entry });
  p.updated_at = new Date().toISOString();
  persist();
}

// A finished project has nothing left to do: everything still open is checked off.
function finishTodo(p) {
  const todo = p.data.todo;
  if (!todo) return;
  const at = new Date().toISOString(), open = [...todo.items, ...todo.lumber].filter(t => !t.done_at);
  if (!open.length) return;
  for (const t of open) t.done_at = at;
  todo.log.push({ at, what: 'finished', count: open.length });
}

const todoCounts = p => {
  const items = p.data.todo?.items || [];
  return { done: items.filter(t => t.done_at).length, total: items.length, next: items.find(t => !t.done_at) };
};

// The Tasks page: active projects first, then frozen ones, then finished ones (most recently finished
// first; the older ones are behind a "Show all" button so the page stays short).
let showAllFinished = false;
const finishedAt = p => [...p.history].reverse().find(h => h.status === p.status)?.at || p.updated_at;

// Active projects in priority order. By default the nearest due date comes first. Once projects have
// been moved by hand that order is kept (in the settings, so every device shares it), and a project
// that isn't in it yet (new, or back from frozen) slots in by its due date.
const dueKey = p => p.data.due_date || '9999';
function prioritized() {
  const active = store.projects.filter(p => !archived(p) && !isFrozen(p))
    .sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || a.id - b.id);
  const saved = Array.isArray(store.settings.task_order) ? store.settings.task_order : [];
  const ranked = saved.map(id => active.find(p => p.id === id)).filter(Boolean);
  for (const p of active) {
    if (ranked.includes(p)) continue;
    const i = ranked.findIndex(q => dueKey(q) > dueKey(p));
    ranked.splice(i < 0 ? ranked.length : i, 0, p);
  }
  return ranked;
}
const manualOrder = () => Array.isArray(store.settings.task_order) && store.settings.task_order.length > 0;
function setTaskOrder(ids) {
  store.settings.task_order = ids;
  settingsChanged();
}

function showTasks() {
  const active = prioritized();
  const frozen = store.projects.filter(isFrozen).sort((a, b) => b.data.frozen.at.localeCompare(a.data.frozen.at));
  const finished = store.projects.filter(p => archived(p) && !isFrozen(p)).sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)));
  const today = ymd(new Date()), FINISHED_SHOWN = 9;
  const card = (p, kind = 'active') => {
    const c = todoCounts(p), due = p.data.due_date;
    const note = kind === 'frozen' ? `frozen since ${esc(fmtDate(p.data.frozen.at))}`
      : kind === 'finished' ? `${p.status === 'declined' ? 'declined' : 'finished'} ${esc(fmtDate(finishedAt(p)))}`
      : due ? `<span class="${due < today ? 'late' : ''}">due ${esc(fmtDate(due))}</span>` : '';
    return `<a class="card taskproj ${kind}" href="#/tasks/${p.id}"${kind === 'active' ? ` data-id="${p.id}" draggable="false"` : ''}>
      <div class="name"><b>${esc(projectName(p))}</b><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></div>
      <span class="muted" style="font-size:13px">${isClient(p) ? esc(p.data.client_name || p.quote_number) : STREAM_NAME[streamOf(p)]}${note ? ` &middot; ${note}` : ''}</span>
      <div class="progress" aria-hidden="true"><span style="width:${c.total ? Math.round(c.done / c.total * 100) : 0}%"></span></div>
      <span style="font-size:13px">${c.total ? `${c.done} of ${c.total} done` : 'No tasks yet'}${c.next && kind !== 'finished' ? `<br><span class="muted">Next: ${esc(c.next.text)}</span>` : ''}</span>
    </a>`;
  };
  const shownFinished = showAllFinished ? finished : finished.slice(0, FINISHED_SHOWN);
  view.innerHTML = `<div class="pagehead"><h1>Tasks</h1></div>${tasksTabs('projects')}
    ${active.length ? `<div class="taskgrid reorder" id="activeTasks">${active.map(p => card(p)).join('')}</div>
      <p class="muted hint orderhint">${active.length > 1 ? 'Press and hold a project to move it up or down. ' : ''}${manualOrder()
        ? 'In your own order; new projects slot in by due date. <button type="button" class="link" id="orderByDue">Sort by due date</button>'
        : 'Nearest due date first.'}</p>`
      : `<div class="card empty"><p class="muted" style="margin:0">No active projects. Every new project gets its own to-do list as soon as it's created.</p></div>`}
    ${frozen.length ? `<section class="tasksection"><h2>Frozen projects <span>${frozen.length}</span></h2>
      <div class="taskgrid">${frozen.map(p => card(p, 'frozen')).join('')}</div></section>` : ''}
    ${finished.length ? `<section class="tasksection"><h2>Finished projects <span>${finished.length}</span></h2>
      <div class="taskgrid">${shownFinished.map(p => card(p, 'finished')).join('')}</div>
      ${finished.length > FINISHED_SHOWN ? `<p><button type="button" class="link" id="allFinished">${showAllFinished ? 'Show fewer' : `Show all ${finished.length}`}</button></p>` : ''}</section>` : ''}`;
  $('#allFinished')?.addEventListener('click', () => { showAllFinished = !showAllFinished; showTasks(); });
  $('#orderByDue')?.addEventListener('click', () => { setTaskOrder([]); showTasks(); });
  const grid = $('#activeTasks');
  if (!grid) return;
  const press = longPressReorder(grid, ids => { setTaskOrder(ids.map(Number)); showTasks(); }, 'a.taskproj');
  // Letting go after a move is not a tap that opens the project.
  grid.addEventListener('click', e => { if (press.justMoved()) e.preventDefault(); }, true);
  // From the keyboard: Alt + up / down arrow moves the focused project.
  grid.addEventListener('keydown', e => {
    const a = (e.target as Element).closest<HTMLElement>('a.taskproj');
    if (!a || !e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const ids = active.map(p => p.id), i = ids.indexOf(Number(a.dataset.id)), j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setTaskOrder(ids);
    showTasks();
    ($(`#activeTasks a[data-id="${ids[j]}"]`) as HTMLElement)?.focus();
  });
}

// Every open item on every active project's to-do list, as one list in the same order as the
// Projects tab (highest priority first), each project's items in its own list's order. Checking an
// item here checks it off on the project's list. Items checked this week stay, struck through, so a
// mis-tap can be undone. Projects with nothing left to do are left out.
const TODOS_KEEP_DAYS = 7;
function showAllTodos() {
  const since = new Date(Date.now() - TODOS_KEEP_DAYS * 86400000).toISOString(), today = ymd(new Date());
  const shown = t => !t.done_at || t.done_at >= since;
  const draw = () => {
    let open = 0;
    const groups = prioritized().map(p => {
      const all = p.data.todo?.items || [], items = all.filter(shown), left = all.filter(t => !t.done_at).length;
      if (!left) return '';
      open += left;
      const due = p.data.due_date;
      return `<section class="card todogroup" data-project="${p.id}">
        <div class="shophead"><a href="#/tasks/${p.id}"><b>${esc(projectName(p))}</b></a>
          <span class="muted">${isClient(p) ? esc(p.data.client_name || p.quote_number) : STREAM_NAME[streamOf(p)]}${due ? ` &middot; <span class="${due < today ? 'late' : ''}">due ${esc(fmtDate(due))}</span>` : ''} &middot; ${left} to do</span></div>
        <ul class="tasks">${items.map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
          <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span>
          ${t.done_at ? `<span class="when">Done ${esc(fmtDate(t.done_at))}</span>` : ''}</li>`).join('')}</ul>
      </section>`;
    }).filter(Boolean);
    box.innerHTML = `<div class="pagehead"><h1>Tasks</h1></div>${tasksTabs('todos')}
      <p class="muted shopsum">${open ? `${open} thing${open === 1 ? '' : 's'} to do across ${groups.length} project${groups.length === 1 ? '' : 's'}, in the order of the Projects tab.` : 'Nothing left to do.'}
        Checking an item off here checks it off on that project's list too.</p>
      ${groups.length ? `<div class="todoall">${groups.join('')}</div>`
        : '<div class="card empty"><p class="muted" style="margin:0">Every active project\'s to-do list is done.</p></div>'}`;
  };
  view.innerHTML = '<div id="alltodos"></div>';
  const box = $('#alltodos');
  draw();
  box.addEventListener('click', e => {
    const li = (e.target as Element).closest<HTMLElement>('li.task');
    const p = li && store.projects.find(x => x.id === Number(li.closest<HTMLElement>('[data-project]')?.dataset.project));
    const t = p?.data.todo?.items.find(x => x.id === li.dataset.id);
    if (!t) return;
    if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
    t.done_at = t.done_at ? null : new Date().toISOString();
    todoChanged(p, { what: t.done_at ? 'done' : 'undone', text: t.text, list: 'items' });
    draw();
  });
}

// One project's to-do list, its lumber store shopping list and the log of everything done.
function showTodo(p) {
  if (!p.data.todo) { p.data.todo = defaultTodo(p); todoChanged(p); }
  const todo = p.data.todo;
  view.innerHTML = `${projectHeader(p, 'todo', '')}
    <div class="cols">
      <div class="card">
        <h2>To-do list</h2>
        <form class="addtask" data-list="items" autocomplete="off"><textarea rows="1" enterkeyhint="done" placeholder="Add a task, or paste a list" aria-label="New task"></textarea><button class="btn primary">Add</button></form>
        <ul class="tasks" data-list="items"></ul>
        <p class="muted hint">Paste a block of tasks (one per line) to add each line as its own task. Press and hold a task to move it up or down the list.</p>
      </div>
      <aside>
        <div class="card">
          <h2>Lumber store shopping list</h2>
          <form class="addtask" data-list="lumber" id="lumberAdd" autocomplete="off"><textarea rows="1" enterkeyhint="done" placeholder="Add something to buy" aria-label="New shopping list item"></textarea><button class="btn primary">Add</button></form>
          <ul class="tasks" data-list="lumber"></ul>
          <p class="muted hint">Paste a list (one item per line) to add every item at once.</p>
        </div>
        <div class="card"><h2>Task log</h2><ul class="history tasklog" id="todoLog"></ul></div>
      </aside>
    </div>`;

  const draw = list => {
    const ul = $(`ul[data-list="${list}"]`);
    // The lumber line follows the project's estimate until it is checked off or edited.
    if (list === 'lumber') for (const t of todo.lumber) if (t.auto && !t.done_at) t.text = lumberLine(p);
    ul.innerHTML = todo[list].length ? todo[list].map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
        <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}">
        <span class="text">${esc(t.text)}</span>
        ${t.done_at ? `<span class="when">Done ${esc(fmtDate(t.done_at))}</span>` : ''}
        <button type="button" class="x" aria-label="Remove ${esc(t.text)}" title="Remove">&times;</button>
      </li>`).join('')
      : `<li class="none muted">${list === 'lumber' ? 'Nothing to buy yet.' : 'Nothing on the list yet.'}</li>`;
  };
  const drawLog = () => {
    const what = e => ({
      created: 'List made', finished: `Project finished: ${e.count} open item${e.count === 1 ? '' : 's'} checked off`,
      done: `Done: ${esc(e.text)}`, undone: `Unchecked: ${esc(e.text)}`, added: `Added: ${esc(e.text)}`, removed: `Removed: ${esc(e.text)}`,
    }[e.what] || esc(e.what)) + (e.list === 'lumber' ? ' <small>(shopping list)</small>' : '');
    $('#todoLog').innerHTML = [...todo.log].reverse().map(e => `<li><span>${what(e)}</span><span>${esc(fmtDate(e.at))}</span></li>`).join('');
  };
  const redraw = () => { draw('items'); draw('lumber'); drawLog(); };

  const find = (list, id) => todo[list].find(t => t.id === id);
  const toggle = (list, id) => {
    const t = find(list, id);
    if (!t) return;
    t.done_at = t.done_at ? null : new Date().toISOString();
    if (t.done_at) delete t.auto;
    todoChanged(p, { what: t.done_at ? 'done' : 'undone', text: t.text, list });
    redraw();
  };

  // Adds each line of a pasted or typed block as its own item, without the bullets, numbers or checkboxes
  // it was written with. A single typed line is added just as it was typed.
  const linesOf = text => /\n/.test(text) ? splitPasted(text) : [text.replace(/\s+/g, ' ').trim()].filter(Boolean);
  const addLines = (list, items) => {
    if (!items.length) return 0;
    for (const t of items) {
      todo[list].push(newTask(t));
      todo.log.push({ at: new Date().toISOString(), what: 'added', text: t, list });
    }
    todoChanged(p);
    redraw();
    if (items.length > 1) toast(`Added ${items.length} items to the ${TODO_LISTS[list].toLowerCase()}.`);
    return items.length;
  };
  // The add box grows with what's in it, so a pasted block shows every line until it's added.
  const fit = box => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };

  view.querySelectorAll('form.addtask').forEach(form => {
    const box = form.querySelector('textarea'), list = form.dataset.list;
    // Pasting a block (a list from Notes, a text message, an email) adds each line straight away.
    // What's already typed in the box is kept and added first.
    box.addEventListener('paste', e => {
      const pasted = e.clipboardData?.getData('text/plain') || '';
      if (splitPasted(pasted).length < 2) return;   // one item: paste it into the box as usual
      e.preventDefault();
      const before = box.value.slice(0, box.selectionStart), after = box.value.slice(box.selectionEnd);
      addLines(list, [...linesOf(before), ...splitPasted(pasted), ...linesOf(after)]);
      box.value = '';
      fit(box);
    });
    box.addEventListener('input', () => fit(box));
    // Return adds what's in the box (Shift+Return starts a new line, to type several tasks at once).
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!addLines(list, linesOf(box.value))) return box.focus();
      box.value = '';
      fit(box);
      box.focus();
    });
  });

  view.querySelectorAll('ul.tasks').forEach(ul => {
    const list = ul.dataset.list;
    const reorder = ids => {
      todo[list].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      todoChanged(p);
    };
    const press = longPressReorder(ul, reorder);
    ul.addEventListener('click', e => {
      const li = (e.target as Element).closest<HTMLElement>('li.task');
      if (!li) return;
      if (press.justMoved()) { e.preventDefault(); return; }
      if ((e.target as Element).closest('.x')) {
        const t = find(list, li.dataset.id);
        if (!t || !confirm(`Remove "${t.text}" from the ${TODO_LISTS[list].toLowerCase()}?`)) return;
        todo[list] = todo[list].filter(x => x !== t);
        todoChanged(p, { what: 'removed', text: t.text, list });
        redraw();
        return;
      }
      // Tapping the checkbox or the task's text checks it off (or back on).
      if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
      toggle(list, li.dataset.id);
      refreshTabCount();
    });
    // From the keyboard: Alt + up / down arrow moves the focused task.
    ul.addEventListener('keydown', e => {
      const li = (e.target as Element).closest<HTMLElement>('li.task');
      if (!li || !e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const i = todo[list].findIndex(t => t.id === li.dataset.id), j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (i < 0 || j < 0 || j >= todo[list].length) return;
      [todo[list][i], todo[list][j]] = [todo[list][j], todo[list][i]];
      todoChanged(p);
      draw(list);
      ($(`li[data-id="${li.dataset.id}"] input`, ul) as HTMLElement)?.focus();
    });
  });
  // The count on the To-do list tab follows what's ticked or added.
  const refreshTabCount = () => { const tab = $('.projtabs a.on small'), n = todoLeft(p); if (tab) tab.textContent = n ? String(n) : ''; };
  view.addEventListener('submit', () => setTimeout(refreshTabCount));
  redraw();
  if (focusShopping) { focusShopping = false; setTimeout(() => { const box = $('#lumberAdd textarea') as HTMLElement; box?.scrollIntoView({ block: 'center' }); box?.focus(); }, 50); }
}

// The two tabs at the top of the Tasks page.
const tasksTabs = on => `<nav class="tabs">
  <a href="#/tasks" class="${on === 'projects' ? 'on' : ''}">Projects</a>
  <a href="#/tasks/todos" class="${on === 'todos' ? 'on' : ''}">All to-dos <small>${
    store.projects.filter(p => !archived(p) && !isFrozen(p)).reduce((n, p) => n + (p.data.todo?.items || []).filter(t => !t.done_at).length, 0) || ''}</small></a>
  <a href="#/tasks/shopping" class="${on === 'shopping' ? 'on' : ''}">Shopping list <small>${
    store.projects.filter(p => !archived(p) && !isFrozen(p)).reduce((n, p) => n + (p.data.todo?.lumber || []).filter(t => !t.done_at).length, 0) || ''}</small></a>
</nav>`;

// Every active project's lumber store shopping list in one place, to take to the store and check off.
// It opens sorted by wood species, as a clean checklist of thickness, width, length and how many (read
// from each item's wording, see readLumber); "By project" shows each project's list as written. Checking an item here checks it off on the project's own list (and logs it there).
// Items checked in the last week stay visible, struck through, so a mis-tap can be undone; older ones
// are only on the project's own page. Frozen and finished projects are left out.
const SHOPPING_KEEP_DAYS = 7;
let shoppingBy = 'species';   // opens by species every time
function showShopping() {
  const since = new Date(Date.now() - SHOPPING_KEEP_DAYS * 86400000).toISOString();
  const projects = prioritized();
  const shown = t => !t.done_at || t.done_at >= since;
  const draw = () => {
    let open = 0, withItems = 0;
    const groups = projects.map(p => {
      const lumber = p.data.todo?.lumber || [];
      for (const t of lumber) if (t.auto && !t.done_at) t.text = lumberLine(p);   // follows the estimate, as on the project's page
      const items = lumber.filter(shown), left = lumber.filter(t => !t.done_at).length;
      open += left;
      if (left) withItems++;
      return `<section class="card shopgroup" data-project="${p.id}">
        <div class="shophead"><a href="#/tasks/${p.id}"><b>${esc(projectName(p))}</b></a>
          <span class="muted">${isClient(p) ? esc(p.data.client_name || p.quote_number) : STREAM_NAME[streamOf(p)]}${left ? ` &middot; ${left} to buy` : ''}</span></div>
        <ul class="tasks">${items.map(t => `<li class="task ${t.done_at ? 'done' : ''}" data-id="${esc(t.id)}">
          <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}"><span class="text">${esc(t.text)}</span>
          ${t.done_at ? `<span class="when">Done ${esc(fmtDate(t.done_at))}</span>` : ''}</li>`).join('')
          || '<li class="none muted">Nothing to buy.</li>'}</ul>
        <form class="addtask" autocomplete="off"><input placeholder="Add something to buy" aria-label="Add to ${esc(projectName(p))}'s shopping list"><button class="btn small">Add</button></form>
      </section>`;
    });
    const toggle = `<div class="seg" role="tablist" aria-label="Sort the shopping list">
      <button type="button" data-by="species" class="${shoppingBy === 'species' ? 'on' : ''}" aria-selected="${shoppingBy === 'species'}">By species</button>
      <button type="button" data-by="project" class="${shoppingBy === 'project' ? 'on' : ''}" aria-selected="${shoppingBy === 'project'}">By project</button></div>`;
    box.innerHTML = `<div class="pagehead"><h1>Tasks</h1></div>${tasksTabs('shopping')}
      <div class="shoptop">${toggle}<p class="muted shopsum">${open ? `${open} item${open === 1 ? '' : 's'} to buy for ${withItems} project${withItems === 1 ? '' : 's'}.` : 'Nothing left to buy.'}
        Checking an item off here checks it off on that project's list too.${shoppingBy === 'project' ? ' Paste a list into a box to add several items at once.' : ''}</p></div>
      ${!projects.length ? '<div class="card empty"><p class="muted" style="margin:0">No active projects.</p></div>'
        : shoppingBy === 'species' ? bySpecies() : `<div class="shopgrid">${groups.join('')}</div>`}`;
  };
  // Every item still to buy (and any checked this week), as one checklist per species, thickest first.
  const bySpecies = () => {
    const rows = projects.flatMap(p => (p.data.todo?.lumber || []).filter(shown).map(t => ({ p, t, l: readLumber(t.text, t.auto ? p.data.spec?.species : '') })));
    const groups = new Map();
    for (const r of rows) {
      const key = r.l.species || (r.l.lumber ? 'Species not given' : 'Other supplies');
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    const order = k => k === 'Other supplies' ? 2 : k === 'Species not given' ? 1 : 0;
    const keys = [...groups.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    if (!keys.length) return '<div class="card empty"><p class="muted" style="margin:0">Nothing on any shopping list. Add items from a project\'s list, or switch to By project.</p></div>';
    const dash = '<span class="muted">&ndash;</span>';
    return `<div class="species">${keys.map(k => {
      const list = groups.get(k).sort((a, b) => (+!!a.t.done_at - +!!b.t.done_at) || (b.l.q || 0) - (a.l.q || 0) || (b.l.w || 0) - (a.l.w || 0));
      const left = list.filter(r => !r.t.done_at).length, other = k === 'Other supplies';
      return `<section class="card spgroup">
        <h3>${esc(k)} <span class="muted">${left ? `${left} to buy` : 'all bought'}</span></h3>
        ${other ? '' : '<div class="sphead" aria-hidden="true"><span></span><span>Thickness</span><span>Width</span><span>Length</span><span>How many</span></div>'}
        <ul class="tasks sprows">${list.map(({ p, t, l }) => `<li class="task ${t.done_at ? 'done' : ''} ${other ? 'other' : ''}" data-id="${esc(t.id)}" data-project="${p.id}">
          <input type="checkbox" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.text)}">
          ${other ? `<span class="text">${esc(t.text)}</span>`
            : `<span class="dim">${l.thick ? esc(l.thick) : l.thickMissing ? '<span class="need" title="Thickness not given">?</span>' : dash}</span><span class="dim">${l.width ? esc(l.width) : dash}</span>
               <span class="dim">${l.length ? esc(l.length) : dash}</span><span class="dim">${l.count ? esc(l.count) : dash}</span>`}
          <span class="for muted"><a href="#/tasks/${p.id}">${esc(projectName(p))}</a>${!other && l.note ? ` &middot; ${esc(l.note)}` : ''}${!other && l.thickMissing && !t.done_at ? ' &middot; <span class="need">thickness not given</span>' : ''}${t.done_at ? ` &middot; bought ${esc(fmtDate(t.done_at))}` : ''}</span>
        </li>`).join('')}</ul>
      </section>`;
    }).join('')}</div>
    <p class="muted hint">Species and sizes are read from how each item is written, such as "2 &times; 8/4 walnut, 7&quot; wide, 10 ft" or "2 sheets 3/4&quot; birch ply, 4x8". To add items, use By project or the project's own list.</p>`;
  };
  // The page is drawn into its own box, so its handlers go away with it when another page is shown.
  view.innerHTML = '<div id="shopping"></div><div id="scanNudge" class="scannudge" hidden></div>';
  const box = $('#shopping');
  // Ticking things off at the store brings up a button to scan the receipt for them, with the project picked.
  const boughtFor = new Set<number>();
  const nudge = () => {
    const el = $('#scanNudge'), ids = [...boughtFor].filter(id => store.projects.some(x => x.id === id));
    el.hidden = !ids.length;
    if (!ids.length) return;
    const names = ids.map(id => projectName(store.projects.find(x => x.id === id)));
    el.innerHTML = `<span>Bought ${names.length === 1 ? `for <b>${esc(names[0])}</b>` : `for ${names.length} projects`}?</span>
      <a class="btn primary small" href="#/receipt/${ids.at(-1)}">Scan the receipt</a>`;
  };
  box.addEventListener('click', () => setTimeout(nudge));
  draw();
  const projectOf = el => store.projects.find(p => p.id === Number(el.closest('[data-project]')?.dataset.project));
  const add = (p, texts) => {
    p.data.todo ??= defaultTodo(p);
    for (const text of texts) {
      p.data.todo.lumber.push(newTask(text));
      p.data.todo.log.push({ at: new Date().toISOString(), what: 'added', text, list: 'lumber' });
    }
    todoChanged(p);
    draw();
    $(`[data-project="${p.id}"] form input`, box)?.focus();
  };
  box.addEventListener('click', e => {
    const by = (e.target as Element).closest<HTMLElement>('[data-by]');
    if (by) { shoppingBy = by.dataset.by; draw(); return; }
    if ((e.target as Element).closest('a')) return;   // a project's name opens its own list
    const li = (e.target as Element).closest<HTMLElement>('li.task'), p = li && projectOf(li);
    if (!p) return;
    if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
    const t = p.data.todo.lumber.find(x => x.id === li.dataset.id);
    if (!t) return;
    t.done_at = t.done_at ? null : new Date().toISOString();
    if (t.done_at) { delete t.auto; boughtFor.add(p.id); }
    todoChanged(p, { what: t.done_at ? 'done' : 'undone', text: t.text, list: 'lumber' });
    draw();
  });
  box.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target as HTMLFormElement, input = form.querySelector('input'), p = projectOf(form), text = input.value.trim();
    if (p && text) add(p, [text]);
  });
  box.addEventListener('paste', (e: ClipboardEvent) => {
    const input = (e.target as Element).closest?.('form.addtask input'), p = input && projectOf(input);
    const items = p ? splitPasted(e.clipboardData?.getData('text/plain') || '') : [];
    if (items.length < 2) return;
    e.preventDefault();
    add(p, items);
    toast(`Added ${items.length} items to ${projectName(p)}'s shopping list.`);
  });
}

// Reads a shopping-list line for what the lumber store needs: species, thickness, width, length and how
// many. It understands the wording the lumber pickup line uses ("90 linear ft of 8/4 Walnut, 7" wide (9 ×
// 10 ft boards)") and the usual shorthand ("2x 8/4 walnut 7\" wide 10'", "3/4\" maple ply", "20 bf cherry").
// Anything it can't read is left blank, and a line with no wood in it counts as other supplies.
const EXTRA_SPECIES = ['Black walnut:Walnut', 'Walnut', 'Cherry', 'Maple:Hard maple', 'Soft maple', 'White oak', 'Red oak', 'Oak',
  'Baltic birch:Birch', 'Ash', 'Poplar', 'Pine', 'Hickory', 'Teak', 'Mahogany', 'Sapele', 'Padauk', 'Purpleheart', 'Birch', 'Beech', 'Alder', 'Cedar',
  'Douglas fir', 'Fir', 'Basswood', 'Butternut', 'Wenge', 'Zebrawood', 'Bubinga', 'Jatoba', 'Cypress', 'Spruce'];
// Sheet goods that aren't plywood keep their own name; [pattern, group name].
const SHEET_KINDS = [['mdf', 'MDF'], ['osb', 'OSB'], ['melamine', 'Melamine'], ['hardboard', 'Hardboard'], ['masonite', 'Hardboard'],
  ['particle ?board', 'Particleboard']];
// Thicknesses written out in words on sheet goods. "three quarter" is checked before "quarter".
const THICK_WORDS = [['three[- ]?quarters?', '3/4'], ['half', '1/2'], ['quarter', '1/4']];
// Typed fractions (¾) become 3/4 so they read like everything else; inches() turns "1 1/4", "3/4" or ".75" into a number.
const VULGAR = { '¼': '1/4', '½': '1/2', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
const inches = v => {
  const m = String(v).trim().match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
  return m ? (+(m[1] || 0) + +m[2] / +m[3]) || 0 : parseFloat(v) || 0;
};
function readLumber(text, fallbackSpecies = '') {
  const s = ` ${String(text).replace(/[\u201c\u201d\u2033]/g, '"').replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/(\d?)\s*([\u00bc\u00bd\u00be\u215b\u215c\u215d\u215e])/g, (_, w, f) => `${w ? `${w} ` : ' '}${VULGAR[f]}`)} `, low = s.toLowerCase();
  const names = [...store.settings.species.map(x => [x.name, x.name]), ...EXTRA_SPECIES.map(x => { const [a, b] = x.split(':'); return [a, b || a]; })]
    .sort((a, b) => b[0].length - a[0].length);
  const hit = names.find(([n]) => new RegExp(`[^a-z]${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?[^a-z]`).test(low));
  // Sheet goods are grouped as "<species> plywood" (or "Plywood", "MDF", "OSB" and so on), apart from solid boards.
  // Baltic birch only comes in sheets, so it counts as one even when the line doesn't say ply.
  const kind = SHEET_KINDS.find(([k]) => new RegExp(`[^a-z]${k}s?[^a-z]`).test(low));
  const sheet = !!kind || /[^a-z](?:ply|plywood|sheets?|baltic)[^a-z]/.test(low);
  let species = hit ? hit[1] : fallbackSpecies || '';
  if (sheet) species = kind && !hit ? kind[1] : hit ? `${hit[0]} plywood` : 'Plywood';
  species = species ? species[0].toUpperCase() + species.slice(1) : '';
  const num = '(\\d+(?:\\.\\d+)?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+)';
  const m = re => s.match(new RegExp(re, 'i'));
  const quarters = m('(\\d{1,2})\\/4(?![\\d"])(?!\\s*(?:"|in\\b|inch))');
  const thickIn = m(`${num}\\s*(?:"|in\\b|inch(?:es)?)\\s*thick`) || (sheet ? m(`${num}\\s*(?:"|in\\b|inch(?:es)?)(?!\\s*(?:wide|long|w\\b|l\\b))`) : null);
  const width = m(`${num}\\s*(?:"|in\\b|inch(?:es)?)\\s*(?:wide|w\\b)`) || m(`(?:wide|width)\\s*:?\\s*${num}\\s*(?:"|in\\b)?`);
  const boards = m(`(\\d+)\\s*(?:\\u00d7|x)\\s*${num}\\s*(?:ft|feet|foot|')\\s*boards?`);
  const linear = m(`${num}\\s*(?:linear|lin\\.?)\\s*(?:ft|feet)`);
  const len = m(`${num}\\s*(?:ft|feet|foot|')(?![a-z])`) || m(`${num}\\s*(?:"|in\\b)\\s*(?:long|l\\b)`);
  const bf = m(`${num}\\s*(?:board\\s*f(?:ee|oo)t|bd\\.?\\s*ft|bf)\\b`);
  const count = m('^\\s*(\\d+)\\s*(?:\\u00d7|x(?=\\s)|pcs?\\b|pieces?\\b|boards?\\b|sheets?\\b)') || m('(?:\\u00d7|\\bx)\\s*(\\d+)\\s*$');
  const r: any = { species, sheet };
  if (sheet) {
    // Sheet goods are bought by thickness, so it is read however it's written: 3/4", 3/4 in, 3/4-inch, a bare
    // 3/4 or ½, .75", or 18mm. "1/2 sheet" is half a sheet, not a thickness. "2 3/4" ply" is two sheets of 3/4".
    const mm = m('(\\d+(?:\\.\\d+)?)\\s*mm\\b');
    const inch = m(`(\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)[\\s-]*(?:"|in\\b\\.?|inch(?:es)?)(?![\\s-]*(?:wide|long|w\\b|l\\b))`);
    const bare = m('(?<![\\d/.])(\\d{1,2}\\/\\d{1,2})(?![\\d/]|\\s*(?:\'|ft\\b|feet|foot|wide|long|sheets?\\b))');
    if (mm) { r.thick = `${mm[1]} mm`; r.q = parseFloat(mm[1]) / 25.4 * 4; }
    else if (inch || bare) {
      let t = (inch || bare)[1].trim();
      const mixed = t.match(/^(\d+)\s+(\d+\/\d+)$/);
      if (mixed && +mixed[1] >= 2) { r.count = mixed[1]; t = mixed[2]; }   // "2 3/4" ply": a count, then the thickness
      r.thick = `${t}"`; r.q = inches(t) * 4;
    } else {
      const word = THICK_WORDS.find(([w]) => new RegExp(`[^a-z]${w}[- ]?inch`).test(low));
      if (word) { r.thick = `${word[1]}"`; r.q = inches(word[1]) * 4; }
      else r.thickMissing = true;
    }
    // A sheet size such as 4x8, 4' x 8', 4 by 8 or 5×5 fills the width and length columns.
    const size = m('(?<![\\d/.])(\\d{1,2})\\s*\'?\\s*(?:[x\\u00d7]|by)\\s*(\\d{1,2})\\s*\'?(?![\\d/x\\u00d7"])');
    if (size) { r.width = `${size[1]} ft`; r.length = `${size[2]} ft`; }
    const part = m('(?<![\\d/.])(\\d{1,2}\\/\\d{1,2})\\s*sheet');
    if (part && !r.count) r.count = `${part[1]} sheet`;
  }
  else if (quarters) { r.thick = `${quarters[1]}/4`; r.q = +quarters[1]; }
  else if (thickIn) { r.thick = `${thickIn[1]}"`; r.q = inches(thickIn[1]) * 4; }
  if (width) { r.width = `${width[1]}"`; r.w = inches(width[1]); }
  if (boards) { r.length = `${boards[2]} ft`; r.count = `${boards[1]} board${boards[1] === '1' ? '' : 's'}`; if (linear) r.note = `${linear[1]} linear ft`; }
  else if (linear) r.length = `${linear[1]} linear ft`;
  else if (len && !r.length) r.length = len[0].trim().replace(/\s*(feet|foot|')$/i, ' ft').replace(/\s*(?:"|in)\s*(?:long|l)$/i, '"');
  if (!r.count && count) r.count = count[1];
  if (bf) r.count = r.count ? `${r.count} (${bf[1]} bf)` : `${bf[1]} bf`;
  r.lumber = !!(hit || sheet || r.thick || r.width || bf || boards || linear);
  if (!r.lumber) r.species = '';
  return r;
}

// Turns pasted text into list items: one per line (or per semicolon, or per bullet when they all came
// on one line), without the bullets, numbers or checkboxes the list was written with. Commas are left
// alone, since they turn up inside items ("8/4 walnut, 7\" wide").
function splitPasted(text) {
  let parts = text.split(/\r?\n/);
  if (parts.filter(x => x.trim()).length < 2) parts = text.split(/;|\s[\u2022\u00b7\u25aa\u25e6\u2023\u2043]\s/);
  return parts
    .map(x => x.replace(/^\s*(?:[-*+\u2022\u00b7\u25aa\u25e6\u2023\u2043\u2013\u2014]|\d{1,3}[.)]|[a-z][.)](?=\s)|\[[ xX]?\]|[\u2610\u2611\u2612\u2713\u2714])\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Press and hold an item to pick it up, then drag it up or down the list and let go. A quick swipe
// still scrolls the page; only a steady press lifts the item. `drop` gets the new order of ids (each
// item's data-id). Works for a single column and for a grid of cards (left to right, then down).
function longPressReorder(ul, drop, item = 'li.task') {
  let timer = null, lifted = null, startX = 0, startY = 0, movedUntil = 0, pointer = null, order = '';
  const cancelPress = () => { clearTimeout(timer); timer = null; };
  ul.addEventListener('contextmenu', e => { if (e.target.closest(item)) e.preventDefault(); });
  // While an item is lifted, a finger moving on the screen drags it instead of scrolling the page.
  ul.addEventListener('touchmove', e => { if (lifted) e.preventDefault(); }, { passive: false });
  ul.addEventListener('pointerdown', e => {
    const li = e.target.closest(item);
    if (!li || e.button > 0 || e.target.closest('.x')) return;
    startX = e.clientX; startY = e.clientY; pointer = e.pointerId;
    cancelPress();
    timer = setTimeout(() => {
      timer = null;
      lifted = li;
      order = [...ul.querySelectorAll(item)].map(x => x.dataset.id).join();
      li.classList.add('lifted');
      try { li.setPointerCapture(pointer); } catch {}
      navigator.vibrate?.(15);
    }, 450);
  });
  ul.addEventListener('pointermove', e => {
    if (!lifted) {
      if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) cancelPress();
      return;
    }
    e.preventDefault();
    const others = [...ul.querySelectorAll(item)].filter(x => x !== lifted);
    const rects = others.map(x => x.getBoundingClientRect()), oneColumn = rects.every(r => r.left === rects[0]?.left);
    const before = others.find((x, i) => {
      const r = rects[i];
      return oneColumn ? e.clientY < r.top + r.height / 2 : e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
    });
    if ((before || null) !== lifted.nextElementSibling) ul.insertBefore(lifted, before || null);
  });
  const end = () => {
    cancelPress();
    if (!lifted) return;
    lifted.classList.remove('lifted');
    lifted = null;
    movedUntil = Date.now() + 400;   // the click that follows letting go is not a tap on the task
    const ids = [...ul.querySelectorAll(item)].map(x => x.dataset.id);
    if (ids.join() !== order) drop(ids);
  };
  ul.addEventListener('pointerup', end);
  ul.addEventListener('pointercancel', end);
  return { justMoved: () => Date.now() < movedUntil };
}

// ---------- small-batch product runs ----------
// A batch run is a product-line project made from one of the catalog's products (Settings → Products):
// so many units, split by variant, to be in the mail by a ship-by date (the project's due date). The
// product's per-unit price, cost, time and materials are copied in when the run is created, so later
// catalog edits don't change runs already under way.
function isBatch(p) { return !!p.data.batch; }
function batchUnits(b) { return b.variants.reduce((n, v) => n + pos(v.qty), 0); }
const variantLabel = (b, v) => v.name ? `${b.product} (${v.name})` : b.product;

function batchCalc(data) {
  const b = data.batch, units = batchUnits(b);
  const hours = cents(units * pos(b.unit_hours)), laborCost = cents(hours * pos(data.rates?.hourly_rate ?? store.settings.hourly_rate));
  const materials = cents(units * pos(b.unit_cost));
  const total = cents(b.variants.reduce((sum, v) => sum + pos(v.qty) * pos(v.price ?? b.unit_price), 0));
  return {
    units, board_feet: 0, lumber: { bf: 0, quarters: 4, width: 0, feet: 0, boards: 0, buyBf: 0 },
    labor_hours: hours, contingency_hours: 0, labor_cost: laborCost, materials_est: materials, materials_cost: materials, other_costs: 0,
    cost: cents(laborCost + materials), subtotal: total, tax: 0, total, retainer: 0, balance: total, deposit: 0,
  };
}
function priceProject(p, stream = streamOf(p)) { return isBatch(p) ? batchCalc(p.data) : price(p.data, stream); }

// "Wave / Black Walnut / Silver/Blue" -> { head: 'Wave', rest: 'Black Walnut / Silver/Blue' }.
function qbGroup(name) {
  const parts = String(name || '').split(' / ');
  return parts.length > 1 ? { head: parts[0], rest: parts.slice(1).join(' / ') } : null;
}

// The quick form at the top of the Product line tab. It starts closed (just its header) each time the
// app opens, stays open while you use it, and closes again once a run is added.
let qbOpen = false;
function renderQuickBatch() {
  const card = $('#quickBatch'), products = (store.settings.products || []).filter(x => x.listed !== false);
  if (!products.length) {
    card.innerHTML = `<h2>Quick batch run</h2><p class="muted" style="margin:0">${shopState === 'failed'
      ? "Your products couldn't be loaded from jmwood.work just now. Reload the page to try again." : 'Loading your products from jmwood.work&hellip;'}</p>`;
    return;
  }
  let chosen = products[0].id;
  const product = () => products.find(x => x.id === chosen) || products[0];
  const draw = () => {
    const pr = product(), variants = pr.variants.length ? pr.variants : [{ name: '', price: 0 }];
    // On a phone, variants named like "Wave / Black Walnut / Silver/Blue" are grouped under their first option
    // ("Wave"), so each row only needs the rest. Only when that actually groups something.
    const heads = variants.map(v => qbGroup(v.name)?.head);
    const groups = variants.length > 2 && heads.every(Boolean) && new Set(heads).size < variants.length;
    card.classList.toggle('closed', !qbOpen);
    card.innerHTML = `<div class="actions qbhead"><h2 style="margin:0"><button type="button" class="qbtoggle" aria-expanded="${qbOpen}"><span class="qbchev" aria-hidden="true">&#9656;</span> Quick batch run</button></h2><span style="flex:1"></span><a href="#/products" style="font-size:13px">Edit products</a></div>
      ${store.shopifyConnected ? '<p class="muted" style="margin:-4px 0 12px;font-size:13px">Your Shopify orders fill a run for each product on their own. Use this for anything extra, like stock for a market.</p>' : ''}
      <form id="batchForm" class="grid" autocomplete="off">
        <label class="f"><span>Product</span><select id="qbProduct">${products.map(x => `<option value="${esc(x.id)}" ${x.id === pr.id ? 'selected' : ''}>${esc(x.name || 'Unnamed product')}</option>`).join('')}</select></label>
        <div class="f w6"><span>${variants.length > 1 ? 'How many of each variant' : 'How many'}</span><div class="qbvariants">
          ${variants.map((v, i) => {
            const g = groups && qbGroup(v.name), prev = groups && i > 0 && qbGroup(variants[i - 1].name);
            return `${g && g.head !== prev?.head ? `<div class="qbgroup">${esc(g.head)}</div>` : ''}<label class="qbv">
              <span class="qbname" title="${esc(v.name)}">${g ? `<span class="qlong">${esc(v.name)}</span><span class="qshort">${esc(g.rest)}</span>` : esc(v.name || 'Units')} <small>${money(v.price)}</small></span>
              <span class="qbctl"><button type="button" class="btn small" data-step="-1" tabindex="-1" aria-label="One fewer">&minus;</button><input type="number" inputmode="numeric" min="0" step="1" data-v="${i}" value="${variants.length === 1 ? 1 : ''}" placeholder="0"><button type="button" class="btn small" data-step="1" tabindex="-1" aria-label="One more">+</button></span>
            </label>`;
          }).join('')}
        </div></div>
        <label class="f"><span>In the mail by</span><input type="date" id="qbShip" required></label>
        <div class="f w6 actions qbsubmit"><button class="btn primary" type="submit">Add batch run</button><span class="muted" id="qbTotal"></span></div>
      </form>`;
    const form = $('#batchForm', card);
    const qtys = () => [...form.querySelectorAll('[data-v]')].map(el => ({ ...variants[Number(el.dataset.v)], qty: Math.round(pos(el.value)) }));
    const total = () => {
      const list = qtys(), units = list.reduce((n, v) => n + v.qty, 0);
      $('#qbTotal', card).textContent = units ? `${units} unit${units === 1 ? '' : 's'} \u00b7 ${money(list.reduce((sum, v) => sum + v.qty * pos(v.price), 0))} retail` : '';
      return units;
    };
    total();
    $('.qbtoggle', card).addEventListener('click', () => { qbOpen = !qbOpen; draw(); });
    $('#qbProduct', card).addEventListener('change', e => { chosen = e.target.value; draw(); });
    form.addEventListener('input', total);
    // The phone's - / + buttons beside each variant.
    form.addEventListener('click', e => {
      const step = (e.target as HTMLElement).closest('[data-step]') as HTMLElement;
      if (!step) return;
      e.preventDefault();
      const input = step.parentElement.querySelector('input') as HTMLInputElement;
      const n = Math.max(0, Math.round(pos(input.value)) + Number(step.dataset.step));
      input.value = n ? String(n) : '';
      mark();
      total();
    });
    const mark = () => form.querySelectorAll('.qbv').forEach(row => row.classList.toggle('some', pos((row.querySelector('input') as HTMLInputElement).value) > 0));
    form.addEventListener('input', mark);
    mark();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!total()) return toast('Enter how many to make.');
      const ship = $('#qbShip', card).value;
      if (!ship) return toast('Choose the date they need to be in the mail.');
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      const made = await createBatch(pr, qtys(), ship);
      button.disabled = false;
      if (made) qbOpen = false;
      if (made && location.hash.startsWith('#/s/product')) showBoard();
    });
  };
  draw();
}

async function createBatch(pr, qtys, ship, opts: { source?: string; quiet?: boolean } = {}) {
  const stamp = new Date().toISOString(), s = store.settings, status = 'in_progress', stamped = Date.now();
  const data = {
    ...blankData(), title: pr.name || 'Product', due_date: ship, retainer: 0,
    spec: { ...blankData().spec, type: 'custom', species: '', description: '' },
    lumber: { bf: '', quarters: '', width: '' },
    batch: {
      product_id: pr.id, product: pr.name || 'Product',
      unit_cost: pos(pr.unit_cost), unit_hours: pos(pr.unit_hours), materials: pr.materials || '',
      // Only the variants being made; others can be added on the run's page.
      variants: qtys.filter(v => v.qty > 0).map((v, i) => ({ id: `v${stamped}${i}`, name: v.name, price: pos(v.price), qty: v.qty,
        ...(opts.source === 'shopify' ? { ordered: v.qty, extra: 0 } : {}) })),
      ...(opts.source ? { source: opts.source } : {}),
    },
  };
  data.rates.hourly_rate = s.hourly_rate;
  // Starts in Building and In progress: it is a real order, and materials can be bought straight away.
  const draft = { stream: 'product', status, stage: 'building', data, calc: batchCalc(data), history: [{ status, at: stamp }], created_at: stamp, updated_at: stamp };
  (draft.data as any).todo = defaultTodo(draft);
  let project;
  try { project = await api('/api/projects', draft); }
  catch (e) { if (!opts.quiet) toast(`Not saved: ${e.message}`); return null; }
  store.projects.push(project);
  saved.projects.set(project.id, JSON.stringify(project, unbusy));
  toast(`${opts.source === 'shopify' ? 'New Shopify orders: added' : 'Added'} ${projectName(project)}`);
  return project;
}

// A batch run's own page: units by variant with quick + / - buttons, the ship-by date and status.
function showBatch(p) {
  const b = p.data.batch;
  ed = { project: p, stream: streamOf(p), data: p.data, dirty: false };
  view.innerHTML = `
    ${projectHeader(p, 'details', '<span class="muted">Changes save automatically</span>')}
    <div id="nowStrip" hidden></div>
    <div class="stages" id="stages" role="group" aria-label="Project phase"></div>
    <div class="cols">
      <div>
        <div class="card" id="units"></div>
        <div class="card">
          <div class="grid">
            <label class="f"><span>In the mail by</span><input type="date" id="shipBy" value="${esc(p.data.due_date)}"></label>
            <label class="f w6"><span>Notes</span><textarea id="batchNotes" placeholder="Order numbers, who it's for, packaging...">${esc(p.data.notes)}</textarea></label>
          </div>
        </div>
      </div>
      <aside>
        <div class="card" id="purchasesCard"></div><div class="card" id="statusCard"></div>
        <p class="noprint" style="text-align:right"><button class="link" id="delete" style="color:var(--bad)">Delete this run</button></p>
      </aside>
    </div>`;

  const touch = () => {
    p.calc = batchCalc(p.data);
    p.updated_at = new Date().toISOString();
    $('#projTitle').textContent = projectName(p);
    persist();
  };
  const units = $('#units');
  const renderUnits = () => {
    const n = batchUnits(b), calc = p.calc;
    const unused = (store.settings.products.find(x => x.id === b.product_id)?.variants || []).filter(x => !b.variants.some(v => v.name === x.name));
    units.innerHTML = `<h2>Units to make</h2>
      ${fromShop(b) ? `<p class="note">Kept up to date from your Shopify orders${b.orders?.length ? `: ${b.orders.map(o => esc(o.name)).join(', ')}` : ' (none open right now)'}.
        Use &minus; / + to make more or fewer than ordered.</p>` : ''}
      ${b.variants.map((v, i) => `<div class="qty">
        <span>${esc(v.name || b.product)} <small class="muted">${money(v.price ?? b.unit_price)}${fromShop(b) ? ` &middot; ${pos(v.ordered)} ordered${v.extra ? `, ${v.extra > 0 ? '+' : ''}${v.extra} by hand` : ''}` : ''}</small></span>
        <button type="button" class="btn small" data-step="-1" data-i="${i}" aria-label="One fewer ${esc(v.name || 'unit')}">&minus;</button>
        <input type="number" min="0" step="1" data-i="${i}" value="${pos(v.qty)}" aria-label="${esc(v.name || 'Units')}">
        <button type="button" class="btn small" data-step="1" data-i="${i}" aria-label="One more ${esc(v.name || 'unit')}">+</button>
        <button type="button" class="link" data-remove="${i}" ${b.variants.length === 1 || pos(v.ordered) > 0 ? 'hidden' : ''}>remove</button>
      </div>`).join('')}
      <div class="actions" style="margin-top:10px">
        <select id="addVariant" style="width:auto" aria-label="Variant to add">${unused.map(x => `<option value="${esc(x.name)}">${esc(x.name)} (${money(x.price)})</option>`).join('')}<option value="">Other&hellip;</option></select>
        <button type="button" class="btn small" id="addVariantBtn">+ Add variant</button>
      </div>
      <hr class="rule">
      <div class="tot grand"><span>Total units</span><span>${n}</span></div>
      <div class="tot"><span>Retail value</span><span>${money(calc.total)}</span></div>
      <div class="tot"><span class="muted">Cost to make <small>materials${b.unit_hours ? ' and time' : ''}</small></span><span class="muted">${money(calc.cost)}</span></div>
      ${b.unit_hours ? `<div class="tot"><span class="muted">Shop time</span><span class="muted">${hrs(calc.labor_hours)}</span></div>` : ''}
      ${b.materials ? `<p class="muted" style="margin:10px 0 0;font-size:13px">Materials per unit: ${esc(b.materials)}</p>` : ''}`;
  };
  units.addEventListener('click', e => {
    const el = e.target.closest('button');
    if (!el) return;
    if (el.dataset.step) {
      setVariantQty(b, b.variants[el.dataset.i], Math.round(pos(b.variants[el.dataset.i].qty)) + Number(el.dataset.step));
    } else if (el.dataset.remove !== undefined) {
      b.variants.splice(Number(el.dataset.remove), 1);
    } else if (el.id === 'addVariantBtn') {
      const listed = store.settings.products.find(x => x.id === b.product_id)?.variants || [];
      const name = $('#addVariant').value || prompt('Name of the variant')?.trim();
      if (!name) return;
      b.variants.push({ id: `v${Date.now()}`, name, price: pos(listed.find(x => x.name === name)?.price ?? b.variants[0]?.price), qty: 1, ...(fromShop(b) ? { ordered: 0, extra: 1 } : {}) });
    } else return;
    touch();
    renderUnits();
  });
  units.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.i === undefined || el.tagName !== 'INPUT') return;
    setVariantQty(b, b.variants[el.dataset.i], Math.round(pos(el.value)));
    touch();
    renderUnits();
  });
  onDatePicked($('#shipBy'), () => {
    const input = $('#shipBy');
    if (setPhaseDue(p, lastPhase(p), input.value)) { b.ship_manual = true; touch(); } else input.value = p.data.due_date || '';
    renderStages();
  });
  $('#batchNotes').addEventListener('input', e => { p.data.notes = e.target.value; touch(); });
  $('#delete').addEventListener('click', () => {
    if (!confirm(`Delete ${projectName(p)}? This cannot be undone.`)) return;
    store.projects = store.projects.filter(x => x !== p);
    persist();
    location.hash = boardLink();
  });
  // The phase strip's last date is the ship-by date too, so keep the two in step.
  $('#stages').addEventListener('phasedate', () => { $('#shipBy').value = p.data.due_date || ''; b.ship_manual = true; });
  ed.redraw = () => { $('#shipBy').value = p.data.due_date || ''; renderUnits(); renderStages(); renderStatusCard(); $('#projTitle').textContent = projectName(p); };
  renderUnits();
  renderStages();
  renderStatusCard();
  renderPurchasesCard(p);
}

// ---------- product catalog (for batch runs) ----------
// Products, variants and prices come from the jmwood.work shop: the server reads the collection shown
// on its Small Batch Projects page. They are copied into the settings so the form works offline too;
// what it costs to make each unit, how long it takes and what to buy are filled in on the Products page.
let shopState = 'loading';   // 'loading', 'ok' or 'failed'
async function loadShopProducts() {
  let shop;
  try {
    const res = await fetch('/api/shop-products', { cache: 'no-cache' });
    shop = res.ok ? await res.json() : null;
  } catch { shop = null; }
  if (!Array.isArray(shop?.products)) {
    shopState = 'failed';
    if ($('#quickBatch') && !(store.settings.products || []).length) renderQuickBatch();
    return;
  }
  shopState = 'ok';
  const s = store.settings, before = JSON.stringify(s.products || []);
  s.products ??= [];
  for (const item of shop.products) {
    let pr = s.products.find(x => x.handle === item.handle);
    if (!pr) s.products.push(pr = { id: item.handle, handle: item.handle, unit_cost: 0, unit_hours: 0, materials: '' });
    Object.assign(pr, { name: item.title, variants: item.variants, listed: true });
  }
  // Taken off the shop: kept (with its notes) in case it comes back, but not offered for new runs.
  for (const pr of s.products) if (pr.handle && !shop.products.some(x => x.handle === pr.handle)) pr.listed = false;
  s.products.sort((a, b) => shop.products.findIndex(x => x.handle === a.handle) - shop.products.findIndex(x => x.handle === b.handle));
  if (JSON.stringify(s.products) !== before) settingsChanged();
  if ($('#quickBatch')) renderQuickBatch();
  else if (currentHash.startsWith('#/products')) showProducts();
}

function showProducts() {
  const s = store.settings, products = (s.products ||= []).filter(x => x.listed !== false);
  const range = pr => {
    const prices = pr.variants.map(v => pos(v.price));
    const lo = Math.min(...prices), hi = Math.max(...prices);
    return !prices.length ? '' : lo === hi ? money(lo) : `${money(lo)} to ${money(hi)}`;
  };
  view.innerHTML = `<a href="#/s/product" class="back">&larr; Product line</a>
    <div class="pagehead"><h1>Products</h1><span class="spacer"></span><span class="muted">Changes save automatically</span></div>
    <p class="muted">Products, variants and prices come from the Small Batch Projects page on jmwood.work, so change them in Shopify.
      Fill in what each unit takes to make here: it goes into a batch run's cost and shows on the run's page.
      A run copies these numbers when it's created, so changing them later doesn't change runs already under way.</p>
    ${shopState === 'failed' ? '<p class="note err">The shop couldn\'t be reached just now, so this is the list as last loaded.</p>' : ''}
    ${products.length ? '' : `<div class="card"><p class="muted" style="margin:0">${shopState === 'loading' ? 'Loading products from jmwood.work&hellip;' : 'No products found.'}</p></div>`}
    <div id="productList">${products.map(pr => `<div class="card" data-id="${esc(pr.id)}">
      <div class="actions" style="margin-bottom:10px"><b>${esc(pr.name)}</b><span class="muted">${pr.variants.length} variant${pr.variants.length === 1 ? '' : 's'}, ${range(pr)}</span></div>
      <p class="muted" style="margin:0 0 12px;font-size:13px">${pr.variants.map(v => `${esc(v.name)} (${money(v.price)})`).join(' &middot; ')}</p>
      <div class="grid">
        <label class="f"><span>Materials cost per unit ($)</span><input data-k="unit_cost" type="number" min="0" step="any" value="${esc(pr.unit_cost)}"></label>
        <label class="f"><span>Shop hours per unit</span><input data-k="unit_hours" type="number" min="0" step="any" value="${esc(pr.unit_hours)}"></label>
        <label class="f"><span>Days from order to in the mail</span><input data-k="lead_days" type="number" min="0" step="1" value="${esc(pr.lead_days ?? DEFAULT_LEAD_DAYS)}"></label>
        <label class="f w6"><span>Materials to buy per unit (shown on the run's page)</span><input data-k="materials" value="${esc(pr.materials)}" placeholder="e.g. 1.5 bf walnut, 2 rubber feet"></label>
      </div></div>`).join('')}</div>`;
  $('#productList').addEventListener('input', e => {
    const k = e.target.dataset.k, pr = s.products.find(x => x.id === e.target.closest('[data-id]')?.dataset.id);
    if (!k || !pr) return;
    pr[k] = inputValue(e.target);
    settingsChanged();
  });
}

// ---------- runs fed by Shopify orders ----------
// With the Shopify app connected, each product with unfulfilled orders has one open batch run that
// holds everything still owed for it, by variant. New orders add to it, fulfilled or cancelled ones
// come off, and when nothing is left to make it is marked complete. The next order starts a new run.
// Each variant keeps what was ordered and what was added or taken off by hand: qty = ordered + extra.
// The ship-by date is the oldest open order's date plus the product's lead time, unless it was set by hand.
const DEFAULT_LEAD_DAYS = 14;
function fromShop(b) { return b.source === 'shopify'; }
function setVariantQty(b, v, qty) {
  v.qty = Math.max(0, qty);
  if (fromShop(b)) v.extra = v.qty - pos(v.ordered);
}
const shipByFor = (pr, orders) => {
  const d = new Date(orders.map(o => o.created_at).sort()[0]);
  d.setDate(d.getDate() + Math.round(pos(pr.lead_days ?? DEFAULT_LEAD_DAYS)));
  return ymd(d);
};

let ordersBusy = false;
async function loadShopOrders() {
  if (!store.shopifyConnected || ordersBusy) return;
  ordersBusy = true;
  try {
    const res = await fetch('/api/shop-orders', { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    if (Array.isArray(data?.orders)) await syncRunsWithOrders(data.orders);
    else if (data?.error) console.warn(`Shopify orders: ${data.error}`);
  } catch {}
  ordersBusy = false;
}

async function syncRunsWithOrders(orders) {
  const touched = [];
  for (const pr of store.settings.products || []) {
    const mine = orders.map(o => ({ ...o, items: o.items.filter(i => i.handle === pr.handle) })).filter(o => o.items.length);
    const owed = new Map();
    for (const o of mine) for (const i of o.items) owed.set(i.variant, (owed.get(i.variant) || 0) + i.qty);
    let run = store.projects.find(p => isBatch(p) && fromShop(p.data.batch) && p.data.batch.product_id === pr.id && !archived(p));
    if (!run) {
      if (!mine.length) continue;
      run = await createBatch(pr, [...owed].map(([name, qty]) => ({ name, qty, price: pr.variants.find(v => v.name === name)?.price ?? 0 })),
        shipByFor(pr, mine), { source: 'shopify', quiet: true });
      if (!run) return;   // the server couldn't be reached: try again next time
    }
    const b = run.data.batch, before = JSON.stringify([b, run.data.due_date, run.status]);
    for (const [name, qty] of owed) {
      let v = b.variants.find(x => x.name === name);
      if (!v) b.variants.push(v = { id: `v${Date.now()}${b.variants.length}`, name, price: pr.variants.find(x => x.name === name)?.price ?? 0, extra: 0 });
      v.ordered = qty;
    }
    for (const v of b.variants) {
      if (!owed.has(v.name)) v.ordered = 0;
      v.extra ??= 0;
      v.qty = Math.max(0, pos(v.ordered) + v.extra);
    }
    b.variants = b.variants.filter(v => v.qty > 0 || v.ordered > 0);
    b.orders = mine.map(o => ({ name: o.name, created_at: o.created_at }));
    // What each order paid for this product, kept after it ships, for the run's profit summary.
    for (const o of mine) {
      if (!o.items.some(i => i.amount !== undefined)) continue;   // a list read before amounts were asked for
      (b.sales ||= {})[o.name] = { at: o.created_at, units: o.items.reduce((n, i) => n + pos(i.quantity ?? i.qty), 0), amount: cents(o.items.reduce((n, i) => n + num(i.amount), 0)) };
    }
    if (mine.length && !b.ship_manual) run.data.due_date = shipByFor(pr, mine);
    if (!b.variants.length) {   // everything has shipped
      b.variants = [];
      run.status = 'complete';
      run.history.push({ status: 'complete', at: new Date().toISOString() });
      finishTodo(run);
      if (isFrozen(run)) { delete run.data.frozen; run.history.push({ frozen: false, at: new Date().toISOString() }); }
    }
    if (JSON.stringify([b, run.data.due_date, run.status]) === before) continue;
    run.calc = batchCalc(run.data);
    run.updated_at = new Date().toISOString();
    touched.push(run);
  }
  if (!touched.length) return;
  persist();
  // Show the new numbers on whatever page is open.
  if (ed?.project && touched.includes(ed.project) && ed.redraw) ed.redraw();
  else if (!ed && (currentHash === '#/' || currentHash.startsWith('#/s/') || currentHash.startsWith('#/calendar'))) route();
}

// ---------- receipts: material purchases ----------
// A photo of a store receipt is sent to the server, which keeps it (the receipts table, for taxes and
// audits) and reads it (Workers AI, see src/lib/receipts.ts) into line items. They're shown here to
// check over: fix a description or price, untick what isn't for this job, pick the project, and the
// ticked items are added to that project's material purchases
// (data.purchases: [{ id, date, store, item, qty, amount, receipt }], `receipt` being the receipt's id).
// Items left over can then go to another project from the same receipt. A receipt that can't be read
// keeps its photo and the lines are typed in; a purchase with no receipt at all can be typed in too.
const SCAN_MAX_SIDE = 1600;   // long side of the photo sent to the server, in pixels: plenty to read a receipt
const PHOTO_MAX_CHARS = 1_400_000;   // what the server will keep (a D1 row); photos are made smaller until they fit
let scan = null;              // the receipt being checked over: { id, store, date, total, tax, image, kept, lines: [{ description, qty, amount, on, added }] }
let scanFailed = null;        // a photo that couldn't be read: { id, image, kept, message }
let scanGeneral = false;      // the ticked items are general business expenses, not for one project
let scanProjectId = null;     // the project picked to add items to
let purchaseSeq = 0;

const purchasesOf = p => (p.data.purchases ||= []);
const spentOn = p => cents((p.data.purchases || []).reduce((n, x) => n + num(x.amount), 0));
// What the project expected to spend on materials: lumber and hardware for a piece, materials for a batch run.
const budgetFor = p => isBatch(p) ? num(p.calc.materials_est) : num(p.calc.materials_est) + num(p.calc.other_costs);
// Projects that can take purchases, most recently touched first.
const purchaseProjects = () => store.projects.filter(p => !archived(p) || p.id === scanProjectId).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
const receiptId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// A photo can be replaced, so its address carries a version (its size) and the browser keeps each version.
const photoUrl = (id, v?) => `/api/receipts/${encodeURIComponent(id)}/photo${v ? `?v=${v}` : ''}`;

// Shrinks a phone photo (often 4000+ px) to a JPEG data URL small enough to send quickly and keep.
async function shrinkPhoto(file: File) {
  // createImageBitmap turns the photo upright from its camera orientation, as it's shown on screen.
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => { throw new Error("That file couldn't be opened as a photo."); });
  let side = SCAN_MAX_SIDE, quality = 0.85, url = '';
  for (let tries = 0; tries < 6; tries++) {
    const scale = Math.min(1, side / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';   // a transparent PNG would otherwise turn black as a JPEG
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= PHOTO_MAX_CHARS) break;
    quality = Math.max(0.6, quality - 0.1);
    if (quality === 0.6) side = Math.round(side * 0.85);
  }
  img.close();
  return url;
}

// The server's own explanation reads better than "The server returned 400: {...}".
const serverSaid = error => String(error.message).match(/"error":"([^"]+)"/)?.[1] || error.message;

async function readReceipt(file: File) {
  const box = $('#scanBox');
  scan = null;
  scanFailed = null;
  scanGeneral = false;
  box.innerHTML = '<p class="scanning">Reading the receipt&hellip; <span class="muted">this takes a few seconds</span></p>';
  let image = '', id = receiptId(), kept = false;
  try {
    image = await shrinkPhoto(file);
    box.insertAdjacentHTML('afterbegin', `<img class="receiptimg" src="${image}" alt="The receipt photo">`);
    const r = await api('/api/receipts/scan', { id, image });
    kept = !!r.kept;
    if (r.error) throw new Error(r.error);
    if (!r.items.length) throw new Error("No items could be read from that photo. Try again with the whole receipt flat, in good light, or type the items in.");
    scan = {
      id, image, kept, store: r.store, date: r.date || ymd(new Date()), total: r.total, tax: r.tax, notes: '', general: [],
      lines: [...r.items.map(i => ({ description: i.description, qty: i.quantity, amount: i.amount, on: true })),
        ...(r.tax ? [{ description: 'Sales tax', qty: 1, amount: r.tax, on: true, tax: true }] : [])],
    };
    renderScan();
  } catch (error) {
    scanFailed = image ? { id, image, kept, message: serverSaid(error) } : null;
    if (scanFailed) renderScanFailed();
    else box.innerHTML = `<p class="note err">${esc(serverSaid(error))}</p>`;
  }
}

// Reading failed: the photo is still kept, and the lines can be typed in from it.
function renderScanFailed() {
  const box = $('#scanBox');
  if (!box || !scanFailed) return;
  box.innerHTML = `<img class="receiptimg" src="${scanFailed.image}" alt="The receipt photo">
    <p class="note err" style="margin-top:12px">${esc(scanFailed.message)}</p>
    <div class="actions"><button type="button" class="btn" data-byhand>Type the items in from this photo</button></div>`;
}

// Starts a receipt to type in: from a photo that couldn't be read, or with no photo at all.
function startByHand(from = null) {
  scan = { id: from?.id || receiptId(), image: from?.image || '', kept: !!from?.kept, store: '', date: ymd(new Date()), total: 0, tax: 0,
    notes: '', general: [], lines: [{ description: '', qty: 1, amount: '', on: true }] };
  scanFailed = null;
  scanGeneral = false;
  renderScan();
  $('#scanBox [data-scan="store"]')?.focus();
}

function showReceipt(projectId) {
  if (projectId) scanProjectId = projectId;
  const from = store.projects.find(p => p.id === projectId);
  view.innerHTML = `
    ${from && !sectionOf(prevHash) ? `<a href="#/p/${from.id}/summary" class="back">&larr; ${esc(projectName(from))}</a>` : backLink(boardLink(), 'Projects')}
    <div class="pagehead"><h1>Scan a receipt</h1><span class="spacer"></span><a class="btn small" href="#/receipts">All receipts</a></div>
    <div class="card receipt">
      <div class="actions">
        <label class="btn primary">Take a photo<input type="file" accept="image/*" capture="environment" data-photo hidden></label>
        <label class="btn">Choose a photo<input type="file" accept="image/*" data-photo hidden></label>
        <span class="muted" style="font-size:13px">Lay the receipt flat in good light, with the whole thing in the picture. The photo is kept with the receipt.</span>
      </div>
      <p style="margin:10px 0 0;font-size:13px"><button type="button" class="link" data-nophoto>No receipt? Type a purchase in by hand</button></p>
      <div id="scanBox"></div>
    </div>`;
  view.querySelectorAll('[data-photo]').forEach((input: HTMLInputElement) => input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) readReceipt(file);
  }));
  if (scan) renderScan(); else if (scanFailed) renderScanFailed();
}

function renderScan() {
  const box = $('#scanBox');
  if (!box || !scan) return;
  const picked = scan.lines.filter(l => l.on && !l.added);
  const pickedSum = cents(picked.reduce((n, l) => n + num(l.amount), 0));
  const allSum = cents(scan.lines.reduce((n, l) => n + num(l.amount), 0));
  const left = scan.lines.filter(l => !l.added);
  const projects = purchaseProjects();
  if (!projects.some(p => p.id === scanProjectId)) scanProjectId = projects[0]?.id ?? null;
  box.innerHTML = `${scan.image ? `<img class="receiptimg" src="${scan.image}" alt="The receipt photo">` : ''}
    <div class="grid" style="margin-top:14px">
      <label class="f w3"><span>Store</span><input data-scan="store" value="${esc(scan.store)}"></label>
      <label class="f"><span>Date</span><input type="date" data-scan="date" value="${esc(scan.date)}"></label>
      <label class="f w6"><span>Notes <small class="muted" style="font-weight:400">what you bought and why</small></span><textarea data-scan="notes" rows="2" placeholder="e.g. Glue and hinges for the stool lid; spare blade for the table saw">${esc(scan.notes || '')}</textarea></label>
    </div>
    <div class="scanhead">
      <h2>Items ${scan.image ? 'on the receipt' : 'bought'}</h2>
      ${left.length > 1 ? `<span class="muted" style="font-size:13px"><button type="button" class="link" data-all="1">Tick all</button> &middot; <button type="button" class="link" data-all="0">Untick all</button></span>` : ''}
    </div>
    <ul class="scanlines">${scan.lines.map((l, i) => `<li class="${l.added ? 'added' : l.on ? '' : 'off'}">
      <input type="checkbox" data-i="${i}" data-k="on" ${l.on && !l.added ? 'checked' : ''} ${l.added ? 'disabled' : ''} aria-label="Include ${esc(l.description)}">
      <input data-i="${i}" data-k="description" value="${esc(l.description)}" ${l.added ? 'disabled' : ''} placeholder="What was bought" aria-label="Item">
      <input type="number" step="any" inputmode="decimal" data-i="${i}" data-k="amount" value="${esc(l.amount)}" ${l.added ? 'disabled' : ''} placeholder="$" aria-label="Price ($)">
      ${l.added ? `<span class="addedto">Added to ${esc(l.added)}</span>` : `<button type="button" class="link" data-remove="${i}" aria-label="Remove this line">&times;</button>`}
    </li>`).join('')}</ul>
    <button type="button" class="link" data-addline>+ Add ${scan.image ? 'a line that was missed' : 'another line'}</button>
    <hr class="rule">
    ${scan.total && Math.abs(allSum - scan.total) >= 0.01 ? `<p class="note">The lines add up to ${money(allSum)}, but the receipt total reads ${money(scan.total)}. Check for a missed or misread line.</p>` : ''}
    ${left.length ? `<label class="checkline"><input type="checkbox" id="scanGeneral" ${scanGeneral ? 'checked' : ''}> <span><b>General business expense</b>
      <small class="muted">not for one project: tools, shop supplies, shipping materials&hellip;</small></span></label>
    ${scanGeneral ? '' : `<div class="grid">
      <label class="f w4"><span>Add the ticked items to</span><select id="scanProject">${projects.map(p =>
        `<option value="${p.id}" ${p.id === scanProjectId ? 'selected' : ''}>${esc(projectName(p))}${isClient(p) ? ` (${esc(p.data.client_name || p.quote_number)})` : ''}</option>`).join('')}</select></label>
    </div>`}
    <div class="actions" style="margin-top:12px">
      <button type="button" class="btn primary" id="scanAdd" ${picked.length && (scanGeneral || scanProjectId) ? '' : 'disabled'}>Add ${picked.length} item${picked.length === 1 ? '' : 's'} (${money(pickedSum)}) to ${scanGeneral ? 'general business expenses' : 'material costs'}</button>
    </div>` : `<p class="note ok">Every item on this receipt has been added.</p>`}
    <p style="margin-top:14px"><button type="button" class="link" data-new>Done with this receipt &middot; ${scan.image ? 'scan another' : 'start another'}</button></p>`;
  const sel = $('#scanProject', box);
  if (sel) typeAhead(sel);
}

// One listener on the page for the whole check-over form, so redraws don't stack up handlers.
function scanEvents(e: Event) {
  const el = e.target as any;
  if (e.type === 'click' && el.closest?.('[data-nophoto]')) {
    if (scan?.lines.some(l => l.on && !l.added) && !confirm('Some ticked items haven\'t been added to a project yet. Start over anyway?')) return;
    return startByHand();
  }
  if (e.type === 'click' && el.closest?.('[data-byhand]')) return startByHand(scanFailed);
  if (!scan || !el.closest?.('#scanBox')) return;
  if (e.type === 'input' || e.type === 'change') {
    if (el.dataset.scan) {
      scan[el.dataset.scan] = el.value;
      // Once filed, a change to the store, date or notes is saved straight away.
      if (e.type === 'change' && scan.filed) fileReceipt(scan).catch(error => toast(`Not saved: ${serverSaid(error)}`));
      return;
    }
    if (el.id === 'scanGeneral') { if (e.type === 'change') { scanGeneral = el.checked; renderScan(); } return; }
    if (el.id === 'scanProject') { scanProjectId = Number(el.value); if (e.type === 'change') renderScan(); return; }
    const line = scan.lines[el.dataset.i];
    if (!line) return;
    if (el.dataset.k === 'on') line.on = el.checked;
    else if (el.dataset.k === 'amount') line.amount = el.value === '' ? '' : cents(num(el.value));
    else line.description = el.value;
    if (e.type !== 'change') return;
    if (el.dataset.k === 'on') return renderScan();
    // Redraw once focus has moved on, then put it back where it went (as the labor panel does).
    setTimeout(() => {
      const f = (document.activeElement as HTMLElement)?.dataset;
      renderScan();
      if (f?.i !== undefined && f.k) $(`#scanBox [data-i="${f.i}"][data-k="${f.k}"]`)?.focus();
    });
    return;
  }
  const btn = el.closest('button');
  if (!btn) return;
  if (btn.dataset.all) scan.lines.forEach(l => { if (!l.added) l.on = btn.dataset.all === '1'; });
  else if (btn.dataset.remove) scan.lines.splice(Number(btn.dataset.remove), 1);
  else if (btn.dataset.addline !== undefined) {
    scan.lines.push({ description: '', qty: 1, amount: '', on: true });
    renderScan();
    $(`#scanBox [data-i="${scan.lines.length - 1}"][data-k="description"]`)?.focus();
    return;
  } else if (btn.dataset.new !== undefined) {
    if (scan.lines.some(l => l.on && !l.added) && !confirm('Some ticked items haven\'t been added to a project yet. Start over anyway?')) return;
    scan = null;
    $('#scanBox').innerHTML = '';
    return;
  } else if (btn.id === 'scanAdd') { addScanned(); return; }
  renderScan();
}
view.addEventListener('click', scanEvents);
view.addEventListener('input', scanEvents);
view.addEventListener('change', scanEvents);

// Files the receipt (its photo, if not kept yet, then store, date and total) before its lines go on
// the project, so every purchase on a project has its receipt on file.
async function fileReceipt(r) {
  if (r.image && !r.kept) {
    await api('/api/receipts/photo', { id: r.id, image: r.image });
    r.kept = true;
  }
  const lineSum = cents(r.lines.reduce((n, l) => n + num(l.amount), 0));
  const tax = cents(r.lines.filter(l => l.tax || /^sales tax$/i.test(String(l.description).trim())).reduce((n, l) => n + num(l.amount), 0)) || num(r.tax);
  await api('/api/receipts', { id: r.id, store: r.store, date: r.date, total: r.total || lineSum, tax, notes: r.notes || '', general: r.general || [] });
  r.filed = true;
  receiptLog = null;   // the list is out of date now
}

let filing = false;
const lineId = () => `m${Date.now().toString(36)}${(purchaseSeq++).toString(36)}`;
async function addScanned() {
  const general = scanGeneral;
  const p = general ? null : store.projects.find(x => x.id === scanProjectId);
  const lines = scan.lines.filter(l => l.on && !l.added && String(l.description).trim());
  if ((!general && !p) || !lines.length || filing) return;
  const r = scan;
  filing = true;
  const btn = $('#scanAdd');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving the receipt…'; }
  // General business expenses are kept with the receipt itself, so they're saved with it.
  const before = r.general || [];
  if (general) r.general = [...before, ...lines.map(l => ({ id: lineId(), item: String(l.description).trim(), qty: l.qty || 1, amount: cents(num(l.amount)) }))];
  try { await fileReceipt(r); }
  catch (error) {
    filing = false;
    r.general = before;
    toast(`The receipt couldn't be saved, so nothing was added: ${serverSaid(error)}`);
    renderScan();
    return;
  }
  filing = false;
  if (general) {
    for (const l of lines) { l.added = 'general business expenses'; l.on = false; }
    toast(`Added ${lines.length} item${lines.length === 1 ? '' : 's'} to general business expenses.`);
    if (scan === r) renderScan();
    return;
  }
  for (const l of lines) {
    purchasesOf(p).push({ id: lineId(), date: r.date, store: String(r.store).trim(),
      item: String(l.description).trim(), qty: l.qty || 1, amount: cents(num(l.amount)), receipt: r.id });
    l.added = projectName(p);
    l.on = false;
  }
  p.updated_at = new Date().toISOString();
  persist();
  toast(`Added ${lines.length} item${lines.length === 1 ? '' : 's'} to ${projectName(p)}. Spent on materials so far: ${money(spentOn(p))}`);
  if (scan === r) renderScan();
}

// The "Material purchases" card on a project's page.
function renderPurchasesCard(p) {
  const card = $('#purchasesCard');
  if (!card) return;
  const list = [...(p.data.purchases || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const spent = spentOn(p), budget = budgetFor(p);
  card.innerHTML = `<h2>Material purchases</h2>
    ${list.length ? `<ul class="purchases">${list.map(x => `<li>
      <span>${esc(x.item)}<br><small class="muted">${[x.store, x.date && shortDay(x.date)].filter(Boolean).map(esc).join(' &middot; ')}</small></span>
      <span class="amt">${money(x.amount)}</span>
      <button type="button" class="link" data-unpurchase="${esc(x.id)}" aria-label="Remove ${esc(x.item)}">&times;</button>
    </li>`).join('')}</ul>
    <hr class="rule">
    <div class="tot"><b>Spent on materials</b><b>${money(spent)}</b></div>
    ${budget ? `<div class="tot"><span class="muted">Estimated <small>${isBatch(p) ? 'materials' : 'lumber and hardware'}</small></span><span class="muted">${money(budget)}</span></div>
    <div class="tot"><span class="${spent > budget ? 'over' : 'muted'}">${spent > budget ? 'Over the estimate' : 'Left in the estimate'}</span><span class="${spent > budget ? 'over' : 'muted'}">${money(Math.abs(budget - spent))}</span></div>` : ''}`
    : '<p class="muted" style="margin:0 0 10px;font-size:14px">Nothing bought for this project yet.</p>'}
    <div class="actions" style="margin-top:10px"><a class="btn small" href="#/receipt/${p.id}">Scan a receipt</a><a class="btn small" href="#/p/${p.id}/summary">Profit and receipts</a></div>`;
}
view.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-unpurchase]');
  const p = ed?.project;
  if (!btn || !p) return;
  const item = (p.data.purchases || []).find(x => x.id === btn.dataset.unpurchase);
  if (!item || !confirm(`Remove ${item.item} (${money(item.amount)}) from this project's purchases?${item.receipt ? ' The receipt photo stays on file under All receipts.' : ''}`)) return;
  p.data.purchases = p.data.purchases.filter(x => x !== item);
  p.updated_at = new Date().toISOString();
  persist();
  if (ed.redraw && $('#summary')) ed.redraw(); else renderPurchasesCard(p);
});

// ---------- every receipt kept ----------
let receiptLog = null;   // [{ id, store, date, total, tax, has_photo, created_at }] from the server, newest first
async function loadReceipts() {
  if (!receiptLog) receiptLog = (await api('/api/receipts')).receipts;
  return receiptLog;
}
// Where each receipt's lines went: receipt id -> [{ p, lines }].
function receiptUses() {
  const uses = new Map();
  for (const p of store.projects) for (const x of p.data.purchases || []) {
    if (!x.receipt) continue;
    const list = uses.get(x.receipt) || [];
    let use = list.find(u => u.p === p);
    if (!use) list.push(use = { p, lines: [] });
    use.lines.push(x);
    uses.set(x.receipt, list);
  }
  return uses;
}

// A photo, full screen. Tap anywhere (or press Escape) to close it.
function showPhoto(src, caption = '', id = '') {
  const box = document.createElement('div');
  box.className = 'photoview';
  box.innerHTML = `<img src="${esc(src)}" alt="${esc(caption || 'Receipt photo')}"><div class="cap">${esc(caption)} <a href="${esc(src)}" target="_blank" rel="noopener">Open on its own</a> &middot; tap to close</div>
    ${id ? '<div class="photoacts"><button type="button" class="btn small" data-act="replace">Replace photo</button><button type="button" class="btn small" data-act="remove">Remove photo</button></div>' : ''}`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    if (t.closest('a')) return;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'replace') {
      // The wrong photo was kept: pick (or take) the right one, and it takes this one's place.
      pickPhoto(file => { close(); addReceiptPhoto(id, file); });
      return;
    }
    if (act === 'remove') {
      if (!confirm('Remove this photo from the receipt? The receipt and its lines stay; you can add another photo after.')) return;
      close();
      removeReceiptPhoto(id);
      return;
    }
    close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(box);
}
view.addEventListener('click', e => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-photo-id]');
  if (!t) return;
  e.preventDefault();
  showPhoto((t as HTMLAnchorElement).getAttribute('href') || photoUrl(t.dataset.photoId), t.dataset.caption, t.dataset.photoId);
});
// A receipt from before photos were kept has none: show a note in its place.
view.addEventListener('error', e => {
  const img = e.target as HTMLElement;
  if (img.tagName !== 'IMG' || !img.classList.contains('rthumb')) return;
  const holder = img.closest('[data-photo-id]');
  const id = (holder as HTMLElement)?.dataset.photoId;
  const box = document.createElement(id ? 'button' : 'span');
  box.className = id ? 'nophoto addphoto' : 'nophoto';
  box.innerHTML = id ? ADD_PHOTO_INNER : 'No photo kept';
  if (id) Object.assign(box, { type: 'button', title: ADD_PHOTO_TITLE }).dataset.addphoto = id;
  (holder || img).replaceWith(box);
}, true);

// The box shown in place of a missing receipt photo: a camera and "Add photo" (dragging one in is in the tooltip).
const ADD_PHOTO_TITLE = 'No photo kept. Tap to add one, or drag a photo here.';
const ADD_PHOTO_INNER = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>Add photo</span>';
const addPhotoButton = (id: string) => `<button type="button" class="nophoto addphoto" data-addphoto="${esc(id)}" title="${ADD_PHOTO_TITLE}" aria-label="Add a photo of this receipt">${ADD_PHOTO_INNER}</button>`;

// A receipt with no photo (scanned before photos were kept, or typed in): tap its box to pick one from the
// phone's photos (or take one), or drag a photo onto it on a computer.
async function addReceiptPhoto(id: string, file: File, btn?: HTMLElement) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic)$/i.test(file.name)) { toast('That file isn\'t a photo. Use a JPG or PNG.'); return; }
  if (btn) btn.innerHTML = 'Saving&hellip;'; else toast('Saving the photo…');
  try {
    const image = await shrinkPhoto(file);
    // What's known about the receipt (from its lines, for one scanned before receipts were kept), so it's listed properly.
    const r = withOldReceipts([...await loadReceipts()], receiptUses()).find(x => x.id === id);
    await api('/api/receipts/photo', { id, image });
    if (r) await api('/api/receipts', { id, store: r.store, date: r.date, total: r.total, tax: r.tax, notes: r.notes || '' });
    receiptLog = null;
    toast('Photo saved with the receipt.');
  } catch (error) {
    toast(`The photo couldn't be saved: ${serverSaid(error)}`);
  }
  redrawReceipts();
}
// Redraw where we are (All receipts, or a project's Summary), without jumping back to the top.
function redrawReceipts() {
  if (currentHash.startsWith('#/receipts')) showReceiptLog(currentHash.split('/')[2] || '');
  else if (ed?.redraw && $('#summary')) loadReceipts().then(() => ed?.redraw?.()).catch(() => {});
}
async function removeReceiptPhoto(id: string) {
  try {
    await api(`/api/receipts/${encodeURIComponent(id)}/photo/delete`, {});
    receiptLog = null;
    toast('Photo removed. Tap Add photo to put the right one on.');
  } catch (error) {
    toast(`The photo couldn't be removed: ${serverSaid(error)}`);
  }
  redrawReceipts();
}
// The phone's photo picker (or camera); a file chooser on a computer.
function pickPhoto(then: (file: File) => void) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
  input.addEventListener('change', () => { const file = input.files?.[0]; if (file) then(file); });
  input.click();
}
view.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-addphoto]');
  if (!btn) return;
  pickPhoto(file => addReceiptPhoto(btn.dataset.addphoto, file, btn));
});
const dropTarget = (e: DragEvent) => (e.target as HTMLElement).closest?.<HTMLElement>('[data-addphoto]');
view.addEventListener('dragover', (e: DragEvent) => {
  const btn = dropTarget(e);
  if (!btn) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  btn.classList.add('over');
});
view.addEventListener('dragleave', (e: DragEvent) => dropTarget(e)?.classList.remove('over'));
view.addEventListener('drop', (e: DragEvent) => {
  const btn = dropTarget(e);
  if (!btn) return;
  e.preventDefault();
  btn.classList.remove('over');
  const file = e.dataTransfer.files?.[0];
  if (file) addReceiptPhoto(btn.dataset.addphoto, file, btn);
});

const yearOf = r => (r.date || r.created_at || '').slice(0, 4);

// The receipts kept, plus ones scanned before photos were kept (only named by their lines on projects).
function withOldReceipts(log, uses) {
  const filed = new Set(log.map(r => r.id));
  return [...log, ...[...uses].filter(([id]) => !filed.has(id)).map(([id, used]) => {
    const first = used[0].lines[0];
    return { id, store: first.store, date: first.date, has_photo: false, created_at: '', notes: '', general: [], old: true,
      total: cents(used.reduce((n, u) => n + u.lines.reduce((m, x) => m + num(x.amount), 0), 0)),
      tax: cents(used.reduce((n, u) => n + u.lines.filter(x => /^sales tax$/i.test(x.item)).reduce((m, x) => m + num(x.amount), 0), 0)) };
  })].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function showReceiptLog(year) {
  view.innerHTML = `<a href="#/receipt" class="back">&larr; Scan a receipt</a>
    <div class="pagehead"><h1>All receipts</h1></div><div class="card"><p class="muted">Loading&hellip;</p></div>`;
  let log;
  try { log = [...await loadReceipts()]; }
  catch (error) { $('.card', view).innerHTML = `<p class="note err">${esc(serverSaid(error))}</p>`; return; }
  if (!currentHash.startsWith('#/receipts')) return;   // moved on while loading
  const uses = receiptUses();
  log = withOldReceipts(log, uses);
  const years = [...new Set(log.map(yearOf).filter(Boolean))].sort().reverse();
  const shown = year ? log.filter(r => yearOf(r) === year) : log;
  const sum = (list, f) => cents(list.reduce((n, x) => n + num(f(x)), 0));
  const generalSum = list => sum(list, r => sum(r.general || [], l => l.amount));
  view.innerHTML = `<a href="#/receipt" class="back">&larr; Scan a receipt</a>
    <div class="pagehead"><h1>All receipts</h1></div>
    <div class="card" id="qbCard"></div>
    <nav class="tabs"><a href="#/receipts" class="${year ? '' : 'on'}">All</a>${years.map(y => `<a href="#/receipts/${y}" class="${y === year ? 'on' : ''}">${y}</a>`).join('')}</nav>
    <div class="card">
      ${shown.length ? `<div class="tot grand" style="margin-top:0;border-top:0;padding-top:0"><span>${shown.length} receipt${shown.length === 1 ? '' : 's'}${year ? ` in ${year}` : ''}</span><span>${money(sum(shown, r => r.total))}</span></div>
      <div class="tot"><span class="muted">Sales tax paid</span><span class="muted">${money(sum(shown, r => r.tax))}</span></div>
      ${generalSum(shown) ? `<div class="tot"><span class="muted">General business expenses</span><span class="muted">${money(generalSum(shown))}</span></div>` : ''}
      <ul class="rlog">${shown.map(r => {
        const used = uses.get(r.id) || [];
        return `<li>
          ${r.has_photo ? `<a href="${photoUrl(r.id, r.photo_v)}" class="thumb" data-photo-id="${esc(r.id)}" data-caption="${esc([r.store, r.date && fmtDate(r.date)].filter(Boolean).join(', '))}"><img class="rthumb" loading="lazy" src="${photoUrl(r.id, r.photo_v)}" alt="Receipt photo"></a>` : addPhotoButton(r.id)}
          <div class="rinfo"><b>${esc(r.store || 'Store not given')}</b> <span class="muted">${esc(r.date ? fmtDate(r.date) : '')}</span>
            ${r.notes ? `<div class="rnote">${esc(r.notes)}</div>` : ''}
            <div class="rprojects">${used.map(u => `<a href="#/p/${u.p.id}/summary">${esc(projectName(u.p))}</a> ${money(sum(u.lines, x => x.amount))}`).join(' &middot; ')}
              ${!used.length && !(r.general || []).length ? `<span class="muted">Not on any project.</span> <button type="button" class="link" data-delreceipt="${esc(r.id)}" style="color:var(--bad)">Delete</button>` : ''}</div>
            ${(r.general || []).length ? `<div class="rgeneral"><b>General business</b><ul class="purchases">${r.general.map(l => `<li><span>${esc(l.item)}</span><span class="amt">${money(l.amount)}</span>
              <button type="button" class="link" data-ungeneral="${esc(r.id)}:${esc(l.id)}" aria-label="Remove ${esc(l.item)}">&times;</button></li>`).join('')}</ul></div>` : ''}
            ${r.old ? '' : `<button type="button" class="link rnotebtn" data-renote="${esc(r.id)}">${r.notes ? 'Edit notes' : 'Add notes'}</button>`}</div>
          <span class="amt">${money(r.total)}</span>
        </li>`;
      }).join('')}</ul>` : '<p class="muted" style="margin:0">No receipts kept yet. Scan one and its photo is kept here.</p>'}
    </div>
    <p class="muted" style="font-size:13px">Every receipt photo scanned is kept, even ones with no lines added to a project. Receipts scanned before photos were kept show No photo.</p>`;
  renderQuickBooksCard();
  // Notes and general business lines are saved on the receipt itself.
  const resave = async (r, change) => {
    try { await api('/api/receipts', { ...r, ...change }); }
    catch (error) { toast(`Not saved: ${serverSaid(error)}`); return; }
    receiptLog = null;
    showReceiptLog(year);
  };
  view.querySelectorAll('[data-renote]').forEach(b => b.addEventListener('click', () => {
    const r = log.find(x => x.id === b.dataset.renote);
    const notes = r && prompt('Notes: what was bought and why', r.notes || '');
    if (notes != null && r) resave(r, { notes });
  }));
  view.querySelectorAll('[data-ungeneral]').forEach(b => b.addEventListener('click', () => {
    const [id, lineId] = b.dataset.ungeneral.split(':');
    const r = log.find(x => x.id === id), line = r?.general.find(l => l.id === lineId);
    if (!line || !confirm(`Remove ${line.item} (${money(line.amount)}) from general business expenses? The receipt stays on file.`)) return;
    resave(r, { general: r.general.filter(l => l !== line) });
  }));
  view.querySelectorAll('[data-delreceipt]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this receipt and its photo? This cannot be undone.')) return;
    try { await api(`/api/receipts/${encodeURIComponent(b.dataset.delreceipt)}/delete`, {}); }
    catch (error) { toast(serverSaid(error)); return; }
    receiptLog = null;
    showReceiptLog(year);
  }));
}

// ---------- Excel export for QuickBooks ----------
// Everything for a span of dates in one workbook, laid out to match up against QuickBooks Online:
// each receipt as one expense (its date, vendor and total are what the bank or card feed shows),
// each line with the customer and project it belongs to, income by project (each Shopify order on its
// own), and every project's profit and loss as its Summary shows it.
const EXPENSE_CATEGORY = 'Supplies & Materials';   // a QuickBooks default account; change it in the sheet if you file elsewhere
const NOT_STARTED = ['draft', 'sent', 'declined'];   // client quotes that never became work

const day = iso => String(iso || '').slice(0, 10);
const customerOf = p => isClient(p) ? (p.data.client_name || 'Client') : isProduct(p) ? 'Shopify' : 'JM Woodwork';
// A name that stays the same in QuickBooks: a batch run's title changes with its unit count, so it's named by its start date.
const exportName = p => isBatch(p) ? `${p.data.title} run ${day(p.created_at)}` : projectName(p);
const customerProject = p => `${customerOf(p)}:${exportName(p)}`;
const finishedDay = p => archived(p) ? day(finishedAt(p)) : '';
const $c = (v, s): Cell => (v === '' || v == null ? null : { v, s });

// Income for a project, one row per payment where it's known: [{ date, customer, description, amount, tax }].
function incomeRows(p) {
  const rev = revenueOf(p), done = finishedDay(p);
  if (rev.typed) return [{ date: done, customer: customerOf(p), description: 'Revenue received (typed in on the Summary)', amount: rev.amount, tax: 0 }];
  if (isBatch(p)) {
    const sales = Object.entries(p.data.batch.sales || {}) as [string, any][];
    if (sales.length) return sales.map(([name, x]) => ({ date: day(x.at), customer: 'Shopify', description: `Shopify order ${name}, ${pos(x.units)} × ${p.data.batch.product}`, amount: num(x.amount), tax: 0 }));
    return num(p.calc.total) ? [{ date: '', customer: 'Shopify', description: 'Retail value of the units (expected; not sold through Shopify yet)', amount: num(p.calc.total), tax: 0 }] : [];
  }
  if (!rev.amount) return [];
  return [{ date: p.status === 'delivered' ? done : '', customer: customerOf(p), amount: rev.amount, tax: num(p.calc.tax),
    description: `${rev.label}${p.status === 'delivered' ? '' : ' (not delivered yet)'}` }];
}

async function exportQuickBooks(from, to) {
  const inRange = d => !!d && d >= from && d <= to;
  const uses = receiptUses();
  const log = withOldReceipts([...await loadReceipts()], uses);
  const photo = r => r.has_photo ? { link: `${location.origin}${photoUrl(r.id)}`, text: 'Photo' } : 'No photo';

  // A project is in the export if money moved on it in the span, or it was being worked on then.
  const projects = store.projects.filter(p => {
    const lines = (p.data.purchases || []).some(x => inRange(x.date));
    const paid = incomeRows(p).some(r => inRange(r.date));
    if (lines || paid) return true;
    if (isClient(p) && NOT_STARTED.includes(p.status)) return false;
    return day(p.created_at) <= to && (!archived(p) || finishedDay(p) >= from);
  }).sort((a, b) => a.created_at.localeCompare(b.created_at));

  const head = ['Project', 'Customer:Project', 'Customer', 'Stream', 'Status', 'Started', 'Finished', 'Revenue', 'Revenue basis',
    'Sales tax collected', 'Materials & supplies', 'Profit', 'Margin', 'State tax set-aside', 'Income tax set-aside', 'Profit after taxes',
    'Hours worked', 'Profit per hour after taxes', 'Receipts', 'Link'];
  const summary: Cell[][] = [head];
  const totals = { rev: 0, tax: 0, spent: 0, profit: 0, stateSet: 0, incomeSet: 0, kept: 0, hours: 0 };
  for (const p of projects) {
    const x = pnlOf(p);
    const salesTax = isClient(p) && !x.rev.typed ? num(p.calc.tax) : 0;
    summary.push([exportName(p), customerProject(p), customerOf(p), STREAM_NAME[streamOf(p)], STATUS_NAME[p.status] || p.status,
      $c(day(p.created_at), 'date'), $c(finishedDay(p), 'date'), $c(x.rev.amount, 'money'), [x.rev.label, streamOf(p) === 'gallery' ? '' : x.rev.detail].filter(Boolean).join(', '),
      $c(salesTax, 'money'), $c(x.spent, 'money'), $c(x.profit, 'money'), x.rev.amount ? $c(x.profit / x.rev.amount, 'pct') : null,
      $c(x.stateSet, 'money'), $c(x.incomeSet, 'money'), $c(x.kept, 'money'), x.hours ? $c(x.hours, 'hours') : null,
      x.perHour != null ? $c(cents(x.perHour), 'money') : null, new Set((p.data.purchases || []).map(l => l.receipt || l.id)).size,
      { link: `${location.origin}/#/p/${p.id}/summary`, text: 'Summary' }]);
    totals.rev += x.rev.amount; totals.tax += salesTax; totals.spent += x.spent; totals.profit += x.profit;
    totals.stateSet += x.stateSet; totals.incomeSet += x.incomeSet; totals.kept += x.kept; totals.hours += x.hours;
  }
  if (projects.length) summary.push([{ v: 'Total', s: 'bold' }, null, null, null, null, null, null, $c(cents(totals.rev), 'boldmoney'), null,
    $c(cents(totals.tax), 'boldmoney'), $c(cents(totals.spent), 'boldmoney'), $c(cents(totals.profit), 'boldmoney'), null,
    $c(cents(totals.stateSet), 'boldmoney'), $c(cents(totals.incomeSet), 'boldmoney'), $c(cents(totals.kept), 'boldmoney'), totals.hours ? $c(totals.hours, 'hours') : null]);

  // One row per receipt: what to match against the bank or card transaction.
  const receipts: Cell[][] = [['Date', 'Vendor', 'Total', 'Sales tax', 'Category', 'Customer:Project', 'Memo', 'Notes', 'General business', 'Receipt ID', 'Photo']];
  for (const r of [...log].reverse().filter(r => inRange(r.date))) {
    const used = uses.get(r.id) || [];
    const general = r.general || [];
    const items = [...used.flatMap(u => u.lines.map(l => l.item)), ...general.map(l => l.item)].filter(i => !/^sales tax$/i.test(i));
    const where = used.length + (general.length ? 1 : 0) > 1 ? 'Split: see Expense lines'
      : used.length ? customerProject(used[0].p) : general.length ? 'General business' : 'Not on a project';
    receipts.push([$c(r.date, 'date'), r.store, $c(r.total, 'money'), $c(r.tax, 'money'), EXPENSE_CATEGORY, where,
      items.join('; ').slice(0, 1000), r.notes || '', general.length ? $c(cents(general.reduce((n, l) => n + num(l.amount), 0)), 'money') : null, r.id, photo(r)]);
  }

  // One row per line, with the project it's billed to: for splitting a receipt across projects in QuickBooks.
  const known = new Map(log.map(r => [r.id, r]));
  const lines: Cell[][] = [['Date', 'Vendor', 'Description', 'Amount', 'Category', 'Customer:Project', 'Customer', 'Project', 'Class', 'Receipt notes', 'Receipt ID', 'Photo']];
  const allLines = [
    ...store.projects.flatMap(p => (p.data.purchases || []).filter(x => inRange(x.date)).map(x => ({ p, x }))),
    ...log.filter(r => inRange(r.date)).flatMap(r => (r.general || []).map(l => ({ p: null, x: { ...l, date: r.date, store: r.store, receipt: r.id } }))),
  ].sort((a, b) => a.x.date.localeCompare(b.x.date) || String(a.x.receipt).localeCompare(String(b.x.receipt)));
  for (const { p, x } of allLines) {
    const r = known.get(x.receipt);
    lines.push([$c(x.date, 'date'), x.store, x.item, $c(num(x.amount), 'money'), EXPENSE_CATEGORY,
      p ? customerProject(p) : '', p ? customerOf(p) : '', p ? exportName(p) : '', p ? STREAM_NAME[streamOf(p)] : 'General business',
      r?.notes || '', x.receipt || 'Typed in', r ? photo(r) : 'No photo']);
  }

  // Income: dated payments in the span, and what's still expected on the projects listed.
  const income: Cell[][] = [['Date', 'Customer', 'Customer:Project', 'Project', 'Description', 'Amount before sales tax', 'Sales tax', 'Total', 'Class']];
  for (const p of projects) for (const r of incomeRows(p)) {
    if (r.date && !inRange(r.date)) continue;
    income.push([r.date ? $c(r.date, 'date') : 'Not received yet', r.customer, customerProject(p), exportName(p), r.description,
      $c(r.amount, 'money'), $c(r.tax, 'money'), $c(cents(r.amount + r.tax), 'money'), STREAM_NAME[streamOf(p)]]);
  }

  const about: Cell[][] = [
    [{ v: `${store.settings.business_name || 'Shop Tracker'}: export for QuickBooks`, s: 'bold' }],
    [`Dates ${from} to ${to}, made ${ymd(new Date())}.`],
    [],
    [{ v: 'Project summary', s: 'bold' }],
    ['Every project worked on or paid in these dates, with its whole profit and loss as its Summary page shows it (not only the part in these dates).'],
    ['Revenue is the agreed or quoted price before sales tax, a product run\'s Shopify orders, or the figure typed in on the Summary.'],
    [`Tax set-asides are estimates: the project's state tax rate plus ${+pos(store.settings.income_tax_pct)}% income tax, taken from profit.`],
    [],
    [{ v: 'Expenses by receipt', s: 'bold' }],
    ['One row per receipt dated in the span. Date, vendor and total match the bank or card transaction to categorize in QuickBooks.'],
    [`Category is "${EXPENSE_CATEGORY}" for every row; change it where a purchase belongs in another account.`],
    [],
    [{ v: 'Expense lines', s: 'bold' }],
    ['Each line of each receipt with the customer and project it went to, for splitting a transaction across projects.'],
    ['General business expenses (not for one project) have no customer or project, and "General business" as their class.'],
    [],
    [{ v: 'Income', s: 'bold' }],
    ['Payments dated in the span (a client job on the day it was marked delivered, each Shopify order on its order date), then amounts still expected on the projects listed.'],
    [],
    ['Photo and Summary links open in Shop Tracker, so sign in there first.'],
  ];

  const sheets: Sheet[] = [
    { name: 'Project summary', rows: summary, widths: [28, 40, 20, 14, 14, 11, 11, 13, 34, 12, 14, 13, 8, 12, 12, 13, 9, 13, 9, 10] },
    { name: 'Expenses by receipt', rows: receipts, widths: [11, 28, 12, 11, 20, 40, 60, 50, 14, 16, 10] },
    { name: 'Expense lines', rows: lines, widths: [11, 28, 44, 12, 20, 40, 20, 28, 16, 50, 16, 10] },
    { name: 'Income', rows: income, widths: [14, 20, 40, 28, 52, 14, 11, 13, 14] },
    { name: 'About', rows: about, widths: [140], header: false },
  ];
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(workbook(sheets)), download: `shop-tracker-quickbooks-${from}-to-${to}.xlsx` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return { projects: projects.length, receipts: receipts.length - 1 };
}

// The export's card on the All receipts page: a span of dates, with quick picks for this year and last.
let qbFrom = '', qbTo = '';
function renderQuickBooksCard() {
  const card = $('#qbCard');
  if (!card) return;
  const now = new Date(), y = now.getFullYear();
  qbFrom ||= `${y}-01-01`;
  qbTo ||= ymd(now);
  card.innerHTML = `<h2>Export for QuickBooks</h2>
    <p class="muted" style="margin:0 0 10px;font-size:14px">An Excel file with every project's summary, each receipt and its lines with the customer and project they belong to, and income, for the dates you pick.</p>
    <div class="qbrange">
      <label class="f"><span>From</span><input type="date" id="qbFrom" value="${esc(qbFrom)}"></label>
      <label class="f"><span>To</span><input type="date" id="qbTo" value="${esc(qbTo)}"></label>
    </div>
    <p style="margin:8px 0 0;font-size:13px"><button type="button" class="link" data-span="${y}">This year</button> &middot;
      <button type="button" class="link" data-span="${y - 1}">Last year</button> &middot;
      <button type="button" class="link" data-span="q">This quarter</button></p>
    <div class="actions" style="margin-top:12px"><button type="button" class="btn primary" id="qbGo">Download Excel file</button><span class="muted" id="qbSaid" style="font-size:13px"></span></div>`;
  card.addEventListener('change', e => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'qbFrom') qbFrom = el.value; else if (el.id === 'qbTo') qbTo = el.value;
  });
  card.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    if (btn.dataset.span) {
      const span = btn.dataset.span;
      if (span === 'q') { const q = Math.floor(now.getMonth() / 3) * 3; qbFrom = ymd(new Date(y, q, 1)); qbTo = ymd(new Date(y, q + 3, 0)); }
      else { qbFrom = `${span}-01-01`; qbTo = `${span}-12-31`; }
      ($('#qbFrom') as HTMLInputElement).value = qbFrom;
      ($('#qbTo') as HTMLInputElement).value = qbTo;
      return;
    }
    if (btn.id !== 'qbGo') return;
    const said = $('#qbSaid');
    if (!qbFrom || !qbTo || qbFrom > qbTo) { said.textContent = 'Pick a From date on or before the To date.'; return; }
    btn.disabled = true;
    said.textContent = 'Making the file…';
    try {
      const n = await exportQuickBooks(qbFrom, qbTo);
      said.textContent = `Downloaded: ${n.projects} project${n.projects === 1 ? '' : 's'}, ${n.receipts} receipt${n.receipts === 1 ? '' : 's'}.`;
    } catch (error) { said.textContent = `Couldn't make the file: ${serverSaid(error)}`; }
    btn.disabled = false;
  });
}

// ---------- project summary: receipts and profit ----------
// Revenue against what was spent, the hours put in (typed in: data.hours_worked) and what that comes
// to per hour. Revenue is worked out from the project unless a figure is typed in (data.revenue_actual):
// a client job's agreed (or quoted) price before sales tax, or a product run's Shopify sales
// (data.batch.sales, kept from its orders) or else the retail value of its units.
function revenueOf(p) {
  const typed = p.data.revenue_actual;
  if (typed !== '' && typed != null) return { amount: pos(typed), label: 'Revenue received', typed: true };
  if (isBatch(p)) {
    const sales = Object.entries(p.data.batch.sales || {}) as [string, any][];
    if (sales.length) return { amount: cents(sales.reduce((n, [, s]) => n + num(s.amount), 0)), label: `Shopify orders`, detail: sales.map(([name]) => name).join(', ') };
    return { amount: num(p.calc.total), label: 'Retail value of the units', detail: 'expected, not yet sold through Shopify' };
  }
  if (streamOf(p) === 'gallery') return { amount: 0, label: 'Not for sale', detail: 'type in a price below if it sells' };
  return { amount: num(p.calc.subtotal), label: p.calc.agreed ? 'Agreed price' : 'Quoted price', detail: num(p.calc.tax) ? 'before sales tax' : '' };
}

// The project's profit and loss, as its Summary shows it (and the QuickBooks export lists it).
function pnlOf(p) {
  const rev = revenueOf(p), spent = spentOn(p), profit = cents(rev.amount - spent);
  const hours = pos(p.data.hours_worked), rate = pos(p.data.rates?.hourly_rate ?? store.settings.hourly_rate);
  // Set aside from profit: the project's state rate (the one picked on its Details, or the no-state default
  // for work without a state) plus the income tax share from the settings.
  const state = isClient(p) ? p.data.client_state : '';
  const statePct = state ? pos(p.data.rates?.tax_pct) : pos(store.settings.tax_pct);
  const incomePct = pos(store.settings.income_tax_pct), taxPct = statePct + incomePct;
  const base = Math.max(profit, 0);
  const stateSet = cents(base * statePct / 100), incomeSet = cents(base * incomePct / 100);
  const setAside = cents(stateSet + incomeSet), kept = cents(profit - setAside);
  const perHour = hours ? kept / hours : null;
  return { rev, spent, profit, hours, rate, state, statePct, incomePct, taxPct, stateSet, incomeSet, setAside, kept, perHour };
}

function showSummary(p) {
  ed = { project: p, stream: streamOf(p), data: p.data, dirty: false };
  view.innerHTML = `${projectHeader(p, 'summary', '<button class="btn small" onclick="window.print()">Print / save as PDF</button>')}
    <div class="printhead"><h1>${esc(projectName(p))}</h1><div class="muted">${isClient(p) ? `${esc(p.quote_number)} &middot; ${esc(p.data.client_name || '')} &middot; ` : ''}${STREAM_NAME[streamOf(p)]} &middot; Summary as of ${esc(fmtDate(new Date().toISOString()))}</div></div>
    <div class="cols" id="summary">
      <div><div class="card" id="pnl"></div></div>
      <aside><div class="card" id="receiptsCard"></div></aside>
    </div>`;
  const touch = () => { p.updated_at = new Date().toISOString(); persist(); };
  const pnl = $('#pnl');
  const renderPnl = () => {
    const { rev, spent, profit, hours, rate, state, statePct, incomePct, taxPct, stateSet, incomeSet, kept, perHour } = pnlOf(p);
    const receipts = new Set((p.data.purchases || []).map(x => x.receipt || x.id)).size;
    const estHours = num(p.calc.labor_hours) + num(p.calc.contingency_hours);
    pnl.innerHTML = `<h2>Profit and loss</h2>
      <div class="pl-sec">Revenue</div>
      <div class="tot"><span>${esc(rev.label)}${rev.detail ? ` <small>${esc(rev.detail)}</small>` : ''}</span><b>${money(rev.amount)}</b></div>
      ${isClient(p) && num(p.calc.tax) && !rev.typed ? `<div class="tot"><span class="muted">Sales tax collected <small>passed on to the state, not counted</small></span><span class="muted">${money(p.calc.tax)}</span></div>` : ''}
      <div class="pl-sec">Expenses</div>
      <div class="tot"><span>Materials and supplies <small>${(p.data.purchases || []).length} line${(p.data.purchases || []).length === 1 ? '' : 's'} from ${receipts} receipt${receipts === 1 ? '' : 's'}, tax included</small></span><b>&minus; ${money(spent)}</b></div>
      <div class="tot grand ${profit < 0 ? 'loss' : 'profit'}"><span>${profit < 0 ? 'Loss' : 'Profit'}</span><span>${money(Math.abs(profit))}</span></div>
      ${rev.amount ? `<div class="tot"><span class="muted">Margin</span><span class="muted">${Math.round(profit / rev.amount * 100)}%</span></div>` : ''}
      ${taxPct ? `<div class="pl-sec">Set aside for taxes <small style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--muted)">estimates, ${+cents(taxPct)}% of profit</small></div>
        ${statePct ? `<div class="tot"><span>State tax <small>${state ? `${esc(STATE_NAME[state] || state)} ` : ''}${+statePct}%</small></span><b>&minus; ${money(stateSet)}</b></div>` : ''}
        ${incomePct ? `<div class="tot"><span>Income tax <small>${+incomePct}%</small></span><b>&minus; ${money(incomeSet)}</b></div>` : ''}
        <div class="tot grand aftertax ${kept < 0 ? 'loss' : 'profit'}"><span>Profit after taxes</span><span>${money(kept)}</span></div>` : ''}
      <div class="pl-sec">Time</div>
      <div class="tot"><span>Hours worked</span><b>${hours ? hrs(hours) : '<span class="muted">not entered</span>'}</b></div>
      ${perHour != null ? `<div class="tot grand perhour ${perHour < rate ? 'under' : ''}"><span>Profit per hour${taxPct ? ' <small>after taxes</small>' : ''}</span><span>${money(perHour)}</span></div>
        <div class="tot"><span class="muted">Your hourly rate on this project</span><span class="muted">${money(rate)}</span></div>` : ''}
      <hr class="rule">
      <div class="grid noprint">
        <label class="f w3"><span>Total hours worked</span><input type="number" min="0" step="0.25" inputmode="decimal" id="hoursWorked" value="${esc(p.data.hours_worked ?? '')}" placeholder="${estHours ? `estimate ${+estHours.toFixed(2)}` : 'e.g. 12.5'}"></label>
        <label class="f w3"><span>Revenue received ($) <small>leave blank to use the ${esc(revenueOf({ ...p, data: { ...p.data, revenue_actual: '' } }).label.replace(/^(?!Shopify)./, c => c.toLowerCase()))}</small></span><input type="number" min="0" step="0.01" inputmode="decimal" id="revenueActual" value="${esc(p.data.revenue_actual ?? '')}"></label>
      </div>`;
  };
  pnl.addEventListener('change', e => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'hoursWorked') p.data.hours_worked = el.value === '' ? '' : pos(el.value);
    else if (el.id === 'revenueActual') p.data.revenue_actual = el.value === '' ? '' : cents(pos(el.value));
    else return;
    touch();
    renderPnl();
  });

  const renderReceipts = () => {
    const card = $('#receiptsCard');
    const groups = new Map();
    for (const x of p.data.purchases || []) {
      const key = x.receipt || `hand:${x.id}`;
      if (!groups.has(key)) groups.set(key, { id: x.receipt, store: x.store, date: x.date, lines: [] });
      groups.get(key).lines.push(x);
    }
    const list = [...groups.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const known = new Map<string, any>((receiptLog || []).map(r => [r.id, r]));
    card.innerHTML = `<h2>Receipts</h2>
      ${list.length ? `<ul class="rgroups">${list.map(g => {
        const r = known.get(g.id), mine = cents(g.lines.reduce((n, x) => n + num(x.amount), 0));
        const caption = [g.store, g.date && fmtDate(g.date)].filter(Boolean).join(', ');
        const photo = g.id && (!receiptLog || r?.has_photo)
          ? `<a href="${photoUrl(g.id, r?.photo_v)}" class="thumb" data-photo-id="${esc(g.id)}" data-caption="${esc(caption)}"><img class="rthumb" loading="lazy" src="${photoUrl(g.id, r?.photo_v)}" alt="Receipt photo"></a>`
          : g.id ? addPhotoButton(g.id) : '<span class="nophoto">Typed in</span>';
        return `<li>${photo}<div class="rinfo">
          <div class="rtop"><b>${esc(g.store || 'Store not given')}</b><span class="muted">${esc(g.date ? fmtDate(g.date) : '')}</span></div>
          <ul class="purchases">${g.lines.map(x => `<li><span>${esc(x.item)}</span><span class="amt">${money(x.amount)}</span>
            <button type="button" class="link noprint" data-unpurchase="${esc(x.id)}" aria-label="Remove ${esc(x.item)}">&times;</button></li>`).join('')}</ul>
          ${r?.notes ? `<div class="rnote">${esc(r.notes)}</div>` : ''}
          ${r && r.total && Math.abs(r.total - mine) >= 0.01 ? `<small class="muted">Receipt total ${money(r.total)}; ${money(mine)} of it is on this project.</small>` : ''}
        </div></li>`;
      }).join('')}</ul>
      <div class="tot grand"><span>Total spent</span><span>${money(spentOn(p))}</span></div>`
      : '<p class="muted" style="margin:0 0 10px;font-size:14px">No receipts on this project yet.</p>'}
      <div class="actions noprint" style="margin-top:10px"><a class="btn small primary" href="#/receipt/${p.id}">Scan a receipt</a><a class="btn small" href="#/receipts">All receipts &middot; Excel export</a></div>`;
  };
  ed.redraw = () => { renderPnl(); renderReceipts(); };
  ed.redraw();
  // Which receipts have photos (and their printed totals) come from the server.
  loadReceipts().then(() => { if (ed?.project === p && $('#summary')) renderReceipts(); }).catch(() => {});
}

// ---------- design notes (internal; never shown on the client quote) ----------
const NOTE_KINDS = ['Client call', 'Site visit', 'Email or message', 'Research', 'Other'];

// Web addresses typed into a note, as links that open in a new tab.
const linksHtml = text => (String(text).match(/https?:\/\/[^\s<>"]+/g) || [])
  .map(url => url.replace(/[.,;:!?)\]]+$/, ''))
  .map(url => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`).join('');

function showDesign(p) {
  const design = p.data.design ??= { brief: '', notes: [] };
  const touch = () => { p.updated_at = new Date().toISOString(); persist(); };
  const render = () => {
    // Newest first; entries added on the same day keep the latest on top.
    const order = design.notes.map((_, i) => i).sort((a, b) => design.notes[b].date.localeCompare(design.notes[a].date) || b - a);
    view.innerHTML = `
      ${projectHeader(p, 'design', '<span class="muted">Changes save automatically</span>')}
      <div class="design">
        <div class="card"><h2>Design brief</h2>
          <textarea class="brief" id="brief" placeholder="The current picture of what the client wants: how the piece will be used, style and references, the space it's going into, must-haves, budget and timing.">${esc(design.brief)}</textarea>
          <div class="links" id="briefLinks">${linksHtml(design.brief)}</div>
        </div>
        <div class="card" id="entries">
          <div class="actions"><h2 style="margin:0">Calls &amp; due diligence</h2><span class="spacer" style="flex:1"></span>
            <button class="btn primary small" data-act="add">+ Add note</button></div>
          ${order.length ? '' : '<p class="muted" style="margin:12px 0 0">No notes yet. Add one after each client call, site visit or piece of research.</p>'}
          <div style="margin-top:12px">${order.map(i => `<div class="entry">
            <div class="actions">
              <input type="date" data-i="${i}" data-k="date" value="${esc(design.notes[i].date)}" aria-label="Date">
              <select data-i="${i}" data-k="kind" aria-label="Type of note">${[...new Set([...NOTE_KINDS, design.notes[i].kind])].map(k =>
                `<option ${k === design.notes[i].kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
              <span class="spacer"></span><button class="link" data-act="remove" data-i="${i}">remove</button>
            </div>
            <textarea data-i="${i}" data-k="text" placeholder="What was discussed, decided or found. Paste links to photos or files and they become clickable below." aria-label="Note">${esc(design.notes[i].text)}</textarea>
            <div class="links" data-links="${i}">${linksHtml(design.notes[i].text)}</div>
          </div>`).join('')}</div>
        </div>
      </div>`;
    $('#brief').addEventListener('input', e => { design.brief = e.target.value; $('#briefLinks').innerHTML = linksHtml(design.brief); touch(); });
    const entries = $('#entries');
    entries.addEventListener('input', e => {
      const { i, k } = e.target.dataset;
      if (i === undefined) return;
      design.notes[i][k] = e.target.value;
      if (k === 'text') $(`[data-links="${i}"]`).innerHTML = linksHtml(e.target.value);
      touch();
    });
    entries.addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (act === 'add') {
        design.notes.push({ date: ymd(new Date()), kind: NOTE_KINDS[0], text: '' });
      } else if (act === 'remove') {
        const note = design.notes[e.target.dataset.i];
        if (note.text.trim() && !confirm('Remove this note?')) return;
        design.notes.splice(e.target.dataset.i, 1);
      } else return;
      touch();
      render();
      if (act === 'add') $(`textarea[data-i="${design.notes.length - 1}"]`).focus();
    });
  };
  render();
}

// ---------- cut list ----------
// The pieces of lumber to cut for a project, as a checklist on its own Cut list tab (#/p/<id>/cuts), kept in its data as
// data.cutlist = { items, source }. Each item is { id, part, qty, t, w, l, species, done_at } with sizes
// in inches (thickness <= width <= length), or just a part with no sizes for a line typed without them.
// The list can be filled from a SketchUp model (.skp) or an OpenCutList CSV dropped onto the card: the
// file is read here in the browser (see skp.ts), shown for a check, then added. Pieces can also be typed.
const cutListCard = () => `<div class="card cutlist" id="cutlist">
  <div class="actions"><h2 style="margin:0">Cut list</h2><span class="spacer" style="flex:1"></span><span class="muted cutsum" id="cutSum"></span></div>
  <label class="cutdrop" id="cutDrop"><input type="file" id="cutFile" hidden>
    <b>Add from SketchUp</b><span class="muted">Drop a .skp model here, or tap to pick one. An OpenCutList CSV works too.</span></label>
  <div id="cutReview"></div>
  <form class="addtask" id="cutAdd" autocomplete="off"><textarea rows="1" enterkeyhint="done" placeholder="Add a piece, e.g. Shelf 3/4 x 10 x 30 (2)" aria-label="New piece to cut"></textarea><button class="btn primary">Add</button></form>
  <ul class="tasks cuts" id="cutItems"></ul>
  <p class="muted hint">Sizes are thickness &times; width &times; length in inches, as cut. Tap a piece once it's cut. Paste several lines to add them all.</p>
</div>`;

function showCuts(p) {
  view.innerHTML = `${projectHeader(p, 'cuts', '<span class="muted">Changes save automatically</span>')}
    <div class="design">${cutListCard()}</div>`;
  wireCutList(p);
}

const bdFt = x => x.t && x.w && x.l ? x.t * x.w * x.l * (x.qty || 1) / 144 : 0;
const cutDims = x => x.l ? `${fmtInches(x.t)} × ${fmtInches(x.w)} × ${fmtInches(x.l)}` : '';
// Thickest stock first, then widest and longest, so a board can be milled once for every piece from it.
const cutOrder = (a, b) => (b.l ? 1 : 0) - (a.l ? 1 : 0) || (b.t || 0) - (a.t || 0) || (b.w || 0) - (a.w || 0) || (b.l || 0) - (a.l || 0);

function wireCutList(p) {
  const list = () => (p.data.cutlist ??= { items: [], source: null });
  const species = p.data.spec?.species || '';
  const touch = () => { p.updated_at = new Date().toISOString(); persist(); };
  const tabCount = () => { const tab = $('.projtabs a.on'); if (tab) tab.innerHTML = `Cut list${cutsLeft(p) ? ` <small title="pieces left to cut">${cutsLeft(p)}</small>` : ''}`; };
  const toItem = (x: Piece) => ({ id: newTask('').id, part: x.part, qty: x.qty || 1, t: x.t, w: x.w, l: x.l, species: x.species || '', done_at: null });

  const draw = () => {
    const items = [...(p.data.cutlist?.items || [])].sort(cutOrder);
    let last = null;
    $('#cutItems').innerHTML = items.length ? items.map(x => {
      const group = x.l ? `${fmtInches(x.t)}″ thick` : 'Other';
      const head = group !== last ? `<li class="cuthead">${esc(group)}</li>` : '';
      last = group;
      const sp = x.species || species;
      return `${head}<li class="task cut ${x.done_at ? 'done' : ''}" data-id="${esc(x.id)}">
        <input type="checkbox" ${x.done_at ? 'checked' : ''} aria-label="${esc(`${x.qty} ${x.part}`)}">
        <span class="text"><b class="qty">${x.qty}×</b> ${esc(x.part)}${x.l ? ` <span class="dims">${cutDims(x)}${sp ? ` <small class="sp">${esc(sp)}</small>` : ''}</span>` : ''}</span>
        ${x.done_at ? `<span class="when">Cut ${esc(fmtDate(x.done_at))}</span>` : ''}
        <button type="button" class="x" aria-label="Remove ${esc(x.part)}" title="Remove">&times;</button>
      </li>`;
    }).join('') : '<li class="none muted">No pieces yet. Drop in a SketchUp model or type one above.</li>';
    const all = p.data.cutlist?.items || [], pieces = all.reduce((n, x) => n + (x.qty || 1), 0);
    const cut = all.filter(x => x.done_at).reduce((n, x) => n + (x.qty || 1), 0);
    const bf = all.filter(x => !x.done_at).reduce((n, x) => n + bdFt(x), 0);
    $('#cutSum').textContent = pieces ? `${cut} of ${pieces} cut${bf ? ` · ${bf.toFixed(1)} bd ft to go` : ''}` : '';
    tabCount();
  };

  // A model or CSV that's been read, waiting to be checked and added.
  let review = null;
  // "Named parts only" (remembered on this device): parts SketchUp named itself (Component#12, or anything with "Component" in it) are left
  // out, so a model full of extra bits gives just the parts that were named.
  const shownPieces = () => review.pieces.map((x, i) => ({ x, i })).filter(({ x }) => !review.namedOnly || x.named);
  const reviewTotal = () => shownPieces().filter(({ x }) => x.on).reduce((q, { x }) => q + (x.qty || 0), 0);
  const drawReview = () => {
    const box = $('#cutReview');
    if (!review) { box.innerHTML = ''; return; }
    const n = reviewTotal(), has = list().items.length, shown = shownPieces();
    const unnamed = review.pieces.filter(x => !x.named).reduce((q, x) => q + x.qty, 0);
    box.innerHTML = `<div class="cutcheck">
      <p><b>${esc(review.file)}</b>: ${esc(review.note)} Untick anything that isn't cut from lumber, and fix any counts (a copy kept off to the side in the model counts too).${review.pieces.some(x => !x.on) ? ' Flat shapes with no thickness start unticked.' : ''}</p>
      ${unnamed ? `<label class="cutnamed"><input type="checkbox" data-named ${review.namedOnly ? 'checked' : ''}>
        <span><b>Only include parts I named</b> <span class="muted">${review.namedOnly ? `${unnamed} unnamed piece${unnamed === 1 ? '' : 's'} (names with &ldquo;Component&rdquo;, Group#&hellip;) left out` : `leaves out ${unnamed} unnamed piece${unnamed === 1 ? '' : 's'} (names with &ldquo;Component&rdquo;, Group#&hellip;)`}</span></span></label>` : ''}
      <ul>${shown.map(({ x, i }) => `<li class="${x.on ? '' : 'off'}">
        <input type="checkbox" data-i="${i}" ${x.on ? 'checked' : ''} aria-label="Include ${esc(x.part)}">
        <input type="number" min="0" step="1" inputmode="numeric" data-q="${i}" value="${x.qty}" aria-label="How many ${esc(x.part)}">
        <span class="nm">${esc(x.part)}${x.species ? ` <small class="sp">${esc(x.species)}</small>` : ''}</span><span class="dims">${cutDims(x)}</span></li>`).join('')
        || '<li class="none muted">No parts in this model have names of their own. Untick the box above to see them all, or name the parts in SketchUp (Entity Info &gt; Definition) and drop it in again.</li>'}</ul>
      <div class="actions"><button type="button" class="btn primary" data-cut="add" ${n ? '' : 'disabled'}>Add ${n} piece${n === 1 ? '' : 's'}</button>
        ${has ? `<button type="button" class="btn" data-cut="replace" ${n ? '' : 'disabled'}>Replace the list</button>` : ''}
        <button type="button" class="link" data-cut="cancel">Cancel</button></div></div>`;
  };
  $('#cutReview').addEventListener('change', e => {
    const el = e.target as HTMLInputElement, i = el.dataset.i ?? el.dataset.q;
    if (review && el.dataset.named !== undefined) {
      review.namedOnly = el.checked;
      try { localStorage.setItem('cutNamedOnly', el.checked ? '1' : ''); } catch {}
      drawReview();
      return;
    }
    if (!review || i === undefined) return;
    const x = review.pieces[i];
    if (el.dataset.i !== undefined) x.on = el.checked;
    else { x.qty = Math.max(0, Math.round(+el.value || 0)); x.on = x.qty > 0; ($(`#cutReview [data-i="${i}"]`) as HTMLInputElement).checked = x.on; }
    // Only the row and the buttons change, so the count box being typed in stays put.
    el.closest('li').classList.toggle('off', !x.on);
    const n = reviewTotal();
    $('#cutReview [data-cut="add"]').textContent = `Add ${n} piece${n === 1 ? '' : 's'}`;
    $('#cutReview').querySelectorAll('[data-cut="add"], [data-cut="replace"]').forEach(b => { (b as HTMLButtonElement).disabled = !n; });
  });
  $('#cutReview').addEventListener('click', e => {
    const act = (e.target as HTMLElement).dataset?.cut;
    if (!act || !review) return;
    if (act !== 'cancel') {
      const items = shownPieces().map(({ x }) => x).filter(x => x.on && x.qty > 0).map(toItem);
      const cl = list();
      if (act === 'replace') {
        if (cl.items.some(x => x.done_at) && !confirm('Replace the whole cut list, including pieces already checked off?')) return;
        cl.items = items;
      } else cl.items.push(...items);
      cl.source = { file: review.file, at: new Date().toISOString() };
      touch();
      toast(`Added ${items.reduce((q, x) => q + x.qty, 0)} pieces to the cut list.`);
    }
    review = null;
    drawReview();
    draw();
  });

  const readFile = async (file: File) => {
    try {
      const isCsv = /\.(csv|txt|tsv)$/i.test(file.name) || /^text\//.test(file.type);
      const got = isCsv ? readCutCsv(await file.text()) : await readSkp(await file.arrayBuffer());
      // A SketchUp material counts as the species only when it names one from Settings (models are often
      // coloured by section instead); pieces then come together by name and size.
      const known = store.settings.species.map(sp => sp.name);
      const speciesOf = m => known.find(k => m && m.toLowerCase().replace(/[_\s]+/g, ' ').includes(k.toLowerCase())) || '';
      const merged = new Map();
      for (const x of got.pieces) {
        const sp = x.species || speciesOf(x.material), key = [x.part, x.t, x.w, x.l, sp].join('|');
        if (merged.has(key)) merged.get(key).qty += x.qty;
        else merged.set(key, { part: x.part, qty: x.qty, t: x.t, w: x.w, l: x.l, species: sp });
      }
      // Left unticked: flat shapes with no thickness (glass, panels drawn as a face, the floor) and
      // anything that looks like a scale figure.
      let namedOnly = false;
      try { namedOnly = !!localStorage.getItem('cutNamedOnly'); } catch {}
      review = { file: file.name, note: got.note, namedOnly, pieces: [...merged.values()].sort(cutOrder)
        .map(x => ({ ...x, named: isCsv || x.part !== 'Part', on: !(x.l && x.t < 1 / 32) && !/^(chris|susan|steve|sumele|bryce|person|scale figure)\b/i.test(x.part) })) };
      drawReview();
      $('#cutReview').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      review = null;
      $('#cutReview').innerHTML = `<div class="cutcheck bad"><p><b>${esc(file.name)}</b>: ${esc(err.message || String(err))}</p>
        <div class="actions"><button type="button" class="link" data-cut="cancel">OK</button></div></div>`;
      $('#cutReview [data-cut]').addEventListener('click', () => { $('#cutReview').innerHTML = ''; });
    }
  };
  const drop = $('#cutDrop'), picker = $('#cutFile') as HTMLInputElement;
  picker.addEventListener('change', () => { if (picker.files?.[0]) readFile(picker.files[0]); picker.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) readFile(file);
  });

  // Typed or pasted pieces: one per line.
  const form = $('#cutAdd'), box = form.querySelector('textarea');
  const fit = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
  const addLines = lines => {
    const items = lines.map(readPieceLine).map(x => toItem({ ...x, species: '' }));
    if (!items.length) return false;
    list().items.push(...items);
    touch();
    draw();
    if (items.length > 1) toast(`Added ${items.length} lines to the cut list.`);
    return true;
  };
  box.addEventListener('paste', e => {
    const lines = splitPasted(e.clipboardData?.getData('text/plain') || '');
    if (lines.length < 2) return;
    e.preventDefault();
    addLines(lines);
  });
  box.addEventListener('input', fit);
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const lines = /\n/.test(box.value) ? splitPasted(box.value) : [box.value.replace(/\s+/g, ' ').trim()].filter(Boolean);
    if (!addLines(lines)) return box.focus();
    box.value = '';
    fit();
    box.focus();
  });

  $('#cutItems').addEventListener('click', e => {
    const li = (e.target as Element).closest<HTMLElement>('li.cut'), cl = p.data.cutlist;
    const x = li && cl?.items.find(t => t.id === li.dataset.id);
    if (!x) return;
    if ((e.target as Element).closest('.x')) {
      if (!confirm(`Remove ${x.qty} × ${x.part} from the cut list?`)) return;
      cl.items = cl.items.filter(t => t !== x);
    } else {
      if ((e.target as Element).matches('input[type=checkbox]')) e.preventDefault();
      x.done_at = x.done_at ? null : new Date().toISOString();
    }
    touch();
    draw();
  });
  draw();
}

// ---------- client-facing quote ----------
function showQuote(p) {
  const { data: d, calc } = p, s = store.settings, spec = d.spec;
  const validUntil = new Date(p.created_at);
  validUntil.setDate(validUntil.getDate() + pos(s.quote_valid_days));
  const dims = [spec.length, spec.width, spec.height].map(v => +pos(v));
  const extras = [['drawers', 'drawer'], ['doors', 'door'], ['shelves', 'shelf', 'shelves']]
    .filter(([k]) => pos(spec[k]) > 0).map(([k, one, many]) => `${spec[k]} ${spec[k] === 1 ? one : many || one + 's'}`).join(', ');
  view.innerHTML = `
    ${projectHeader(p, 'quote', '<button class="btn primary small" onclick="window.print()">Print / save as PDF</button>')}
    <article class="card quote">
      <div class="qhead">
        <div><h1>${esc(s.business_name || 'Quote')}</h1><div class="muted pre">${esc(s.business_contact)}</div></div>
        <div style="text-align:right"><b>Quote ${esc(p.quote_number)}</b><br>${esc(fmtDate(p.created_at))}<br>
          <span class="muted">Valid until ${esc(fmtDate(validUntil.toISOString()))}</span></div>
      </div>
      <dl>
        <dt>Prepared for</dt><dd>${esc(d.client_name || '-')}${d.client_email ? `<br>${esc(d.client_email)}` : ''}${d.client_phone ? `<br>${esc(d.client_phone)}` : ''}</dd>
        <dt>Project</dt><dd><b>${esc(projectName(p))}</b></dd>
        <dt>Wood</dt><dd>${esc(spec.species || '-')}</dd>
        <dt>Dimensions</dt><dd>${dims[0]}" L &times; ${dims[1]}" W &times; ${dims[2]}" H</dd>
        <dt>Finish</dt><dd>${esc(FINISHES[spec.finish].name)}</dd>
        ${extras ? `<dt>Includes</dt><dd>${esc(extras)}</dd>` : ''}
        ${d.due_date ? `<dt>Est. completion</dt><dd>${esc(fmtDate(d.due_date))}</dd>` : ''}
      </dl>
      ${spec.description ? `<p class="pre">${esc(spec.description)}</p>` : ''}
      <table>
        <tr><td>${esc(projectName(p))}<br><span class="muted">Design, materials and craftsmanship</span></td><td>${money(calc.subtotal)}</td></tr>
        ${calc.tax ? `<tr><td>${esc(STATE_NAME[d.client_state] || '')} sales tax (${+pos(d.rates.tax_pct)}%)</td><td>${money(calc.tax)}</td></tr>` : ''}
        <tr class="grand"><td>Total</td><td>${money(calc.total)}</td></tr>
        ${calc.retainer ? `<tr><td>Less design retainer paid</td><td>&minus; ${money(calc.retainer)}</td></tr>
        <tr><td><b>Balance due</b></td><td><b>${money(calc.balance)}</b></td></tr>` : ''}
        ${calc.deposit ? `<tr><td class="muted">Deposit to begin (${+pos(d.rates.deposit_pct)}%${calc.retainer ? ' of balance' : ''})</td><td>${money(calc.deposit)}</td></tr>` : ''}
      </table>
      <p class="muted">Material costs are contingent upon lumber availability and may vary.</p>
      <p class="muted pre">${esc(s.quote_terms)}</p>
    </article>`;
}

// ---------- settings ----------
function showSettings() {
  const s = store.settings;
  const inp = (label, key, type = 'text', cls = '') =>
    `<label class="f ${cls}"><span>${label}</span><input data-path="${key}" type="${type}" ${type === 'number' ? 'min="0" step="any"' : ''} value="${esc(s[key])}"></label>`;
  view.innerHTML = `
    <div class="pagehead"><h1>Settings</h1><span class="spacer"></span><span class="muted">Changes save automatically</span></div>
    <div class="card" id="general">
      <fieldset><h2>Your business (shown on quotes)</h2><div class="grid">
        ${inp('Business name', 'business_name', 'text', 'w3')}
        <label class="f w3"><span>Contact details</span><textarea data-path="business_contact" placeholder="Address, phone, email">${esc(s.business_contact)}</textarea></label>
        <label class="f w6"><span>Quote terms</span><textarea data-path="quote_terms">${esc(s.quote_terms)}</textarea></label>
      </div></fieldset>
      <fieldset><h2>Defaults for new quotes</h2><div class="grid">
        ${inp('Hourly rate ($)', 'hourly_rate', 'number')}${inp('Design retainer ($)', 'design_retainer', 'number')}${inp('Contingency (%)', 'contingency_pct', 'number')}${inp('Materials markup (%)', 'markup_pct', 'number')}
        ${inp('Sales tax when no state is set (%)', 'tax_pct', 'number')}${inp('Deposit (%)', 'deposit_pct', 'number')}${inp('Quote valid for (days)', 'quote_valid_days', 'number')}
      </div></fieldset>
      <fieldset><h2>Estimating</h2><div class="grid">
        ${inp('Shop speed multiplier', 'shop_speed', 'number', 'w3')}${inp('Lumber waste allowance (%)', 'waste_pct', 'number', 'w3')}
      </div><p class="muted" style="margin-bottom:0">Shop speed scales every estimated hour: if jobs take you about 20% longer than estimated, set it to 1.2.</p></fieldset>
      <fieldset><h2>Project summaries</h2><div class="grid">
        ${inp('Income tax to set aside (% of profit)', 'income_tax_pct', 'number', 'w3')}
      </div><p class="muted" style="margin-bottom:0">Each project's Summary sets aside this share of its profit for income tax, plus its state's rate (the state picked on a client job, or the no-state sales tax rate above for other work).</p></fieldset>
    </div>
    <div class="card"><h2>Sales tax by state</h2>
      <p class="muted" style="margin-top:0">Choosing a client's state on a quote applies the rate below. These are statewide rates only, without city or county taxes, so check them against current rates before relying on them.</p>
      <details><summary class="link" style="display:inline-block">Show and edit state rates</summary>
        <div class="grid" id="stateTax" style="grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); margin-top:12px">
          ${STATES.map(([code, name]) => `<label class="f" style="grid-column:auto"><span>${name}</span><input type="number" min="0" step="any" data-state="${code}" value="${esc(s.state_tax[code] ?? 0)}"></label>`).join('')}
        </div>
      </details>
    </div>
    <div class="card"><h2>Wood species</h2>
      <p class="muted" style="margin-top:0" id="feedInfo"></p>
      <div style="overflow-x:auto"><table class="list" id="species"></table></div>
      <p><button class="link" id="addSpecies">+ Add species</button></p>
      <p class="muted" style="margin-bottom:0">Labor factor: 1.0 is cherry or walnut. Harder, tear-out-prone woods are above 1, softwoods below.</p>
    </div>
    <div class="card"><h2>Product line</h2>
      <p class="muted" style="margin-top:0">${(s.products || []).length} product${(s.products || []).length === 1 ? '' : 's'} from jmwood.work, for quick batch runs on the Product line tab.
        ${store.shopifyConnected ? 'Shopify is connected: unfulfilled orders keep each product\'s run up to date.' : 'Connect the Shopify app (the <code>SHOPIFY_CLIENT_ID</code> and <code>SHOPIFY_CLIENT_SECRET</code> secrets, see DEPLOYMENT.md) to build runs from unfulfilled orders.'}</p>
      <a class="btn" href="#/products">Edit products</a>
    </div>
    <div class="card"><h2>Backup</h2>
      <p class="muted">Projects and settings are stored on the server and shared by every device you sign in on. Export a backup now and then to keep a copy of your own.</p>
      <div class="actions"><button class="btn" id="export">Export backup</button>
        <button class="btn" id="import">Import backup&hellip;</button><input type="file" id="importFile" accept="application/json,.json" hidden></div>
    </div>
    <div class="card"><h2>This device</h2>
      <p class="muted">Signing out means typing the password again next time, on this device only. Other devices stay signed in.</p>
      <form method="post" action="/logout"><button class="btn">Sign out</button></form>
    </div>`;

  $('#general').addEventListener('input', e => {
    if (!e.target.dataset.path) return;
    s[e.target.dataset.path] = inputValue(e.target);
    settingsChanged();
  });

  const speciesTable = $('#species');
  const itemLabel = i => `${i.species} \u00b7 ${i.size}${i.wide ? ` \u00b7 ${i.wide}` : ''}${i.spec ? ` \u00b7 ${i.spec}` : ''} \u2013 $${i.price.toFixed(2)}`;
  const itemOptions = (list, selected) => feed.items.filter(i => i.list === list)
    .map(i => `<option value="${esc(i.id)}" ${i.id === selected ? 'selected' : ''}>${esc(itemLabel(i))}</option>`).join('');
  const renderSpecies = () => {
    $('#feedInfo').textContent = feed
      ? `Species linked to a Parkerville Wood Products item take its price per board foot. Their price lists are checked weekly; last checked ${fmtDate(feed.checked)}.`
      : 'The Parkerville Wood Products price list could not be loaded just now, so prices are as last saved.';
    speciesTable.innerHTML = `<tr><th>Name</th><th>Parkerville price list item</th><th>$ / board foot</th><th>Labor factor</th><th></th></tr>` + s.species.map((sp, i) => {
      const linked = feed && sp.source && feed.items.some(item => item.id === sp.source);
      return `<tr>
      <td><input data-i="${i}" data-k="name" value="${esc(sp.name)}" aria-label="Species name" style="min-width:110px"></td>
      <td><select data-i="${i}" data-k="source" aria-label="Parkerville price list item" style="min-width:300px" ${feed ? '' : 'disabled'}>
        <option value="">Not linked: I set the price</option>
        ${sp.source && !linked ? `<option value="${esc(sp.source)}" selected>${feed ? 'Linked item is no longer listed' : 'Linked'}</option>` : ''}
        ${feed ? `<optgroup label="Domestic">${itemOptions('domestic', sp.source)}</optgroup><optgroup label="Exotic">${itemOptions('exotic', sp.source)}</optgroup>` : ''}
      </select></td>
      <td><input data-i="${i}" data-k="price" type="number" min="0" step="any" value="${esc(sp.price)}" aria-label="Price per board foot" style="min-width:80px" ${linked ? 'disabled title="Set by the linked price list item"' : ''}></td>
      <td><input data-i="${i}" data-k="labor" type="number" min="0.1" step="0.05" value="${esc(sp.labor)}" aria-label="Labor factor"></td>
      <td><button class="link" data-remove="${i}">remove</button></td></tr>`;
    }).join('');
    speciesTable.querySelectorAll('select:not(:disabled)').forEach(select => typeAhead(select, 440));
  };
  renderSpecies();
  $('#stateTax').addEventListener('input', e => {
    s.state_tax[e.target.dataset.state] = inputValue(e.target);
    settingsChanged();
  });
  speciesTable.addEventListener('input', e => {
    const { i, k } = e.target.dataset;
    if (i === undefined) return;
    s.species[i][k] = inputValue(e.target);
    if (k === 'source') {
      const item = feed?.items.find(x => x.id === e.target.value);
      if (item) s.species[i].price = item.price;
    }
    settingsChanged();
    if (k === 'source') renderSpecies();
  });
  speciesTable.addEventListener('click', e => {
    if (e.target.dataset.remove === undefined) return;
    s.species.splice(Number(e.target.dataset.remove), 1);
    settingsChanged();
    renderSpecies();
  });
  $('#addSpecies').addEventListener('click', () => {
    s.species.push({ name: '', price: 0, labor: 1, source: '' });
    settingsChanged();
    renderSpecies();
    speciesTable.querySelector('tr:last-child input').focus();
  });

  $('#export').addEventListener('click', () => {
    const { shopifyConnected, ...backup } = store;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    a.download = `shop-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#import').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { backup = null; }
    if (!backup || !Array.isArray(backup.projects) || !backup.settings) return toast('That file is not a Shop Tracker backup.');
    if (!confirm(`Replace the ${store.projects.length} project(s) here with the ${backup.projects.length} in this backup?`)) return;
    try {
      await save();
      store = loadStore(await api('/api/import', backup));
    } catch (e) {
      return toast(`Import failed: ${e.message}`);
    }
    saved = snapshot();
    backfillTodos();
    settingsChanged();
    route();
    toast('Backup imported.');
  });
}

// ---------- new-order bell ----------
// The bell in the header counts Shopify orders placed since it was last opened (on any device).
// Opening it lists the latest orders, with the new ones marked, and clears the count.
let bell = { orders: [], open: false, busy: false };
const ago = iso => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  const days = Math.round(min / 1440);
  return days < 7 ? `${days} day${days === 1 ? '' : 's'} ago` : fmtDate(iso);
};
const FULFILLMENT = { UNFULFILLED: 'Unfulfilled', FULFILLED: 'Fulfilled', PARTIALLY_FULFILLED: 'Partly fulfilled', IN_PROGRESS: 'In progress', ON_HOLD: 'On hold', SCHEDULED: 'Scheduled' };

function showBellCount() {
  const n = bell.open ? 0 : bell.orders.filter(o => o.new).length;
  const el = $('#bellCount');
  el.hidden = !n;
  el.textContent = n > 9 ? '9+' : String(n);
  $('#bell').setAttribute('aria-label', n ? `${n} new order${n === 1 ? '' : 's'}` : 'Orders');
  // On a home-screen app that is allowed to, the count shows on the app icon too.
  try { n ? (navigator as any).setAppBadge?.(n) : (navigator as any).clearAppBadge?.(); } catch {}
}

function renderBellPanel(error = '') {
  const fresh = bell.orders.filter(o => o.new), earlier = bell.orders.filter(o => !o.new).slice(0, Math.max(3, 8 - fresh.length));
  // The product line run an order's units are being made in, if one is open.
  const runOf = o => store.projects.find(p => isBatch(p) && !archived(p) && p.data.batch.orders?.some(x => x.name === o.name));
  const row = o => `<li class="${o.new ? 'new' : ''}"><a href="${esc(o.url)}" target="_blank" rel="noopener">
      <span class="ohead"><b>${esc(o.name)}</b><span class="muted">${esc(ago(o.created_at))}</span><span class="amt">${money(o.total)}</span></span>
      <span class="oitems">${o.items.map(i => `${esc(i.title)}${i.variant ? ` (${esc(i.variant)})` : ''} &times; ${i.qty}`).join(', ')}</span>
      ${FULFILLMENT[o.fulfillment] ? `<span class="pill ${o.fulfillment === 'FULFILLED' ? 'accepted' : ''}">${FULFILLMENT[o.fulfillment]}</span>` : ''}
    </a>${runOf(o) ? `<a class="orun" href="#/p/${runOf(o).id}">In the ${esc(projectName(runOf(o)))} run &rarr;</a>` : ''}</li>`;
  $('#bellPanel').innerHTML = `
    <div class="bellhead"><b>Shop orders</b><button type="button" class="bellclose" aria-label="Close">&times;</button></div>
    ${error ? `<p class="note err">${esc(error)}</p>` : ''}
    ${fresh.length ? `<h4>New</h4><ul>${fresh.map(row).join('')}</ul>` : `<p class="muted bellnone">No new orders since you last looked.</p>`}
    ${earlier.length ? `<h4>Earlier</h4><ul>${earlier.map(row).join('')}</ul>` : ''}
    <a class="bellall" href="https://admin.shopify.com/store/vtza5i-0a/orders" target="_blank" rel="noopener">All orders in Shopify</a>`;
}

let bellError = '';
async function loadNewOrders() {
  if (!store.shopifyConnected || bell.busy) return;
  bell.busy = true;
  try {
    const res = await fetch('/api/new-orders', { cache: 'no-store' });
    const data = res.ok || res.status === 502 ? await res.json() : null;
    if (data?.connected) {
      $('#bellWrap').hidden = false;
      bellError = data.error ? "Couldn't reach Shopify just now." : '';
      if (!data.error) {
        // Orders already shown as new in the open panel stay marked until it closes.
        const shownNew = new Set(bell.open ? bell.orders.filter(o => o.new).map(o => o.id) : []);
        bell.orders = data.orders.map(o => ({ ...o, new: o.new || shownNew.has(o.id) }));
      }
      showBellCount();
      if (bell.open) { renderBellPanel(bellError); markOrdersSeen(); }
    }
  } catch {}
  bell.busy = false;
}

function markOrdersSeen() {
  const newest = bell.orders.find(o => o.new);   // newest first
  if (newest) api('/api/new-orders/seen', { upTo: newest.created_at }).catch(() => {});
}

function setBell(open) {
  if (bell.open === open) return;
  bell.open = open;
  $('#bellPanel').hidden = !open;
  $('#bell').setAttribute('aria-expanded', String(open));
  if (open) { renderBellPanel(bellError); markOrdersSeen(); loadNewOrders(); }
  else bell.orders.forEach(o => { o.new = false; });
  showBellCount();
}
$('#bell').addEventListener('click', () => setBell(!bell.open));
$('#bellPanel').addEventListener('click', e => { if ((e.target as Element).closest('.bellclose, .orun')) setBell(false); });
document.addEventListener('click', e => { if (bell.open && !(e.target as Element).closest('#bellWrap')) setBell(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setBell(false); });
window.addEventListener('hashchange', () => setBell(false));

// On a phone app the stream band on the Projects page pins just under the status bar. A fixed bar
// behind the status bar takes the color of the stream at the top of the screen (the page background
// in the gap between streams), so cards and the outgoing band slide under it rather than showing
// behind the clock, and it switches color right as the next band takes over. Pinned bands also get
// the "stuck" class for a stronger shadow.
let stuckFrame = 0;
const statusCover = document.createElement('div');
statusCover.id = 'statusCover';
document.body.append(statusCover);
const markStuckBands = () => {
  stuckFrame = 0;
  const lanes = [...document.querySelectorAll<HTMLElement>('.lane')];
  const head = lanes[0]?.querySelector<HTMLElement>('.lanehead');
  const top = head ? parseFloat(getComputedStyle(head).top) || 0 : 0;
  let color = '';
  if (top > 0 && lanes.length && lanes[0].getBoundingClientRect().top < top) {
    const current = lanes.find(l => { const r = l.getBoundingClientRect(); return r.top <= top + 0.5 && r.bottom > top + 0.5; });
    color = current ? getComputedStyle(current).getPropertyValue('--lane') : getComputedStyle(document.body).backgroundColor;
  }
  statusCover.style.background = color;
  lanes.forEach(l => {
    const h = l.querySelector<HTMLElement>('.lanehead');
    h?.classList.toggle('stuck', top > 0 && h.getBoundingClientRect().top <= top + 0.5);
  });
};
window.addEventListener('scroll', () => { if (!stuckFrame) stuckFrame = requestAnimationFrame(markStuckBands); }, { passive: true });
window.addEventListener('hashchange', () => requestAnimationFrame(markStuckBands));

backfillTodos();
route();
loadPrices();
loadNewOrders();
loadShopProducts().then(loadShopOrders);
// While the page is open, check for new and fulfilled orders every few minutes.
setInterval(() => { if (document.visibilityState === 'visible') loadShopOrders(); }, 5 * 60 * 1000);
// and for the bell every couple of minutes.
setInterval(() => { if (document.visibilityState === 'visible') loadNewOrders(); }, 2 * 60 * 1000);
// Pick up other devices' changes when coming back to this tab, and send pending ones when leaving it.
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' ? save(true) : (loadNewOrders(), refresh().then(loadShopOrders)));
window.addEventListener('pagehide', () => save(true));
window.addEventListener('online', () => save());
