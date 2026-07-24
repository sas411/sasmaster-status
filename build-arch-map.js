#!/usr/bin/env node
/**
 * build-arch-map.js — MAPGEN-BUILD-003 build step.
 *
 * Renders resources/sasmaster-true-architecture-interactive.template.html into the
 * deployable resources/sasmaster-true-architecture-interactive.html by:
 *   1. Reading the template (no data literal — carries the __ARCH_DATA_INLINE__ marker).
 *   2. Reading resources/architecture-nodes.json (hand-maintained topology: LAYERS/NODES/
 *      EDGES; NODES[].cnt strings may carry {{count:<key>}} / {{asof:<key>}} placeholders).
 *   3. Reading resources/arch-map-data.json (MAPGEN-DATA-001's --emit output: per-key
 *      {value, census_command, derived_at, status}).
 *   4. Resolving every {{count:*}}/{{asof:*}} placeholder found anywhere in the topology's
 *      string fields against arch-map-data.json's counts.
 *   5. FAILING the build (exit 1) rather than shipping a wrong/stale/lying number:
 *        - unresolved placeholder (key not present in arch-map-data.json's counts)
 *        - a referenced key whose status != "ok" (error/skipped — never render null/junk)
 *        - a referenced key whose derived_at is older than MAX_AGE_DAYS (30) — stale
 *          census, same 30-day backstop the card's Risks section names
 *   6. Inlining the merged {LAYERS, NODES, EDGES} as JSON into __ARCH_DATA_INLINE__
 *      (</script> escaped so embedded prose mentioning a closing script tag can't break
 *      the page), prepending a generated-file banner comment, and writing the result
 *      atomically (tmp file + rename) to the sibling .html.
 *   7. Running token_lint.py against the output, in the SAME invocation shape the
 *      existing hooks/token-gate.sh already uses (file arg + tokens.md arg) — propagating
 *      its exit code so a rogue color blocks the build exactly like it blocks a live edit.
 *
 * Zero new npm dependencies — fs/path/child_process only (repo already has node_modules,
 * this script doesn't need any of it).
 *
 * Usage: node build-arch-map.js
 *        npm run build:archmap
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const RESOURCES = path.join(ROOT, 'resources');
const TEMPLATE_PATH = path.join(RESOURCES, 'sasmaster-true-architecture-interactive.template.html');
const NODES_PATH = path.join(RESOURCES, 'architecture-nodes.json');
const DATA_PATH = path.join(RESOURCES, 'arch-map-data.json');
const OUTPUT_PATH = path.join(RESOURCES, 'sasmaster-true-architecture-interactive.html');
const MARKER = '__ARCH_DATA_INLINE__';
const MAX_AGE_DAYS = 30;

const TOKEN_LINT = path.join(process.env.HOME || '/Users/shivashish', 'SaSMaster', 'hooks', 'token_lint.py');
const TOKENS_MD = path.join(process.env.HOME || '/Users/shivashish', 'SaSMaster', 'design-system', 'tokens.md');
const PYTHON3 = fs.existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3';

function fail(msg) {
  console.error('build-arch-map: FAIL — ' + msg);
  process.exit(1);
}

function readJson(p, label) {
  if (!fs.existsSync(p)) fail(`${label} not found: ${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`${label} is not valid JSON (${p}): ${e.message}`);
  }
}

function ageDays(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity; // unparsable = treat as maximally stale
  return (Date.now() - t) / 86400000;
}

// ── Load inputs ─────────────────────────────────────────────────────────
if (!fs.existsSync(TEMPLATE_PATH)) fail(`template not found: ${TEMPLATE_PATH}`);
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
if (!template.includes(MARKER)) fail(`template is missing the ${MARKER} marker`);

const nodesJson = readJson(NODES_PATH, 'architecture-nodes.json');
const archData = readJson(DATA_PATH, 'arch-map-data.json');
const counts = (archData && archData.counts) || {};

if (!Array.isArray(nodesJson.LAYERS) || !Array.isArray(nodesJson.NODES) || !Array.isArray(nodesJson.EDGES)) {
  fail('architecture-nodes.json missing LAYERS/NODES/EDGES arrays');
}

// Deep copy so the source file on disk is never mutated by this process.
const merged = JSON.parse(JSON.stringify({
  LAYERS: nodesJson.LAYERS,
  NODES: nodesJson.NODES,
  EDGES: nodesJson.EDGES,
}));

// ── Placeholder resolution ──────────────────────────────────────────────
const PLACEHOLDER_RE = /\{\{(count|asof):([a-zA-Z0-9_]+)\}\}/g;
const unresolved = [];   // keys referenced but missing from counts
const badStatus = [];    // keys referenced whose status != 'ok'
const stale = [];        // keys referenced whose derived_at is older than MAX_AGE_DAYS

function fmtValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toLocaleString('en-US');
  return String(v);
}

function fmtAsof(iso) {
  // date part only, e.g. "2026-07-23" from "2026-07-23T16:48:54Z"
  if (typeof iso !== 'string') return String(iso);
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : iso;
}

function resolveString(s) {
  if (typeof s !== 'string' || s.indexOf('{{') === -1) return s;
  return s.replace(PLACEHOLDER_RE, (whole, kind, key) => {
    const entry = counts[key];
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value')) {
      unresolved.push(key);
      return whole; // leave unresolved marker in place so it's grep-able for debugging
    }
    if (entry.status !== 'ok') {
      badStatus.push({ key, status: entry.status });
    } else if (ageDays(entry.derived_at) > MAX_AGE_DAYS) {
      stale.push({ key, derived_at: entry.derived_at, age_days: Math.round(ageDays(entry.derived_at)) });
    }
    if (kind === 'count') return fmtValue(entry.value);
    return fmtAsof(entry.derived_at);
  });
}

function walkAndResolve(node) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === 'string') node[i] = resolveString(node[i]);
      else walkAndResolve(node[i]);
    }
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (typeof node[k] === 'string') node[k] = resolveString(node[k]);
      else walkAndResolve(node[k]);
    }
  }
}

walkAndResolve(merged);

if (unresolved.length) {
  fail(`unresolved placeholder key(s) not present in arch-map-data.json counts: ${[...new Set(unresolved)].join(', ')}`);
}
if (badStatus.length) {
  const detail = badStatus.map(b => `${b.key} (status=${b.status})`).join(', ');
  fail(`referenced key(s) not status:'ok' — never rendering a null/error/skipped value as if live: ${detail}`);
}
if (stale.length) {
  const detail = stale.map(s => `${s.key} (${s.age_days}d old, derived_at=${s.derived_at})`).join(', ');
  fail(`referenced key(s) older than ${MAX_AGE_DAYS}d — re-run arch_map_census.sh before publishing: ${detail}`);
}

// ── Inline + write ───────────────────────────────────────────────────────
let inlineJson = JSON.stringify(merged);
inlineJson = inlineJson.split('</script>').join('<\\/script>');

const banner =
  '<!-- GENERATED by build-arch-map.js from architecture-nodes.json + arch-map-data.json ' +
  '-- DO NOT HAND-EDIT; edit the sources and run `npm run build:archmap`. ' +
  'Built ' + new Date().toISOString() + ' -->\n';

let output = template.split(MARKER).join(inlineJson);
output = banner + output;

const tmpPath = OUTPUT_PATH + '.tmp' + process.pid;
fs.writeFileSync(tmpPath, output, 'utf8');
fs.renameSync(tmpPath, OUTPUT_PATH);
console.log(`build-arch-map: wrote ${OUTPUT_PATH} (${merged.NODES.length} nodes, ${merged.EDGES.length} edges, ${merged.LAYERS.length} layers)`);

// ── token_lint ───────────────────────────────────────────────────────────
if (!fs.existsSync(TOKEN_LINT)) fail(`token_lint.py not found: ${TOKEN_LINT}`);
if (!fs.existsSync(TOKENS_MD)) fail(`tokens.md not found: ${TOKENS_MD}`);

const lint = spawnSync(PYTHON3, [TOKEN_LINT, OUTPUT_PATH, TOKENS_MD], { stdio: 'inherit' });
if (lint.error) fail(`could not run token_lint.py: ${lint.error.message}`);
if (lint.status !== 0) {
  fail(`token_lint.py failed (exit ${lint.status}) — fix rogue colors, or add legit new colors to design-system/tokens.md FIRST (BLESS), then rebuild.`);
}

console.log('build-arch-map: token_lint PASS. Build OK — NOT pushed. Review, then Shiv: ! git push (sasmaster-status).');
