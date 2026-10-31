#!/usr/bin/env node
// Turns a release record into what an environment runs, and checks it from the outside.
// docs/BRINDLE_DEPLOY.md explains where this sits.
//
//   node scripts/deploy/coolify.mjs plan      <env> <release.json> [--bootstrap]  the deploy plan for opengym-release
//   node scripts/deploy/coolify.mjs verify    <env> <release.json>                wait until <env>'s address serves it
//   node scripts/deploy/coolify.mjs render    <env> <release.json>                the compose the plan carries
//   node scripts/deploy/coolify.mjs describe  <env>                               exposure= and url= lines (workflows)
//   node scripts/deploy/coolify.mjs provision <env> <release.json>                create the Coolify service (once)
//
// The deploy itself runs on Boop Beep (deploy/opengym-release.sh), which takes the plan on stdin.
// --bootstrap turns INVITE_ONLY off for that one release, so the owner's profile can be created
// on a fresh instance (invite codes come from an admin, and there is none yet).
// provision needs COOLIFY_URL, COOLIFY_TOKEN, COOLIFY_PROJECT_UUID and COOLIFY_SERVER_UUID.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = { api: 'ghcr.io/brindlehq/opengym-api', web: 'ghcr.io/brindlehq/opengym-web' };

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

const isPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;
const isHost = h => typeof h === 'string' && /^[a-z0-9.-]+$/.test(h);

export function environmentConfig(environments, env) {
  const cfg = environments[env];
  if (!cfg) throw new Error(`Unknown environment "${env}" (deploy/environments.json has ${Object.keys(environments).join(', ')})`);
  if (!['tailnet', 'public'].includes(cfg.exposure)) throw new Error(`${env}: exposure must be "tailnet" or "public"`);
  if (!isHost(cfg.tailnet?.host) || !isPort(cfg.tailnet?.port)) throw new Error(`${env}: tailnet needs a bare host and a port`);
  if (!isHost(cfg.public?.host)) throw new Error(`${env}: public needs a bare host`);
  if (!isPort(cfg.localPort)) throw new Error(`${env}: localPort must be a port number`);
  if (!Number.isInteger(cfg.backupRetentionDays) || cfg.backupRetentionDays < 1) throw new Error(`${env}: backupRetentionDays must be a positive integer`);
  if (!/^\S+ \S+ \S+ \S+ \S+$/.test(cfg.backupCron)) throw new Error(`${env}: backupCron must be a five-field cron expression`);
  return cfg;
}

// Where an environment answers, from its `exposure`:
//   tailnet  https://<tailnet.host>:<tailnet.port>, via `tailscale serve` on Boop Beep only
//   public   https://<public.host>, via the Cloudflare tunnel and a Coolify (Traefik) domain
// The tailnet address keeps working in public mode too (the loopback port and tailscale serve
// stay), but passkeys and sign-in belong to the one address in `url`. Switching an environment
// that already has accounts locks their passkeys out (docs/BRINDLE_DEPLOY.md).
export function address(cfg) {
  if (cfg.exposure === 'public') {
    return {
      exposure: 'public', host: cfg.public.host, url: `https://${cfg.public.host}`,
      coolifyDomain: `http://${cfg.public.host}:8080`,
      // Cloudflare sets this header itself, so the sign-in throttle can tell visitors apart.
      cfConnectingIp: '$http_cf_connecting_ip',
    };
  }
  return {
    exposure: 'tailnet', host: cfg.tailnet.host, url: `https://${cfg.tailnet.host}:${cfg.tailnet.port}`,
    coolifyDomain: '', cfConnectingIp: '',
  };
}

// Coolify variables the compose file reads as ${NAME}. Literal: Coolify writes them to the
// service's .env single-quoted, so compose passes a `$` through to nginx untouched (Coolify reads
// any compose value starting with `$` as a variable of its own, so it cannot go in the file).
export const serviceEnv = where => [{ key: 'CF_CONNECTING_IP', value: where.cfConnectingIp, is_literal: true }];

