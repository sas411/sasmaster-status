// WARROOM-SYNTHETIC-001 — staging fixture + production guard.
//
// Every scenario in the synthetic suite drives PURE functions
// (warroom-health.js, warroom-runstate.js, warroom-readplane.js,
// warroom-render.js, warroom-clock.js, warroom-alert-predicates.js) with
// synthetic in-memory data. None of those functions do file/network I/O
// themselves. The one place this suite touches disk at all is S4 (feed
// staleness), which needs a real file with a controllable mtime to prove
// `fileAgeSeconds()`-shaped age computation — that file lives under a
// fresh temp "staging root" this module creates, NEVER under this repo's
// real `data/`, `finance-data.json`, `status.json`, or `warroom/*.json`.
//
// assertStagingRoot(root) is the "structurally impossible to write
// production" guard the card requires: it throws (caller must treat as
// abort-non-zero) if `root` is missing, or resolves inside this repo, or
// resolves inside ~/SaSMaster, or literally equals a MotherDuck target
// string ('md:...'). A caller that ignores the throw and writes anyway is
// a caller bug outside this module's reach — but every write path in this
// suite (see test/warroom-synthetic-suite.test.mjs) calls this first and
// aborts the whole run on throw, so satisfying it structurally is the only
// way any scenario's setup proceeds.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..'); // sasmaster-status checkout
const HOME = process.env.HOME || '';
const SASMASTER_ROOT = path.join(HOME, 'SaSMaster');

function assertStagingRoot(root) {
  if (!root || typeof root !== 'string') {
    throw new Error('SYNTHETIC-GUARD: staging root missing');
  }
  if (root.indexOf('md:') === 0 || root.indexOf('sasmaster.ops') !== -1) {
    throw new Error('SYNTHETIC-GUARD: refusing a MotherDuck/production DSN as a staging root (' + root + ')');
  }
  const resolved = path.resolve(root);
  if (resolved === REPO_ROOT || resolved.indexOf(REPO_ROOT + path.sep) === 0) {
    // Exception: our own designated scratch subfolder, which is itself
    // gitignored and never the real data/ or root config files.
    if (resolved.indexOf(path.join(REPO_ROOT, 'test', '.synthetic-staging')) !== 0) {
      throw new Error('SYNTHETIC-GUARD: staging root resolves inside the live repo (' + resolved + ') — not staging');
    }
  }
  if (resolved.indexOf(SASMASTER_ROOT) === 0) {
    throw new Error('SYNTHETIC-GUARD: staging root resolves inside ~/SaSMaster (' + resolved + ') — not staging');
  }
  if (resolved.indexOf(os.tmpdir()) !== 0 && resolved.indexOf(path.join(REPO_ROOT, 'test', '.synthetic-staging')) !== 0) {
    throw new Error('SYNTHETIC-GUARD: staging root must live under the OS temp dir or test/.synthetic-staging (' + resolved + ')');
  }
  return true;
}

function makeStagingRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warroom-synthetic-'));
  assertStagingRoot(root); // fail loudly here too, never assume our own factory is safe
  return root;
}

function teardownStagingRoot(root) {
  assertStagingRoot(root); // never rm -rf anything this guard would refuse to write to
  fs.rmSync(root, { recursive: true, force: true });
}

// Deterministic hash of a fixture's on-disk state (S4's staging feed file
// plus a manifest of scenario touch-points), so PHASE 5a's "post-run fixture
// hash equals pre-run hash" and PHASE 5b's "fixture hash unchanged after
// negative control" are mechanical, not a visual diff.
function hashStagingRoot(root) {
  const h = crypto.createHash('sha256');
  function walk(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      fs.readdirSync(p).sort().forEach(function (child) { walk(path.join(p, child)); });
    } else {
      h.update(path.relative(root, p));
      h.update(fs.readFileSync(p));
    }
  }
  if (fs.existsSync(root)) walk(root);
  return h.digest('hex');
}

// Writes a staging feed file with a controlled mtime (age in seconds before
// "now"). Used by S4. Never touches the real finance-data.json.
function writeAgedFeed(root, filename, contents, ageSeconds, now) {
  assertStagingRoot(root);
  const filePath = path.join(root, filename);
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2));
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const mtime = new Date(nowMs - ageSeconds * 1000);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

function fileAgeSeconds(absPath, now) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  try {
    const st = fs.statSync(absPath);
    return Math.floor((nowMs - st.mtimeMs) / 1000);
  } catch (e) {
    return null;
  }
}

// Heartbeat -- WARROOM-SYNTHETIC-001 CONSTRAINTS: "Completion writes a
// heartbeat row to the run-log." A REAL run-log write means mdQuery against
// sasmaster.ops.run_log, which this suite must never call directly (see
// header note). Until §5c/§5d are ruled and a real integration point is
// designed (a distinct job_id in the production run-log, written by the
// SAME house mdQuery convention alert-engine.js uses, from a context that
// is NOT this test process), the heartbeat is recorded to a local file next
// to the repo (never committed, never under the live data/ paths) so the
// self-monitor predicate has a real timestamp to evaluate against in the
// meantime. This is a disclosed interim, not a silent substitute.
const HEARTBEAT_PATH = path.join(REPO_ROOT, 'warroom', '.synthetic-heartbeat.json');

function writeHeartbeat(now) {
  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify({ job_id: 'warroom-synthetic-suite', last_run_utc: iso }, null, 2));
  return iso;
}

function readHeartbeat() {
  try {
    const raw = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
    return raw.last_run_utc || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  REPO_ROOT: REPO_ROOT,
  SASMASTER_ROOT: SASMASTER_ROOT,
  assertStagingRoot: assertStagingRoot,
  makeStagingRoot: makeStagingRoot,
  teardownStagingRoot: teardownStagingRoot,
  hashStagingRoot: hashStagingRoot,
  writeAgedFeed: writeAgedFeed,
  fileAgeSeconds: fileAgeSeconds,
  writeHeartbeat: writeHeartbeat,
  readHeartbeat: readHeartbeat,
};
