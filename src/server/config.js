/**
 * Runtime configuration. Everything is read once, at startup, so a missing
 * variable fails loudly at boot instead of mid-request.
 */
import { resolve } from 'node:path';

function flag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export function loadConfig(env = process.env) {
  const root = resolve(process.cwd());
  return {
    root,
    port: int('PORT', 4173),
    host: env.HOST ?? '127.0.0.1',
    nodeEnv: env.NODE_ENV ?? 'development',
    isProduction: (env.NODE_ENV ?? 'development') === 'production',

    databasePath: env.NAGARO_DB_PATH ? resolve(env.NAGARO_DB_PATH) : resolve(root, 'data', 'nagaro.db'),
    uploadDir: env.NAGARO_UPLOAD_DIR ? resolve(env.NAGARO_UPLOAD_DIR) : resolve(root, 'storage', 'uploads'),
    publicDir: resolve(root, 'src', 'web', 'public'),

    baseUrl: env.NAGARO_BASE_URL ?? `http://${env.HOST ?? '127.0.0.1'}:${int('PORT', 4173)}`,
    trustProxy: flag('NAGARO_TRUST_PROXY', false),
    forceSecureCookies: flag('NAGARO_FORCE_SECURE_COOKIES', false),
    ipSalt: env.NAGARO_IP_SALT ?? 'nagaro-development-salt',

    bootstrapAdmin: {
      email: env.NAGARO_BOOTSTRAP_ADMIN_EMAIL ?? null,
      password: env.NAGARO_BOOTSTRAP_ADMIN_PASSWORD ?? null,
      name: env.NAGARO_BOOTSTRAP_ADMIN_NAME ?? 'Nagaro Administrator',
    },

    adminNotificationEmail: env.NAGARO_ADMIN_NOTIFICATION_EMAIL ?? null,

    smtp: {
      host: env.SMTP_HOST ?? null,
      port: int('SMTP_PORT', 587),
      user: env.SMTP_USER ?? null,
      pass: env.SMTP_PASS ?? null,
      secure: flag('SMTP_SECURE', false),
      from: env.SMTP_FROM ?? env.NAGARO_ADMIN_NOTIFICATION_EMAIL ?? 'no-reply@nagaro.local',
      transport: env.NAGARO_MAIL_TRANSPORT ?? null,
    },

    demoSeed: flag('NAGARO_DEMO_SEED', false),

    // Deployment environment. Local development is unchanged: SQLite on disk
    // plus the local upload directory. These only take effect when set.
    isVercel: Boolean(env.VERCEL),
    databaseUrl: env.DATABASE_URL ?? null,
    directUrl: env.DIRECT_URL ?? env.DATABASE_URL ?? null,
    // Explicit opt-in for an ephemeral throwaway SQLite file (os.tmpdir()) when
    // no persistent database is configured. The deployed app must never fall
    // back to a local SQLite file silently; api/index.js refuses to boot
    // without either DATABASE_URL or this flag.
    allowEphemeralSqlite: flag('NAGARO_ALLOW_EPHEMERAL_SQLITE', false),
  };
}

/** Human-readable summary printed at boot; never includes secrets. */
export function describeConfig(config) {
  return [
    `environment : ${config.nodeEnv}`,
    `listening   : ${config.baseUrl}`,
    `database    : ${config.databasePath}`,
    `uploads     : ${config.uploadDir}`,
    `email       : ${config.smtp.host ? `SMTP via ${config.smtp.host}:${config.smtp.port}` : 'not configured (inquiries will still be saved)'}`,
    `notify to   : ${config.adminNotificationEmail ?? '(no administrator notification address set)'}`,
  ].join('\n             ');
}

export const config = loadConfig();
