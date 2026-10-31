#!/usr/bin/env node
// Deploys one release record to one environment's Coolify service, and proves it landed.
// docs/BRINDLE_DEPLOY.md explains where this sits; .github/workflows/test.yml (staging) and
// promote.yml (production) are the callers.
//
//   node scripts/deploy/coolify.mjs render    <env> <release.json>   print the compose it would upload
//   node scripts/deploy/coolify.mjs provision <env> <release.json>   create the Coolify service (once)
//   node scripts/deploy/coolify.mjs deploy    <env> <release.json>   upload, deploy, verify
//
// --bootstrap (deploy only) turns INVITE_ONLY off for that one deploy, so the owner's profile can
// be created on a fresh instance (invite codes come from an admin, and there is none yet).
//
// Environment: COOLIFY_URL, COOLIFY_TOKEN, and COOLIFY_SERVICE_UUID (deploy) or
// COOLIFY_PROJECT_UUID + COOLIFY_SERVER_UUID (provision). Writes deployment-result.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = { api: 'ghcr.io/brindlehq/opengym-api', web: 'ghcr.io/brindlehq/opengym-web' };
// Coolify variables the compose file reads as ${NAME}. Literal: Coolify writes them to the
// service's .env single-quoted, so compose passes the `$` through to nginx untouched.
export const SERVICE_ENV = [{ key: 'CF_CONNECTING_IP', value: '$http_cf_connecting_ip', is_literal: true }];

export function validateRelease(release) {
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(release?.sha || '')) problems.push('sha is not a full commit sha');
  for (const app of ['api', 'web']) {
    const ref = release?.[app] || '';
    if (!ref.startsWith(`${IMAGE[app]}@sha256:`) || !/@sha256:[0-9a-f]{64}$/.test(ref)) {
      problems.push(`${app} is not ${IMAGE[app]}@sha256:<digest>`);
    }
  }
  if (problems.length) throw new Error(`Invalid release record: ${problems.join('; ')}`);
  return release;
}

export function environmentConfig(environments, env) {
  const cfg = environments[env];
  if (!cfg) throw new Error(`Unknown environment "${env}" (deploy/environments.json has ${Object.keys(environments).join(', ')})`);
  if (!/^[a-z0-9.-]+$/.test(cfg.host)) throw new Error(`${env}: host "${cfg.host}" is not a bare hostname`);
  if (!Number.isInteger(cfg.backupRetentionDays) || cfg.backupRetentionDays < 1) throw new Error(`${env}: backupRetentionDays must be a positive integer`);
  if (!/^\S+ \S+ \S+ \S+ \S+$/.test(cfg.backupCron)) throw new Error(`${env}: backupCron must be a five-field cron expression`);
  return cfg;
}

export function renderCompose(template, env, cfg, release, { bootstrap = false } = {}) {
  const flag = v => (v ? '1' : '0');
  const values = {
    API_IMAGE: release.api,
    WEB_IMAGE: release.web,
    ENV: env,
    HOST: cfg.host,
    RP_NAME: cfg.rpName,
    INVITE_ONLY: flag(cfg.inviteOnly && !bootstrap),
    ALLOW_GUEST: flag(cfg.allowGuest),
    BACKUP_CRON: cfg.backupCron,
    RETENTION_DAYS: String(cfg.backupRetentionDays),
  };
  return template.replace(/__([A-Z_]+)__/g, (m, key) => {
    if (!(key in values)) throw new Error(`Unknown placeholder ${m} in deploy/coolify-compose.yml`);
    return values[key];
  });
}

