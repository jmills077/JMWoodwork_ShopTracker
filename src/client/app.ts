// Shop Tracker in the browser: every page is drawn here from the shop's data, which the server
// embeds in the page and saves to the database. See README.md for how the pieces fit together.
export {};

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
const streamOf = p => STREAM_NAME[p.stream] ? p.stream : 'client';
const isClient = p => streamOf(p) === 'client';
const statusesFor = stream => stream === 'client' ? STATUSES : OWN_STATUSES;
// Delivered and declined client projects, and finished product and gallery pieces, leave the board for the archive.
const archived = p => isClient(p) ? ['delivered', 'declined'].includes(p.status) : p.status === 'complete';
// A frozen project is on hold: the client went quiet but may come back, or the job hit a long delay.
// It keeps its status, phase and dates, but leaves the board and calendar for the Frozen list, and
// its Todoist project is archived, until it is unfrozen. data.frozen is { at, reason }.
const isFrozen = p => !!p.data?.frozen;
// A status from one stream carried over to another when a project changes stream.
const STATUS_IN_STREAM = {
  client: { planned: 'draft' },
  own: { draft: 'planned', sent: 'planned', declined: 'planned', accepted: 'planned', delivered: 'complete' },
};
// The phase of the work itself, tracked separately from the quote/job status above.
const STAGES = [['ideation', 'Ideation'], ['design', 'Design'], ['build', 'Build'], ['finishing', 'Finishing'], ['ready', 'Delivery']];
const STAGE_NAME = Object.fromEntries(STAGES);
const stageOf = p => STAGE_NAME[p.stage] ? p.stage : 'ideation';
// Each phase after ideation has its own due date. The last phase's is the project's target completion date.
const stageDue = (p, key) => (key === 'ready' ? p.data.due_date : key === 'ideation' ? '' : p.data.stage_due?.[key]) || '';
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
  // A Todoist sync interrupted by closing the page must be retryable.
  for (const p of saved.projects || []) delete p.todoist?.busy;
  return {
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...(saved.settings || {}) },
    projects: Array.isArray(saved.projects) ? saved.projects : [],
    todoistConnected: !!saved.todoistConnected,   // whether the server has a Todoist token (the TODOIST_TOKEN secret)
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
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const hrs = n => `${+num(n).toFixed(2)} h`;
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

// ---------- Todoist ----------
// Requests go through the server, which adds the API token (the TODOIST_TOKEN secret) and passes them on to Todoist.
const TODOIST_API = '/api/todoist';

