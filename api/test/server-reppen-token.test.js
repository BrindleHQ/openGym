/* Reppen access tokens (reppen.js): a signed-in session gets a five-minute EdDSA token behind the
   origin check, the public keys are published, signing out everywhere stops minting, rotation
   publishes old and new keys, and with the feature off none of it exists. Real server.js in a
   child, as in server-account-delete.test.js; the key store's clock-driven parts directly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { openKeyStore, TOKEN_TTL_S, SKEW_S } from '../reppen.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const ISS = 'https://gym.example.test', AUD = 'reppen-test';
const session = (uid, { sv = 0, kind = 'c' } = {}) => {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}:${kind}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const USER = { id: 'u_ana', name: 'Ana', created: new Date().toISOString() };
const GONE = { id: 'u_off', name: 'Off', created: new Date().toISOString(), disabled: true };
const ON = { REPPEN_TOKEN_ISSUER: ISS, REPPEN_TOKEN_AUDIENCE: AUD };

async function startServer(t, { env = {}, dataDir } = {}) {
  if (!dataDir) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-reppen-'));
    fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [USER, GONE], creds: [], subs: [], invites: [] }));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  }
  const childEnv = { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', ADMIN_SOCKET_DIR: path.join(dataDir, 'sock'), ...env };
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  const h = { log: '', dataDir, child };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => child.kill('SIGKILL'));
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.stop = async () => { child.kill('SIGKILL'); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); };
  h.jwks = async () => { const r = await fetch(`${h.api}/api/reppen/jwks`); return { status: r.status, body: await r.json() }; };
  h.mint = async (headers = {}) => {
    const r = await fetch(`${h.api}/api/reppen/token`, { method: 'POST', headers });
    return { status: r.status, body: await r.json() };
  };
  h.cli = (...args) => new Promise(resolve => execFile(process.execPath, ['reppen-keys.js', ...args], { cwd: API, env: childEnv },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout, err: stderr })));
  return h;
}
const browser = (uid, extra = {}) => ({ Cookie: `gymsid=${session(uid)}`, 'Sec-Fetch-Site': 'same-origin', ...extra });

/** The token's header and claims, after checking its signature against the key set it names. */
function verify(token, jwks) {
  const [h, c, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  assert.ok(jwk, `kid ${header.kid} is published`);
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
  assert.ok(crypto.verify(null, Buffer.from(`${h}.${c}`), key, Buffer.from(s, 'base64url')), 'the signature verifies');
  return { header, claims: JSON.parse(Buffer.from(c, 'base64url')) };
}

test('with the feature off every /api/reppen route is a 404 and no key file is made', async t => {
  const h = await startServer(t, { env: { REPPEN_TOKEN_ISSUER: ISS } });
  assert.equal((await h.jwks()).status, 404);
  assert.equal((await h.mint(browser(USER.id))).status, 404);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'reppen-keys.json')), false);
});

test('a signed-in session gets a token that verifies with the published key and carries exactly the contract claims', async t => {
  const h = await startServer(t, { env: ON });
  const file = path.join(h.dataDir, 'reppen-keys.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the key set is 0600');
  const { status, body: jwks } = await h.jwks();
  assert.equal(status, 200);
  assert.equal(jwks.keys.length, 1);
  assert.deepEqual(Object.keys(jwks.keys[0]).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x']);
  assert.deepEqual({ ...jwks.keys[0], x: undefined, kid: undefined }, { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', x: undefined, kid: undefined });

  const before = Math.floor(Date.now() / 1000);
  const r = await h.mint(browser(USER.id));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['expiresAt', 'token']);
  const { header, claims } = verify(r.body.token, jwks);
  assert.deepEqual(header, { alg: 'EdDSA', typ: 'JWT', kid: jwks.keys[0].kid });
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'nbf', 'sub']);
  assert.equal(claims.iss, ISS);
  assert.equal(claims.aud, AUD);
  assert.equal(claims.sub, USER.id);
  assert.ok(claims.iat >= before && claims.iat <= before + 5);
  assert.equal(claims.nbf, claims.iat);
  assert.equal(claims.exp, claims.iat + TOKEN_TTL_S);
  assert.equal(r.body.expiresAt, claims.exp);

  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(h.log, /PRIVATE KEY/, 'the private key is never logged');
  assert.match(raw, /PRIVATE KEY/);
});

test('minting needs a valid session', async t => {
  const h = await startServer(t, { env: ON });
  assert.equal((await h.mint({ 'Sec-Fetch-Site': 'same-origin' })).status, 401);
  assert.equal((await h.mint(browser(GONE.id))).status, 401, 'a disabled account gets nothing');
  assert.equal((await h.mint(browser('u_nobody'))).status, 401);
  const forged = `gymsid=${session(USER.id).slice(0, -2)}xx`;
  assert.equal((await h.mint({ Cookie: forged, 'Sec-Fetch-Site': 'same-origin' })).status, 401);
});

