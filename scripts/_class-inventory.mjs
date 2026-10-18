import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = 'src/web/views';
const files = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
}
walk(root);

const classes = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /class=(?:"([^"]*)"|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1] ?? m[2] ?? '';
    for (const token of raw.split(/\s+/)) {
      if (!token || token.includes('$')) continue;
      if (!classes.has(token)) classes.set(token, []);
      classes.get(token).push(relative(root, f).replace(/\\/g, '/'));
    }
  }
}
const sorted = [...classes.keys()].sort();
const out = sorted.map((c) => `${c}\t${[...new Set(classes.get(c))].join(', ')}`).join('\n');
writeFileSync('scripts/_class-inventory.txt', `${sorted.length} classes\n${out}\n`, 'utf8');
console.log(sorted.length, 'classes written to scripts/_class-inventory.txt');