async function todoist(method, path, body?) {
  let res;
  try {
    res = await fetch(TODOIST_API + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach Todoist. Check your internet connection.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('Todoist rejected the API token. Check the TODOIST_TOKEN secret.');
  if (!res.ok) throw Object.assign(new Error(`Todoist returned ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
  return res.status === 204 ? {} : res.json();
}

// The task list created in Todoist when a quote is accepted.
function todoistPlan(p) {
  const { data, calc } = p;
  const client = isClient(p);
  const tasks = [
    ...(client ? [{ content: `Collect deposit (${money(calc.deposit)})`, description: `Quote ${p.quote_number}, total ${money(calc.total)}` }] : []),
    { content: 'Order lumber & hardware', description: `About ${calc.lumber?.feet ? lumberSummary(data, calc.lumber) : `${calc.board_feet} board feet of ${data.spec.species || 'lumber'}`}` },
  ];
  for (const phase of data.phases) {
    if (pos(phase.hours) > 0 && phase.name) tasks.push({ content: phase.name, description: `Estimated ${hrs(phase.hours)}` });
  }
  if (client) tasks.push({ content: `Collect final payment (${money((calc.balance ?? calc.total) - calc.deposit)})`, description: '' });
  const name = projectName(p) + (client && data.client_name ? ` - ${data.client_name}` : client ? '' : ` - ${STREAM_NAME[streamOf(p)]}`);
  return { name: name.slice(0, 120), tasks };
}

// Creates the Todoist project and its tasks. Picks up where it left off if a previous attempt failed part-way.
async function syncTodoist(p) {
  const state = p.todoist;
  if (state.synced || state.busy || isFrozen(p)) return;
  if (!store.todoistConnected) { state.error = 'No Todoist API token is set. Set the TODOIST_TOKEN secret, then retry.'; persist(); return; }
  if (!state.plan) { state.plan = todoistPlan(p); state.created = 0; }
  state.busy = true;
  try {
    if (!state.project_id) {
      const created = await todoist('POST', '/projects', { name: state.plan.name });
      if (!created.id) throw new Error('Unexpected response from Todoist.');
      state.project_id = String(created.id);
      state.url = `https://app.todoist.com/app/project/${state.project_id}`;
      persist();
    }
    while (state.created < state.plan.tasks.length) {
      await todoist('POST', '/tasks', { ...state.plan.tasks[state.created], project_id: state.project_id });
      state.created++;
      persist();
    }
    state.synced = true;
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  delete state.busy;
  p.updated_at = new Date().toISOString();
  persist();
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
  // Wait for a Todoist project that is mid-creation, so its progress isn't replaced underneath it.
  if (store.projects.some(p => p.todoist.busy)) return;
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
  store.todoistConnected = next.todoistConnected;
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

function route() {
  currentHash = location.hash || '#/';
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
  else if (parts[0] === 'tasks') {
    nav = 'tasks';
    const listed = store.projects.find(p => p.id === Number(parts[1]));
    if (listed) showTodo(listed); else showTasks();
  }
  else if (project && parts[2] === 'quote' && isClient(project)) showQuote(project);
  else if (project && parts[2] === 'design') showDesign(project);
  else if (project && isBatch(project)) showBatch(project);
  else if (project) showEditor(project);
  else showBoard();
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === nav));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => {
  if (ed && !ed.project && ed.dirty && !confirm('Discard this unsaved quote?')) {
    history.replaceState(null, '', currentHash);
    return;
  }
  route();
});

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
  const tabs = `<nav class="tabs streams">${[['all', 'All projects'], ...STREAMS].map(([key, name]) =>
    `<a href="${key === 'all' ? '#/s/all' : `#/s/${key}`}" class="${key === tab ? 'on' : ''}">${name}
      <small>${store.projects.filter(p => key === 'all' || streamOf(p) === key).filter(p => !archived(p) && !isFrozen(p)).length}</small></a>`).join('')}
    <span class="spacer"></span><a href="#/frozen" class="frozenlink">Frozen <small>${frozenCount}</small></a></nav>`;
  const newLabel = tab === 'client' ? 'New quote' : 'New project';
  const head = `<div class="pagehead"><h1>Projects</h1><span class="spacer"></span><a class="btn primary" href="${newLink()}">${newLabel}</a></div>${tabs}`;
  const quick = tab === 'product' ? '<div class="card" id="quickBatch"></div>' : '';
  if (!shown.length) {
    view.innerHTML = `${head}${quick}<div class="card empty"><h1>Nothing here yet</h1>
      <p class="muted">${tab === 'all' ? 'Start by pricing a piece for a client, or plan one of your own.' : esc(STREAMS.find(x => x[0] === tab)[2])}</p>
      <p><a class="btn primary" href="${newLink()}">${newLabel}</a></p></div>`;
    if (quick) renderQuickBatch();
    return;
  }
  const active = by('accepted', 'in_progress');
  const stat = (label, value, note) => `<div class="card stat"><span class="muted">${label}</span><b>${value}</b><span class="muted">${note}</span></div>`;
  let stats;
  if (tab === 'client' || tab === 'all') {
    const open = by('sent'), done = by('complete', 'delivered');
    const booked = active.filter(isClient);
    stats = stat('Quotes awaiting answer', money(sum(open, p => p.calc.total)), `${open.length} sent`)
      + stat('Booked client work', money(sum(booked, p => p.calc.total)), `${booked.length} active`)
      + stat('Shop hours booked', hrs(sum(active, shopHours)), tab === 'all' ? 'all active work' : 'accepted + in progress')
      + (tab === 'all' ? stat('Completed', String(done.length), 'pieces finished')
        : stat('Completed', money(sum(done, p => p.calc.total)), `${done.length} finished`));
  } else {
    const planned = by('planned'), done = by('complete');
    const valueLabel = tab === 'product' ? 'retail value' : 'cost';
    stats = stat('Planned', String(planned.length), `${money(sum(planned, valueOf))} ${valueLabel}`)
      + stat('In progress', String(active.length), `${money(sum(active, valueOf))} ${valueLabel}`)
      + stat('Shop hours booked', hrs(sum(active, shopHours)), 'in progress')
      + stat('Completed', String(done.length), `${money(sum(done, valueOf))} ${valueLabel}`);
  }
  const jobCard = p => `<a class="job" href="#/p/${p.id}" draggable="true" data-id="${p.id}">
      <b>${esc(projectName(p))}</b>
      <div class="row"><span>${isClient(p) ? esc(p.data.client_name || 'No client yet') : streamOf(p) === 'gallery' ? 'Cost' : 'Retail price'}</span><span class="amt">${money(valueOf(p))}</span></div>
      <div class="row"><span>${isClient(p) ? esc(p.quote_number) : ''}</span><span>${hrs(shopHours(p))}</span></div>
      <div class="row foot"><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span>${isBatch(p) && p.data.due_date ? `<span>Ship by ${esc(fmtDate(p.data.due_date))}</span>` : stageDue(p, stageOf(p)) ? `<span>Phase due ${esc(fmtDate(stageDue(p, stageOf(p))))}</span>` : ''}</div>
    </a>`;
  const archive = shown.filter(archived).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const inStage = (key, list = shown) => list.filter(p => !archived(p) && stageOf(p) === key).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const boardHtml = (list = shown) => `<div class="board">
      ${STAGES.map(([key, name]) => `<section class="col" data-stage="${key}">
        <h2><span>${name}</span><span>${inStage(key, list).length}</span></h2>${inStage(key, list).map(jobCard).join('')}</section>`).join('')}
    </div>`;
  // "All projects" shows each stream as its own section, one above the other. Every section keeps its
  // columns, even when empty, so a card can be dragged into another stream.
  const lanes = () => STREAMS.map(([key, name]) => {
    const list = shown.filter(p => streamOf(p) === key), open = list.filter(p => !archived(p));
    return `<section class="lane ${key}" data-stream="${key}">
      <div class="lanehead"><h2>${name} <span>${open.length}</span></h2><a href="#/s/${key}">Open ${name.toLowerCase()} &rarr;</a></div>
      ${boardHtml(list)}
    </section>`;
  }).join('');
  view.innerHTML = `
    ${head}
    ${quick}
    <div class="stats">${stats}</div>
    <div class="boards">${tab === 'all' ? lanes() : boardHtml()}</div>
    ${archive.length ? `<div class="card" style="margin-top:20px"><h2>Archive</h2><table class="list">
      <tr><th>Project</th><th>${tab === 'client' ? 'Client' : tab === 'all' ? 'Stream' : ''}</th><th>${tab === 'client' ? 'Quote' : ''}</th><th>${tab === 'gallery' ? 'Cost' : 'Total'}</th><th>Status</th></tr>
      ${archive.map(p => `<tr><td><a href="#/p/${p.id}">${esc(projectName(p))}</a></td>
        <td>${tab === 'client' ? esc(p.data.client_name) : tab === 'all' ? STREAM_NAME[streamOf(p)] : ''}</td>
        <td>${tab === 'client' ? esc(p.quote_number) : ''}</td><td>${money(valueOf(p))}</td><td><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></td></tr>`).join('')}
      </table></div>` : ''}`;

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
    setStage(p, col.dataset.stage);
    if (move) setStream(p, stream);
    else showBoard();
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
  const jobs = store.projects.filter(p => !isFrozen(p) && ['accepted', 'in_progress', 'complete'].includes(p.status)).map(p => {
    const began = (isClient(p) && p.history.findLast(h => h.status === 'accepted')) || p.history.findLast(h => h.status === 'in_progress');
    const start = ymd(new Date(began?.at || p.updated_at));
    const current = STAGES.findIndex(([key]) => key === stageOf(p));
    const dated = STAGES.map(([key], i) => ({ key, i, due: stageDue(p, key) })).filter(x => x.due);
    let segs = [];
    if (dated.some(x => x.key !== 'ready')) {
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
        const text = named ? `${projectName(j.p)} \u00b7 ${STAGE_NAME[seg.key]}${due ? ' (due)' : ''}` : due ? 'Due' : '';
        return `<a class="bar st-${seg.key} ${seg.past ? 'past' : ''} ${named ? 'label' : ''} ${key === j.start ? 's' : ''} ${key === j.end ? 'e' : ''}" href="#/p/${j.p.id}"
          title="${esc(projectName(j.p))} \u2013 ${esc(isClient(j.p) ? j.p.data.client_name || STREAM_NAME.client : STREAM_NAME[streamOf(j.p)])}">${esc(text)}</a>`;
      }).join('')}</div>`;
    }
    day.setDate(day.getDate() + 7);
  } while (day.getMonth() === mon - 1 && day.getFullYear() === year);

  const daysLeft = due => Math.round((+new Date(due + 'T00:00') - +new Date(today + 'T00:00')) / 86400000);
  const dueText = (j, due) => {
    if (!due) return `<a href="#/p/${j.p.id}">Set a date</a>`;
    const n = daysLeft(due);
    return `${esc(fmtDate(due))} <span class="${n < 0 ? 'late' : 'muted'}">(${n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'} left`})</span>`;
  };
  view.innerHTML = `
    <div class="pagehead">
      <h1>${new Date(year, mon - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1><span class="spacer"></span>
      <a class="btn" href="${monthLink(-1)}" aria-label="Previous month">&larr;</a>
      <a class="btn" href="#/calendar">Today</a>
      <a class="btn" href="${monthLink(1)}" aria-label="Next month">&rarr;</a>
    </div>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(n => `<div class="dow">${n}</div>`).join('')}${cells}</div>
    <div class="legend">${STAGES.map(([key, name]) => `<span><span class="swatch st-${key}"></span>${name}</span>`).join('')}</div>
    <div class="card" style="margin-top:16px"><h2>Scheduled projects</h2>
      ${jobs.length ? `<table class="list"><tr><th>Project</th><th>Client or stream</th><th>Phase</th><th>Phase due</th><th>Target completion</th></tr>
        ${jobs.map(j => `<tr><td><span class="swatch st-${stageOf(j.p)}"></span><a href="#/p/${j.p.id}">${esc(projectName(j.p))}</a></td>
          <td>${isClient(j.p) ? esc(j.p.data.client_name) : STREAM_NAME[streamOf(j.p)]}</td><td>${STAGE_NAME[stageOf(j.p)]}</td><td>${dueText(j, stageDue(j.p, stageOf(j.p)))}</td><td>${dueText(j, j.p.data.due_date)}</td></tr>`).join('')}</table>`
        : '<p class="muted" style="margin:0">Nothing is scheduled. A project appears here once its quote is marked accepted (or work starts on a product or gallery piece), from that day to its target completion date.</p>'}
    </div>`;
}

// ---------- type-ahead dropdowns ----------
// Replaces a <select> with a box you can type in to narrow the choices. The select stays in the
// page, hidden, as the value the form reads, and gets an "input" event when the choice changes.
// The list floats over the page (so a scrolling table can't clip it) and closes if the page scrolls.
let comboCount = 0, closeOpenCombo = null;
window.addEventListener('scroll', e => {
  if (closeOpenCombo && !(e.target instanceof Element && e.target.closest('.combo ul'))) closeOpenCombo();
}, true);

function typeAhead(select, minWidth = 0) {
  const id = `combo${++comboCount}`;
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  wrap.innerHTML = `<input type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}" autocomplete="off" spellcheck="false"><ul id="${id}" role="listbox" hidden></ul>`;
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
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    // Line the list up under the box, or above it when there's no room below.
    const box = input.getBoundingClientRect(), width = Math.min(Math.max(box.width, minWidth), window.innerWidth - 16);
    const below = window.innerHeight - box.bottom, above = box.top;
    const flip = below < Math.min(list.scrollHeight, 264) + 8 && above > below;
    Object.assign(list.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`,
      top: flip ? '' : `${box.bottom + 3}px`,
      bottom: flip ? `${window.innerHeight - box.top + 3}px` : '',
    });
    closeOpenCombo = close;
    setActive(q ? (shown.length ? 0 : -1) : shown.indexOf(current()));
  };
  const close = () => {
    if (closeOpenCombo === close) closeOpenCombo = null;
    list.hidden = true;
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
  return `<div class="noprint">
    <a href="${boardLink()}" class="back">&larr; Projects</a>
    <div class="projhead">
      <div class="name"><h1 id="projTitle">${esc(projectName(p))}</h1><span class="pill ${p.status}" id="statusPill">${STATUS_NAME[p.status]}</span></div>
      <div class="sub">${isClient(p) ? `${esc(p.quote_number)} &middot; ` : ''}${STREAM_NAME[streamOf(p)]}</div>
    </div>
    ${isFrozen(p) ? `<div class="note frozen"><span><b>Frozen since ${esc(fmtDate(p.data.frozen.at))}</b>${p.data.frozen.reason ? `: ${esc(p.data.frozen.reason)}` : ''}.
      It's off the board and calendar until you unfreeze it.</span><button type="button" class="btn small" data-unfreeze="${p.id}">Unfreeze</button></div>` : ''}
    <nav class="tabs">
      <a href="#/p/${p.id}" class="${tab === 'details' ? 'on' : ''}">Details</a>
      <a href="#/p/${p.id}/design" class="${tab === 'design' ? 'on' : ''}">Design notes</a>
      <a href="#/tasks/${p.id}">To-do list</a>
      ${isClient(p) ? `<a href="#/p/${p.id}/quote" class="${tab === 'quote' ? 'on' : ''}">Client quote</a>` : ''}
      <span class="spacer"></span><span class="side">${side}</span>
    </nav>
  </div>`;
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

  view.innerHTML = `
    ${project ? projectHeader(project, 'details', '<span class="muted">Changes save automatically</span>')
      : `<a href="${boardLink()}" class="back">&larr; Projects</a><div class="pagehead"><h1>${client ? 'New quote' : `New ${STREAM_NAME[stream].toLowerCase()} piece`}</h1>
        <span class="spacer"></span><a href="#/new">Change kind of project</a></div>`}
    ${project ? '<div class="stages" id="stages" role="group" aria-label="Project phase"></div>' : ''}
    <div class="cols">
      <form class="card" id="form" autocomplete="off">
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
          ${project ? '<div class="actions" style="margin-top:12px"><button type="button" class="btn" id="lumberSend">Send to Todoist</button><span class="muted" id="lumberSent" style="font-size:13px"></span></div>' : ''}
        </div>
        ${project ? '<div class="card" id="statusCard"></div><div class="card" id="todoistCard"></div>' : ''}
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
  $('#lumberSend')?.addEventListener('click', async e => {
    e.target.disabled = true;
    await sendLumberTask(project);
    e.target.disabled = false;
  });

  if (project) {
    $('#delete').addEventListener('click', () => {
      const synced = project.todoist.project_id ? ' Its Todoist project will be left as it is.' : '';
      const what = isClient(project) ? `${project.quote_number} (${projectName(project)})` : projectName(project);
      if (!confirm(`Delete ${what}? This cannot be undone.${synced}`)) return;
      store.projects = store.projects.filter(p => p !== project);
      persist();
      location.hash = boardLink();
    });
    renderStages();
    renderStatusCard();
    renderTodoistCard();
  }
  renderPanel();
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
  $('[data-lumber="bf"]').placeholder = `Estimate: ${calc.board_feet}`;
  $('[data-lumber="quarters"]').value = n.quarters;
  $('#lumberOut').innerHTML = n.feet
    ? `<b>About ${esc(lumberSummary(d, n))}</b><br><span class="muted" style="font-size:13px">${+n.bf} board feet &times; 12 &divide; (${n.quarters / 4}" &times; ${+n.width}") = ${+n.exactFeet.toFixed(1)} ft,
        rounded up to full ${BOARD_LENGTH_FT} ft boards. That is ${+n.buyBf} board feet to buy, which the materials cost above is based on.</span>`
    : `<span class="muted">Enter the width of the boards available to see how many linear feet to buy, in full ${BOARD_LENGTH_FT} ft boards.</span>`;
  if ($('#lumberSent')) $('#lumberSent').textContent = d.lumber.sent ? `Last sent: ${d.lumber.sent}` : '';
}

// Creates a pickup task in Todoist, or updates the one sent earlier if it is still open.
async function sendLumberTask(p) {
  const n = p.calc.lumber, lumber = p.data.lumber;
  if (!n.feet) return toast('Enter the board width first.');
  if (!store.todoistConnected) return toast('Todoist is not connected. Set the TODOIST_TOKEN secret first.');
  const summary = lumberSummary(p.data, n);
  const body = {
    content: `Pick up about ${summary}`,
    description: `${+n.bf} board feet for ${projectName(p)} (${isClient(p) ? p.quote_number : STREAM_NAME[streamOf(p)]}).`,
  };
  try {
    let task = null, updated = false;
    if (lumber.task_id) {
      try { task = await todoist('POST', `/tasks/${lumber.task_id}`, body); } catch { task = null; }
      updated = !!task?.id && !task.checked && !task.is_deleted;
    }
    if (!updated) {
      const home = p.todoist.project_id ? { project_id: p.todoist.project_id } : {};   // the job's own list, else the Inbox
      try { task = await todoist('POST', '/tasks', { ...body, ...home }); }
      catch (e) { if (!home.project_id) throw e; task = await todoist('POST', '/tasks', body); }
    }
    lumber.task_id = String(task.id);
    lumber.sent = summary;
    p.updated_at = new Date().toISOString();
    persist();
    toast(updated ? 'Todoist task updated.' : 'Pickup task sent to Todoist.');
  } catch (e) {
    toast(`Todoist: ${e.message}`);
  }
  if (ed?.project === p) renderLumber(p.calc);
}

async function createProject() {
  if (ed.creating) return;
  const stamp = new Date().toISOString(), stream = ed.stream, status = stream === 'client' ? 'draft' : 'planned';
  if (stream !== 'client') Object.assign(ed.data, { client_name: '', client_email: '', client_phone: '', client_state: '', retainer: 0 });
  const draft = {
    stream, status,
    stage: 'ideation', data: ed.data, calc: price(ed.data, stream), todoist: {}, history: [{ status, at: stamp }], created_at: stamp, updated_at: stamp,
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
  // A product-line piece gets its Todoist list right away, so materials can be bought as soon as it's ordered.
  if (stream === 'product' && store.todoistConnected) runTodoistSync(project);
}

function renderStatusCard() {
  const p = ed.project, client = isClient(p), next = (client ? NEXT_STEP : OWN_NEXT_STEP)[p.status];
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
  $('#statusSelect').addEventListener('change', e => setStatus(p, e.target.value));
  $('#streamSelect').addEventListener('change', e => setStream(p, e.target.value));
}

// Moves a project to another stream, carrying its status over to the nearest one that stream has.
function setStream(p, stream) {
  if (stream === streamOf(p)) return;
  const status = STATUS_IN_STREAM[stream === 'client' ? 'client' : 'own'][p.status] || p.status;
  p.stream = stream;
  p.calc = priceProject(p, stream);
  p.updated_at = new Date().toISOString();
  if (status !== p.status) { p.status = status; p.history.push({ status, at: p.updated_at }); }
  persist();
  toast(`Moved to ${STREAM_NAME[stream]}`);
  route();
}

function renderStages() {
  const p = ed.project, current = STAGES.findIndex(([key]) => key === stageOf(p)), today = ymd(new Date());
  const el = $('#stages');
  el.innerHTML = STAGES.map(([key, name], i) => {
    const due = stageDue(p, key);
    return `<div>
      <button type="button" data-stage="${key}" class="${i < current ? 'done' : i === current ? 'on' : ''}" ${i === current ? 'aria-current="step"' : ''}>${i < current ? '&#10003; ' : ''}${name}</button>
      ${key === 'ideation' ? '' : `<label class="due ${i === current && due && due < today ? 'late' : ''}"><span>${i === current && due && due < today ? 'Overdue' : 'Due'}</span>
        <input type="date" data-due="${key}" value="${esc(due)}" aria-label="${name} due date"></label>`}
    </div>`;
  }).join('');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setStage(p, b.dataset.stage);
    renderStages();
    renderStatusCard();
  }));
  el.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
    if (input.dataset.due === 'ready') p.data.due_date = input.value;
    else (p.data.stage_due ??= {})[input.dataset.due] = input.value;
    p.updated_at = new Date().toISOString();
    persist();
    renderStages();
  }));
}

