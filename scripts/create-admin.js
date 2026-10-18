/**
 * CLI: provision a staff account.
 *
 *   npm run admin:create -- --email ops@nagaro.example --name "Ops Lead" --role ADMIN
 *
 * The password is read from --password, or NAGARO_NEW_ADMIN_PASSWORD, or
 * prompted for interactively. It is never echoed and never written to disk.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getDb, closeDb, databasePath } from '../src/server/db/connection.js';
import { applyMigrations } from '../src/server/db/migrate.js';
import { createAdminUser, countActiveAdmins } from '../src/server/services/adminUserService.js';
import { passwordProblems } from '../src/server/security/passwords.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; }
    else out[key] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  applyMigrations(db);

  const email = String(args.email ?? process.env.NAGARO_NEW_ADMIN_EMAIL ?? '').trim();
  if (!email) {
    console.error('Usage: npm run admin:create -- --email <address> [--name "Full Name"] [--role ADMIN|STAFF]');
    console.error('       Supply --password or NAGARO_NEW_ADMIN_PASSWORD, or enter it when prompted.');
    process.exitCode = 2;
    return;
  }

  let password = args.password ?? process.env.NAGARO_NEW_ADMIN_PASSWORD ?? null;
  if (!password) {
    if (!stdin.isTTY) {
      console.error('No TTY available for a password prompt. Use --password or NAGARO_NEW_ADMIN_PASSWORD.');
      process.exitCode = 2;
      return;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    password = await rl.question('Password: ');
    const confirm = await rl.question('Confirm password: ');
    rl.close();
    if (password !== confirm) {
      console.error('Passwords do not match. Nothing was created.');
      process.exitCode = 1;
      return;
    }
  }

  const problems = passwordProblems(password);
  if (problems.length > 0) {
    console.error('Password rejected:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const systemActor = { id: null, label: 'CLI provisioning', role: 'ADMIN' };
  try {
    const user = createAdminUser(db, {
      actor: systemActor,
      payload: {
        email,
        display_name: args.name ?? process.env.NAGARO_NEW_ADMIN_NAME ?? 'Nagaro Staff',
        role: args.role ?? 'ADMIN',
        password,
      },
    });
    console.log(`Created ${user.role} account ${user.email} (id ${user.id}).`);
    console.log(`Database: ${databasePath()}`);
    console.log(`Active administrators: ${countActiveAdmins(db)}`);
  } catch (error) {
    console.error(`Could not create the account: ${error.message}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

await main();
