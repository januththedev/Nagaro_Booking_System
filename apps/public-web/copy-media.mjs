/**
 * Build-time media copy.
 *
 * The official campus photography lives once, in `src/web/public/trace-media`
 * (served by the Node runtime at `/assets/trace-media/...`). The Next.js public
 * experience references the same photographs at `/trace-media/...`, served
 * statically by the CDN, so the landing and catalogue imagery never depends on
 * a serverless function boot. This script copies the tree before `next build`
 * / `next dev`; the copy is gitignored and rebuilt every time.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const source = resolve(appRoot, '..', '..', 'src', 'web', 'public', 'trace-media');
const target = join(appRoot, 'public', 'trace-media');

if (!existsSync(source)) {
  console.error(`[copy-media] source missing: ${source}`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`[copy-media] trace-media ready for the public build`);