function setStage(p, stage) {
  if (stage === stageOf(p)) return;
  p.stage = stage;
  p.updated_at = new Date().toISOString();
  p.history.push({ stage, at: p.updated_at });
  persist();
}

async function setStatus(p, status) {
  if (status === p.status) return;
  p.status = status;
  p.updated_at = new Date().toISOString();
  p.history.push({ status, at: p.updated_at });
  if (isFinished(p)) finishTodo(p);
  persist();
  if (ed?.project === p) { renderStatusCard(); renderTodoistCard(); }
  else showBoard();
  // Accepting a quote, or starting work on one of the shop's own pieces, opens the job in Todoist.
  if (status === (isClient(p) ? 'accepted' : 'in_progress') && !p.todoist.synced && !p.todoist.busy) {
    if (isFrozen(p)) toast('Its Todoist list will be made when you unfreeze it.');
    else if (store.todoistConnected) await runTodoistSync(p);
    else toast(`${isClient(p) ? 'Quote accepted' : 'Work started'}. Set the TODOIST_TOKEN secret to create its task list.`);
  }
}

async function runTodoistSync(p) {
  const first = !p.todoist.project_id;
  const pending = isBatch(p) ? syncBatchTodoist(p) : syncTodoist(p);
  if (ed?.project === p) renderTodoistCard();
  await pending;
  toast(p.todoist.error ? `Todoist: ${p.todoist.error}` : first ? 'Todoist project created.' : 'Todoist updated.');
  if (ed?.project === p) renderTodoistCard();
}

