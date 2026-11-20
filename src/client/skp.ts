// Reads a cut list out of a SketchUp model, in the browser (the file is never uploaded).
//
// A .skp file (SketchUp 2017 and the versions around it) is a stream of MFC-archived objects, and
// Trimble doesn't publish its layout, so this reads just the parts a cut list needs, by pattern:
//   - component definitions: their name is three strings (name, description, path) then a save time.
//     Each definition's own geometry is written just before its name.
//   - vertices: x, y, z in inches, after the vertex record's tag.
//   - component instances: a 3 x 3 axes matrix, the origin and a scale, after the definition they use
//     (an archive object number), and followed by the instance's name.
// The object numbers aren't written next to the definitions, so they are matched up in file order,
// using how much geometry lies between them when a definition isn't used anywhere.
// Each part's size is its definition's bounding box (scaled if the instance was scaled), smallest side
// first: thickness x width x length. Loose geometry that isn't a component or group is left out.
//
// A cut list can also come from a CSV (OpenCutList's export, or any table with name, quantity,
// length, width and thickness columns), and readPieceLine reads one typed line like "Shelf 3/4 x 10 x 30 (2)".

export interface Piece { part: string; qty: number; t: number | null; w: number | null; l: number | null; species?: string }
export interface CutRead { pieces: Piece[]; note: string }

const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