test('a request from another origin is refused; the paired phone mints with its Bearer', async t => {
  const h = await startServer(t, { env: ON });
  for (const extra of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await h.mint(browser(USER.id, extra))).status, 403, JSON.stringify(extra));
  }
  const { Cookie } = browser(USER.id);
  assert.equal((await h.mint({ Cookie, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.mint({ Cookie, Origin: ORIGIN })).status, 200);

  const phone = await h.mint({ Authorization: `Bearer ${session(USER.id, { kind: 'b' })}`, Origin: 'capacitor://localhost' });
  assert.equal(phone.status, 200);
  assert.equal(verify(phone.body.token, (await h.jwks()).body).claims.sub, USER.id);
});

test('signing out everywhere stops further minting for every earlier session', async t => {
  const h = await startServer(t, { env: ON });
  const cookie = browser(USER.id);
  const bearer = { Authorization: `Bearer ${session(USER.id, { kind: 'b' })}` };
  assert.equal((await h.mint(cookie)).status, 200);
  const out = await fetch(`${h.api}/api/logout/all`, { method: 'POST', headers: cookie });
  assert.equal(out.status, 200);
  assert.equal((await h.mint(cookie)).status, 401);
  assert.equal((await h.mint(bearer)).status, 401);
  // A session made after the bump (version 1) mints again.
  const fresh = { Cookie: `gymsid=${session(USER.id, { sv: 1 })}`, 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await h.mint(fresh)).status, 200);
});

test('the key set survives a restart, and rotation publishes the new key before and the old key after', async t => {
  let h = await startServer(t, { env: ON });
  const first = (await h.jwks()).body.keys[0].kid;
  const oldToken = (await h.mint(browser(USER.id))).body.token;
  await h.stop();
  h = await startServer(t, { env: ON, dataDir: h.dataDir });
  assert.deepEqual((await h.jwks()).body.keys.map(k => k.kid), [first], 'same key after a restart');

  // Default lead: the new key is published at once, and does not sign yet.
  const r = await h.cli('rotate');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /waiting/);
  const jwks = (await h.jwks()).body;
  assert.equal(jwks.keys.length, 2);
  const second = jwks.keys.find(k => k.kid !== first).kid;
  assert.equal(verify((await h.mint(browser(USER.id))).body.token, jwks).header.kid, first, 'still signed with the old key');
  const again = await h.cli('rotate', '--lead', '0');
  assert.equal(again.code, 1, 'one rotation at a time');
  assert.match(again.err, new RegExp(`already waiting: key ${second}`));
  assert.doesNotMatch(r.out + h.log, /PRIVATE KEY/);

  // Survives a restart mid-rotation too.
  await h.stop();
  h = await startServer(t, { env: ON, dataDir: h.dataDir });
  assert.deepEqual((await h.jwks()).body.keys.map(k => k.kid).sort(), [first, second].sort());
  assert.equal(verify(oldToken, (await h.jwks()).body).header.kid, first, 'a token from before still verifies');
  assert.equal((await h.cli('--lead', '5')).code, 2, 'a typo is refused, not run as a list');
});

test('rotation with no lead signs with the new key at once and keeps the old one published', async t => {
  const h = await startServer(t, { env: ON });
  const first = (await h.jwks()).body.keys[0].kid;
  const oldToken = (await h.mint(browser(USER.id))).body.token;
  const r = await h.cli('rotate', '--lead', '0');
  assert.equal(r.code, 0, r.err);
  const jwks = (await h.jwks()).body;
  assert.equal(jwks.keys.length, 2);
  const fresh = verify((await h.mint(browser(USER.id))).body.token, jwks);
  assert.notEqual(fresh.header.kid, first);
  assert.equal(verify(oldToken, jwks).header.kid, first);
  assert.equal((await h.cli('rotate', '--lead', '-1')).code, 1);
});

test('the key store retires a key once its last token has expired, and refuses a damaged file without quoting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-reppen-keys-'));
  try {
    const file = path.join(dir, 'reppen-keys.json');
    let now = 1_800_000_000_000;
    const store = openKeyStore(file, { now: () => now });
    const first = store.jwks().keys[0].kid;
    const { kid: second, activeFrom } = store.rotate(60);
    assert.equal(activeFrom, now + 60_000);
    now = activeFrom - 1;
    assert.equal(JSON.parse(Buffer.from(store.mint('u', { issuer: ISS, audience: AUD }).token.split('.')[0], 'base64url')).kid, first);
    now = activeFrom;
    assert.equal(JSON.parse(Buffer.from(store.mint('u', { issuer: ISS, audience: AUD }).token.split('.')[0], 'base64url')).kid, second);
    // The old key's last token, minted just before activeFrom, lives TOKEN_TTL_S, plus Reppen's skew.
    now = activeFrom + (TOKEN_TTL_S + SKEW_S) * 1000 - 1;
    assert.deepEqual(store.jwks().keys.map(k => k.kid), [first, second]);
    now += 1;
    assert.deepEqual(store.jwks().keys.map(k => k.kid), [second]);
    assert.deepEqual(openKeyStore(file, { now: () => now }).jwks().keys.map(k => k.kid), [second], 'the same from the file');

    const secretBits = JSON.parse(fs.readFileSync(file, 'utf8')).keys[0].pkcs8.split('\n')[1];
    fs.writeFileSync(file, `{"keys":[{"pkcs8":"${secretBits}"`);
    assert.throws(() => openKeyStore(file), e => /cannot be read/.test(e.message) && !e.message.includes(secretBits.slice(0, 12)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