function renderTodoistCard() {
  const p = ed.project, t = p.todoist, card = $('#todoistCard');
  if (!card) return;
  const wanted = streamOf(p) === 'product' || ['accepted', 'in_progress', 'complete'].includes(p.status);
  const when = isClient(p) ? 'this quote is accepted' : streamOf(p) === 'product' ? 'the project is created' : 'work starts';
  let body;
  if (t.archive_error) body = `<p class="note err">${esc(t.archive_error)}</p>
    <div class="actions"><button class="btn primary" id="archiveRetry">Retry</button>${t.url ? `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open in Todoist</a>` : ''}</div>`;
  else if (isFrozen(p)) body = t.project_id
    ? `<p class="muted">Its Todoist project is archived while the project is frozen. Unfreezing brings it back with its tasks as they were.</p>`
    : '<p class="muted">Frozen. Any Todoist list is made once it is unfrozen.</p>';
  else if (isBatch(p)) body = batchTodoistHtml(p);
  else if (t.busy) body = '<p class="note">Creating the project and tasks in Todoist&hellip;</p>';
  else if (t.synced) body = `<p class="note ok">Task list created (${t.plan.tasks.length} tasks).</p>
    <a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open in Todoist</a>`;
  else if (t.error) body = `<p class="note err">${esc(t.error)}</p>
    ${t.created ? `<p class="muted">${t.created} of ${t.plan.tasks.length} tasks were created. Retrying continues from there.</p>` : ''}
    <div class="actions"><button class="btn primary" id="sync">Retry</button><a href="#/settings">Todoist settings</a></div>`;
  else if (!store.todoistConnected) body = `<p class="muted">Connect Todoist (see <a href="#/settings">Settings</a>) and a project with a task list will be created when ${when}.</p>`;
  else if (wanted) body = '<button class="btn primary" id="sync">Create Todoist project</button>';
  else body = `<p class="muted">A Todoist project with one task per build phase will be created when ${when}.</p>`;
  card.innerHTML = `<h2>Todoist</h2>${body}`;
  $('#sync', card)?.addEventListener('click', () => runTodoistSync(p));
  $('#archiveRetry', card)?.addEventListener('click', () => matchTodoistToFreeze(p));
}

