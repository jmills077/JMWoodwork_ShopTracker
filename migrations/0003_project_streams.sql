-- Projects belong to one of three streams: 'client' (custom work quoted for a client),
-- 'product' (the shop's own product line) or 'gallery' (pieces made for the business, not for sale).
-- Every project made before this was client work.
ALTER TABLE projects ADD COLUMN stream TEXT NOT NULL DEFAULT 'client';
