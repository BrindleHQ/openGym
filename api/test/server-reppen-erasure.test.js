/* A deleted account is erased in Reppen too (reppen.js, erasureSender): the request is recorded in
   db.json with the deletion, sent with a token minted for the deleted account, retried while
   Reppen fails, across a restart, and dropped once Reppen accepts it. The deletion never waits for
   Reppen. A fake Reppen on a local port, the real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const ON = { REPPEN_TOKEN_ISSUER: 'https://gym.example.test', REPPEN_TOKEN_AUDIENCE: 'reppen-test', REPPEN_ERASURE_RETRY_MS: '100' };
const cookie = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return `gymsid=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
};
const ADMIN = { id: 'u_adm', name: 'Adminna', created: new Date().toISOString(), admin: true, owner: true };
const USER = { id: 'u_ana', name: 'Ana', created: new Date().toISOString() };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, check, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A Reppen that records every erasure request and answers `status` (changeable). */
async function fakeReppen(t) {
  const f = { status: 503, calls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      f.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || 'null'), status: f.status });
      res.writeHead(f.status, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  f.url = `http://127.0.0.1:${server.address().port}`;
  return f;
}

async function startServer(t, { env, dataDir }) {
  if (!dataDir) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-reppen-erase-'));
    fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [ADMIN, USER], creds: [], subs: [], invites: [] }));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', ADMIN_SOCKET_DIR: path.join(dataDir, 'sock'), ...env },
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => child.kill('SIGKILL'));
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.stop = async () => { child.kill('SIGKILL'); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); };
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.deleteUser = () => fetch(`${h.api}/api/admin/user/delete`, {
    method: 'POST', headers: { Cookie: cookie(ADMIN.id), 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: USER.id })
  });
  return h;
}

function claimsVerified(token, jwks) {
  const [h, c, s] = token.split('.');
  const { kid } = JSON.parse(Buffer.from(h, 'base64url'));
  const jwk = jwks.keys.find(k => k.kid === kid);
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  assert.ok(crypto.verify(null, Buffer.from(`${h}.${c}`), key, Buffer.from(s, 'base64url')));
  return JSON.parse(Buffer.from(c, 'base64url'));
}

test('a deleted account is erased in Reppen: retried while it fails, across a restart, and dropped once accepted', async t => {
  const reppen = await fakeReppen(t);
  const env = { ...ON, REPPEN_API_URL: reppen.url + '/' };
  let h = await startServer(t, { env });

  const del = await h.deleteUser();
  assert.equal(del.status, 200, 'the deletion goes ahead with Reppen down');
  assert.deepEqual(h.db().users.map(u => u.id), [ADMIN.id]);

  await until('two failed attempts', () => h.db().reppenErasure?.[0]?.attempts >= 2);
  const [rec] = h.db().reppenErasure;
  assert.equal(rec.sub, USER.id);
  assert.equal(rec.lastError, 'http 503');
  assert.match(rec.commandId, /^[A-Za-z0-9_-]{1,128}$/, 'a commandId Reppen accepts');

  const jwks = await (await fetch(`${h.api}/api/reppen/jwks`)).json();
  const first = reppen.calls[0];
  assert.equal(first.method, 'POST');
  assert.equal(first.url, '/v1/account/erasure');
  assert.deepEqual(first.body, { commandId: rec.commandId, confirm: 'eraseAccount' });
  const claims = claimsVerified(first.auth.replace(/^Bearer /, ''), jwks);
  assert.equal(claims.sub, USER.id, 'a token for the deleted account');
  assert.equal(claims.aud, 'reppen-test');

  // Down for good mid-retry; Reppen recovers meanwhile.
  await h.stop();
  const before = reppen.calls.length;
  reppen.status = 202;
  h = await startServer(t, { env, dataDir: h.dataDir });
  await until('the record is dropped', () => Array.isArray(h.db().reppenErasure) && h.db().reppenErasure.length === 0);
  const accepted = reppen.calls.slice(before);
  assert.ok(accepted.some(c => c.status === 202));
  assert.ok(reppen.calls.every(c => c.body.commandId === rec.commandId), 'every retry is the same command');

  const settled = reppen.calls.length;
  await sleep(500);
  assert.equal(reppen.calls.length, settled, 'nothing more is sent after Reppen accepted it');
  assert.doesNotMatch(h.log, /Bearer|eyJ/, 'no token in the log');
});

test('without REPPEN_API_URL a deletion records nothing for Reppen', async t => {
  const h = await startServer(t, { env: ON });
  assert.equal((await h.deleteUser()).status, 200);
  assert.equal(h.db().reppenErasure, undefined);
});

test('with REPPEN_API_URL but no token settings the erasure is kept, and sent once a restart has them', async t => {
  const reppen = await fakeReppen(t);
  reppen.status = 202;
  const { REPPEN_TOKEN_AUDIENCE, ...partial } = { ...ON, REPPEN_API_URL: reppen.url };
  let h = await startServer(t, { env: partial });
  assert.equal((await h.deleteUser()).status, 200);
  assert.equal(h.db().reppenErasure.length, 1);
  await sleep(400);
  assert.equal(reppen.calls.length, 0, 'nothing is sent without a token to send it with');
  assert.match(h.log, /kept and not sent/);
  await h.stop();
  h = await startServer(t, { env: { ...partial, REPPEN_TOKEN_AUDIENCE }, dataDir: h.dataDir });
  await until('the record is dropped', () => h.db().reppenErasure.length === 0);
  assert.equal(reppen.calls.length, 1);
});
