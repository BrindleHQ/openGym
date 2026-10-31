/* SESSION_COOKIE: two instances on one hostname (staging and production on different ports of a
   tailnet name) need different session cookie names, because browsers keep cookies per host, not
   per port. With the same name, signing in to one replaced the other's session and signing out
   of one cleared both. Real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

async function startServer(t, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cookiename-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_one', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'https://gym.test:9443', RP_ID: 'gym.test', SESSION_COOKIE: '', ...extraEnv }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${await boundPort(child, () => log)}`;
}
const me = (api, name) => fetch(`${api}/api/me`, { headers: { Cookie: `${name}=${mintSession('u_one')}` } });
const logout = (api, name) => fetch(`${api}/api/logout`, {
  method: 'POST',
  headers: { Cookie: `${name}=${mintSession('u_one')}`, Origin: 'https://gym.test:9443', 'Content-Type': 'application/json' },
  body: '{}'
});

test('SESSION_COOKIE names the cookie: the instance reads and clears only its own', async t => {
  const api = await startServer(t, { SESSION_COOKIE: 'gymsid-staging' });
  assert.equal((await me(api, '__Host-gymsid-staging')).status, 200);
  // The other instance's cookie on the same hostname is not this one's session.
  assert.equal((await me(api, '__Host-gymsid')).status, 401);
  const out = await logout(api, '__Host-gymsid-staging');
  assert.equal(out.status, 200);
  const cleared = out.headers.getSetCookie().map(c => c.split('=')[0]);
  assert.ok(cleared.includes('__Host-gymsid-staging'));
  assert.ok(!cleared.includes('__Host-gymsid'), 'signing out here must not sign the other instance out');
});

test('unset, or a value that is not a cookie name, keeps the default name', async t => {
  for (const SESSION_COOKIE of ['', 'bad name;x']) {
    const api = await startServer(t, { SESSION_COOKIE });
    assert.equal((await me(api, '__Host-gymsid')).status, 200, `SESSION_COOKIE=${JSON.stringify(SESSION_COOKIE)}`);
  }
});
