/**
 * Production catalogue bootstrap.
 *
 * Uses only verified TRACE editorial files already shipped by the repository.
 * The image rows point at the immutable `/assets/*` route; future uploads can
 * replace them with Vercel Blob-backed photographs through the admin UI.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { seedCatalogue } from './seed.js';
import { getSpaceByCode, publishSpace } from '../services/spaceService.js';

const root = resolve(import.meta.dirname, '../../..');

export const editorialCovers = {
  'TRC-MR-01': {
    path: 'src/web/public/trace-media/research/idea-studio.webp',
    alt: 'TRACE Idea Studio arranged for a focused team session',
  },
  'TRC-MR-02': {
    path: 'src/web/public/trace-media/research/creator-space.jpg',
    alt: 'Creator Space at TRACE Expert City during an interactive presentation',
  },
  'TRC-CW-01': {
    path: 'src/web/public/trace-media/research/expert-city-coworking.webp',
    alt: 'The active coworking hall inside TRACE Expert City',
  },
  'TRC-AUD-01': {
    path: 'src/web/public/trace-media/research/bay-07.jpg',
    alt: 'A large brick event hall at TRACE staged with conference lighting',
  },
  'TRC-CW-02': {
    path: 'src/web/public/trace-media/research/expert-city-private-offices.webp',
    alt: 'A calm, naturally lit workspace inside TRACE Expert City',
  },
};

function mimeForPath(path) {
  return extname(path).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/webp';
}

export function ensureEditorialCover(db, space) {
  const existing = db.prepare('SELECT id FROM space_image WHERE space_id = ? ORDER BY sort_order, id LIMIT 1').get(space.id);
  if (existing) return false;
  const cover = editorialCovers[space.code];
  if (!cover) throw new Error(`No verified editorial cover is configured for ${space.code}.`);
  const absolute = resolve(root, cover.path);
  const size = statSync(absolute).size;
  const extension = extname(cover.path).toLowerCase();
  const storedName = `${createHash('sha256').update(`editorial:${space.code}`).digest('hex').slice(0, 32)}${extension}`;
  const publicPath = cover.path.replace(/^src\/web\/public\//, '').replaceAll('\\', '/');
  const publicUrl = `/assets/${publicPath}`;
  db.prepare(`
    INSERT INTO space_image
      (space_id, stored_name, original_name, mime_type, byte_size, alt_text,
       sort_order, is_cover, created_at, blob_url, blob_pathname)
    VALUES (?,?,?,?,?,?,0,1,?,?,NULL)
  `).run(
    space.id,
    storedName,
    basename(cover.path),
    mimeForPath(cover.path),
    size,
    cover.alt,
    Date.now(),
    publicUrl,
  );
  return true;
}

export function provisionProductionCatalogue(db, { actor }) {
  const before = Number(db.prepare('SELECT COUNT(*) AS c FROM space').get().c);
  const catalogue = seedCatalogue(db, { actor, withImages: false, publish: false });
  for (const entry of catalogue) {
    const space = getSpaceByCode(db, entry.space.code);
    ensureEditorialCover(db, space);
    publishSpace(db, { actor, spaceId: space.id });
  }
  const after = Number(db.prepare('SELECT COUNT(*) AS c FROM space').get().c);
  return { before, after, catalogue };
}
