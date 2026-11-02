/* Reppen access tokens: this instance is the identity provider for a self-hosted Reppen service.
 *
 * A signed-in session asks POST /api/reppen/token for a short-lived token and sends it to Reppen
 * as a Bearer. Reppen checks it against the public keys at GET /api/reppen/jwks. The token is an
 * EdDSA (Ed25519) JWT with exactly iss, aud, sub, iat, nbf and exp, and lives five minutes.
 *
 * The signing keys are their own, never the session secret: whoever holds ./data/secret can mint
 * sessions here, and Reppen must not need it, or be able to. They live in ./data/reppen-keys.json
 * (0600), made on the first start with the feature on, and are never logged. A key set file that
 * cannot be read stops the server, saying so without quoting it, rather than quietly making new
 * keys: a Reppen configured with the old public key would refuse every token without a word.
 *
 * Rotation publishes the new key before it signs anything (`lead` seconds, so a Reppen that
 * caches the key set sees it first), and keeps every older key published until the last token it
 * signed has expired, skew included. Only the running server writes the file (admin socket,
 * reppen-keys.js), the same way only it writes db.json.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './durable.js';

export const TOKEN_TTL_S = 300;
// The clock skew Reppen allows on exp and nbf. A retired key stays published this much longer.
export const SKEW_S = 60;
export const DEFAULT_LEAD_S = 600;
export const MAX_LEAD_S = 7 * 86400;

/** The feature flag and its settings. Off unless both the issuer and the audience are set. */
export function reppenConfig(env = process.env) {
  const issuer = (env.REPPEN_TOKEN_ISSUER || '').trim();
  const audience = (env.REPPEN_TOKEN_AUDIENCE || '').trim();
  const apiUrl = (env.REPPEN_API_URL || '').trim().replace(/\/+$/, '');
  return { enabled: !!(issuer && audience), issuer, audience, apiUrl };
}

const b64u = b => Buffer.from(b).toString('base64url');

// The RFC 7638 thumbprint of the public key: a key id that names the key and nothing else.
const kidOf = x => b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest());

function newKey(activeFrom) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' });
  return { kid: kidOf(x), x, pkcs8: privateKey.export({ type: 'pkcs8', format: 'pem' }), activeFrom, retireAt: null };
}

const validKey = k => k && typeof k.kid === 'string' && typeof k.x === 'string' && typeof k.pkcs8 === 'string'
  && Number.isFinite(k.activeFrom) && (k.retireAt === null || Number.isFinite(k.retireAt));

/**
 * The key set at `file`, made when absent. `now` is injectable for tests.
 * Returns { mint(sub, { issuer, audience }), jwks(), rotate(leadS), list() }.
 */
