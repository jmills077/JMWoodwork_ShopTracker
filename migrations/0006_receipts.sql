-- Every receipt photo, kept for taxes and audits. The line items themselves live with each project
-- (data.purchases, each naming its receipt by id), since one receipt can be split across projects.
-- The photo is a JPEG as base64 text (about 0.3-1 MB each; a D1 row holds up to 2 MB).
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,                 -- made by the browser, e.g. r<time in base 36>
  store TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',       -- purchase date, YYYY-MM-DD
  total REAL NOT NULL DEFAULT 0,       -- the receipt's total as printed (or entered)
  tax REAL NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',       -- '' when there is no photo (a purchase entered by hand)
  image TEXT NOT NULL DEFAULT '',      -- base64
  created_at TEXT NOT NULL
);
CREATE INDEX receipts_date ON receipts (date);
