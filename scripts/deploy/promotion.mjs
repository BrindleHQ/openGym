#!/usr/bin/env node
// Decides whether a Tests run may be promoted to production (promote.yml). Only a run that
// pushed to main in this repository, went green, and deployed to staging qualifies; its
// release.json has to describe that same commit. Anything else is refused with the reason.
//
//   node scripts/deploy/promotion.mjs <run_id> <release.json>     (needs GH_TOKEN, GITHUB_REPOSITORY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './coolify.mjs';

export function promotionProblems({ run, jobs, release, repo }) {
  const problems = [];
  if (run.path !== '.github/workflows/test.yml') problems.push(`run ${run.id} is "${run.path}", not the Tests workflow`);
  if (run.event !== 'push') problems.push(`run ${run.id} was triggered by ${run.event}, not a push`);
  if (run.head_branch !== 'main') problems.push(`run ${run.id} is on ${run.head_branch}, not main`);
  if (run.head_repository?.full_name !== repo) problems.push(`run ${run.id} built ${run.head_repository?.full_name}, not ${repo}`);
  if (run.status !== 'completed' || run.conclusion !== 'success') problems.push(`run ${run.id} is ${run.status}/${run.conclusion}, not completed/success`);
  // deploy-staging calls deploy.yml, so its job is listed as "deploy-staging / deploy".
  const staged = jobs.find(j => j.name === 'deploy-staging' || j.name.startsWith('deploy-staging / '));
  if (!staged || staged.conclusion !== 'success') problems.push(`run ${run.id} has no successful deploy-staging job`);
  if (release && release.sha !== run.head_sha) problems.push(`release.json is for ${release.sha}, the run built ${run.head_sha}`);
  return problems;
}

async function gh(route) {
  const res = await fetch(`https://api.github.com/${route}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub ${route}: HTTP ${res.status}`);
  return res.json();
}

async function main([runId, releasePath]) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^\d+$/.test(runId || '') || !releasePath || !repo) throw new Error('usage: promotion.mjs <run_id> <release.json>, with GITHUB_REPOSITORY set');
  const run = await gh(`repos/${repo}/actions/runs/${runId}`);
  const { jobs } = await gh(`repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  const release = validateRelease(JSON.parse(fs.readFileSync(releasePath, 'utf8')));
  const problems = promotionProblems({ run, jobs, release, repo });
  if (problems.length) throw new Error(`Run ${runId} cannot be promoted: ${problems.join('; ')}`);
  console.log(`Run ${runId} qualifies: ${release.sha}\n  api ${release.api}\n  web ${release.web}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${release.sha}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
