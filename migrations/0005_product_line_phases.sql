-- The product line now has its own phases: Building, Finishing, Packaging, then Shipped (which closes
-- the project out). Carry product-line projects over from the old five client phases. The app maps
-- old phase names the same way when it reads them, so this only tidies the stored values.
UPDATE projects SET stage = 'building' WHERE stream = 'product' AND stage IN ('ideation', 'design', 'build');
UPDATE projects SET stage = 'packaging' WHERE stream = 'product' AND stage = 'ready';
UPDATE projects SET stage = 'shipped' WHERE stream = 'product' AND status = 'complete';
