import net from 'node:net';
import { execFileSync } from 'node:child_process';

function ownerOnUnix(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(/^p(\d+)$/m.exec(output)?.[1]);
    if (!Number.isInteger(pid)) return null;
    let command = null;
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { /* PID is enough when ps is unavailable. */ }
    return { pid, command };
  } catch { return null; }
}

function ownerOnWindows(port) {
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = output.split(/\r?\n/).find(value =>
      new RegExp(`:${port}\\s+.*LISTENING\\s+\\d+\\s*$`, 'i').test(value));
    const pid = Number(line?.trim().split(/\s+/).at(-1));
    return Number.isInteger(pid) ? { pid, command: null } : null;
  } catch { return null; }
}

export function portOwner(port) {
  return process.platform === 'win32' ? ownerOnWindows(port) : ownerOnUnix(port);
}

/**
 * Reserve-and-release the API port before importing any module that opens the
 * SQLite database or starts background jobs. This makes a second boot fail
 * before it can become a second database writer.
 */
export function assertPortAvailable(port) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    return Promise.reject(new Error(`Invalid API_PORT: ${port}`));
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', error => {
      if (error.code !== 'EADDRINUSE') return reject(error);
      const owner = portOwner(number);
      const detail = owner
        ? `PID ${owner.pid}${owner.command ? ` (${owner.command})` : ''}`
        : 'another process';
      const refusal = new Error(`Gridiron HQ refused to start: port ${number} is already held by ${detail}. ` +
        `Stop that process or choose another port with API_PORT. No database jobs were started.`);
      refusal.code = 'PORT_IN_USE';
      reject(refusal);
    });
    probe.listen(number, () => probe.close(resolve));
  });
}
