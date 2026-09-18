/**
 * Is client/dist current? One check, shared by scripts/start.mjs (installed copy,
 * double-click) and scripts/launcher.mjs (the phone's Start button), so the two can
 * never disagree about when the interface needs rebuilding.
 *
 * Moved here unchanged from start.mjs (2026-09-18): the launcher never rebuilt at all,
 * so client/dist went stale after every pull until someone ran `npm run build`.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Newest mtime across everything that feeds the build, so a stale dist/ (built
 * before a `git pull` landed client changes) gets caught the same way a missing
 * one does. Comparing directory mtimes isn't enough — editing a file inside a
 * folder doesn't bump the folder's own mtime — so this walks every file.
 */
export function newestMtimeMs(entry) {
  let newest = 0;
  const stack = [entry];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (path.basename(p) === 'node_modules') continue;
      for (const child of fs.readdirSync(p)) stack.push(path.join(p, child));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

const distDir = root => path.join(root, 'client', 'dist');
const markerFile = root => path.join(distDir(root), '.source-mtime');

/**
 * { needed, reason: 'missing' | 'stale' | 'fresh', sourceMtime, builtMtime, hasDist }.
 * A dist with no marker (built by a bare `npm run build`) counts as stale: nothing
 * says which sources it was built from.
 */
export function clientBuildStatus(root) {
  const sourceMtime = Math.max(
    newestMtimeMs(path.join(root, 'client', 'src')),
    newestMtimeMs(path.join(root, 'client', 'index.html')),
    newestMtimeMs(path.join(root, 'client', 'vite.config.ts')),
    newestMtimeMs(path.join(root, 'package.json'))
  );
  let builtMtime = 0;
  try { builtMtime = Number(fs.readFileSync(markerFile(root), 'utf8')) || 0; } catch { /* no marker */ }
  const hasDist = fs.existsSync(path.join(distDir(root), 'index.html'));
  const reason = !hasDist ? 'missing' : sourceMtime > builtMtime ? 'stale' : 'fresh';
  return { needed: reason !== 'fresh', reason, sourceMtime, builtMtime, hasDist };
}

/** Record which sources the build that just finished was made from. */
export function writeBuildMarker(root, sourceMtime) {
  fs.writeFileSync(markerFile(root), String(sourceMtime));
}
