#!/usr/bin/env node
'use strict';
/**
 * scripts/warroom-contract-gate.js — WARROOM-CONTRACT-CI-001
 *
 * Mechanical regression gate for the War Room render contracts (C1-C6, C8) already
 * shipped by WARROOM-CLOCK-001, WARROOM-RENDER-001, WARROOM-HEALTH-001,
 * WARROOM-TREND-001, WARROOM-RUNSTATE-001. One module, imported by BOTH the
 * pre-commit hook (.pre-commit-config.yaml) and CI (.github/workflows/ci-tests.yml) —
 * per the card's 🔴 "two implementations drift, the drift will always favor green."
 *
 * ---- GATE-SCOPE (Phase 1 of this card: locate and record the truth) ----
 *   Repo root:        ~/sasmaster-status  (git remote -> github.com/sas411/sasmaster-status)
 *   Page:              warroom-v5.html            (4,492 lines, inline <script>, no bundler)
 *   Generator:         generate-status.js          (2,522 lines, CommonJS, node)
 *   Module system:     CommonJS (dual-environment lib/warroom-*.js: module.exports +
 *                       window.Warroom* global, same pattern as lib/warroom-clock.js)
 *   Test runner:       node:test (`node --test test/`), no jest/vitest/mocha
 *   Pre-commit:        .pre-commit-config.yaml exists (framework: pre-commit), historically
 *                       NOT installed as live git hooks (WARROOM-CLOCK-001's own finding,
 *                       2026-08-24 sweep: zero non-sample files under .git/hooks/) — this
 *                       card adds its hook definition to the same file regardless, per that
 *                       card's own precedent (definition ships, install is Shiv's call).
 *   CI provider:       GitHub Actions. .github/workflows/ci-tests.yml already runs
 *                       `npm test` on push/PR to main (WARROOM-TREND-001). This card adds a
 *                       SECOND JOB to that same workflow file (not a new workflow) so both
 *                       jobs share one trigger and one checkout — see that file for why.
 *   No .claude/ directory exists in sasmaster-status (confirmed by listing). The
 *   HOOKS-INVENTORY.md / .claude/rules/*.md path-scoped-rule machinery described in the
 *   card lives in ~/SaSMaster, a separate repo this card's ground rules say NOT to touch
 *   ("work only inside sasmaster-status unless told otherwise"). NOT wired — recorded as a
 *   gap in DONE_LOG.md, not silently skipped.
 *
 * ---- Design decisions that reconcile "real teeth" with "must not drown in legacy noise" ----
 *   1. DIFF-SCOPED by default (mode 'diff'): only lines added since the merge-base are
 *      judged, matching this codebase's existing G1 doctrine (feedback_g1_gate_whole_file_
 *      false_positives — judge added lines only). warroom-v5.html is 4,492 lines and
 *      generate-status.js is 2,522; a handful of checks (bare `new Date()`, raw trend-glyph
 *      literals) have real, legitimate historical hits that a whole-file gate would relitigate
 *      on every unrelated commit and get disabled within a week (card's own WHY paragraph).
 *   2. A 'full' mode scans the whole tracked render-file set regardless of diff — used for
 *      the Phase 6 VERIFY baseline and for manual audits (`--full`). It is allowed to be
 *      non-zero; that is not a gate bug, it is the honest current state of the code (recorded
 *      per-check in DONE_LOG.md, never padded to look clean — feedback_verify_enumerated_
 *      counts / feedback_reporting_style).
 *   3. A 'files' mode (`--files <paths>`) scans an explicit file list in full (no diff, no
 *      git needed) — used to run the gate against a scratch fixture that lives outside the
 *      repo entirely, so seeded violations never touch production render files.
 *
 * ---- BLOCKED checks (real, not fabricated) ----
 *   check_tile_registered, check_cadence_declared, and the tile-inventory-sourced half of
 *   C6 all require WARROOM_TILE_INVENTORY.md (WARROOM-INVENTORY-001's deliverable), which
 *   does NOT exist in this repo as of this build (confirmed: no file of that name anywhere
 *   under ~/sasmaster-status, no commit ever produced it). Per this card's own constraint
 *   ("This card must not import, stub, or wait on any Phase 1 module") and the sibling
 *   inventory card's own rule ("a stub inventory is the worst possible output, never a
 *   falsely-authoritative LIVE"), this gate does NOT fabricate that file. Those two checks
 *   report status BLOCKED (not PASS, not FAIL) with the missing path named, and BLOCKED
 *   never contributes to the process exit code — see runGate()'s tally. check_one_source_per_
 *   number instead reads a small gate-owned seed registry, WARROOM_METRIC_CANON.json,
 *   documented there as a stand-in, not the long-term registry.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WarroomTrend = require(path.join(REPO_ROOT, 'lib', 'warroom-trend.js'));

const CLOCK_MODULE_FILE = 'lib/warroom-clock.js';
const HEALTH_MODULE_FILE = 'lib/warroom-health.js';
const TREND_MODULE_FILE = 'lib/warroom-trend.js';

// Render-adjacent surfaces this gate scans. Order matters for none of the checks; kept
// alphabetical-ish by discovery order for readability in diffs of this file.
const RENDER_FILES = [
  'warroom-v5.html',
  'generate-status.js',
  'lib/warroom-render.js',
  'lib/warroom-health.js',
  'lib/warroom-runstate.js',
  'lib/warroom-trend.js',
  'lib/warroom-readplane.js',
  'lib/warroom-budget-alert.js',
  'lib/warroom-clock.js',
];

const TILE_INVENTORY_PATH = path.join(REPO_ROOT, 'WARROOM_TILE_INVENTORY.md');
const ALLOWED_SITES_PATH = path.join(REPO_ROOT, 'WARROOM_ALLOWED_SITES.yml');
const METRIC_CANON_PATH = path.join(REPO_ROOT, 'WARROOM_METRIC_CANON.json');

// ---------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------

function readFileLines(relPath) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8').split('\n');
}

function readFileLinesAbs(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, 'utf8').split('\n');
}

function todayIso() {
  // Gate infrastructure, not render code — not subject to its own C5 rule (that rule bans
  // ambient date formatting in the RENDER surfaces feeding the deployed page, not in the
  // CI tool that checks them). Used only for exemption-expiry comparison.
  return new Date().toISOString().slice(0, 10);
}

function extractQuotedStrings(line) {
  // Deliberately simple (no escaped-quote handling) — a heuristic gate over a codebase with
  // no template-literal-heavy escaping in its render surfaces; matches the same tradeoff
  // scripts/check-clock-gate.sh already makes.
  const out = [];
  const re = /(['"`])((?:(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(line))) out.push({ content: m[2], start: m.index });
  return out;
}

// ---------------------------------------------------------------------------------------
// exemption ledger — "# CONTRACT-EXEMPT: C2 — <reason> — <expiry-date>"
// ---------------------------------------------------------------------------------------

const EXEMPT_RE = /CONTRACT-EXEMPT:\s*(C\d)\s*[—-]\s*(.+?)\s*[—-]\s*(\d{4}-\d{2}-\d{2})/;

function findExemptionsInFiles(files) {
  const ledger = [];
  for (const rel of files) {
    const lines = readFileLines(rel);
    if (!lines) continue;
    lines.forEach((line, i) => {
      const m = line.match(EXEMPT_RE);
      if (m) {
        ledger.push({
          file: rel,
          line: i + 1,
          contract: m[1].toUpperCase(),
          reason: m[2].trim(),
          expiry: m[3],
          expired: m[3] < todayIso(),
        });
      }
    });
  }
  return ledger;
}

function lineIsExemptFor(line, contract) {
  const m = line.match(EXEMPT_RE);
  if (!m) return false;
  if (m[1].toUpperCase() !== contract) return false;
  return m[3] >= todayIso(); // an expired exemption does NOT suppress — see runGate()
}

// ---------------------------------------------------------------------------------------
// WARROOM_ALLOWED_SITES.yml — minimal parser for this file's own fixed, flat schema.
// Not a general YAML parser; documented as intentionally narrow (avoids adding a yaml
// dependency to a project that has none today).
// ---------------------------------------------------------------------------------------

function parseAllowedSites() {
  if (!fs.existsSync(ALLOWED_SITES_PATH)) return [];
  const raw = fs.readFileSync(ALLOWED_SITES_PATH, 'utf8');
  const lines = raw.split('\n');
  const sites = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^\s*sites:\s*\[\]\s*$/.test(line)) return [];
    const itemStart = line.match(/^\s*-\s+id:\s*(.+)$/);
    if (itemStart) {
      if (cur) sites.push(cur);
      cur = { id: itemStart[1].trim() };
      continue;
    }
    const kv = line.match(/^\s+(\w+):\s*(.+)$/);
    if (kv && cur) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  if (cur) sites.push(cur);
  return sites;
}

function isAllowedSite(sites, contract, relFile) {
  const now = todayIso();
  return sites.some((s) => s.contract === contract && s.file === relFile && (!s.expiry || s.expiry >= now));
}

function expiredAllowedSites(sites) {
  const now = todayIso();
  return sites.filter((s) => s.expiry && s.expiry < now);
}

// ---------------------------------------------------------------------------------------
// CHECK 1 — C2: bare em-dash as (or standing in for) a rendered value
// ---------------------------------------------------------------------------------------

function check_no_bare_emdash(files) {
  // Scoped to JS-side dynamic construction only (ternary/||/?? fallback expressions, and a
  // quoted-string-whole-content dash inside .js files). Deliberately does NOT flag a bare
  // `>—<` sitting in warroom-v5.html's STATIC markup skeleton (e.g. `<div id="clkd">—</div>`)
  // — that is a pre-hydration placeholder immediately overwritten by the page's own JS on
  // load, not a rendered value; a static grep cannot distinguish "temporary skeleton" from
  // "permanent fallback because a computation failed" (the card's own 🔴 point about why
  // layer (b), the runtime payload assertion, is the real C1/C2 enforcement — see
  // lib/warroom-render.js assertValidPayload()). Flagging every skeleton placeholder here
  // would be exactly the "wall of legacy hits" false-positive failure mode the card warns
  // against and would get this check disabled within a week.
  const violations = [];
  const DASH_WHOLE = /^[\s]*(—|--|---)[\s]*$/; // quoted content that IS just a dash
  const TERNARY_FALLBACK = /\?[^:]*:\s*['"](—|--|---)['"]/;
  const OR_FALLBACK = /(\|\||\?\?)\s*['"](—|--|---)['"]/;

  for (const rel of files) {
    const lines = readFileLines(rel);
    if (!lines) continue;
    const isJs = rel.endsWith('.js');
    lines.forEach((line, i) => {
      if (lineIsExemptFor(line, 'C2')) return;
      let hit = null;
      if (TERNARY_FALLBACK.test(line)) hit = 'ternary fallback to a bare em-dash/double-dash literal';
      else if (OR_FALLBACK.test(line)) hit = '||/?? fallback to a bare em-dash/double-dash literal';
      else if (isJs) {
        for (const q of extractQuotedStrings(line)) {
          if (DASH_WHOLE.test(q.content)) { hit = 'quoted value whose entire content is a bare em-dash/dash placeholder'; break; }
        }
      }
      if (hit) {
        violations.push({ file: rel, line: i + 1, contract: 'C2', message: `bare em-dash/dash placeholder in a rendered value slot (${hit})`, raw: line.trim() });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------
// CHECK 2 — C3: hardcoded status literal outside the computed-health producer
// ---------------------------------------------------------------------------------------

const STATUS_TOKENS = [
  { name: 'HEALTHY', test: (c) => /\bHEALTHY\b/i.test(c) },
  // Case-SENSITIVE, deliberately (unlike the others): this codebase uses lowercase 'ok' as
  // an internal state-code value (f.status==='ok', showToast(...,'ok')) at real call sites
  // that are not display text — verified false positives during this card's own build.
  // 'OK' the rendered badge literal is, in every real occurrence found, upper-case.
  { name: 'OK', test: (c) => c.trim() === 'OK' },
  { name: 'LIVE', test: (c) => /\bLIVE\b/.test(c) },
  { name: 'ON TRACK', test: (c) => /ON TRACK/i.test(c) },
  { name: 'system healthy', test: (c) => /system healthy/i.test(c) },
  { name: 'No pending fixes', test: (c) => /no pending fixes/i.test(c) },
  { name: 'No open alerts', test: (c) => /no open alerts/i.test(c) },
];

function check_no_status_literal(files, allowedSites) {
  const violations = [];
  for (const rel of files) {
    if (rel === HEALTH_MODULE_FILE) continue; // the one allowed producer, by module boundary
    const lines = readFileLines(rel);
    if (!lines) continue;
    lines.forEach((line, i) => {
      if (lineIsExemptFor(line, 'C3')) return;
      if (isAllowedSite(allowedSites, 'C3', rel)) return;
      for (const q of extractQuotedStrings(line)) {
        for (const tok of STATUS_TOKENS) {
          if (tok.test(q.content)) {
            violations.push({
              file: rel,
              line: i + 1,
              contract: 'C3',
              message: `hardcoded status literal "${tok.name}" outside the computed-health producer (${HEALTH_MODULE_FILE}) or a registered WARROOM_ALLOWED_SITES.yml site`,
              raw: line.trim(),
            });
          }
        }
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------
// CHECK 3 — C5: timestamp construction/formatting not routed through the clock helper
// ---------------------------------------------------------------------------------------

function check_one_clock(files, opts) {
  opts = opts || {};
  const violations = [];
  const AMBIENT_FORMAT = /\.toLocale(TimeString|DateString)\(/;
  const RAW_GET = /\.get(Hours|Minutes|Seconds)\(\)/;
  const BARE_NEW_DATE = /\bnew\s+Date\(\s*\)/;
  const DATE_NOW = /\bDate\.now\(\)/;

  for (const rel of files) {
    if (rel === CLOCK_MODULE_FILE) continue; // the one allowed producer
    const lines = readFileLines(rel);
    if (!lines) continue;
    lines.forEach((line, i) => {
      if (lineIsExemptFor(line, 'C5')) return;
      if (AMBIENT_FORMAT.test(line)) {
        violations.push({ file: rel, line: i + 1, contract: 'C5', message: 'ambient toLocaleTimeString()/toLocaleDateString() outside WarroomClock — must go through WarroomClock.toEt()', raw: line.trim() });
      }
      if (RAW_GET.test(line)) {
        violations.push({ file: rel, line: i + 1, contract: 'C5', message: 'raw Date getHours()/getMinutes()/getSeconds() outside WarroomClock', raw: line.trim() });
      }
      // Bare new Date()/Date.now() is intentionally NOT flagged by default (opt-in via
      // --strict-new-date only). Empirically checked during this card's own build: this
      // codebase's real usage includes `computed_at: new Date().toISOString()` — a
      // legitimate provenance timestamp (recording real wall-clock "now" for the payload's
      // own C1/C8 traceability field), not the ambient-display-formatting antipattern C5
      // exists to ban. A bare-construction heuristic cannot tell those apart from the
      // text alone; over-flagging it would itself become the "wall of legacy hits" false
      // positive the card's own WHY paragraph warns will get a gate disabled. The two
      // patterns above (AMBIENT_FORMAT, RAW_GET) already catch the actual display-formatting
      // bug class (a Date value converted to a shown string/number without going through
      // WarroomClock) with a verified-clean full-tree baseline.
      if (opts.includeBareNewDate && (BARE_NEW_DATE.test(line) || DATE_NOW.test(line)) && !/\.toISOString\(\)/.test(line)) {
        violations.push({ file: rel, line: i + 1, contract: 'C5', message: 'bare new Date()/Date.now() (ambient current time) outside WarroomClock — opt-in heuristic (--strict-new-date), verify manually before acting', raw: line.trim() });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------
// CHECK 4 — tile registered bidirectionally against WARROOM_TILE_INVENTORY.md — BLOCKED
// ---------------------------------------------------------------------------------------

function check_tile_registered() {
  if (!fs.existsSync(TILE_INVENTORY_PATH)) {
    return { status: 'BLOCKED', reason: `WARROOM_TILE_INVENTORY.md not found at ${TILE_INVENTORY_PATH} — this check activates when WARROOM-INVENTORY-001 lands`, violations: [] };
  }
  // Not reachable until the inventory exists; left unimplemented deliberately rather than
  // guessing its column format ahead of that card landing.
  return { status: 'PASS', reason: null, violations: [] };
}

// ---------------------------------------------------------------------------------------
// CHECK 5 — C4: cadence declared per source, from the tile inventory — BLOCKED
// ---------------------------------------------------------------------------------------

function check_cadence_declared() {
  if (!fs.existsSync(TILE_INVENTORY_PATH)) {
    return { status: 'BLOCKED', reason: `WARROOM_TILE_INVENTORY.md not found at ${TILE_INVENTORY_PATH} — this check activates when WARROOM-INVENTORY-001 lands`, violations: [] };
  }
  return { status: 'PASS', reason: null, violations: [] };
}

// ---------------------------------------------------------------------------------------
// CHECK 6 — C6: one source per number, driven by WARROOM_METRIC_CANON.json (gate-owned
// seed registry — see module header; NOT the long-term WARROOM_TILE_INVENTORY.md-backed
// registry the card text describes, which does not exist yet).
// ---------------------------------------------------------------------------------------

function check_one_source_per_number(files) {
  if (!fs.existsSync(METRIC_CANON_PATH)) {
    return { status: 'BLOCKED', reason: `WARROOM_METRIC_CANON.json not found at ${METRIC_CANON_PATH}`, violations: [] };
  }
  const canon = JSON.parse(fs.readFileSync(METRIC_CANON_PATH, 'utf8'));
  const violations = [];
  for (const figure of canon.figures || []) {
    const matchesByPattern = {}; // pattern.id -> [{file,line}]
    for (const rel of files) {
      const lines = readFileLines(rel);
      if (!lines) continue;
      lines.forEach((line, i) => {
        for (const p of figure.patterns) {
          const re = new RegExp(p.regex);
          if (re.test(line)) {
            matchesByPattern[p.id] = matchesByPattern[p.id] || [];
            matchesByPattern[p.id].push({ file: rel, line: i + 1, source_label: p.source_label });
          }
        }
      });
    }
    const distinctPatternsHit = Object.keys(matchesByPattern);
    if (distinctPatternsHit.length >= 2) {
      const sites = distinctPatternsHit.map((pid) => {
        const hit = matchesByPattern[pid][0];
        return `${hit.source_label} (${hit.file}:${hit.line})`;
      });
      const first = matchesByPattern[distinctPatternsHit[0]][0];
      violations.push({
        file: first.file,
        line: first.line,
        contract: 'C6',
        message: `figure "${figure.figure}" resolves to ${distinctPatternsHit.length} distinct query sources: ${sites.join(' vs ')}${figure.reconciled ? ' (registry marked reconciled — this is a REGRESSION)' : ' (known, not yet fixed — owner: ' + (figure.owner_card || 'unassigned') + ')'}`,
      });
    }
  }
  return { status: null, reason: null, violations };
}

// ---------------------------------------------------------------------------------------
// CHECK 7 — §2.4: trend glyph must be produced by WarroomTrend.trend(), never a literal,
// and must never contradict the sign of its own delta. Reuses lib/warroom-trend.js's own
// trend() function directly — does not re-derive sign logic (task instruction).
// ---------------------------------------------------------------------------------------

const GLYPH_CHARS = ['↑', '↓', '→']; // up, down, flat(right-arrow)

function check_trend_glyph_sign(files) {
  const violations = [];
  // (a) structural: any render file (outside the trend module + its test) assigning a raw
  // glyph character as/inside a quoted string or directly between tags is a literal, not a
  // computed value — banned unconditionally regardless of whether the sign happens to agree.
  for (const rel of files) {
    if (rel === TREND_MODULE_FILE) continue;
    const lines = readFileLines(rel);
    if (!lines) continue;
    lines.forEach((line, i) => {
      if (lineIsExemptFor(line, 'C4') || lineIsExemptFor(line, 'C2')) return; // §2.4 has no dedicated letter; both tags honored
      let literalGlyph = null;
      for (const g of GLYPH_CHARS) {
        if (line.includes(`>${g}<`)) { literalGlyph = g; break; }
      }
      if (!literalGlyph) {
        for (const q of extractQuotedStrings(line)) {
          if (GLYPH_CHARS.includes(q.content.trim())) { literalGlyph = q.content.trim(); break; }
        }
      }
      if (literalGlyph) {
        violations.push({ file: rel, line: i + 1, contract: 'C4-TREND', message: `trend glyph "${literalGlyph}" assigned as a literal — must come from WarroomTrend.trend(current,prior).glyph, never hand-written`, raw: line.trim() });
      }
    });
  }

  // (b) semantic: where a rendered row exposes both current+prior figures next to a glyph
  // (the FINANCE cost-breakdown table shape), recompute the expected glyph via the real
  // WarroomTrend.trend() and flag a contradiction by name.
  const ROW_RE = /<tr>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>\$?([\d,]+\.\d+)<\/td>\s*<td[^>]*>\$?([\d,]+\.\d+)<\/td>\s*<td[^>]*>(↑|↓|→)<\/td>\s*<\/tr>/;
  for (const rel of files) {
    const lines = readFileLines(rel);
    if (!lines) continue;
    lines.forEach((line, i) => {
      const m = line.match(ROW_RE);
      if (!m) return;
      const label = m[1].trim();
      const current = parseFloat(m[2].replace(/,/g, ''));
      const prior = parseFloat(m[3].replace(/,/g, ''));
      const renderedGlyph = m[4];
      let expected;
      try {
        expected = WarroomTrend.trend(current, prior).glyph;
      } catch (e) {
        return;
      }
      if (expected !== null && expected !== renderedGlyph) {
        violations.push({
          file: rel,
          line: i + 1,
          contract: 'C4-TREND',
          message: `row "${label}": current=${current} prior=${prior} renders glyph "${renderedGlyph}" but WarroomTrend.trend() computes "${expected}" — sign contradiction`,
          raw: line.trim(),
        });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------
// CHECK 8 — C1/C8 layer (b): fetch the deployed page, assert every tile value slot carries
// a resolvable query id + computed_at. Requires WARROOM_TILE_INVENTORY.md for the slot list
// (BLOCKED, same as checks 4/5) — but the fetch+traceability probe itself is real and does
// not need the inventory to produce a useful count: it counts payload objects on the live
// page that look like value slots (per lib/warroom-render.js's {value,state,source,
// computed_at} contract) and are missing source/computed_at.
// ---------------------------------------------------------------------------------------

const DEPLOYED_URL = 'https://sasmaster-status.vercel.app/warroom-v5.html';
const DEPLOYED_DATA_URL = 'https://sasmaster-status.vercel.app/status.json';

function fetchUrl(url, timeout) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(url, { timeout: timeout || 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Recursively find every object in a parsed JSON tree that carries a `value` key, and check
// whether it also carries a non-null `source` and `computed_at` sibling — the WarroomRender
// payload contract (lib/warroom-render.js makeValue/makeZero). Real object literals (unlike
// the rendered HTML/JS, where payloads are built by makeValue(...) FUNCTION CALLS and never
// appear as literal `{value: ...}` text — verified empirically during this card's own build,
// which is why this check reads status.json, not the HTML, as its primary source of slots).
function findValueSlots(node, pathStr, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findValueSlots(v, `${pathStr}[${i}]`, out));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'value') && Object.prototype.hasOwnProperty.call(node, 'state')) {
    out.push({ path: pathStr, node });
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') findValueSlots(v, pathStr ? `${pathStr}.${k}` : k, out);
  }
}

function check_rendered_values_traceable() {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get(DEPLOYED_URL, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', async () => {
        if (res.statusCode !== 200) {
          resolve({ status: 'FAIL', reason: `deployed page returned HTTP ${res.statusCode}`, violations: [], untraceable_count: null });
          return;
        }
        // Primary probe: WarroomRender.makeValue(...) payloads are constructed by function
        // CALLS in the render source, not literal `{value:...}` object text — so the HTML/JS
        // response itself yields ~0 matches by design, not by traceability. Documented, not
        // silently treated as "0 untraceable == fully traceable".
        const slotRe = /\{\s*value\s*:[^{}]*?\}/g;
        const htmlSlots = body.match(slotRe) || [];

        // Secondary, more honest probe: status.json is the actual data payload the page
        // renders from and DOES contain real object literals once parsed as JSON.
        let jsonSlots = [];
        let jsonFetchError = null;
        try {
          const dataRes = await fetchUrl(DEPLOYED_DATA_URL);
          if (dataRes.statusCode === 200) {
            const parsed = JSON.parse(dataRes.body);
            findValueSlots(parsed, '', jsonSlots);
          } else {
            jsonFetchError = `HTTP ${dataRes.statusCode}`;
          }
        } catch (e) {
          jsonFetchError = e.message;
        }

        if (jsonSlots.length === 0 && htmlSlots.length === 0) {
          resolve({
            status: 'UNVERIFIED',
            reason: `fetched ${DEPLOYED_URL} and ${DEPLOYED_DATA_URL} successfully, but found 0 objects matching the WarroomRender {value,state,source,computed_at} payload shape in either${jsonFetchError ? ` (status.json: ${jsonFetchError})` : ''}. This does NOT mean every value is traceable — it means this static/JSON-text heuristic cannot see the shape on the live deployment as currently structured (status.json's top-level fields are not yet emitted in the WarroomRender contract shape). Reported honestly as unable to establish the PHASE 6g baseline, not fabricated as a passing count.`,
            violations: [],
            untraceable_count: null,
          });
          return;
        }

        let untraceable = 0;
        const sampleViolations = [];
        jsonSlots.forEach((slot, idx) => {
          const hasSource = slot.node.source != null && slot.node.source !== '';
          const hasComputedAt = slot.node.computed_at != null && slot.node.computed_at !== '';
          if (!hasSource || !hasComputedAt) {
            untraceable += 1;
            if (sampleViolations.length < 10) {
              sampleViolations.push({ file: DEPLOYED_DATA_URL, line: null, contract: 'C1/C8', message: `value slot at status.json${slot.path ? '.' + slot.path : ''} missing ${!hasSource ? 'source' : ''}${!hasSource && !hasComputedAt ? '/' : ''}${!hasComputedAt ? 'computed_at' : ''}` });
            }
          }
        });
        resolve({
          status: untraceable > 0 ? 'FAIL' : 'PASS',
          reason: `fetched ${DEPLOYED_DATA_URL}: ${jsonSlots.length} WarroomRender-shaped value slot(s) found, ${untraceable} untraceable (missing source/computed_at) — this is the Phase 1/2 burn-down baseline (card PHASE 6g). ${htmlSlots.length} literal matches found directly in ${DEPLOYED_URL} (expected near-zero since payloads there are built by makeValue() calls, not literal object text).`,
          violations: sampleViolations,
          untraceable_count: untraceable,
        });
      });
    });
    req.on('error', (e) => {
      resolve({ status: 'UNVERIFIED', reason: `network fetch to ${DEPLOYED_URL} failed in this environment: ${e.message} — could not run layer (b), not fabricated as passing`, violations: [], untraceable_count: null });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'UNVERIFIED', reason: `network fetch to ${DEPLOYED_URL} timed out — could not run layer (b), not fabricated as passing`, violations: [], untraceable_count: null });
    });
  });
}

// ---------------------------------------------------------------------------------------
// diff scoping — restrict a violation list to lines added since a base ref
// ---------------------------------------------------------------------------------------

const SAFE_REF_RE = /^[A-Za-z0-9._/\-]+$/;

function addedLineSet(baseRef) {
  // Returns Map<relFile, Set<lineNumber>> of ADDED lines only (git diff --unified=0).
  if (!SAFE_REF_RE.test(baseRef)) {
    throw new Error(`refusing to use unsafe --base value "${baseRef}" (git ref characters only)`);
  }
  let diffOut;
  try {
    diffOut = execFileSync('git', ['diff', '--unified=0', `${baseRef}...HEAD`, '--', '.'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  } catch (e) {
    throw new Error(`could not compute diff against base ref "${baseRef}": ${e.message}`);
  }
  const map = new Map();
  let curFile = null;
  let curLine = null;
  for (const raw of diffOut.split('\n')) {
    const fileM = raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileM) { curFile = fileM[1]; continue; }
    const hunkM = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkM) { curLine = parseInt(hunkM[1], 10); continue; }
    if (curFile && curLine != null) {
      if (raw.startsWith('+') && !raw.startsWith('+++')) {
        if (!map.has(curFile)) map.set(curFile, new Set());
        map.get(curFile).add(curLine);
        curLine += 1;
      } else if (raw.startsWith('-') && !raw.startsWith('---')) {
        // removed line, doesn't consume a line number in the new file
      } else if (raw === '' || raw.startsWith('diff --git') || raw.startsWith('index ')) {
        // no-op
      }
    }
  }
  return map;
}

function filterToAddedLines(violations, added) {
  return violations.filter((v) => {
    if (v.line == null) return true; // e.g. layer-(b) fetch findings have no line
    const set = added.get(v.file);
    return set && set.has(v.line);
  });
}

// ---------------------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------------------

function runStaticChecks(files, opts) {
  const allowedSites = parseAllowedSites();
  const c6 = check_one_source_per_number(files);
  const results = {
    C2: { violations: check_no_bare_emdash(files) },
    C3: { violations: check_no_status_literal(files, allowedSites) },
    C5: { violations: check_one_clock(files, { includeBareNewDate: !!opts.strictNewDate }) },
    'tile-registered': check_tile_registered(),
    'cadence-declared': check_cadence_declared(),
    C6: { status: c6.status, reason: c6.reason, violations: c6.violations },
    'trend-glyph': { violations: check_trend_glyph_sign(files) },
  };
  return { results, allowedSites };
}

async function runGate(argv) {
  const mode = argv.includes('--full') ? 'full' : argv.includes('--files') ? 'files' : 'diff';
  const jsonOut = argv.includes('--json');
  const includeRemote = argv.includes('--with-remote'); // layer (b), opt-in (network + slow)

  let files;
  if (mode === 'files') {
    const idx = argv.indexOf('--files');
    files = argv[idx + 1].split(',');
  } else {
    files = RENDER_FILES;
  }

  const { results, allowedSites } = runStaticChecks(files, { mode, strictNewDate: argv.includes('--strict-new-date') });

  if (mode === 'diff') {
    const baseArgIdx = argv.indexOf('--base');
    const baseRef = baseArgIdx !== -1 ? argv[baseArgIdx + 1] : 'origin/main';
    let added;
    try {
      added = addedLineSet(baseRef);
    } catch (e) {
      console.error(`[contract-gate] FAIL — could not resolve base ref for diff scoping: ${e.message}`);
      process.exit(1);
    }
    for (const key of ['C2', 'C3', 'C5']) {
      results[key].violations = filterToAddedLines(results[key].violations, added);
    }
    if (results.C6.violations) results.C6.violations = filterToAddedLines(results.C6.violations, added);
    results['trend-glyph'].violations = filterToAddedLines(results['trend-glyph'].violations, added);
  }

  const exemptions = findExemptionsInFiles(files);
  const expiredExemptions = exemptions.filter((e) => e.expired);
  const expiredSites = expiredAllowedSites(allowedSites);

  let remoteResult = null;
  if (includeRemote) remoteResult = await check_rendered_values_traceable();

  // ---- tally ----
  let totalViolations = 0;
  const report = [];
  for (const [key, val] of Object.entries(results)) {
    if (val.status === 'BLOCKED') {
      report.push({ check: key, status: 'BLOCKED', reason: val.reason });
      continue;
    }
    const count = (val.violations || []).length;
    totalViolations += count;
    report.push({ check: key, status: count > 0 ? 'FAIL' : 'PASS', count, violations: val.violations });
  }
  if (remoteResult) {
    report.push({ check: 'rendered-values-traceable', status: remoteResult.status, reason: remoteResult.reason, untraceable_count: remoteResult.untraceable_count });
  }

  const exitOnExpired = expiredExemptions.length > 0 || expiredSites.length > 0;

  if (jsonOut) {
    console.log(JSON.stringify({ mode, report, exemptions, expiredExemptions, expiredSites, remoteResult }, null, 2));
  } else {
    console.log(`[contract-gate] mode=${mode} files=${files.length}`);
    for (const r of report) {
      if (r.status === 'BLOCKED') {
        console.log(`  BLOCKED  ${r.check.padEnd(24)} — ${r.reason}`);
        continue;
      }
      console.log(`  ${r.status.padEnd(8)} ${r.check.padEnd(24)} ${r.count != null ? r.count + ' violation(s)' : ''}`);
      for (const v of r.violations || []) {
        console.log(`      ${v.contract} violation at ${v.file}${v.line ? ':' + v.line : ''}: ${v.message}`);
      }
      if (r.reason) console.log(`      ${r.reason}`);
    }
    console.log(`[contract-gate] exemption ledger (live, non-expired): ${exemptions.filter((e) => !e.expired).length} entries`);
    exemptions.forEach((e) => console.log(`  ${e.expired ? 'EXPIRED' : 'live'}  ${e.contract} at ${e.file}:${e.line} — "${e.reason}" (expires ${e.expiry})`));
    if (expiredSites.length) console.log(`[contract-gate] EXPIRED WARROOM_ALLOWED_SITES.yml entries: ${expiredSites.map((s) => s.id).join(', ')}`);
  }

  const exit = totalViolations > 0 || exitOnExpired ? 1 : 0;
  if (require.main === module) process.exit(exit);
  return { exit, totalViolations, report, exemptions };
}

module.exports = {
  RENDER_FILES,
  CLOCK_MODULE_FILE,
  HEALTH_MODULE_FILE,
  TREND_MODULE_FILE,
  check_no_bare_emdash,
  check_no_status_literal,
  check_one_clock,
  check_tile_registered,
  check_cadence_declared,
  check_one_source_per_number,
  check_trend_glyph_sign,
  check_rendered_values_traceable,
  parseAllowedSites,
  findExemptionsInFiles,
  addedLineSet,
  filterToAddedLines,
  runStaticChecks,
  runGate,
};

if (require.main === module) {
  runGate(process.argv.slice(2));
}
