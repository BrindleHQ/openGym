import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease, environmentConfig, renderCompose, expectedPublic, publicMismatch, address, serviceEnv, buildPlan } from './coolify.mjs';
import { promotionProblems } from './promotion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const template = fs.readFileSync(path.join(ROOT, 'deploy/coolify-compose.yml'), 'utf8');
const environments = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/environments.json'), 'utf8'));
const digest = c => c.repeat(64);
const release = {
  sha: 'a'.repeat(40),
  api: `ghcr.io/brindlehq/opengym-api@sha256:${digest('1')}`,
  web: `ghcr.io/brindlehq/opengym-web@sha256:${digest('2')}`,
};

test('a release record names both images by digest and the full commit', () => {
  assert.equal(validateRelease(release), release);
  assert.throws(() => validateRelease({ ...release, sha: 'abc1234' }), /full commit sha/);
  assert.throws(() => validateRelease({ ...release, api: 'ghcr.io/brindlehq/opengym-api:latest' }), /api is not/);
  // Another owner's image is refused even with a digest.
  assert.throws(() => validateRelease({ ...release, web: `ghcr.io/duartesantos8/opengym-web@sha256:${digest('2')}` }), /web is not/);
});

test('environment config is checked before anything is rendered', () => {
  assert.throws(() => environmentConfig(environments, 'prod'), /Unknown environment/);
  assert.throws(() => environmentConfig({ x: { ...environments.staging, exposure: 'lan' } }, 'x'), /exposure must be/);
  assert.throws(() => environmentConfig({ x: { ...environments.staging, public: { host: 'https://x.example' } } }, 'x'), /public needs a bare host/);
  assert.throws(() => environmentConfig({ x: { ...environments.staging, backupRetentionDays: 0 } }, 'x'), /positive integer/);
  assert.throws(() => environmentConfig({ x: { ...environments.staging, tailnet: { host: 'h', port: '9443' } } }, 'x'), /tailnet needs/);
});

const esc = s => s.replace(/[.]/g, '\\.');
for (const env of ['staging', 'production']) {
  for (const exposure of ['tailnet', 'public']) {
    test(`${env} (${exposure}) renders with every placeholder filled and only its own paths`, () => {
      const cfg = { ...environmentConfig(environments, env), exposure };
      const where = address(cfg);
      const out = renderCompose(template, env, cfg, release);
      assert.doesNotMatch(out, /__[A-Z_]+__/);
      assert.match(out, new RegExp(`image: ${esc(release.api)}\n`));
      assert.match(out, new RegExp(`image: ${esc(release.web)}\n`));
      assert.match(out, new RegExp(`RP_ID=${esc(where.host)}\n`));
      assert.match(out, new RegExp(`ORIGIN=${esc(where.url)}\n`));
      // Always on loopback: tailscale serve keeps the tailnet way in, whatever the exposure.
      assert.match(out, new RegExp(`- "127\\.0\\.0\\.1:${cfg.localPort}:8080"`));
      const other = env === 'staging' ? 'production' : 'staging';
      assert.doesNotMatch(out, new RegExp(`/srv/opengym/${other}/`), 'one environment never mounts the other\'s data');
      assert.match(out, /INVITE_ONLY=1\n/);
      assert.match(out, /COACH_DISABLED=1\n/);
      assert.match(out, new RegExp(`SESSION_COOKIE=gymsid-${env}\n`), 'its own session cookie on the shared tailnet hostname');
    });
  }
}

test('exposure decides the address, the Coolify domain and the Cloudflare header', () => {
  const cfg = environments.production;
  const tailnet = address({ ...cfg, exposure: 'tailnet' });
  assert.equal(tailnet.url, `https://${cfg.tailnet.host}:${cfg.tailnet.port}`);
  // No Coolify domain: nothing routes it from the internet. No header to trust either.
  assert.equal(tailnet.coolifyDomain, '');
  assert.deepEqual(serviceEnv(tailnet), [{ key: 'CF_CONNECTING_IP', value: '', is_literal: true }]);
  const pub = address({ ...cfg, exposure: 'public' });
  assert.equal(pub.url, `https://${cfg.public.host}`);
  assert.equal(pub.coolifyDomain, `http://${cfg.public.host}:8080`);
  assert.equal(serviceEnv(pub)[0].value, '$http_cf_connecting_ip');
});

