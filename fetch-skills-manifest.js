#!/usr/bin/env node
/**
 * fetch-skills-manifest.js — SKILL-REGISTRY-002 Phase 1
 * Fetches skills-manifest.json from private sas411/sasmaster-skills repo
 * and writes it to resources/skills-manifest.json for public Vercel hosting.
 *
 * Runs as Vercel build step (SKILLS_REPO_PAT from Vercel env)
 * and optionally as part of the local generate-status cron.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PAT  = process.env.SKILLS_REPO_PAT;
const OUT  = path.join(__dirname, 'resources', 'skills-manifest.json');
const API  = 'api.github.com';
const FILE = '/repos/sas411/sasmaster-skills/contents/skills-manifest.json';

if (!PAT) {
  console.error('[fetch-skills-manifest] SKILLS_REPO_PAT not set — cannot fetch private repo');
  process.exit(1);
}

function ghGet(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: API,
      path: apiPath,
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sasmaster-war-room/1.0',
      },
    };
    https.get(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          resolve(JSON.parse(body));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('[fetch-skills-manifest] fetching skills-manifest.json from GitHub...');
  const meta = await ghGet(FILE);

  if (meta.encoding !== 'base64') {
    throw new Error(`Unexpected encoding: ${meta.encoding}`);
  }

  const content = Buffer.from(meta.content, 'base64').toString('utf8');
  const parsed  = JSON.parse(content);  // validate JSON before writing

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(parsed, null, 2));

  const count = parsed.skill_count ?? parsed.skills?.length ?? '?';
  const publicUrl = 'https://sasmaster-public.s3.amazonaws.com/skills-manifest.json';
  console.log(`[fetch-skills-manifest] wrote ${OUT} — ${count} skills, sha ${meta.sha?.slice(0, 8)}`);
  console.log(`[fetch-skills-manifest] canonical public URL: ${publicUrl}`);
}

main().catch(e => {
  console.error('[fetch-skills-manifest] FATAL:', e.message);
  process.exit(1);
});
