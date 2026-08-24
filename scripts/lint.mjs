import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['server', 'scripts', 'test'];
const files = [];
function visit(entry) {
  for (const item of fs.readdirSync(entry, { withFileTypes: true })) {
    const full = path.join(entry, item.name);
    if (item.isDirectory()) visit(full);
    else if (/\.(?:js|mjs)$/.test(item.name)) files.push(full);
  }
}
for (const root of roots) visit(root);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Syntax checked ${files.length} JavaScript files; TypeScript/TSX is covered by npm run typecheck.`);