test('the two environments share neither an address nor a local port', () => {
  for (const exposure of ['tailnet', 'public']) {
    assert.notEqual(address({ ...environments.staging, exposure }).url, address({ ...environments.production, exposure }).url);
  }
  assert.notEqual(environments.staging.localPort, environments.production.localPort);
});

test('--bootstrap turns INVITE_ONLY off for that deploy only', () => {
  const out = renderCompose(template, 'staging', environments.staging, release, { bootstrap: true });
  assert.match(out, /INVITE_ONLY=0\n/);
});

test('an unknown placeholder fails the render instead of shipping literally', () => {
  assert.throws(() => renderCompose('image: __NOPE__', 'staging', environments.staging, release), /Unknown placeholder __NOPE__/);
});

test('a plan carries exactly what opengym-release checks and runs', () => {
  const cfg = environments.production;
  const plan = buildPlan(template, 'production', cfg, { ...release, run_id: 42 });
  // The same fields deploy/opengym-release.sh validates before it touches anything.
  assert.equal(plan.env, 'production');
  assert.deepEqual(plan.release, { sha: release.sha, api: release.api, web: release.web, run_id: '42' });
  assert.equal(typeof plan.docker_compose_raw, 'string');
  assert.equal(Buffer.from(plan.docker_compose_raw, 'base64').toString(), renderCompose(template, 'production', cfg, release));
  assert.equal(plan.local_port, cfg.localPort);
  assert.deepEqual(plan.expect, { invite_only: true, allow_guest: false });
  assert.deepEqual(plan.urls, [{ name: 'web', url: address(cfg).coolifyDomain }]);
  assert.deepEqual(plan.service_env, serviceEnv(address(cfg)));
  // Bootstrap opens signup in the compose and in what the host waits to see.
  const boot = buildPlan(template, 'production', cfg, release, { bootstrap: true });
  assert.deepEqual(boot.expect, { invite_only: false, allow_guest: false });
  assert.match(Buffer.from(boot.docker_compose_raw, 'base64').toString(), /INVITE_ONLY=0\n/);
});

test('a deploy waits for the configuration it rendered, not only the revision', () => {
  const want = expectedPublic(environments.staging);
  assert.deepEqual(want, { invite_only: true, allow_guest: false });
  assert.equal(publicMismatch(want, { invite_only: true, allow_guest: false, media: {} }), null);
  // The bootstrap deploy is done only once the API has really restarted with signup open.
  const boot = expectedPublic(environments.staging, { bootstrap: true });
  assert.match(publicMismatch(boot, { invite_only: true, allow_guest: false }), /invite_only is true, want false/);
  assert.match(publicMismatch(want, {}), /invite_only is undefined/);
});

const goodRun = {
  id: 7, path: '.github/workflows/test.yml', event: 'push', head_branch: 'main', head_sha: release.sha,
  head_repository: { full_name: 'BrindleHQ/openGym' }, status: 'completed', conclusion: 'success',
};
const stagedJobs = [{ name: 'publish', conclusion: 'success' }, { name: 'deploy-staging / deploy', conclusion: 'success' }];
const check = (run, jobs = stagedJobs, rel = release) => promotionProblems({ run, jobs, release: rel, repo: 'BrindleHQ/openGym' });

test('promotion: a green main push that reached staging qualifies', () => {
  assert.deepEqual(check(goodRun), []);
});

test('promotion: anything else is refused, with the reason', () => {
  assert.match(check({ ...goodRun, event: 'pull_request' }).join(), /not a push/);
  assert.match(check({ ...goodRun, head_branch: 'ci-x' }).join(), /not main/);
  // A fork's branch called "main" is still not ours.
  assert.match(check({ ...goodRun, head_repository: { full_name: 'someone/openGym' } }).join(), /not BrindleHQ\/openGym/);
  assert.match(check({ ...goodRun, conclusion: 'failure' }).join(), /not completed\/success/);
  assert.match(check({ ...goodRun, path: '.github/workflows/audit.yml' }).join(), /not the Tests workflow/);
  assert.match(check(goodRun, [{ name: 'deploy-staging / deploy', conclusion: 'skipped' }]).join(), /no successful deploy-staging/);
  assert.match(check(goodRun, [{ name: 'deploy-production / deploy', conclusion: 'success' }]).join(), /no successful deploy-staging/);
  assert.match(check(goodRun, stagedJobs, { ...release, sha: 'b'.repeat(40) }).join(), /release\.json is for/);
});
