#!/usr/bin/env node
/**
 * generate-org-health.js — writes org-health.json for sasmaster-status
 * First-pass org health scaffold: per-repo open PR count, default branch,
 * days since last commit. Branch-protection state is reported as
 * "not_yet_checked" — a sibling agent is handling branch-protection changes
 * concurrently, so this script does not assert protection state.
 *
 * Auth: uses the `gh` CLI (pre-installed on GitHub-hosted runners), which
 * reads GH_TOKEN / GITHUB_TOKEN from the environment automatically — same
 * curl-via-execSync convention generate-status.js already uses for external
 * calls (see jarvisAlive()).
 *
 * frankenstein is intentionally excluded from ORG and must never be added.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORG = 'sas411';
const OUT = path.join(__dirname, '..', 'org-health.json');

// Explicit allowlist. frankenstein must NEVER appear here.
const REPOS = [
  'sasmaster',
  'sasmaster-platform',
  'sasmaster-skills',
  'sasmaster-obsidian',
  'sasmaster-portal',
  'perplexity-mcp',
  'Data-Science-Class',
];

function ghApi(endpoint) {
  const out = execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });
  return JSON.parse(out);
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function repoHealth(name) {
  const base = {
    name,
    full_name: `${ORG}/${name}`,
    default_branch: null,
    open_pr_count: null,
    days_since_last_commit: null,
    last_commit_at: null,
    branch_protection: 'not_yet_checked',
    checked_at: new Date().toISOString(),
    error: null,
  };

  try {
    const repo = ghApi(`repos/${ORG}/${name}`);
    base.default_branch = repo.default_branch || null;
    base.last_commit_at = repo.pushed_at || null;
    base.days_since_last_commit = daysSince(repo.pushed_at);
  } catch (e) {
    base.error = `repo lookup failed: ${String(e.message || e).slice(0, 200)}`;
    return base;
  }

  try {
    const prs = ghApi(`repos/${ORG}/${name}/pulls?state=open&per_page=100`);
    base.open_pr_count = Array.isArray(prs) ? prs.length : null;
  } catch (e) {
    base.error = `pulls lookup failed: ${String(e.message || e).slice(0, 200)}`;
  }

  return base;
}

function main() {
  const repos = REPOS.filter((r) => r.toLowerCase() !== 'frankenstein').map(repoHealth);

  const orgHealth = {
    generated: new Date().toISOString(),
    generated_at: new Date().toISOString(),
    org_health: {
      note: 'First-pass scaffold. branch_protection is not_yet_checked pending a separate branch-protection rollout.',
      repos,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(orgHealth, null, 2));
  console.log(`org-health.json written: ${repos.length} repos`);
}

main();