export function readSkp(buf: ArrayBuffer): CutRead {
  const b = new Uint8Array(buf), dv = new DataView(buf), n = b.length;
  const u16 = (i: number) => i >= 0 && i + 2 <= n ? dv.getUint16(i, true) : -1;
  const u32 = (i: number) => i >= 0 && i + 4 <= n ? dv.getUint32(i, true) : -1;
  const f64 = (i: number) => i >= 0 && i + 8 <= n ? dv.getFloat64(i, true) : NaN;

  // A string: FF FE FF, then a length (one byte, or FF and two bytes), then that many UTF-16 characters.
  const str = (i: number): { text: string; end: number } | null => {
    if (b[i] !== 0xff || b[i + 1] !== 0xfe || b[i + 2] !== 0xff) return null;
    let j = i + 3, len = b[j++];
    if (len === 0xff) { len = u16(j); j += 2; }
    if (len < 0 || j + 2 * len > n) return null;
    let text = '';
    for (let k = 0; k < len; k++) text += String.fromCharCode(dv.getUint16(j + 2 * k, true));
    return { text, end: j + 2 * len };
  };
  const head = str(0);
  if (!head || head.text !== 'SketchUp Model') throw new Error('This isn\'t a SketchUp model (.skp) file.');
  const version = (str(head.end)?.text || '').replace(/[{}]/g, '');
  const tooNew = () => new Error(`This model was saved by SketchUp ${version.split('.')[0] || '?'}, and its parts couldn't be read. `
    + 'In SketchUp, use File > Save As and pick "SketchUp 2017" as the version, then drop that copy in. '
    + 'Or export a CSV from OpenCutList and drop that in instead.');

  const strings: number[] = [];
  for (let i = 0; i < n - 2; i++) if (b[i] === 0xff && b[i + 1] === 0xfe && b[i + 2] === 0xff) strings.push(i);

  // Component definitions.
  const defs: { start: number; end: number; name: string; verts: number[][]; kids: { ref: number; m: number[] }[] }[] = [];
  for (const i of strings) {
    const s1 = str(i), s2 = s1 && str(s1.end), s3 = s2 && str(s2.end);
    if (!s3) continue;
    const saved = u32(s3.end);
    if (saved > 946684800 && saved < 2208988800) defs.push({ start: i, end: s3.end + 4, name: s1.text.trim(), verts: [], kids: [] });
  }

  // The class record that introduces vertices, then the tag every later vertex uses.
  const findClass = (name: string) => {
    for (let i = 0; i < n - 6 - name.length; i++)
      if (b[i] === 0xff && b[i + 1] === 0xff && u16(i + 4) === name.length && ascii(b, i + 6, name.length) === name) return i + 6 + name.length;
    return -1;
  };
  const vClass = findClass('CVertex');
  if (vClass < 0 || !defs.length) throw tooNew();
  // After a tag: 00 00, a byte k, k - 1 bytes of entity id, then the record itself.
  const entityHead = (p: number) => (b[p] === 0 && b[p + 1] === 0 && b[p + 2] >= 1 && b[p + 2] <= 5) ? p + 2 + b[p + 2] : -1;
  const sane = (...xs: number[]) => xs.every(x => Number.isFinite(x) && Math.abs(x) < 1e5);
  const verts: { at: number; v: number[] }[] = [];
  const v0 = entityHead(vClass);
  if (v0 < 0) throw tooNew();
  verts.push({ at: vClass, v: [f64(v0), f64(v0 + 8), f64(v0 + 16)] });
  const vTag = u16(v0 + 24);
  if (!(vTag & 0x8000)) throw tooNew();
  for (let i = v0 + 24; i < n - 30; i++) {
    if (u16(i) !== vTag) continue;
    const p = entityHead(i + 2);
    if (p < 0) continue;
    const v = [f64(p), f64(p + 8), f64(p + 16)];
    if (sane(...v)) verts.push({ at: i, v });
  }

  // Component instances (and groups): 13 numbers, then the instance's name.
  const insts: { at: number; ref: number; m: number[] }[] = [];
  for (const q of strings) {
    const m = Array.from({ length: 13 }, (_, k) => f64(q - 104 + 8 * k));
    if (!sane(...m) || Math.abs(m[12]) < 1e-9) continue;
    const axis = (k: number) => Math.hypot(m[k], m[k + 1], m[k + 2]);
    if (axis(0) < 1e-6 || axis(3) < 1e-6 || axis(6) < 1e-6) continue;
    // The definition it uses: a 2-byte object number, or 7F FF then 4 bytes. Before that, 10 bytes
    // of settings and the entity header (00 00 k id).
    let ref = u16(q - 106), headEnd = q - 106 - 10;
    if (u16(q - 110) === 0x7fff) { ref = u32(q - 108); headEnd = q - 110 - 10; }
    let ok = false;
    for (let k = 1; k <= 5 && !ok; k++) ok = b[headEnd - k] === k && b[headEnd - k - 1] === 0 && b[headEnd - k - 2] === 0;
    if (ok && ref > 0) insts.push({ at: q - 104, ref, m });
  }

  // Each definition's geometry and nested instances lie between the previous definition and its name.
  // What follows the last definition is the model itself.
  const top: { ref: number; m: number[] }[] = [];
  const owner = (at: number) => {
    let lo = 0;
    for (const d of defs) { if (at >= lo && at < d.start) return d; lo = d.end; }
    return at >= lo ? null : undefined;
  };
  for (const x of verts) owner(x.at)?.verts.push(x.v);
  for (const x of insts) {
    const d = owner(x.at);
    if (d === null) top.push(x); else d?.kids.push(x);
  }
  if (!top.length) throw new Error('No components or groups were found in this model. Make each part a component (select it, right-click, Make Component) and save again.');

  // Match the object numbers the instances point at to the definitions, in file order.
  const refs = [...new Set(insts.map(x => x.ref))].sort((a, c) => a - c);
  if (refs.length > defs.length) throw tooNew();
  const byRef = new Map<number, typeof defs[number]>();
  if (refs.length === defs.length) refs.forEach((r, k) => byRef.set(r, defs[k]));
  else {
    // Roughly how many archive objects a definition takes: about 6.5 per vertex (its edges, faces,
    // loops and edge uses) plus one per nested instance and a few for the definition itself.
    const size = defs.map(d => 6.5 * d.verts.length + d.kids.length + 8);
    const R = refs.length, D = defs.length, cost = Array.from({ length: R }, () => new Array(D).fill(Infinity));
    const from = Array.from({ length: R }, () => new Array(D).fill(-1));
    for (let i = 0; i < D; i++) cost[0][i] = i * 0.01;
    for (let j = 1; j < R; j++) for (let i = j; i < D; i++) {
      let between = 0;
      for (let h = i - 1; h >= j - 1; h--) {
        between += size[h];
        const c = cost[j - 1][h] + Math.abs(refs[j] - refs[j - 1] - between);
        if (c < cost[j][i]) { cost[j][i] = c; from[j][i] = h; }
      }
    }
    let i = cost[R - 1].indexOf(Math.min(...cost[R - 1]));
    for (let j = R - 1; j >= 0; j--) { byRef.set(refs[j], defs[i]); i = from[j][i]; }
  }

  // Walk the model from the top: every part with geometry of its own is a piece, counted once per copy.
  const box = new Map<object, number[]>();
  const sizeOf = (d: typeof defs[number]) => {
    if (!box.has(d)) box.set(d, [0, 1, 2].map(k => Math.max(...d.verts.map(v => v[k])) - Math.min(...d.verts.map(v => v[k]))));
    return box.get(d)!;
  };
  const found = new Map<string, Piece>();
  let unnamed = 0;
  const names = new Map<object, string>();
  const walk = (x: { ref: number; m: number[] }, scale: number[], depth: number) => {
    const d = byRef.get(x.ref);
    if (!d || depth > 12) return;
    const w = Math.abs(x.m[12]) || 1;
    const s = [0, 3, 6].map((k, a) => scale[a] * Math.hypot(x.m[k], x.m[k + 1], x.m[k + 2]) / w);
    if (d.verts.length > 1) {
      const dims = sizeOf(d).map((v, a) => Math.round(v * s[a] * 32) / 32).sort((p, q) => p - q);
      if (dims[2] > 0) {
        if (!names.has(d)) names.set(d, d.name && !/^Group#\d+$/.test(d.name) ? d.name.replace(/#\d+$/, '') : `Part ${++unnamed}`);
        const part = names.get(d)!, key = `${part}|${dims.join('x')}`;
        const p = found.get(key);
        if (p) p.qty++;
        else found.set(key, { part, qty: 1, t: dims[0], w: dims[1], l: dims[2] });
      }
    }
    for (const k of d.kids) walk(k, s, depth + 1);
  };
  for (const x of top) walk(x, [1, 1, 1], 0);
  const pieces = [...found.values()];
  if (!pieces.length) throw tooNew();
  const loose = verts.filter(x => owner(x.at) === null).length;
  return {
    pieces,
    note: `Read ${pieces.reduce((q, p) => q + p.qty, 0)} pieces from ${top.length} components in the model`
      + (loose ? '. Some loose geometry that isn\'t a component or group was left out' : '') + '.',
  };
}

// ---------- inches ----------
// 1 1/2, 1-1/2, 3/4, .75, 18mm, 2 ft, 2' 6", 30.5 in: all to inches.
export function readInches(text: string): number | null {
  let s = String(text ?? '').toLowerCase().replace(/[″”]/g, '"').replace(/[′’]/g, "'").trim();
  s = s.replace(/[¼½¾⅛⅜⅝⅞]/g, c => ` ${({ '¼': '1/4', '½': '1/2', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' })[c]}`).trim();
  if (!s) return null;
  const mm = s.match(/^([\d.]+)\s*mm$/), cm = s.match(/^([\d.]+)\s*cm$/), m = s.match(/^([\d.]+)\s*m$/);
  if (mm) return +mm[1] / 25.4;
  if (cm) return +cm[1] / 2.54;
  if (m) return +m[1] / 0.0254;
  const ft = s.match(/^([\d.]+)\s*(?:'|ft|feet|foot)\s*-?\s*(.*)$/);
  if (ft) return +ft[1] * 12 + (ft[2] ? readInches(ft[2]) ?? 0 : 0);
  s = s.replace(/\s*(?:"|in\.?|inch(?:es)?)$/, '').trim();
  const mixed = s.match(/^(\d+)(?:\s+|\s*-\s*)(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return +mixed[1] + +mixed[2] / +mixed[3];
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return +frac[1] / +frac[2];
  const dec = s.match(/^~?(\d*\.?\d+)$/);
  return dec ? +dec[1] : null;
}

// Inches as a woodworker writes them, to the nearest 1/16: 1½, ¾, 22 5/16.
const NICE = { 2: '½', 4: ['', '¼', '', '¾'], 8: ['', '⅛', '', '⅜', '', '⅝', '', '⅞'] };
export function fmtInches(v: number | null) {
  if (v == null || !Number.isFinite(v)) return '?';
  const sixteenths = Math.round(v * 16), whole = Math.floor(sixteenths / 16);
  let rest = sixteenths % 16, den = 16;
  while (rest && rest % 2 === 0) { rest /= 2; den /= 2; }
  const frac = !rest ? '' : den === 2 ? NICE[2] : den === 4 ? NICE[4][rest] : den === 8 ? NICE[8][rest] : `${rest}/${den}`;
  return whole ? (frac ? `${whole}${frac.includes('/') ? ' ' : ''}${frac}` : String(whole)) : frac || '0';
}

// ---------- CSV ----------
function csvRows(text: string): string[][] {
  const first = text.split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].map(c => [c, first.split(c).length] as const).sort((a, c) => c[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && !cell.trim()) { quoted = true; cell = ''; }
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

export function readCutCsv(text: string): CutRead {
  const rows = csvRows(text.replace(/^﻿/, ''));
  const h = rows.findIndex(r => r.some(x => /length/i.test(x)) && r.some(x => /width/i.test(x)));
  if (h < 0) throw new Error('This CSV has no Length and Width columns. Export the cut list from OpenCutList (Export > CSV) and try again.');
  const head = rows[h].map(x => x.trim().toLowerCase());
  // The first column whose heading matches, best wording first (OpenCutList gives cutting, bounding
  // box and final sizes; the cutting size is the one to cut to).
  const col = (...res: RegExp[]) => { for (const re of res) { const i = head.findIndex(x => re.test(x)); if (i >= 0) return i; } return -1; };
  const c = {
    part: col(/^name$/, /part|component|definition|description/, /name/),
    qty: col(/^(count|qty|quantity)$/, /count|qty|quantity|pieces/),
    l: col(/cutting length/, /^length/, /length/),
    w: col(/cutting width/, /^width/, /width/),
    t: col(/cutting thickness/, /^thickness/, /thickness|depth|height/),
    species: col(/material name/, /^material$/, /material|species|wood/),
  };
  const pieces: Piece[] = [];
  for (const r of rows.slice(h + 1)) {
    const get = (k: number) => (k >= 0 ? r[k] ?? '' : '').trim();
    const l = readInches(get(c.l)), w = readInches(get(c.w));
    if (l == null && w == null) continue;
    const dims = [readInches(get(c.t)), w, l];
    const known = dims.filter((x): x is number => x != null).sort((a, z) => a - z);
    const [t, ww, ll] = known.length === 3 ? known : dims;
    pieces.push({ part: get(c.part) || 'Part', qty: Math.max(1, Math.round(+get(c.qty).replace(/[^\d.]/g, '') || 1)), t, w: ww, l: ll, species: get(c.species) || undefined });
  }
  if (!pieces.length) throw new Error('No parts with sizes were found in this CSV.');
  return { pieces, note: `Read ${pieces.reduce((q, p) => q + p.qty, 0)} pieces from the CSV.` };
}

// ---------- one typed line ----------
// "Shelf 3/4 x 10 x 30 (2)", "2x Leg 1 1/2 x 1 1/2 x 23", "Top 3/4 x 20 x 20 qty 1". Without three sizes
// it's kept as a plain line ("Rip the rest of the 8/4 cherry").
const SIZE = String.raw`(?:\d+\s*(?:-|\s)\s*\d+\s*/\s*\d+|\d+\s*/\s*\d+|\d*\.?\d+\s*[¼½¾⅛-⅞]?|[¼½¾⅛-⅞])\s*(?:"|″|in\b|mm\b|cm\b)?`;
const TRIPLE = new RegExp(`(${SIZE})\\s*[x×*]\\s*(${SIZE})\\s*[x×*]\\s*(${SIZE})`, 'i');
export function readPieceLine(line: string): Piece {
  const plain = line.replace(/\s+/g, ' ').trim(), m = plain.match(TRIPLE);
  if (!m) return { part: plain, qty: 1, t: null, w: null, l: null };
  const dims = [m[1], m[2], m[3]].map(x => readInches(x.replace(/(\d)\s*([\u00bc-\u00be\u215b-\u215e])/, '$1 $2')));
  if (dims.some(x => x == null)) return { part: plain, qty: 1, t: null, w: null, l: null };
  let text = plain.replace(m[0], ' ').replace(/\s+/g, ' ').trim(), qty = 1;
  const q = text.match(/\(\s*(\d+)\s*\)|\bqty:?\s*(\d+)\b|^(\d+)\s*(?:x|\u00d7|pcs?|pieces?)\s+|(?:^|\s)[x\u00d7]\s*(\d+)\b|^(\d+)\s+(?=\D)|^(\d+)$/i);
  if (q) { qty = +(q[1] || q[2] || q[3] || q[4] || q[5] || q[6]); text = text.replace(q[0], ' '); }
  const part = text.replace(/^[\s,:\-\u2013]+|[\s,:\-\u2013]+$/g, '').replace(/\s+/g, ' ').trim() || 'Part';
  const [t, w, l] = (dims as number[]).sort((a, z) => a - z);
  return { part, qty: Math.max(1, qty), t, w, l };
}
