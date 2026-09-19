#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-start-smoke-'));
const database = path.join(temp, 'smoke.sqlite');
const port = Number(process.env.GRIDIRON_SMOKE_PORT) || (20000 + process.pid % 20000);

let output = '';
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, API_PORT: String(port), GRIDIRON_DB_PATH: database },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

try {
  // Wait on an unauthenticated route: /api/teams is bearer-authenticated
  // (server/index.js), so polling it without a token only ever yields 401 and
  // this loop would spend all 80 attempts before failing on a healthy server.
  let up = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null) throw new Error(`application exited with code ${child.exitCode}\n${output}`);
    try {
      await fetch(`http://127.0.0.1:${port}/api/model/status`, { signal: AbortSignal.timeout(500) });
      up = true;
      break;
    } catch { /* application is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  if (!up) throw new Error(`application never answered on 127.0.0.1:${port}\n${output}`);

  // Then prove the seeded data really is servable, which is the point of this
  // smoke. POST /api/auth/local-session mints a token for a direct loopback
  // caller (server/routes/local-auth.js), which is exactly what this is.
  const session = await (await fetch(`http://127.0.0.1:${port}/api/auth/local-session`,
    { method: 'POST', signal: AbortSignal.timeout(5000) })).json();
  if (!session?.token) throw new Error(`could not mint a local session\n${JSON.stringify(session)}\n${output}`);
  const response = await fetch(`http://127.0.0.1:${port}/api/teams`,
    { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`application did not answer /api/teams successfully (${response.status})\n${output}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('startup probe returned an unexpected payload');
  console.log(`Application startup smoke passed on isolated database (${payload.length} teams).`);
} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
  fs.rmSync(temp, { recursive: true, force: true });
}
