import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { assertPortAvailable } from '../server/platform/port-guard.js';

test('startup guard names the PID holding the API port', async () => {
  const owner = net.createServer();
  await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.listen(0, resolve);
  });
  try {
    const port = owner.address().port;
    await assert.rejects(assertPortAvailable(port), error => {
      assert.equal(error.code, 'PORT_IN_USE');
      assert.match(error.message, new RegExp(`port ${port}`));
      assert.match(error.message, new RegExp(`PID ${process.pid}`));
      assert.match(error.message, /No database jobs were started/);
      return true;
    });
  } finally {
    await new Promise(resolve => owner.close(resolve));
  }
});

test('startup guard releases an available port after checking it', async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await assertPortAvailable(port);

  const actual = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      actual.once('error', reject);
      actual.listen(port, resolve);
    });
  } finally {
    await new Promise(resolve => actual.close(resolve));
  }
});
