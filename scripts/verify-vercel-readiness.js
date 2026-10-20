/**
 * Fast, secret-safe deployment preflight.
 *
 * Run without flags to validate the checked-in Vercel layout. Add
 * `--require-env` in a linked Vercel environment to verify that production
 * services and security settings are present without printing their values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

function json(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

const packageJson = json('package.json');
const vercel = json('vercel.json');

requireCondition(
  JSON.stringify(packageJson.workspaces) === JSON.stringify(['apps/public-web']),
  'package.json must declare apps/public-web as the npm workspace.',
);
requireCondition(
  packageJson.scripts?.build === 'npm run build --workspace=trace-spaces-public-web',
  'The root build command must build the public Next.js workspace.',
);
requireCondition(!Object.hasOwn(vercel, 'installCommand'), 'vercel.json must use Vercel/npm automatic workspace installation.');
requireCondition(vercel.buildCommand === 'npm run build', 'vercel.json buildCommand must be npm run build.');
requireCondition(vercel.outputDirectory === 'apps/public-web/.next', 'Vercel outputDirectory must point to the workspace build.');
requireCondition(existsSync(resolve(root, 'api/index.js')), 'api/index.js is missing. The booking API cannot deploy.');
requireCondition(existsSync(resolve(root, 'apps/public-web/app/page.tsx')), 'The Next.js public app is missing.');
requireCondition(existsSync(resolve(root, 'db/migrations-postgres/0001_init.sql')), 'The Supabase migration is missing.');

const backendRoutes = new Map((vercel.rewrites ?? []).map((route) => [route.source, route.destination]));
for (const source of ['/api/:path*', '/admin/:path*', '/assets/:path*', '/media/:path*']) {
  requireCondition(backendRoutes.get(source) === '/api/index', `${source} must rewrite to /api/index.`);
}

if (process.argv.includes('--require-env')) {
  const required = [
    'DATABASE_URL',
    'BLOB_READ_WRITE_TOKEN',
    'NAGARO_BASE_URL',
    'NAGARO_IP_SALT',
    'NAGARO_TRUST_PROXY',
    'NAGARO_FORCE_SECURE_COOKIES',
  ];
  for (const name of required) {
    requireCondition(Boolean(String(process.env[name] ?? '').trim()), `Missing required environment variable: ${name}`);
  }
  requireCondition(process.env.NAGARO_TRUST_PROXY === '1', 'NAGARO_TRUST_PROXY must be 1 on Vercel.');
  requireCondition(process.env.NAGARO_FORCE_SECURE_COOKIES === '1', 'NAGARO_FORCE_SECURE_COOKIES must be 1 on Vercel.');
  requireCondition(
    /^postgres(?:ql)?:\/\//i.test(String(process.env.DATABASE_URL ?? '')),
    'DATABASE_URL must be a PostgreSQL connection URI.',
  );
  requireCondition(
    /^https:\/\//i.test(String(process.env.NAGARO_BASE_URL ?? '')),
    'NAGARO_BASE_URL must be an HTTPS origin.',
  );
}

if (failures.length > 0) {
  console.error('Vercel readiness check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Vercel readiness check passed${process.argv.includes('--require-env') ? ' (configuration + environment)' : ' (configuration)'}.`);
}
