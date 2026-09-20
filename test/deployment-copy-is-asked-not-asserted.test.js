/**
 * Copy that tells someone where their data is must be true of the install they
 * are looking at.
 *
 * The app ships two ways from one codebase — on the Mac, where the server
 * provisions the browser over loopback and the database is on that disk, and
 * hosted on Fly, where a Google account signs you in and the database is a
 * server volume. Several strings asserted the first one as a fact: the sidebar
 * told every hosted visitor "data stays on your Mac", the Settings card told
 * them their loopback sign-in was automatic, and the ESPN bookmarklet step told
 * them their session cookies went "to this app on your own computer" while they
 * were in the act of handing those cookies over.
 *
 * `GET /api/auth/providers` answers this per request (`local` is
 * `isDirectLoopback(req)`), so the fix is to ask. These tests are source-text
 * checks, which is the same instrument this repo already uses for "a served
 * field nothing renders" — they prove the claim is conditional, not that it
 * renders correctly, and they are deliberately narrow: they name the exact
 * strings that were wrong rather than trying to catch every future sentence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** Every file whose copy states where data lives or how sign-in happens. */
const CLAIM_FILES = [
  'client/src/App.tsx',
  'client/src/pages/Settings.tsx',
  'client/src/components/EspnConnect.tsx',
  'client/src/components/EspnConnectGate.tsx'
];

test('the flat "your Mac" claim is gone from every user-facing string', () => {
  for (const file of CLAIM_FILES) {
    const src = read(file);
    assert.doesNotMatch(src, /data stays on your Mac/,
      `${file} still asserts the Mac to every reader`);
  }
});

test('every file that claims a location asks the server which install this is', () => {
  for (const file of CLAIM_FILES) {
    const src = read(file);
    assert.match(src, /useDeployment/, `${file} states a location without asking`);
    assert.match(src, /deployment\??\.local/,
      `${file} imports the answer but does not branch on it`);
  }
});

test('the hosted branch says the true thing, not a softened version of the Mac one', () => {
  const app = read('client/src/App.tsx');
  assert.match(app, /data lives on the server/, 'the sidebar names where hosted data actually is');
  const settings = read('client/src/pages/Settings.tsx');
  assert.match(settings, /signed in with Google/i, 'Settings names the sign-in that applies');
  assert.match(settings, /anyone else invited to this install sees the same leagues/,
    'and says the install is shared, which is the part a single-user page never had to');
});

test('the credential claim is conditional in both places that make it', () => {
  // The two places someone hands over an ESPN session cookie. "Only on this
  // machine" is the sentence most worth being right about in the whole app.
  const connect = read('client/src/components/EspnConnect.tsx');
  assert.match(connect, /own database on the server/, 'the Settings card has a hosted branch');
  assert.doesNotMatch(connect, /stored only on this machine\./,
    'and no longer ends the sentence as an unconditional claim');
  const gate = read('client/src/components/EspnConnectGate.tsx');
  assert.match(gate, /to this app on the server/, 'the bookmarklet step has a hosted branch');
});

test('phone pairing is only offered where its endpoints work', () => {
  // PhoneAccess mints codes and reads the tunnel address through endpoints that
  // refuse anything but direct loopback, so on the hosted app it rendered a
  // failed request under instructions for a machine the reader is not at.
  const settings = read('client/src/pages/Settings.tsx');
  assert.match(settings, /deployment\?\.local && <PhoneAccess \/>/,
    'the pairing card is gated on the deployment actually being local');
});

test('an unanswered probe is never treated as local', () => {
  // The failure that would undo all of the above: defaulting to the Mac when the
  // probe fails, which is exactly the assertion these tests exist to remove.
  const src = read('client/src/state/deployment.ts');
  assert.match(src, /\.catch\(\(\) => null\)/, 'a failed probe resolves to unknown');
  assert.doesNotMatch(src, /local: true/, 'nothing in the module hardcodes a local deployment');
  assert.match(src, /body\.local === true/, 'local is read from the server answer only');
});
