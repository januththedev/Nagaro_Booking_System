/**
 * Runs the Node booking runtime and the Next public frontend as one local
 * stack. Node stays on the public port; Next listens only on the configured
 * internal port and is reached through the gateway.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const publicApp = resolve(root, 'apps', 'public-web');
const isProduction = process.argv.includes('--production');
const backendHost = process.env.HOST ?? '127.0.0.1';
const backendPort = process.env.PORT ?? '4173';
const frontendHost = process.env.PUBLIC_FRONTEND_HOST ?? '127.0.0.1';
const frontendPort = process.env.PUBLIC_FRONTEND_PORT ?? '4174';
const frontendOrigin = process.env.PUBLIC_FRONTEND_ORIGIN
  ?? `http://${frontendHost}:${frontendPort}`;
const backendOrigin = process.env.NAGARO_BASE_URL
  ?? `http://${backendHost}:${backendPort}`;

if (!existsSync(resolve(publicApp, 'package.json'))) {
  console.error('[public-stack] apps/public-web is missing. Build or restore the public app first.');
  process.exit(1);
}

let nextCli;
try {
  const requireFromPublicApp = createRequire(resolve(publicApp, 'package.json'));
  nextCli = requireFromPublicApp.resolve('next/dist/bin/next');
} catch {
  console.error('[public-stack] Next.js is not installed. Run npm install --prefix apps/public-web.');
  process.exit(1);
}

const sharedEnv = { ...process.env };
const backendEnv = {
  ...sharedEnv,
  PUBLIC_FRONTEND: 'next',
  PUBLIC_FRONTEND_ORIGIN: frontendOrigin,
};
const frontendEnv = {
  ...sharedEnv,
  API_ORIGIN: process.env.API_ORIGIN ?? backendOrigin,
  API_PROXY_TARGET: process.env.API_PROXY_TARGET ?? backendOrigin,
};

const backendArgs = isProduction
  ? [resolve(root, 'src', 'server', 'index.js')]
  : ['--watch', resolve(root, 'src', 'server', 'index.js')];
const frontendArgs = [
  nextCli,
  isProduction ? 'start' : 'dev',
  '-H', frontendHost,
  '-p', frontendPort,
];

const children = [
  spawn(process.execPath, backendArgs, { cwd: root, env: backendEnv, stdio: 'inherit' }),
  spawn(process.execPath, frontendArgs, { cwd: publicApp, env: frontendEnv, stdio: 'inherit' }),
];

let stopping = false;
let exitCode = 0;

function stop(signal = 'SIGTERM', code = exitCode) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
  setTimeout(() => process.exit(exitCode), 4_000).unref();
}

for (const [index, child] of children.entries()) {
  child.once('error', (error) => {
    console.error(`[public-stack] ${index === 0 ? 'backend' : 'frontend'} failed to start: ${error.message}`);
    stop('SIGTERM', 1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      const name = index === 0 ? 'backend' : 'frontend';
      console.error(`[public-stack] ${name} stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).`);
      stop('SIGTERM', code || 1);
    }
  });
}

process.once('SIGINT', () => stop('SIGINT', 0));
process.once('SIGTERM', () => stop('SIGTERM', 0));
process.once('SIGHUP', () => stop('SIGHUP', 0));

console.log(`[public-stack] ${isProduction ? 'production' : 'development'} stack`);
console.log(`[public-stack] public origin ${backendOrigin} -> Next ${frontendOrigin}`);
