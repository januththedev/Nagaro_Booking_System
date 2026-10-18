/** Lists exported symbols of every server module, to cross-check contracts. */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots = ['src/server/services', 'src/server/security', 'src/server/mail', 'src/server/domain', 'src/server/routes', 'src/web/views', 'src/web/lib'];

async function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...await walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

for (const root of roots) {
  let files;
  try { files = await walk(root); } catch { continue; }
  for (const file of files.sort()) {
    try {
      const mod = await import(pathToFileURL(join(process.cwd(), file)).href);
      const names = Object.keys(mod).filter((n) => n !== 'default').sort();
      console.log(`\n${file.replace(/\\/g, '/')}  (${names.length})`);
      console.log(`  ${names.join(', ')}`);
    } catch (error) {
      console.log(`\n${file.replace(/\\/g, '/')}  *** IMPORT FAILED: ${error.message.split('\n')[0]}`);
    }
  }
}
