-- 0002: add Vercel Blob reference columns to space_image (optional, production only).
ALTER TABLE space_image ADD COLUMN blob_url TEXT;
ALTER TABLE space_image ADD COLUMN blob_pathname TEXT;