export function openKeyStore(file, { now = () => Date.now() } = {}) {
  const save = s => atomicWrite(file, JSON.stringify(s, null, 2), 0o600);
  let set;
  try {
    set = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!set || !Array.isArray(set.keys) || !set.keys.length || !set.keys.every(validKey)) throw new Error('bad shape');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${path.basename(file)} cannot be read; restore it from a backup, or move it away to make new keys`);
    set = { keys: [newKey(now())] };
    save(set);
  }
  try { fs.chmodSync(file, 0o600); } catch { /* a host filesystem that refuses chmod */ }

  const keyObjects = new Map();
  const privateOf = k => {
    if (!keyObjects.has(k.kid)) keyObjects.set(k.kid, crypto.createPrivateKey(k.pkcs8));
    return keyObjects.get(k.kid);
  };
  const published = t => set.keys.filter(k => k.retireAt === null || k.retireAt > t);
  // The newest key whose time has come. A key waiting out its lead is published but signs nothing.
  const signing = t => published(t).filter(k => k.activeFrom <= t).sort((a, b) => b.activeFrom - a.activeFrom)[0];

  return {
    // `scope` is set only by this server's own account-erasure requests; a session's token never
    // carries one, so a signed-in browser cannot ask Reppen to erase anything.
    mint(sub, { issuer, audience }, scope) {
      const key = signing(now());
      const iat = Math.floor(now() / 1000);
      const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }));
      const claims = { iss: issuer, aud: audience, sub, iat, nbf: iat, exp: iat + TOKEN_TTL_S };
      if (scope) claims.scope = scope;
      const body = b64u(JSON.stringify(claims));
      const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), privateOf(key));
      return { token: `${head}.${body}.${b64u(sig)}`, expiresAt: iat + TOKEN_TTL_S };
    },
    jwks() {
      return { keys: published(now()).map(k => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid, alg: 'EdDSA', use: 'sig' })) };
    },
    /** A new signing key from `leadS` seconds on; every key before it retires once its tokens are gone. */
    rotate(leadS = DEFAULT_LEAD_S) {
      const t = now();
      const pending = set.keys.find(k => k.activeFrom > t);
      if (pending) return { error: `a rotation is already waiting: key ${pending.kid} signs from ${new Date(pending.activeFrom).toISOString()}` };
      const fresh = newKey(t + leadS * 1000);
      const retireAt = fresh.activeFrom + (TOKEN_TTL_S + SKEW_S) * 1000;
      const keys = published(t).map(k => ({ ...k, retireAt: k.retireAt === null ? retireAt : Math.min(k.retireAt, retireAt) }));
      const next = { keys: [...keys, fresh] };
      save(next);
      set = next;
      return { kid: fresh.kid, activeFrom: fresh.activeFrom };
    },
    /** The keys without their private halves, for the admin command. */
    list() {
      const t = now(), current = signing(t);
      return set.keys.map(k => ({ kid: k.kid, activeFrom: k.activeFrom, retireAt: k.retireAt, signing: k === current, published: k.retireAt === null || k.retireAt > t }));
    }
  };
}

/* Account erasure in Reppen. When an account is deleted here, Reppen is asked to erase its data
 * too: POST /v1/account/erasure at REPPEN_API_URL with a token minted for the deleted account
 * carrying `scope: "account.erase"`, which Reppen requires on that route
 * (the account record is gone by then; the key set still signs for its id). The request is a
 * record in db.json (`reppenErasure`), written in the same save that removes the account, so a
 * crash cannot lose one; it is sent in the background and retried, doubling from `retryMs` up to
 * an hour, until Reppen answers 2xx, across restarts. The deletion never waits for Reppen. The
 * commandId is fixed per record, so a retry after a lost answer is the same request to Reppen.
 */
export const ERASURE_MAX_DELAY_MS = 3600000;
const ERASURE_TIMEOUT_MS = 15000;

// `active` false (tokens off) keeps the records and sends nothing until a restart with tokens on.
export function erasureSender({ db, save, mint, apiUrl, retryMs, active = true, log = console, now = () => Date.now() }) {
  let running = false, again = false;
  const pending = () => db().reppenErasure || [];

  async function send(item) {
    const r = await fetch(`${apiUrl}/v1/account/erasure`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mint(item.sub).token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: item.commandId, confirm: 'eraseAccount' }),
      redirect: 'error',
      signal: AbortSignal.timeout(ERASURE_TIMEOUT_MS)
    });
    await r.arrayBuffer().catch(() => {});
    return r.status;
  }

  async function run() {
    if (!active) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        for (const item of [...pending()]) {
          if (item.nextAt > now()) continue;
          let status = 0, failure = null;
          try { status = await send(item); } catch (e) { failure = e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.name; }
          const list = pending(), i = list.indexOf(item);
          if (i < 0) continue;
          if (status >= 200 && status < 300) {
            list.splice(i, 1);
            log.log(`reppen: erasure of ${item.sub} accepted (${status})`);
          } else {
            item.attempts += 1;
            item.nextAt = now() + Math.min(retryMs * 2 ** Math.min(item.attempts - 1, 30), ERASURE_MAX_DELAY_MS);
            item.lastError = status ? `http ${status}` : failure;
            log.warn(`reppen: erasure of ${item.sub} failed (${item.lastError}), attempt ${item.attempts}, retrying at ${new Date(item.nextAt).toISOString()}`);
          }
          try { save(); } catch (e) { log.error('reppen: could not save the erasure queue', e.message); }
        }
      } while (again);
    } finally { running = false; }
  }

  return {
    /** Records the erasure in db (the caller saves it with the deletion) and sends it soon. */
    enqueue(sub) {
      const d = db();
      (d.reppenErasure ||= []).push({ sub, commandId: 'opengym-' + crypto.randomBytes(16).toString('base64url'), since: now(), attempts: 0, nextAt: now(), lastError: null });
      setImmediate(() => { run().catch(e => log.error('reppen: erasure run', e)); });
    },
    start() {
      const tick = () => { run().catch(e => log.error('reppen: erasure run', e)); };
      setInterval(tick, retryMs).unref();
      setImmediate(tick);
    },
    run
  };
}