export function coolifyClient({ url, token, request = fetch }) {
  if (!url || !token) throw new Error('COOLIFY_URL and COOLIFY_TOKEN are required');
  const base = url.replace(/\/+$/, '') + '/api/v1/';
  return async function api(method, route, body) {
    const res = await request(base + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Coolify ${method} ${route}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
}

// Coolify reports "<state>:<health>" per container. The API and web carry healthchecks, so they
// have to be healthy; the backup container has none and reports running:unknown. `bad` is not
// final on its own: right after the deploy is queued Coolify still reports the state from before
// it (a stopped service reads "exited"), so the caller only fails once a bad state persists.
export function serviceState(service) {
  const apps = Object.fromEntries((service.applications || []).map(a => [a.name, a]));
  const missing = ['api', 'web', 'backup'].filter(n => !apps[n]);
  if (missing.length) return { done: false, reason: `missing containers: ${missing.join(', ')}` };
  const bad = Object.values(apps).find(a => /^(exited|degraded|restarting)/.test(a.status || ''));
  if (bad) return { done: false, bad: true, reason: `${bad.name} is ${bad.status}` };
  const waiting = ['api', 'web'].filter(n => apps[n].status !== 'running:healthy');
  if (waiting.length) return { done: false, reason: waiting.map(n => `${n} ${apps[n].status}`).join(', ') };
  if (!/^running/.test(apps.backup.status || '')) return { done: false, reason: `backup ${apps.backup.status}` };
  return { done: true, ok: true, apps };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// How long a container may stay exited or restarting before the deploy counts as failed. Long
// enough for Coolify to pull and start both images, short of the overall timeout.
const BAD_FOR_MS = 3 * 60000;

async function waitFor(what, fn, { timeoutMs, everyMs = 5000 }) {
  const until = Date.now() + timeoutMs;
  let last = 'not checked yet';
  for (;;) {
    let r;
    try { r = await fn(); } catch (e) { r = { done: false, reason: e.message }; }
    if (r.done) {
      if (!r.ok) throw new Error(`${what} failed: ${r.reason}`);
      return r;
    }
    if (r.reason !== last) console.log(`  waiting for ${what}: ${r.reason}`);
    last = r.reason;
    if (Date.now() > until) throw new Error(`${what} timed out after ${timeoutMs / 1000}s (last: ${last})`);
    await sleep(everyMs);
  }
}

// What the new containers must say publicly. The revision proves the images (both are rebuilt
// for every commit); the two flags prove the configuration, since a redeploy that changes only
// configuration keeps the old containers answering, healthy, until Coolify gets to restarting them.
export function expectedPublic(cfg, { bootstrap = false } = {}) {
  return { invite_only: !!cfg.inviteOnly && !bootstrap, allow_guest: !!cfg.allowGuest };
}

export function publicMismatch(want, config) {
  const off = Object.keys(want).filter(k => config?.[k] !== want[k]);
  return off.length ? off.map(k => `${k} is ${config?.[k]}, want ${want[k]}`).join(', ') : null;
}

async function publicChecks(host, release, want, request = fetch) {
  const bust = `?t=${Date.now()}`;
  const rel = await request(`https://${host}/release.json${bust}`, { headers: { 'Cache-Control': 'no-cache' } });
  if (!rel.ok) return { done: false, reason: `release.json HTTP ${rel.status}` };
  const served = await rel.json().catch(() => ({}));
  if (served.revision !== release.sha) return { done: false, reason: `serving ${served.revision || 'unknown'}, want ${release.sha}` };
  const health = await request(`https://${host}/api/health${bust}`);
  const body = await health.json().catch(() => ({}));
  if (!health.ok || body.ok !== true || body.writable !== true) return { done: false, reason: `api/health HTTP ${health.status} ${JSON.stringify(body)}` };
  const config = await (await request(`https://${host}/api/config${bust}`)).json().catch(() => ({}));
  const off = publicMismatch(want, config);
  if (off) return { done: false, reason: `old configuration still answering: ${off}` };
  return { done: true, ok: true, users: body.users };
}

function load(env, releasePath) {
  const release = validateRelease(JSON.parse(fs.readFileSync(releasePath, 'utf8')));
  const environments = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/environments.json'), 'utf8'));
  const cfg = environmentConfig(environments, env);
  const template = fs.readFileSync(path.join(ROOT, 'deploy/coolify-compose.yml'), 'utf8');
  return { release, cfg, template };
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

async function main(argv) {
  const [cmd, env, releasePath, ...flags] = argv;
  if (!['render', 'provision', 'deploy'].includes(cmd) || !env || !releasePath) {
    console.error('usage: coolify.mjs render|provision|deploy <env> <release.json> [--bootstrap]');
    process.exit(2);
  }
  const bootstrap = flags.includes('--bootstrap');
  const { release, cfg, template } = load(env, releasePath);
  const compose = renderCompose(template, env, cfg, release, { bootstrap });
  if (cmd === 'render') return void process.stdout.write(compose);

  const api = coolifyClient({ url: process.env.COOLIFY_URL, token: process.env.COOLIFY_TOKEN });
  const urls = [{ name: 'web', url: `http://${cfg.host}:8080` }];

  if (cmd === 'provision') {
    const { COOLIFY_PROJECT_UUID: project_uuid, COOLIFY_SERVER_UUID: server_uuid } = process.env;
    if (!project_uuid || !server_uuid) throw new Error('COOLIFY_PROJECT_UUID and COOLIFY_SERVER_UUID are required');
    const made = await api('POST', 'services', {
      name: `opengym-${env}`, description: `openGym ${env} (BrindleHQ/openGym, docs/BRINDLE_DEPLOY.md)`,
      project_uuid, server_uuid, environment_name: env, instant_deploy: false,
      docker_compose_raw: b64(compose), urls,
    });
    await api('PATCH', `services/${made.uuid}/envs/bulk`, { data: SERVICE_ENV });
    console.log(`created service ${made.uuid}; set COOLIFY_SERVICE_UUID for the ${env} environment to it`);
    return;
  }

  const uuid = process.env.COOLIFY_SERVICE_UUID;
  if (!uuid) throw new Error('COOLIFY_SERVICE_UUID is required');
  const started = new Date().toISOString();
  console.log(`${env}: ${release.sha}\n  api ${release.api}\n  web ${release.web}${bootstrap ? '\n  bootstrap: INVITE_ONLY off for this deploy' : ''}`);
  const before = await api('GET', `services/${uuid}`);
  if (before.name !== `opengym-${env}`) throw new Error(`Service ${uuid} is "${before.name}", not opengym-${env}: refusing to deploy to the wrong environment`);

  await api('PATCH', `services/${uuid}`, { docker_compose_raw: b64(compose), urls });
  await api('PATCH', `services/${uuid}/envs/bulk`, { data: SERVICE_ENV });
  const queued = await api('POST', `deploy?uuid=${encodeURIComponent(uuid)}&force=false`);
  console.log(`  queued: ${JSON.stringify(queued.deployments || queued)}`);

  // A redeploy of the same digests can report healthy before the queued restart begins, so the
  // check that matters is the public one: the new revision answering through Cloudflare.
  let badSince = null;
  const state = await waitFor('containers', async () => {
    const s = serviceState(await api('GET', `services/${uuid}`));
    if (s.bad) {
      badSince ??= Date.now();
      if (Date.now() - badSince > BAD_FOR_MS) return { done: true, ok: false, reason: `${s.reason} for ${BAD_FOR_MS / 1000}s` };
      return s;
    }
    badSince = null;
    if (s.done && s.ok) {
      const images = { api: s.apps.api.image, web: s.apps.web.image };
      if (images.api && images.api !== release.api) return { done: false, reason: `api runs ${images.api}` };
      if (images.web && images.web !== release.web) return { done: false, reason: `web runs ${images.web}` };
    }
    return s;
  }, { timeoutMs: 8 * 60000 });
  const want = expectedPublic(cfg, { bootstrap });
  const live = await waitFor('public endpoint', () => publicChecks(cfg.host, release, want), { timeoutMs: 5 * 60000 });

  const result = {
    environment: env, url: `https://${cfg.host}`, service: uuid, sha: release.sha,
    api: release.api, web: release.web, bootstrap, started, finished: new Date().toISOString(),
    containers: Object.fromEntries(Object.entries(state.apps).map(([n, a]) => [n, a.status])),
    users: live.users,
  };
  fs.writeFileSync('deployment-result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(`${env} is serving ${release.sha} at https://${cfg.host}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
