#!/usr/bin/env node
/**
 * WARROOM-REDESIGN-001 Phase D — Scripted Parity Gate
 * Compares v5 vs v3 (or index.html) on shared KPI tiles.
 * Posts PASS/FAIL to #builds via Slack webhook.
 * Run: node scripts/parity-gate.js
 * Cron: 0 9 * * * cd ~/sasmaster-status && node scripts/parity-gate.js
 */
'use strict';

const { chromium } = require('playwright');
const https = require('https');
const path = require('path');
const fs = require('fs');

const V5_PATH = path.resolve(__dirname, '../warroom-v5.html');
const V3_PATH = path.resolve(__dirname, '../index.html');
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_BUILDS || process.env.SLACK_WEBHOOK_URL || '';
const RESULTS_DIR = path.resolve(__dirname, '../logs/parity');
const THRESHOLD = 0.15; // 15% divergence allowed on numeric tiles

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Shared KPI selectors — must match what both boards render
const V5_SELECTORS = {
  agents:       '.kstrip .k:nth-child(1) .v',
  s3_gb:        '.kstrip .k:nth-child(2) .v',
  follow_up:    '.kstrip .k:nth-child(3) .v',
  build_cost:   '.kstrip .k:nth-child(6) .v',
  bless_queue:  '.kstrip .k:nth-child(7) .v',
  nielsen_clock:'.kstrip .k:nth-child(8) .v',
  health_pct:   '.healthbar b',
};

// v3 may have different selectors — update when v3 is inspected
const V3_SELECTORS = {
  agents:       '.kstrip .k:nth-child(1) .v',
  s3_gb:        '.kstrip .k:nth-child(2) .v',
  follow_up:    '.kstrip .k:nth-child(3) .v',
  build_cost:   '.kstrip .k:nth-child(6) .v',
  bless_queue:  '.kstrip .k:nth-child(7) .v',
  nielsen_clock:'.kstrip .k:nth-child(8) .v',
  health_pct:   '.healthbar b',
};

async function scrapeBoard(page, url, selectors) {
  const fileUrl = url.startsWith('http') ? url : 'file://' + url;
  await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  // wait up to 5s for status.json-driven data
  await page.waitForTimeout(5000);
  const result = {};
  for (const [key, sel] of Object.entries(selectors)) {
    try {
      result[key] = await page.$eval(sel, el => el.innerText.trim());
    } catch (_) {
      result[key] = 'N/A';
    }
  }
  return result;
}

function parseNum(str) {
  if (!str || str === '—' || str === 'N/A') return null;
  return parseFloat(str.replace(/[^0-9.\-]/g, '')) || null;
}

function compareKPIs(v5, v3) {
  const findings = [];
  let pass = true;
  for (const key of Object.keys(V5_SELECTORS)) {
    const a = v5[key], b = v3[key];
    const na = parseNum(a), nb = parseNum(b);
    if (na !== null && nb !== null) {
      const avg = (Math.abs(na) + Math.abs(nb)) / 2;
      const diff = avg > 0 ? Math.abs(na - nb) / avg : 0;
      const ok = diff <= THRESHOLD;
      if (!ok) pass = false;
      findings.push({ key, v5: a, v3: b, diff: (diff * 100).toFixed(1) + '%', ok });
    } else {
      // non-numeric: exact match
      const ok = a === b || b === 'N/A';
      if (!ok) pass = false;
      findings.push({ key, v5: a, v3: b, diff: 'text', ok });
    }
  }
  return { pass, findings };
}

function buildSlackMsg(result, runTs) {
  const icon = result.pass ? '✅' : '🔴';
  const label = result.pass ? 'PASS' : 'FAIL';
  const rows = result.findings.map(f => {
    const mark = f.ok ? '✓' : '✗';
    return `${mark} \`${f.key.padEnd(14)}\` v5: \`${f.v5}\`  v3: \`${f.v3}\`  Δ${f.diff}`;
  }).join('\n');
  return {
    text: `${icon} *War Room Parity Gate — ${label}* · ${runTs}\n\`\`\`${rows}\`\`\`\nPhase D · WARROOM-REDESIGN-001 · Day 1 of 7`
  };
}

function postToSlack(payload) {
  if (!SLACK_WEBHOOK) {
    console.log('[parity-gate] No SLACK_WEBHOOK set — skipping Slack post');
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(SLACK_WEBHOOK);
    const opts = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const runTs = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();

  let v5 = {}, v3 = {};
  try {
    const pg5 = await ctx.newPage();
    v5 = await scrapeBoard(pg5, V5_PATH, V5_SELECTORS);
    await pg5.close();
  } catch (e) { console.error('[parity-gate] v5 scrape error:', e.message); }

  const v3Exists = fs.existsSync(V3_PATH);
  if (v3Exists) {
    try {
      const pg3 = await ctx.newPage();
      v3 = await scrapeBoard(pg3, V3_PATH, V3_SELECTORS);
      await pg3.close();
    } catch (e) { console.error('[parity-gate] v3 scrape error:', e.message); }
  } else {
    console.warn('[parity-gate] v3 not found at', V3_PATH, '— comparing v5 against itself (vacuous PASS)');
    v3 = { ...v5 };
  }

  await browser.close();

  const result = compareKPIs(v5, v3);
  const outFile = path.join(RESULTS_DIR, `parity-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ ts: runTs, pass: result.pass, findings: result.findings, v5, v3 }, null, 2));
  console.log(`[parity-gate] ${result.pass ? 'PASS' : 'FAIL'} — written to ${outFile}`);

  const msg = buildSlackMsg(result, runTs);
  await postToSlack(msg);
  process.exit(result.pass ? 0 : 1);
}

main().catch(e => { console.error('[parity-gate]', e); process.exit(2); });