// ---------- frozen projects ----------
function freezeProject(p) {
  const reason = prompt(`Freeze ${projectName(p)}? It leaves the board and calendar until you unfreeze it${p.todoist.project_id ? ', and its Todoist project is archived' : ''}.\n\nWhy is it on hold? (optional)`, '');
  if (reason === null) return;
  const at = new Date().toISOString();
  p.data.frozen = { at, reason: reason.trim() };
  p.updated_at = at;
  p.history.push({ frozen: true, at, ...(reason.trim() ? { note: reason.trim() } : {}) });
  persist();
  toast(`${projectName(p)} is frozen. It's under Frozen on the Projects page.`);
  route();
  matchTodoistToFreeze(p);
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
  matchTodoistToFreeze(p);
}

// Archives a frozen project's Todoist project, and brings it back (tasks and all) when it is unfrozen.
// A batch run edited while frozen is then brought up to date, and a job that was accepted or started
// while frozen gets the Todoist list it would have had.
async function matchTodoistToFreeze(p) {
  const t = p.todoist, frozen = isFrozen(p);
  if (t.busy) { setTimeout(() => matchTodoistToFreeze(p), 1500); return; }
  if (t.project_id && !!t.archived !== frozen) {
    if (!store.todoistConnected) t.archive_error = 'No Todoist API token is set. Set the TODOIST_TOKEN secret, then retry.';
    else {
      try {
        await todoist('POST', `/projects/${t.project_id}/${frozen ? 'archive' : 'unarchive'}`);
        t.archived = frozen;
        delete t.archive_error;
      } catch (e) {
        if (e.status === 404) t.archived = frozen;   // deleted in Todoist: nothing to archive or bring back
        else t.archive_error = `Couldn't ${frozen ? 'archive' : 'bring back'} its Todoist project. ${e.message}`;
      }
    }
    p.updated_at = new Date().toISOString();
    persist();
  } else if (t.archive_error) {
    delete t.archive_error;
    persist();
  }
  if (t.archive_error) toast(`Todoist: ${t.archive_error}`);
  else if (!frozen && store.todoistConnected) {
    if (isBatch(p) && t.project_id) await syncBatchTodoist(p);
    else if (!t.project_id && !t.synced && p.status === (isClient(p) ? 'accepted' : 'in_progress')) await runTodoistSync(p);
    else if (t.project_id) toast('Its Todoist project is back.');
  }
  if (ed?.project === p) renderTodoistCard();
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
    <p class="muted">Projects on hold: a client who's gone quiet but may come back, or a job with a long delay. They stay off the board and calendar,
      and their Todoist projects are archived. Unfreezing one puts it back on the board where it left off and brings its Todoist project back.</p>
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
// is finished (a client job delivered, or one of the shop's own pieces complete) everything is checked off.
const TODO_LISTS = { items: 'To-do list', lumber: 'Shopping list' };
let taskSeq = 0;
const newTask = (text, extra = {}) => ({ id: `t${Date.now().toString(36)}${(taskSeq++).toString(36)}`, text, done_at: null, ...extra });
const isFinished = p => isClient(p) ? p.status === 'delivered' : p.status === 'complete';

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

// The Tasks page: every active project, to open its list.
function showTasks() {
  const active = store.projects.filter(p => !archived(p) && !isFrozen(p))
    .sort((a, b) => (a.data.due_date || '9999').localeCompare(b.data.due_date || '9999') || b.updated_at.localeCompare(a.updated_at));
  const frozen = store.projects.filter(isFrozen).length;
  view.innerHTML = `<div class="pagehead"><h1>Tasks</h1></div>
    ${active.length ? `<div class="taskgrid">${active.map(p => {
      const c = todoCounts(p), today = ymd(new Date()), due = p.data.due_date;
      return `<a class="card taskproj" href="#/tasks/${p.id}">
        <div class="name"><b>${esc(projectName(p))}</b><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span></div>
        <span class="muted" style="font-size:13px">${isClient(p) ? esc(p.data.client_name || p.quote_number) : STREAM_NAME[streamOf(p)]}${due ? ` &middot; <span class="${due < today ? 'late' : ''}">due ${esc(fmtDate(due))}</span>` : ''}</span>
        <div class="progress" aria-hidden="true"><span style="width:${c.total ? Math.round(c.done / c.total * 100) : 0}%"></span></div>
        <span style="font-size:13px">${c.total ? `${c.done} of ${c.total} done` : 'No tasks yet'}${c.next ? `<br><span class="muted">Next: ${esc(c.next.text)}</span>` : ''}</span>
      </a>`;
    }).join('')}</div>`
    : `<div class="card empty"><p class="muted" style="margin:0">No active projects. Every new project gets its own to-do list as soon as it's created.</p></div>`}
    ${frozen ? `<p class="muted" style="font-size:13px;margin-top:16px">${frozen} frozen project${frozen === 1 ? '' : 's'} not shown. Their lists are on their own pages (see <a href="#/frozen">Frozen</a>).</p>` : ''}`;
}

// One project's to-do list, its lumber store shopping list and the log of everything done.
function showTodo(p) {
  if (!p.data.todo) { p.data.todo = defaultTodo(p); todoChanged(p); }
  const todo = p.data.todo;
  view.innerHTML = `<a href="#/tasks" class="back">&larr; Tasks</a>
    <div class="pagehead"><h1>${esc(projectName(p))}</h1><span class="pill ${p.status}">${STATUS_NAME[p.status]}</span>
      <span class="spacer"></span><a class="btn" href="#/p/${p.id}">Open project</a></div>
    ${isFrozen(p) ? `<p class="note frozen">This project is frozen. Its list is kept as it is until you unfreeze it.</p>` : ''}
    <div class="cols">
      <div class="card">
        <h2>To-do list</h2>
        <form class="addtask" data-list="items" autocomplete="off"><input placeholder="Add a task" aria-label="New task"><button class="btn primary">Add</button></form>
        <ul class="tasks" data-list="items"></ul>
        <p class="muted hint">Press and hold a task to move it up or down the list.</p>
      </div>
      <aside>
        <div class="card">
          <h2>Lumber store shopping list</h2>
          <form class="addtask" data-list="lumber" autocomplete="off"><input placeholder="Add something to buy" aria-label="New shopping list item"><button class="btn primary">Add</button></form>
          <ul class="tasks" data-list="lumber"></ul>
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

  view.querySelectorAll('form.addtask').forEach(form => form.addEventListener('submit', e => {
    e.preventDefault();
    const input = form.querySelector('input'), text = input.value.trim(), list = form.dataset.list;
    if (!text) return input.focus();
    todo[list].push(newTask(text));
    todoChanged(p, { what: 'added', text, list });
    input.value = '';
    redraw();
    input.focus();
  }));

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
  redraw();
}

// Press and hold an item to pick it up, then drag it up or down the list and let go. A quick swipe
// still scrolls the page; only a steady press lifts the item. `drop` gets the new order of ids.
function longPressReorder(ul, drop) {
  let timer = null, lifted = null, startX = 0, startY = 0, movedUntil = 0, pointer = null, order = '';
  const cancelPress = () => { clearTimeout(timer); timer = null; };
  ul.addEventListener('contextmenu', e => { if (e.target.closest('li.task')) e.preventDefault(); });
  // While an item is lifted, a finger moving on the screen drags it instead of scrolling the page.
  ul.addEventListener('touchmove', e => { if (lifted) e.preventDefault(); }, { passive: false });
  ul.addEventListener('pointerdown', e => {
    const li = e.target.closest('li.task');
    if (!li || e.button > 0 || e.target.closest('.x')) return;
    startX = e.clientX; startY = e.clientY; pointer = e.pointerId;
    cancelPress();
    timer = setTimeout(() => {
      timer = null;
      lifted = li;
      order = [...ul.querySelectorAll('li.task')].map(x => x.dataset.id).join();
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
    const others = [...ul.querySelectorAll('li.task')].filter(x => x !== lifted);
    const before = others.find(x => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if ((before || null) !== lifted.nextElementSibling) ul.insertBefore(lifted, before || null);
  });
  const end = () => {
    cancelPress();
    if (!lifted) return;
    lifted.classList.remove('lifted');
    lifted = null;
    movedUntil = Date.now() + 400;   // the click that follows letting go is not a tap on the task
    const ids = [...ul.querySelectorAll('li.task')].map(x => x.dataset.id);
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
// catalog edits don't change runs already under way. Its Todoist project is created with the run and
// kept up to date as units or the date change.
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

// What the run's Todoist project should hold: buying materials first, a task per variant, and shipping.
function batchTodoistPlan(p) {
  const b = p.data.batch, units = batchUnits(b), ship = p.data.due_date || '';
  const making = b.variants.filter(v => pos(v.qty) > 0);
  const breakdown = making.map(v => `${pos(v.qty)} \u00d7 ${variantLabel(b, v)}`).join('\n');
  const tasks = [
    { key: 'materials', content: `Buy materials for ${units} \u00d7 ${b.product}`,
      description: [b.materials ? `Per unit: ${b.materials}` : '', breakdown].filter(Boolean).join('\n\n'), due: ymd(new Date(p.created_at)) },
    ...making.map(v => ({ key: `v:${v.id}`, content: `Make ${pos(v.qty)} \u00d7 ${variantLabel(b, v)}`, description: '', due: ship })),
    { key: 'ship', content: `Ship ${units} \u00d7 ${b.product}`, description: breakdown, due: ship },
  ];
  const name = `${b.product} \u00d7 ${units}${ship ? ` - ship by ${fmtDate(ship)}` : ''}`;
  return { name: name.slice(0, 120), tasks };
}

// Brings the run's Todoist project in line with the run: creates it the first time, then renames it and
// adds, updates or deletes tasks as the units, variants and ship-by date change. Only tasks whose
// wording or date changed are sent again, so it is safe to call after every edit.
const batchSyncAgain = new Set();
async function syncBatchTodoist(p) {
  const t = p.todoist;
  if (isFrozen(p)) return;   // caught up when it's unfrozen
  if (t.busy) { batchSyncAgain.add(p.id); return; }
  if (!store.todoistConnected) { t.error = 'No Todoist API token is set. Set the TODOIST_TOKEN secret, then retry.'; persist(); return; }
  t.busy = true;
  t.tasks ??= {};
  const isMissing = e => e.status === 404 || e.status === 400;
  try {
    const plan = batchTodoistPlan(p);
    if (!t.project_id) {
      const created = await todoist('POST', '/projects', { name: plan.name });
      if (!created.id) throw new Error('Unexpected response from Todoist.');
      t.project_id = String(created.id);
      t.url = `https://app.todoist.com/app/project/${t.project_id}`;
      t.name = plan.name;
      persist();
    } else if (t.name !== plan.name) {
      await todoist('POST', `/projects/${t.project_id}`, { name: plan.name });
      t.name = plan.name;
      persist();
    }
    for (const task of plan.tasks) {
      const sig = JSON.stringify([task.content, task.description, task.due]), have = t.tasks[task.key];
      if (have?.sig === sig) continue;
      const body = { content: task.content, description: task.description };
      let id = null;
      if (have) {
        try { id = (await todoist('POST', `/tasks/${have.id}`, { ...body, ...(task.due ? { due_date: task.due } : { due_string: 'no date' }) })).id; }
        catch (e) { if (!isMissing(e)) throw e; }   // deleted in Todoist: make it again
      }
      if (!id) id = (await todoist('POST', '/tasks', { ...body, project_id: t.project_id, ...(task.due ? { due_date: task.due } : {}) })).id;
      t.tasks[task.key] = { id: String(id), sig };
      persist();
    }
    // A variant taken off the run (or down to zero units) takes its task with it.
    for (const key of Object.keys(t.tasks)) {
      if (plan.tasks.some(task => task.key === key)) continue;
      try { await todoist('DELETE', `/tasks/${t.tasks[key].id}`); } catch (e) { if (!isMissing(e)) throw e; }
      delete t.tasks[key];
      persist();
    }
    t.plan = { name: plan.name, tasks: plan.tasks.map(({ content, description }) => ({ content, description })) };
    t.synced = true;
    t.synced_at = new Date().toISOString();
    t.error = null;
  } catch (e) {
    t.error = e.message;
  }
  delete t.busy;
  p.updated_at = new Date().toISOString();
  persist();
  if (ed?.project === p) renderTodoistCard();
  if (batchSyncAgain.delete(p.id)) await syncBatchTodoist(store.projects.find(x => x.id === p.id) || p);
}

// Edits are sent to Todoist shortly after the last one, so clicking + five times makes one update.
const batchSyncTimers = new Map();
function scheduleBatchSync(p) {
  if (!store.todoistConnected) return;
  clearTimeout(batchSyncTimers.get(p.id));
  batchSyncTimers.set(p.id, setTimeout(() => {
    batchSyncTimers.delete(p.id);
    const current = store.projects.find(x => x.id === p.id);
    if (current) syncBatchTodoist(current);
  }, 1500));
}

function batchTodoistHtml(p) {
  const t = p.todoist;
  if (!store.todoistConnected) return '<p class="muted">Connect Todoist (see <a href="#/settings">Settings</a>) to get a task list for this run that updates as you change it.</p>';
  const open = t.url ? `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open in Todoist</a>` : '';
  if (t.busy) return `<p class="note">Updating Todoist&hellip;</p>${open}`;
  if (t.error) return `<p class="note err">${esc(t.error)}</p><div class="actions"><button class="btn primary" id="sync">Retry</button>${open}</div>`;
  if (t.synced) return `<p class="note ok">Up to date in Todoist (${Object.keys(t.tasks || {}).length} tasks). Changes here are sent there automatically.</p><div class="actions">${open}</div>`;
  return '<button class="btn primary" id="sync">Create Todoist project</button>';
}

// The quick form at the top of the Product line tab.
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
    card.innerHTML = `<div class="actions" style="margin-bottom:12px"><h2 style="margin:0">Quick batch run</h2><span style="flex:1"></span><a href="#/products" style="font-size:13px">Edit products</a></div>
      ${store.shopifyConnected ? '<p class="muted" style="margin:-4px 0 12px;font-size:13px">Your Shopify orders fill a run for each product on their own. Use this for anything extra, like stock for a market.</p>' : ''}
      <form id="batchForm" class="grid" autocomplete="off">
        <label class="f"><span>Product</span><select id="qbProduct">${products.map(x => `<option value="${esc(x.id)}" ${x.id === pr.id ? 'selected' : ''}>${esc(x.name || 'Unnamed product')}</option>`).join('')}</select></label>
        <div class="f w6"><span>${variants.length > 1 ? 'How many of each variant' : 'How many'}</span><div class="qbvariants">
          ${variants.map((v, i) => `<label class="qbv"><span title="${esc(v.name)}">${esc(v.name || 'Units')} <small>${money(v.price)}</small></span><input type="number" min="0" step="1" data-v="${i}" value="${variants.length === 1 ? 1 : ''}" placeholder="0"></label>`).join('')}
        </div></div>
        <label class="f"><span>In the mail by</span><input type="date" id="qbShip" required></label>
        <div class="f w6 actions"><button class="btn primary" type="submit">Add batch run</button><span class="muted" id="qbTotal"></span></div>
      </form>`;
    const form = $('#batchForm', card);
    const qtys = () => [...form.querySelectorAll('[data-v]')].map(el => ({ ...variants[Number(el.dataset.v)], qty: Math.round(pos(el.value)) }));
    const total = () => {
      const list = qtys(), units = list.reduce((n, v) => n + v.qty, 0);
      $('#qbTotal', card).textContent = units ? `${units} unit${units === 1 ? '' : 's'} \u00b7 ${money(list.reduce((sum, v) => sum + v.qty * pos(v.price), 0))} retail` : '';
      return units;
    };
    total();
    $('#qbProduct', card).addEventListener('change', e => { chosen = e.target.value; draw(); });
    form.addEventListener('input', total);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!total()) return toast('Enter how many to make.');
      const ship = $('#qbShip', card).value;
      if (!ship) return toast('Choose the date they need to be in the mail.');
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      const made = await createBatch(pr, qtys(), ship);
      button.disabled = false;
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
  // Starts in Build and In progress: it is a real order, and materials can be bought straight away.
  const draft = { stream: 'product', status, stage: 'build', data, calc: batchCalc(data), todoist: {}, history: [{ status, at: stamp }], created_at: stamp, updated_at: stamp };
  (draft.data as any).todo = defaultTodo(draft);
  let project;
  try { project = await api('/api/projects', draft); }
  catch (e) { if (!opts.quiet) toast(`Not saved: ${e.message}`); return null; }
  store.projects.push(project);
  saved.projects.set(project.id, JSON.stringify(project, unbusy));
  toast(`${opts.source === 'shopify' ? 'New Shopify orders: added' : 'Added'} ${projectName(project)}${store.todoistConnected ? '. Creating its Todoist list\u2026' : ''}`);
  if (store.todoistConnected) runTodoistSync(project);
  return project;
}

// A batch run's own page: units by variant with quick + / - buttons, the ship-by date, status and Todoist.
function showBatch(p) {
  const b = p.data.batch;
  ed = { project: p, stream: streamOf(p), data: p.data, dirty: false };
  view.innerHTML = `
    ${projectHeader(p, 'details', '<span class="muted">Changes save automatically</span>')}
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
        <div class="card" id="statusCard"></div><div class="card" id="todoistCard"></div>
        <p class="noprint" style="text-align:right"><button class="link" id="delete" style="color:var(--bad)">Delete this run</button></p>
      </aside>
    </div>`;

  const touch = (todo = true) => {
    p.calc = batchCalc(p.data);
    p.updated_at = new Date().toISOString();
    $('#projTitle').textContent = projectName(p);
    persist();
    if (todo) scheduleBatchSync(p);
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
  $('#shipBy').addEventListener('change', e => { p.data.due_date = e.target.value; b.ship_manual = true; touch(); renderStages(); });
  $('#batchNotes').addEventListener('input', e => { p.data.notes = e.target.value; touch(false); });
  $('#delete').addEventListener('click', () => {
    const synced = p.todoist.project_id ? ' Its Todoist project will be left as it is.' : '';
    if (!confirm(`Delete ${projectName(p)}? This cannot be undone.${synced}`)) return;
    store.projects = store.projects.filter(x => x !== p);
    persist();
    location.hash = boardLink();
  });
  // The phase strip's last date is the ship-by date too, so keep the two in step.
  $('#stages').addEventListener('change', () => { $('#shipBy').value = p.data.due_date || ''; b.ship_manual = true; scheduleBatchSync(p); });
  ed.redraw = () => { $('#shipBy').value = p.data.due_date || ''; renderUnits(); renderStages(); renderStatusCard(); $('#projTitle').textContent = projectName(p); };
  renderUnits();
  renderStages();
  renderStatusCard();
  renderTodoistCard();
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
      Fill in what each unit takes to make here: it goes into a batch run's cost and its Todoist shopping task.
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
        <label class="f w6"><span>Materials to buy per unit (goes on the Todoist shopping task)</span><input data-k="materials" value="${esc(pr.materials)}" placeholder="e.g. 1.5 bf walnut, 2 rubber feet"></label>
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
  if (!store.shopifyConnected || ordersBusy || store.projects.some(p => p.todoist.busy)) return;
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
  for (const run of touched) if (run.status !== 'complete') scheduleBatchSync(run);
  // Show the new numbers on whatever page is open.
  if (ed?.project && touched.includes(ed.project) && ed.redraw) ed.redraw();
  else if (!ed && (currentHash === '#/' || currentHash.startsWith('#/s/') || currentHash.startsWith('#/calendar'))) route();
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
    <div class="card"><h2>Todoist</h2>
      <p id="todoistState"></p>
      <div class="actions">
        <button class="btn" id="testToken">Test connection</button>
      </div>
      <p class="muted" style="margin-bottom:0">The API token is set on the server as the <code>TODOIST_TOKEN</code> secret (see DEPLOYMENT.md). Find it in Todoist under Settings &rarr; Integrations &rarr; Developer. It is used for every device and sent only to todoist.com.</p>
    </div>
    <div class="card"><h2>Backup</h2>
      <p class="muted">Projects and settings are stored on the server and shared by every device you sign in on. Export a backup now and then to keep a copy of your own.</p>
      <div class="actions"><button class="btn" id="export">Export backup</button>
        <button class="btn" id="import">Import backup&hellip;</button><input type="file" id="importFile" accept="application/json,.json" hidden></div>
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

  const renderTodoistState = () => {
    $('#todoistState').innerHTML = store.todoistConnected
      ? '<span class="pill accepted">Connected</span> A token is set. Accepted quotes will create a Todoist project.'
      : '<span class="pill">Not connected</span> Set the <code>TODOIST_TOKEN</code> secret to create a Todoist project when a quote is accepted.';
  };
  renderTodoistState();
  $('#testToken').addEventListener('click', async () => {
    if (!store.todoistConnected) return toast('Set the TODOIST_TOKEN secret first.');
    try { await todoist('GET', '/projects?limit=1'); toast('Connected to Todoist.'); }
    catch (e) { toast(e.message); }
  });

  $('#export').addEventListener('click', () => {
    const { todoistConnected, shopifyConnected, ...backup } = store;
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

backfillTodos();
route();
loadPrices();
loadShopProducts().then(loadShopOrders);
// While the page is open, check for new and fulfilled orders every few minutes.
setInterval(() => { if (document.visibilityState === 'visible') loadShopOrders(); }, 5 * 60 * 1000);
// Pick up other devices' changes when coming back to this tab, and send pending ones when leaving it.
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' ? save(true) : refresh().then(loadShopOrders));
window.addEventListener('pagehide', () => save(true));
window.addEventListener('online', () => save());