export function renderCompose(template, env, cfg, release, { bootstrap = false } = {}) {
  const flag = v => (v ? '1' : '0');
  const where = address(cfg);
  const values = {
    API_IMAGE: release.api,
    WEB_IMAGE: release.web,
    ENV: env,
    HOST: where.host,
    ORIGIN: where.url,
    LOCAL_PORT: String(cfg.localPort),
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
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

// What the new release must show at its address: the revision proves the images (both are
// rebuilt for every commit), the two flags the configuration.
export function expectedPublic(cfg, { bootstrap = false } = {}) {
  return { invite_only: !!cfg.inviteOnly && !bootstrap, allow_guest: !!cfg.allowGuest };
}

export function publicMismatch(want, config) {
  const off = Object.keys(want).filter(k => config?.[k] !== want[k]);
  return off.length ? off.map(k => `${k} is ${config?.[k]}, want ${want[k]}`).join(', ') : null;
}

async function publicChecks(base, release, want, request = fetch) {
  const bust = `?t=${Date.now()}`;
  const rel = await request(`${base}/release.json${bust}`, { headers: { 'Cache-Control': 'no-cache' } });
  if (!rel.ok) return { done: false, reason: `release.json HTTP ${rel.status}` };
  const served = await rel.json().catch(() => ({}));
  if (served.revision !== release.sha) return { done: false, reason: `serving ${served.revision || 'unknown'}, want ${release.sha}` };
  const health = await request(`${base}/api/health${bust}`);
  const body = await health.json().catch(() => ({}));
  if (!health.ok || body.ok !== true || body.writable !== true) return { done: false, reason: `api/health HTTP ${health.status} ${JSON.stringify(body)}` };
  const config = await (await request(`${base}/api/config${bust}`)).json().catch(() => ({}));
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

// Everything opengym-release needs for one deploy; it checks the same fields before acting.
export function buildPlan(template, env, cfg, release, { bootstrap = false } = {}) {
  const where = address(cfg);
  return {
    env,
    release: { sha: release.sha, api: release.api, web: release.web, ...(release.run_id ? { run_id: String(release.run_id) } : {}) },
    docker_compose_raw: b64(renderCompose(template, env, cfg, release, { bootstrap })),
    urls: [{ name: 'web', url: where.coolifyDomain }],
    service_env: serviceEnv(where),
    local_port: cfg.localPort,
    expect: expectedPublic(cfg, { bootstrap }),
  };
}

async function main(argv) {
  const [cmd, env, releasePath, ...flags] = argv;
  if (cmd === 'describe' && env) {
    // For workflows: where this environment answers, as GITHUB_OUTPUT lines.
    const environments = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/environments.json'), 'utf8'));
    const where = address(environmentConfig(environments, env));
    return void process.stdout.write(`exposure=${where.exposure}\nurl=${where.url}\n`);
  }
  if (!['plan', 'verify', 'render', 'provision'].includes(cmd) || !env || !releasePath) {
    console.error('usage: coolify.mjs plan|verify|render|provision <env> <release.json> [--bootstrap]\n       coolify.mjs describe <env>');
    process.exit(2);
  }
  const bootstrap = flags.includes('--bootstrap');
  const { release, cfg, template } = load(env, releasePath);
  if (cmd === 'render') return void process.stdout.write(renderCompose(template, env, cfg, release, { bootstrap }));
  if (cmd === 'plan') return void process.stdout.write(JSON.stringify(buildPlan(template, env, cfg, release, { bootstrap })) + '\n');

  const where = address(cfg);
  if (cmd === 'verify') {
    // The host already checked its loopback port; this is the same check through the address
    // people use (tailnet or Cloudflare), from outside Boop Beep.
    const live = await waitFor(where.url, () => publicChecks(where.url, release, expectedPublic(cfg, { bootstrap })), { timeoutMs: 2 * 60000, everyMs: 2000 });
    console.log(`${env} is serving ${release.sha} at ${where.url} (${live.users} profiles)`);
    return;
  }

  const plan = buildPlan(template, env, cfg, release, { bootstrap });
  const api = coolifyClient({ url: process.env.COOLIFY_URL, token: process.env.COOLIFY_TOKEN });
  const { COOLIFY_PROJECT_UUID: project_uuid, COOLIFY_SERVER_UUID: server_uuid } = process.env;
  if (!project_uuid || !server_uuid) throw new Error('COOLIFY_PROJECT_UUID and COOLIFY_SERVER_UUID are required');
  const made = await api('POST', 'services', {
    name: `opengym-${env}`, description: `openGym ${env} (BrindleHQ/openGym, docs/BRINDLE_DEPLOY.md)`,
    project_uuid, server_uuid, environment_name: env, instant_deploy: false,
    docker_compose_raw: plan.docker_compose_raw, urls: plan.urls,
  });
  await api('PATCH', `services/${made.uuid}/envs/bulk`, { data: plan.service_env });
  console.log(`created service ${made.uuid}; write it to /srv/opengym/${env}/service-uuid on Boop Beep`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
