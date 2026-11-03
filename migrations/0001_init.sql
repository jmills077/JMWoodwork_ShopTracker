-- Shop Tracker schema.
--
-- Projects keep the quote's working details (client, spec, rates, phases, lumber, design notes,
-- due dates) as one JSON document in `data`, the same shape as the old in-browser app and its
-- backup files, so backups import unchanged. Columns the pages sort and filter on sit beside it.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  stage TEXT NOT NULL DEFAULT 'ideation',
  data TEXT NOT NULL,            -- JSON: what is being built and how it is priced
  calc TEXT NOT NULL,            -- JSON: priced totals as of the last save
  todoist TEXT NOT NULL DEFAULT '{}',   -- JSON: progress creating the job's Todoist project
  history TEXT NOT NULL DEFAULT '[]',   -- JSON: status and phase changes, oldest first
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_status ON projects (status);

-- Parkerville Wood Products' price lists, refreshed weekly by the Worker's cron trigger.
CREATE TABLE price_items (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,     -- order on the supplier's list
  list TEXT NOT NULL,            -- 'domestic' or 'exotic'
  species TEXT NOT NULL,
  size TEXT NOT NULL,
  wide TEXT NOT NULL,
  spec TEXT NOT NULL,
  price REAL NOT NULL            -- $ per board foot
);
