#!/usr/bin/env node
/**
 * Expose the running app to your phone through a Cloudflare quick tunnel.
 *
 *   npm run tunnel
 *
 * Prints an https://….trycloudflare.com address and registers it with the app so
 * Settings → "Phone access" can show it next to the pairing code. The address
 * only exists while this process runs; Ctrl-C kills it and the app is local-only
 * again. Nobody can sign in through it without a pairing code minted on this Mac.
 *
 * Requires cloudflared (brew install cloudflared).
 */
import { spawn, spawnSync } from 'node:child_process';

const PORT = process.env.API_PORT || 5177;
const LOCAL = `http://localhost:${PORT}`;

if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).error) {
  console.error('cloudflared is not installed. Run: brew install cloudflared');
  process.exit(1);
}

// The server can take a few seconds to answer right after boot (seed
// reconciliation, schedulers), so give it a fair chance before giving up.
let ready = false;
for (let attempt = 0; attempt < 10 && !ready; attempt++) {
  try {
    const res = await fetch(`${LOCAL}/api/teams`, { signal: AbortSignal.timeout(8000) });
    ready = res.ok;
  } catch { /* retry */ }
  if (!ready) await new Promise(r => setTimeout(r, 1500));
}
if (!ready) {
  console.error(`Gridiron HQ is not answering on ${LOCAL}. Start it first (npm start).`);
  process.exit(1);
}

const child = spawn('cloudflared', ['tunnel', '--url', LOCAL, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
let announced = false;

async function register(url) {
  try {
    await fetch(`${LOCAL}/api/auth/tunnel-url`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
    });
  } catch (error) {
    console.error(`could not register the tunnel with the app: ${error.message}`);
  }
}

function watch(stream) {
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk.toString();
    const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !announced) {
      announced = true;
      // The app only remembers the address in memory, so re-announce it every
      // 30s — a server restart mid-evening must not blank Settings → Phone access.
      setInterval(() => register(match[0]), 30000).unref();
      register(match[0]).then(() => {
        console.log('\n  Phone address (open this on your phone):\n');
        console.log(`      ${match[0]}\n`);
        console.log('  Then on this Mac: Settings → Phone access → Generate code, and type it on the phone.');
        console.log('  Leave this window open for the draft. Ctrl-C to close the tunnel.\n');
      });
    }
    if (buffer.length > 20000) buffer = buffer.slice(-5000);
  });
}
watch(child.stdout); watch(child.stderr);

const shutdown = async () => {
  await register('');
  child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', code => { console.log(`cloudflared exited (${code})`); register(''); process.exit(code ?? 0); });
