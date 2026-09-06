#!/usr/bin/env node
/**
 * A dedicated, always-running Cloudflare quick tunnel for the launcher
 * (scripts/launcher.mjs), so a phone can reach it even when the main app's
 * own tunnel isn't up yet. Run as a launchd service (KeepAlive) alongside
 * the launcher itself — see com.gridironhq.launcher-tunnel.plist.
 *
 * Caveat worth being honest about: a Cloudflare *quick* tunnel has no fixed
 * hostname. This address stays the same as long as this process keeps
 * running, but a Mac reboot restarts it and mints a NEW address — there is
 * no way around that without a paid/named Cloudflare Tunnel tied to a domain.
 * The address is written to launcher-tunnel-url.txt on every start so it can
 * always be read back after a reboot, even without being at the Mac (e.g. by
 * asking Claude to read it, or via Screen Sharing).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LAUNCHER_PORT) || 5199;
const URL_FILE = path.join(ROOT, 'server', 'data', 'launcher-tunnel-url.txt');

// launchd runs services with a minimal PATH that doesn't include Homebrew,
// so the bare command name that works in a terminal fails silently here.
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || '/opt/homebrew/bin/cloudflared';
const child = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'],
  { stdio: ['ignore', 'pipe', 'pipe'] });

let buffer = '';
const watch = stream => stream.on('data', chunk => {
  buffer += chunk.toString();
  const m = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m) {
    fs.writeFileSync(URL_FILE, m[0]);
    console.log(`Launcher tunnel: ${m[0]}`);
  }
  if (buffer.length > 20000) buffer = buffer.slice(-5000);
});
watch(child.stdout); watch(child.stderr);
child.on('exit', code => { console.log(`cloudflared exited (${code})`); process.exit(code ?? 0); });
