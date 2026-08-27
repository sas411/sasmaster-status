#!/usr/bin/env node
/**
 * generate-status.js — writes status.json for sasmaster-status v3
 * All data sourced from real files — no mocks.
 */

const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const WarroomClock = require('./lib/warroom-clock.js'); // WARROOM-CLOCK-001 — the one clock module (C5)
const WarroomHealth = require('./lib/warroom-health.js'); // WARROOM-HEALTH-001 — the one health evaluator (C6)
const WarroomRunstate = require('./lib/warroom-runstate.js'); // WARROOM-RUNSTATE-001 — the one run-state evaluator (C6)
const JobCadence = require('./lib/job-cadence-registry.js'); // WARROOM-RUNSTATE-001 — the one job-cadence source, shared with ~/SaSMaster/scripts/alert-engine.js (C4/C6)

const SASMASTER   = path.join(process.env.HOME, 'SaSMaster');
const PENDING     = path.join(SASMASTER, 'pending-approvals.json');
const TASKS_FILE  = path.join(SASMASTER, 'TASKS.md');
const DONE_FILE   = path.join(SASMASTER, 'DONE_LOG.md');
const OUT         = path.join(__dirname, 'status.json');

// ── JARVIS ───────────────────────────────────────────────────────────────────
// Socket Mode daemon is dead (JARVIS-ARCH-001). JARVIS is alive when Railway
// HTTP Events API responds to /health.
function jarvisAlive() {
  try {
    // STATUS-PROCLEAK-001: array-form, no shell. Also adds an outer timeout —
    // --max-time bounds curl's own transfer, but nothing bounded the wait if
    // curl itself wedged, which would stall the whole generator.
    const _r = spawnSync(
      '/usr/bin/curl',
      ['-sf', '--max-time', '4', 'https://api.sasmaster.dev/health'],
      { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const out = (_r.status === 0 && _r.stdout) ? _r.stdout : '';
    return out.includes('"status"') && out.includes('"ok"');
  } catch { return false; }
}

// ── TASKS.md parser (v2) ──────────────────────────────────────────────────────
// Supports: - [HIGH|MED|EXPLORE] [WIP|BLOCK:reason|REVIEW] [TAG] text {meta} ^id
// Backward compatible: lines without state/id still parse as BACKLOG with auto-tag.

const STATE_RE = /\[(WIP|BLOCK:([^\]]*)|REVIEW)\]/i;
const ID_RE    = /\^([a-f0-9]{6})\s*$/;
const META_RE  = /\{([^}]+)\}/;

function detectTag(text) {
  if (/edgar|financial|s3|postgresql|scraper|financial.anal/i.test(text)) return 'EDGAR';
  if (/tmdb|imdb|trending|content.*load/i.test(text)) return 'DATA';
  if (/agent|cron|jarvis|slack|webhook|build\.sh/i.test(text)) return 'AGENT';
  if (/ui|portal|nav|design|html|css|homepage|archive|sasmaster\.html/i.test(text)) return 'UI';
  if (/qa|test|check|puppeteer/i.test(text)) return 'QA';
  return 'INFRA';
}

function parseTasks() {
  if (!fs.existsSync(TASKS_FILE)) return { high: 0, med: 0, highItems: [], medItems: [], exploreItems: [], wipItems: [], blockedItems: [], reviewItems: [] };
  const lines = fs.readFileSync(TASKS_FILE, 'utf8').split('\n');

  let sprint = 'Backlog';
  const highItems = [], medItems = [], exploreItems = [];
  const wipItems = [], blockedItems = [], reviewItems = [];

  lines.forEach((line, idx) => {
    // Sprint headers (skip DRAFT headers — those go to parseQADrafts)
    if (/^##/.test(line) && !/^##\s*\[DRAFT\]/.test(line)) {
      sprint = line.replace(/^#+\s*/, '').trim();
      return;
    }

    const pm = line.match(/^\s*-\s*\[(HIGH|MED|EXPLORE)\]/i);
    if (!pm) return;

    const priority = pm[1].toUpperCase();
    let rest = line.slice(line.indexOf(`[${pm[1]}]`) + pm[1].length + 2).trim();

    // Skip historical DONE lines
    if (/^\[DONE/i.test(rest)) return;

    // State tag
    let state = 'BACKLOG', blockReason = '';
    const sm = rest.match(STATE_RE);
    if (sm) {
      const sr = sm[1].toUpperCase();
      if (sr === 'WIP')               state = 'WIP';
      else if (sr.startsWith('BLOCK')){ state = 'BLOCKED'; blockReason = sm[2] || ''; }
      else if (sr === 'REVIEW')        state = 'REVIEW';
      rest = rest.replace(STATE_RE, '').trim();
    }

    // Explicit tag override [DATA|AGENT|UI|INFRA|EDGAR|QA]
    let tag = '';
    const tgm = rest.match(/^\[([A-Z]+)\]/);
    if (tgm && ['DATA','AGENT','UI','INFRA','EDGAR','QA'].includes(tgm[1])) {
      tag = tgm[1];
      rest = rest.slice(tgm[0].length).trim();
    }

    // Inline metadata {key:val}
    const meta = {};
    const mm = rest.match(META_RE);
    if (mm) {
      mm[1].split(',').forEach(pair => {
        const [k, v] = pair.split(':').map(s => s.trim());
        if (k && v) meta[k] = v;
      });
      rest = rest.replace(META_RE, '').trim();
    }

    // ^id
    let id = `t${idx}`;
    const im = rest.match(ID_RE);
    if (im) { id = im[1]; rest = rest.replace(ID_RE, '').trim(); }

    const full = rest.replace(/—\s*injected.*$/i, '').trim();
    if (!full) return;
    const text = full.length > 120 ? full.slice(0, 120) + '…' : full;
    if (!tag) tag = detectTag(full);

    const item = { id, lineIndex: idx, text, full, sprint, tag, priority, state, blockReason, meta };

    // Route by state first, then priority for BACKLOG
    if      (state === 'WIP')     wipItems.push(item);
    else if (state === 'BLOCKED') blockedItems.push(item);
    else if (state === 'REVIEW')  reviewItems.push(item);
    else if (priority === 'HIGH') highItems.push(item);
    else if (priority === 'MED')  medItems.push(item);
    else                          exploreItems.push(item);
  });

  return {
    high: highItems.length, med: medItems.length,
    highItems, medItems, exploreItems,   // no caps — return all
    wipItems, blockedItems, reviewItems,
  };
}

// ── QA draft tasks ────────────────────────────────────────────────────────────
function parseQADrafts() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  const content = fs.readFileSync(TASKS_FILE, 'utf8');
  const drafts  = [];
  const blocks  = content.split(/\n(?=## \[DRAFT\])/);
  blocks.forEach(block => {
    if (!/^## \[DRAFT\]/i.test(block)) return;
    const header   = (block.match(/^## \[DRAFT\]\s*(.+)/) || [])[1] || 'QA Draft';
    const checkId  = (header.match(/·\s*([\w-]+)\s*·/) || [])[1] || '';
    const buildId  = (header.match(/build:([\w-]+)/) || [])[1] || '';
    const desc     = (block.match(/- description:\s*(.+)/) || [])[1] || '';
    const fixDesc  = (block.match(/- fix_description:\s*(.+)/) || [])[1] || '';
    drafts.push({ id: `qa-${checkId}`, checkId, buildId, text: desc || header, fixDesc, tag: 'QA', state: 'REVIEW', priority: 'HIGH', sprint: 'QA Drafts' });
  });
  return drafts;
}

// ── Memory pending + phase strip ──────────────────────────────────────────────
function parseMemoryContext() {
  const memFile = path.join(SASMASTER, 'CLAUDE_MEMORY.md');
  if (!fs.existsSync(memFile)) return { phaseStatus: {}, pending: [] };
  const content = fs.readFileSync(memFile, 'utf8');

  // Phase status lines: phase_1: LIVE — description
  const phaseStatus = {};
  content.split('\n').forEach(line => {
    const m = line.match(/^(phase_\w+):\s*(\S+)\s*(?:—\s*(.*))?/);
    if (m) phaseStatus[m[1]] = { status: m[2], desc: (m[3] || '').trim() };
  });

  // Pending block (lines starting with "- " after a "# Pending" header)
  const pendingMatch = content.match(/# Pending\n([\s\S]*?)(?:\n#|$)/);
  const pending = pendingMatch
    ? pendingMatch[1].split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean)
    : [];

  return { phaseStatus, pending };
}

// ── DONE_LOG.md ──────────────────────────────────────────────────────────────
function parseDoneLog() {
  if (!fs.existsSync(DONE_FILE)) return { entries: [], heatmap: {} };
  const content = fs.readFileSync(DONE_FILE, 'utf8');
  const blocks  = content.split('---').map(b => b.trim()).filter(Boolean);

  const heatmap = {};
  const entries = blocks.reverse().slice(0, 10).map(block => {
    const date  = (block.match(/Date:\s*(.+)/) || [])[1]?.trim() || '';
    const task  = (block.match(/Task:\s*(.+)/) || [])[1]?.trim() || '';
    const notes = (block.match(/Notes:\s*([\s\S]+?)(?:\n[A-Z]|$)/) || [])[1]?.trim().slice(0, 120) || '';

    // Count builds per date for heatmap
    if (date) {
      const key = date.slice(0, 10);
      heatmap[key] = (heatmap[key] || 0) + 1;
    }
    return { task, date, notes, status: 'DONE' };
  }).filter(e => e.task);

  // Also count from all blocks for heatmap depth
  blocks.forEach(block => {
    const date = (block.match(/Date:\s*(.+)/) || [])[1]?.trim() || '';
    if (date) {
      const key = date.slice(0, 10);
      heatmap[key] = (heatmap[key] || 0) + 1;
    }
  });

  return { entries, heatmap };
}

// ── Pending approvals → Review column ───────────────────────────────────────
function parsePending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING, 'utf8')).map((p, i) => ({
      id: `review-${i}`,
      text: (p.description || p.type || 'Pending item').slice(0, 88),
      full: p.description || p.type || 'Pending item',
      sprint: 'Review',
      tag: 'PENDING',
      priority: 'REVIEW',
      approvalId: p.id,
      // WARROOM-WORKQUEUE-001 — real `opened_at` for the work_queue model's
      // `review` kind (C6). Previously dropped entirely (only id/description
      // survived), which is why the review column had no age anywhere on the
      // board. `p.timestamp` is the file's own field — not derived, not the
      // date inside `description`'s free text.
      openedAt: p.timestamp || null,
    }));
  } catch { return []; }
}

// ── Agent fleet ──────────────────────────────────────────────────────────────
// `jobId` maps to Command API /trigger VALID_JOBS — null means no Run button.
// `channel` is the primary Slack destination — used by UI without a hardcoded map.
// WARROOM-HEALTH-001 — cadence/job registry for the 14 live/cron agents. Source of truth
// (this table is authoritative at runtime; WARROOM_AGENT_INVENTORY.md in ~/SaSMaster mirrors
// it for human review/edit — see that file's own note on keeping the two in sync, C6: this
// is the ONE place cadence_ms/job/expected_state are declared, the doc is documentation of
// it, not a second source). cadence_ms=null means no scheduler entry exists (GATE-C) — never
// guessed. `job` is the real `ops.run_log.job` column value, resolved from
// docs/JOB_ID_NAMING.md + the Phase-0 crontab capture where parseAgents()'s own `jobId` field
// is absent or doesn't match (SEC EDGAR, Financial Analyst, Security Watchdog, Railway
// Monitor have no jobId here at all; IAB Intel's jobId 'iab-intel' doesn't match the real job
// 'iab-agent' — both gaps flagged in WARROOM_AGENT_INVENTORY.md, not silently patched over).
const AGENT_HEALTH_CONFIG = {
  'JARVIS':            { job: null,                  cadence_ms: null,                expected_state: 'active' },
  'Media Intel':       { job: 'media-intel-agent',   cadence_ms: 24 * 3600000,        expected_state: 'active' },
  'TMDB Daily':        { job: 'tmdb-daily-agent',    cadence_ms: 24 * 3600000,        expected_state: 'active' },
  'DoneLog Analyst':   { job: 'donelog-analyst',     cadence_ms: 24 * 3600000,        expected_state: 'active' }, // crontab says daily; parseAgents() label says "Post-build" — discrepancy flagged in WARROOM_AGENT_INVENTORY.md, crontab wins per GATE-C
  'LinkedIn Agent':    { job: 'linkedin-agent',      cadence_ms: 7 * 24 * 3600000,     expected_state: 'active' },
  'SEC EDGAR':         { job: 'edgar-scraper',       cadence_ms: 24 * 3600000,        expected_state: 'active' },
  'Tech Intel':        { job: 'tech-intel-agent',    cadence_ms: 7 * 24 * 3600000,     expected_state: 'active' },
  'Financial Analyst': { job: 'financial-analyst',   cadence_ms: 7 * 24 * 3600000,     expected_state: 'active' },
  'Weekly Review':     { job: 'weekly-review-agent', cadence_ms: 7 * 24 * 3600000,     expected_state: 'active' },
  'IAB Intel':         { job: 'iab-agent',           cadence_ms: 7 * 24 * 3600000,     expected_state: 'active' },
  'Security Watchdog': { job: 'security-watchdog',   cadence_ms: 24 * 3600000,        expected_state: 'active' },
  'Railway Monitor':   { job: 'railway-monitor',     cadence_ms: 15 * 60000,          expected_state: 'active' },
  'Research Portal':   { job: null,                  cadence_ms: null,                expected_state: 'active' },
  'Data Guardian':     { job: null,                  cadence_ms: null,                expected_state: 'active' },
  // WARROOM-AGENT-RUNPLANE-001 (2026-08-27) — 15th schedule-evaluated agent. It was typed
  // `subagent` in parseAgents() and so fell to the "N/A — on-demand, not schedule-evaluated"
  // branch, which was simply untrue: `0 9 1 */3 *` is installed in the live crontab under the
  // tag SaSMaster-viz-evaluator-quarterly. cadence_ms is READ OFF that expression, not chosen:
  // consecutive fires are Jan1→Apr1→Jul1→Oct1, whose LARGEST gap is 92 days (Jul→Oct); taking
  // the max rather than the mean is what stops a correct on-time run from being scored late in
  // the longest quarter. `job` is null because no ops.run_log rows are written under a
  // viz-evaluator job name (its cron line is one of the few that does NOT go through
  // runlog_wrap) — so it evaluates as never_run until that is wired, which is the honest state
  // and is tracked in the card, NOT smoothed over by pointing at some other job's rows.
  'Viz Evaluator':     { job: null,                  cadence_ms: 92 * 24 * 3600000,   expected_state: 'active' },
};

// GATE-A — RULED BY SHIV 2026-08-27 ("fix the underlying staleness and null — make this
// production ready"), WARROOM-AGENT-RUNPLANE-001. Previously both null, so evaluateHealth()
// threw and every schedule-evaluated agent rendered `ERROR — gate-a-unresolved`; that also
// kept alert-engine.js's ruleR1 a fleet-wide placeholder incapable of firing a per-agent
// late/stale alert. Both are now real numbers, so the badges AND the alert plane compute.
//
// The resolution is option (i)'s values carried by option (iii)'s structure — the constants
// were already separately named, and the two spec clauses turn out to govern different
// surfaces rather than contradicting each other:
//   §2.1 defines `stale := age > cadence × 3`. It is the clause that DEFINES staleness, and
//     the card's Phase-5 fixture table was authored against it — so AGENTS get 3.
//   C4's "exceeding cadence × 2 flips every dependent tile to STALE and fires an alert" is
//     about dependent data-FEED tiles, which is exactly what FEED_STALE_MULT governs — so
//     FEEDS get 2.
// Read that way each clause lands on its own surface, and neither number is a compromise.
//
// What this decides concretely: the healthy ceiling stays 1.5× (fixed in warroom-health.js,
// never a GATE-A knob). An agent between 1.5× and 3× cadence reads `late`; beyond 3×, `stale`.
// Financial Analyst and Weekly Review at 1.86× therefore read LATE — visible and escalating —
// rather than sitting below the line and reading healthy, which is what a ×2 AGENT threshold
// would have done to them. Feeds stay tighter at 2× because a stale feed silently poisons
// every tile downstream of it, so it should shout sooner than a late agent.
//
// Reversible in one line each: change the number and rerun `node --test test/`. The synthetic
// suite reads these constants live, so its expected table regenerates rather than being
// hand-edited (WARROOM-HEALTH-001 Phase 5).
const AGENT_STALE_MULT = 3;
const FEED_STALE_MULT  = 2;

// WARROOM-HEALTH-001 Phase 4 — fetches the latest run_log row per job for the agents in
// AGENT_HEALTH_CONFIG, in one batched query. Same MOTHERDUCK_TOKEN-as-env-var pattern as
// readSentinelStatus() (line ~1815) — never interpolated into the connection string.
// Fails OPEN (empty map) on any read error: an unreadable run-log is not proof of
// never_run, it just means this cycle can't compute health, which the evaluator surfaces
// as `has_run_record: false` -> never_run is the honest fallback, not a fabricated state.
// WARROOM-RUNSTATE-001 -- the shared terminal-record query (C6). Both
// computeAgentHealthEval() (via fetchAgentRunLog(), below) and run-state cells
// (buildScrapers()'s TMDB tile) read this SAME query, not two independent ones --
// one number, one source, per the card's C6 extension to health.
//
// Returns, per job: {run_id, last_started, last_finished, last_exit, terminalDurationsMs}.
// `terminalDurationsMs` is every terminal run's (finished_at - started_at) in ms, most
// recent 20, used for WarroomRunstate's p95 bootstrap -- capped at 20 rows/job so this
// stays a cheap query, not a full-table scan per generation cycle.
function fetchRunLogTerminalByJob(jobs) {
  try {
    const token = readEnvVar('MOTHERDUCK_TOKEN');
    if (!token || !jobs || jobs.length === 0) return {};
    const jobList = jobs.map(j => `'${j.replace(/'/g, "''")}'`).join(',');
    const sql = `
      WITH latest AS (
        SELECT job, run_id, started_at, finished_at, exit_code,
               row_number() OVER (PARTITION BY job ORDER BY started_at DESC) AS rn
        FROM ops.run_log WHERE job IN (${jobList})
      ),
      terminal_durs AS (
        SELECT job, epoch(finished_at) - epoch(started_at) AS dur_s,
               row_number() OVER (PARTITION BY job ORDER BY started_at DESC) AS rn
        FROM ops.run_log WHERE job IN (${jobList}) AND finished_at IS NOT NULL
      )
      SELECT l.job, l.run_id, l.started_at, l.finished_at, l.exit_code,
             (SELECT list(dur_s) FROM terminal_durs t WHERE t.job = l.job AND t.rn <= 20) AS durs_s
      FROM latest l WHERE l.rn = 1`;
    // STATUS-PROCLEAK-001: array-form spawnSync, NOT execSync-through-a-shell.
    // execSync's timeout kills only /bin/sh, orphaning the duckdb grandchild
    // (which holds a live MotherDuck connection) forever. Direct-binary spawn
    // makes duckdb the direct child, so killSignal actually reaps it. Passing
    // the SQL as its own argv entry also removes the shell-quoting hazard.
    const _r = spawnSync(
      '/opt/homebrew/bin/duckdb',
      ['-json', '-c', sql.replace(/\n/g, ' '), 'md:sasmaster'],
      { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, motherduck_token: token } }
    );
    const out = (_r.status === 0 && _r.stdout) ? _r.stdout : '';
    const rows = JSON.parse(out);
    const byJob = {};
    for (const r of rows) {
      byJob[r.job] = {
        run_id: r.run_id,
        last_started: r.started_at,
        last_finished: r.finished_at,
        last_exit: r.exit_code,
        terminalDurationsMs: (r.durs_s || []).map(s => s * 1000),
      };
    }
    return byJob;
  } catch (e) {
    return {};
  }
}

// WARROOM-HEALTH-001 Phase 4 -- projects the latest run_log row per job for the agents in
// AGENT_HEALTH_CONFIG out of an already-fetched byJob map.
// WARROOM-RUNSTATE-001 remediation (gap 3, C6 tightened): this used to call
// fetchRunLogTerminalByJob() a SECOND time with its own job list -- same query shape as the
// TMDB tile's call, but a genuinely separate execSync/duckdb round trip, so health and
// run-state could in principle observe two different snapshots of the run-log within the
// same generation cycle. Now takes the single runstateByJob result computed once in main
// (ALL_WIRED_JOBS, see below) and projects from it -- one query, three consumers (TMDB
// tile, health, QUEUE jobs-running count), not "one query shape called three times".
function fetchAgentRunLog(byJob) {
  const out = {};
  for (const job in (byJob || {})) {
    out[job] = { last_exit: byJob[job].last_exit, last_started: byJob[job].last_started };
  }
  return out;
}

// WARROOM-PIPELINE-RESTORE-001 (2026-08-27) — the C7 structured blocked_signal contract
// the line above used to note as unimplemented ("no agent yet emits..."). An agent that
// needs to report a genuine, non-crash "blocked, awaiting Shiv" state (LinkedIn Agent's
// "No theme set" is the first/reference case) writes a structured entry to this file —
// never by this module regexing lastOutput/log prose (C7 forbids that explicitly). Fails
// open (empty map) on any read error: an unreadable/missing signals file is not evidence
// of "nothing is blocked," it just means this cycle can't add that signal — the evaluator
// falls through to its normal has_run_record/cadence-based classification, same as before
// this file existed.
const AGENT_BLOCKED_SIGNALS_FILE = path.join(SASMASTER, 'data', 'agent-blocked-signals.json');
function readAgentBlockedSignals() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_BLOCKED_SIGNALS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

// WARROOM-HEALTH-001 — computes the evaluator result for one agent. Pulled out of
// parseAgents()'s .map() so every return branch (including the three early-return paths
// for statusOverride/no-log/no-logfile agents) gets a healthEval, never a missing field a
// render call site would crash on.
function computeAgentHealthEval(a, runLogByJob, blockedSignalsByJob) {
  const cfg = AGENT_HEALTH_CONFIG[a.name];
  if (!cfg) {
    // Marketplace/subagent/drafted agents (37 of 51) — not in the live-cron denominator
    // (parseAgents()'s own pre-existing type filter excludes them); no health claim made.
    return { state: 'na', age: null, reason: 'on-demand, not schedule-evaluated', inputs: null };
  }
  const runRow = cfg.job ? runLogByJob[cfg.job] : undefined;
  const blockedSignal = (cfg.job && blockedSignalsByJob && blockedSignalsByJob[cfg.job]) || null;
  try {
    return WarroomHealth.evaluateHealth({
      last_run: runRow ? runRow.last_started : null,
      last_exit: runRow ? runRow.last_exit : null,
      cadence_ms: cfg.cadence_ms,
      expected_state: cfg.expected_state,
      has_run_record: !!runRow,
      blocked_signal: blockedSignal, // WARROOM-PIPELINE-RESTORE-001: read from readAgentBlockedSignals(), see above
      now: WarroomClock.nowUtc(),
      agentStaleMult: AGENT_STALE_MULT,
      feedStaleMult: FEED_STALE_MULT
    });
  } catch (e) {
    // GATE-A unresolved (AGENT_STALE_MULT/FEED_STALE_MULT both null) -> evaluateHealth()
    // throws by design; surfaced as an explicit gate-blocked state, never a guessed one.
    // NOTE (WARROOM-PIPELINE-RESTORE-001): this throw fires BEFORE evaluateHealth() ever
    // reaches its blocked_signal check, so an agent with a real, correctly-wired
    // blockedSignal (e.g. LinkedIn Agent) still renders 'error | gate-a-unresolved', not
    // 'blocked', until Shiv rules on GATE-A (see WARROOM-HEALTH-001 card, options i/ii/iii).
    // That is a real, pre-existing, orthogonal blocker on ALL 14 schedule-evaluated agents
    // (confirmed live in status.json at the time of this pass) — not something this card
    // should route around by relaxing the guard (that would be exactly the "guessed
    // threshold" GATE-A exists to prevent).
    return { state: 'error', age: null, reason: 'gate-a-unresolved', inputs: null };
  }
}

// ── WARROOM-AGENT-RUNPLANE-001 (2026-08-27) — schedule/next-fire from the scheduler, not prose ──
// ONE-SOURCE-001 (§22) + GATE-C. parseAgents()'s agent literals below carry hand-typed
// `schedule`/`nextRun` prose ("Daily 5:30AM", "Tomorrow 6AM", "Post 12AM build"). Those strings
// are written once and then rot silently against the real scheduler, and three had already
// drifted when this pass measured them against the live crontab:
//   - Security Watchdog  displayed "Daily 5:30AM"  · actually `30 9 * * *`  (9:30 AM)
//   - DoneLog Analyst    displayed "Post-build"    · actually `0 12 * * *`  (noon daily)
//   - Financial Analyst  displayed "Sunday 8PM"    · actually `10 20 * * 0` (Sun 8:10 PM)
// (the crontab COMMENT lies too — `# SaSMaster-security-watchdog-daily530am` on the 9:30 line —
// which is exactly why the label must be derived from the expression, never from any prose.)
//
// Authority is WARROOM-AGENTLIB-001's `~/SaSMaster/agent-registry.json`: a generated,
// DO-NOT-EDIT-BY-HAND join of crontab + launchd + manifest + run_log whose `schedule_raw` is
// the real scheduler expression and whose `next_fire_utc` comes from its own cron expansion
// module (scripts/agentlib/lib/next-fire.js). We read it; we do not re-derive it here (C6).
//
// Fails OPEN: an unreadable/absent/stale registry leaves every agent's existing literal exactly
// as it was — this override can correct a label, never blank one. It also only ever REPLACES a
// value for an agent the registry actually holds a schedule for; it never invents one for an
// agent with no scheduler entry (GATE-C: guessing a cadence silently invents the threshold that
// decides green).
const AGENT_REGISTRY_FILE = path.join(SASMASTER, 'agent-registry.json');
// The registry generator's own cron-expansion module — imported, never reimplemented (C6).
// Optional: if it can't be loaded, applyRegistrySchedule() still corrects the SCHEDULE label
// (the drift that matters most) and simply declines to state a next fire, rather than falling
// back to a second, divergent cron implementation.
let NextFire = null;
try { NextFire = require(path.join(SASMASTER, 'scripts', 'agentlib', 'lib', 'next-fire.js')); }
catch { NextFire = null; }
// Display name -> agent-registry.json `id`. Most match AGENT_HEALTH_CONFIG's `job`; the two
// that don't are recorded here rather than papered over by fuzzy matching.
const AGENT_REGISTRY_ID = {
  'Media Intel':       'media-intel-agent',
  'TMDB Daily':        'tmdb-daily-agent',
  'DoneLog Analyst':   'donelog-analyst',
  'LinkedIn Agent':    'linkedin-agent',
  'SEC EDGAR':         'edgar-scraper',
  'Tech Intel':        'tech-intel-agent',
  'Financial Analyst': 'financial-analyst',
  'Weekly Review':     'weekly-review-agent',
  'IAB Intel':         'iab-agent',
  'Security Watchdog': 'security-watchdog',
  'Railway Monitor':   'railway-monitor',
  // id differs from the job name — the crontab comment tag is the registry id here.
  'Viz Evaluator':     'SaSMaster-viz-evaluator-quarterly',
  'Mac Worker':        'mac-worker',
};
function readRegistrySchedule() {
  try {
    const reg = JSON.parse(fs.readFileSync(AGENT_REGISTRY_FILE, 'utf8'));
    const byId = {};
    for (const row of (reg.agents || [])) byId[row.id] = row;
    return byId;
  } catch {
    return {};
  }
}
// Renders a scheduler expression as the two display strings the AGENTS cards show.
// `schedule` = what the scheduler says (the expression, verbatim, plus its kind).
// `nextRun`  = the registry's computed next fire, in ET to match the rest of the board.
function applyRegistrySchedule(a, byId) {
  const id = AGENT_REGISTRY_ID[a.name];
  if (!id) return a;
  const row = byId[id];
  if (!row || !row.schedule_raw) return a;

  const out = { ...a, scheduleSource: 'agent-registry.json#' + id, scheduleRaw: row.schedule_raw };
  if (row.schedule_kind === 'cron') {
    out.schedule = row.schedule_raw;
  } else {
    // launchd / always-on descriptors already read as prose in the registry (e.g. mac-worker's
    // "KeepAlive=true (launchd always-on; ...)"). Keep them, but trim to the card's width.
    out.schedule = String(row.schedule_raw).split('(')[0].trim();
  }
  // C6 — compute the INSTANT here, from the registry's expression, using the SAME module the
  // registry generator uses (scripts/agentlib/lib/next-fire.js). We do not re-implement cron
  // expansion, and we do not read the registry's STORED next_fire_utc: the registry regenerates
  // on its own cadence while this runs every 5 minutes, so its stored instant is routinely in
  // the past by the time we read it (measured: every daily agent, hours stale, rendering a
  // already-elapsed time as the NEXT run). Expression = registry's to declare; instant = ours to
  // evaluate at render time. The module is ET-aware, which matters because the crontab it came
  // from is interpreted in local ET, not UTC.
  let nextFireUtc = null;
  if (NextFire && row.schedule_kind === 'cron') {
    try {
      nextFireUtc = NextFire.computeNextFire(
        { schedule_kind: 'cron', schedule_raw: row.schedule_raw }, Date.now()
      ).next_fire_utc;
    } catch { nextFireUtc = null; }
  }

  if (nextFireUtc) {
    // Two traps this formatting has to avoid, both caught by verifying the FIRST version of
    // this function against real registry rows rather than trusting it:
    //
    // (1) STALE REGISTRY. agent-registry.json is generated on its own cadence, so a fast-cadence
    //     agent's stored next_fire is already in the past by the time the 5-min status cycle
    //     reads it (Railway Monitor, */15, was rendering "Thu 2:45 AM" — a past instant printed
    //     as the NEXT run). A next-fire in the past is not a next fire; say the registry is
    //     stale rather than print a time that has already happened.
    // (2) DROPPED DATE. A weekday+time-only format collapses every future fire into "this week":
    //     Viz Evaluator's real next fire, 2026-10-01, rendered as "Thu 9:00 AM" — indistinguishable
    //     from tomorrow. Include the calendar date whenever the fire is more than a week out.
    const fire = new Date(nextFireUtc);
    const ageMs = Date.now() - fire.getTime();
    if (!(fire instanceof Date) || isNaN(fire.getTime())) {
      out.nextRun = 'N/A — unparseable next_fire in registry';
    } else if (ageMs > 0) {
      out.nextRun = 'N/A — registry next-fire is stale (' + fire.toISOString().slice(0, 16) + 'Z)';
    } else {
      const withinAWeek = (-ageMs) < 7 * 24 * 3600000;
      out.nextRun = fire.toLocaleString('en-US', withinAWeek
        ? { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }
        : { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  } else {
    // No next fire is a real fact for an always-on daemon — say that, don't leave a stale date.
    out.nextRun = 'always on';
  }
  return out;
}

// ── GATE-B fleet classification (RULED 2026-08-27) ───────────────────────────────────────
// Three classes, each defined by an observable fact about the agent, never by a hand-kept list
// that would drift the moment an agent gains or loses a scheduler entry:
//
//   'scheduled'  — has a real installed scheduler entry AND a declared cadence, so its liveness
//                  is a cadence question. These are the PRIMARY agents: they are the health
//                  denominator, and they sort first (Shiv's ruling: prioritise the primary
//                  agents over the nice-to-haves).
//   'event'      — genuinely live but not cadence-evaluated: always-on daemons (JARVIS, Mac
//                  Worker), event-triggered in-process calls (Data Guardian), scaffolds
//                  (Research Portal) and drafted-but-gated agents (Gracenote OnConnect).
//                  Liveness here is a process/trigger question, so scoring them against a
//                  cadence would mark a perfectly healthy daemon stale.
//   'invocable'  — Claude Code persona definitions (.claude/agents/*.md). No process, no log,
//                  no exit code. They cannot be cron-scheduled or job-queue dispatched, and
//                  inventing a cadence for them would fabricate liveness — exactly what GATE-B
//                  exists to prevent. Excluded from the health denominator; never 'retired',
//                  which would hide them.
//
// 'scheduled' is derived from AGENT_HEALTH_CONFIG holding a numeric cadence — the same table
// the evaluator reads — so an agent cannot be counted in the denominator by one rule and
// health-evaluated by another (C6).
// The 'event' class is an EXPLICIT named set, not a type-field heuristic. `type:'subagent'`
// mixes two unlike things — real processes (Mac Worker's launchd daemon) and Claude Code
// persona definitions (Autonomous Coder, Data Modeler) — so classifying on it put personas in
// the live class. Each name below was inspected this pass and has a real process, trigger, or
// scaffold behind it; everything else that isn't scheduled is a persona.
const AGENT_EVENT_CLASS = new Set([
  'JARVIS',               // Railway HTTP Events API daemon — always on
  'Mac Worker',           // com.sasmaster.mac-worker, launchd KeepAlive daemon
  'Data Guardian',        // event-triggered in-process call after ingestion
  'Research Portal',      // scaffolded, no entrypoint on disk yet
  'Gracenote OnConnect',  // drafted, spine-promotion GATED
  'Nielsen Orchestrator', // real orchestrator, but no scheduler entry of its own (2026-08-27 audit)
]);
function classifyAgent(a) {
  const cfg = AGENT_HEALTH_CONFIG[a.name];
  // 'scheduled' is derived from a NUMERIC cadence in the evaluator's own table — so an agent
  // in AGENT_HEALTH_CONFIG with cadence_ms:null (JARVIS, Research Portal, Data Guardian) is
  // correctly NOT counted in a denominator it could never score healthy against.
  if (cfg && typeof cfg.cadence_ms === 'number') return { ...a, classification: 'scheduled' };
  if (AGENT_EVENT_CLASS.has(a.name)) return { ...a, classification: 'event' };
  return { ...a, classification: 'invocable' };
}
const FLEET_CLASS_ORDER = { scheduled: 0, event: 1, invocable: 2 };
// Stable sort: primary (scheduled) agents first, then event/daemon, then personas. Within a
// class the original hand-authored order is preserved — Array.prototype.sort is stable in
// Node 20, and the index tiebreak makes that explicit rather than relying on it.
function sortFleetByPriority(agents) {
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const d = (FLEET_CLASS_ORDER[x.a.classification] ?? 9) - (FLEET_CLASS_ORDER[y.a.classification] ?? 9);
      return d !== 0 ? d : x.i - y.i;
    })
    .map(x => x.a);
}

function parseAgents(allWiredRunstateByJob) {
  const LOG = path.join(SASMASTER, 'logs');
  const runLogByJob = fetchAgentRunLog(allWiredRunstateByJob);
  const agents = [
    { name: 'JARVIS',            icon: '🤖', schedule: 'HTTP API',      nextRun: 'Always on',       log: 'jarvis.log',            channel: 'HTTP Events API',    jobId: null, descOverride: 'HTTP Events API (Railway) — Socket Mode daemon retired' },
    { name: 'Media Intel',       icon: '📡', schedule: '6AM daily',     nextRun: 'Tomorrow 6AM',    log: 'media-intel.log',       channel: '#sasmaster-intel',   jobId: 'media-intel' },
    { name: 'TMDB Daily',        icon: '📺', schedule: '5AM daily',     nextRun: 'Tomorrow 5AM',    log: 'tmdb-agent.log',        channel: '#sasmaster-intel',   jobId: 'tmdb-daily' },
    { name: 'DoneLog Analyst',   icon: '📊', schedule: 'Post-build',    nextRun: 'Post 12AM build', log: 'donelog-analyst.log',   channel: '#sasmaster-builds',  jobId: null },
    { name: 'LinkedIn Agent',    icon: '✍️',  schedule: 'Monday 8PM',   nextRun: 'Mon 8PM',         log: 'linkedin-agent.log',    channel: '#sasmaster-content', jobId: 'linkedin-agent' },
    { name: 'SEC EDGAR',         icon: '📑', schedule: '6:30 AM daily', nextRun: 'Tomorrow 6:30 AM',log: 'sec-edgar.log',         channel: '#sasmaster-intel',   jobId: null },
    { name: 'Tech Intel',        icon: '🛰️', schedule: 'Friday 6PM',   nextRun: 'Fri 6PM',         log: 'tech-intel.log',        channel: '#sasmaster-intel',   jobId: 'tech-intel' },
    { name: 'Financial Analyst', icon: '💰', schedule: 'Sunday 8PM',   nextRun: 'Sun 8PM',         log: 'financial-analyst.log', channel: '#sasmaster-intel',   jobId: null },
    { name: 'Weekly Review',     icon: '🗂️', schedule: 'Sunday 8PM',   nextRun: 'Sun 8PM',         log: 'weekly-review.log',     channel: '#sasmaster-content', jobId: 'weekly-review' },
    { name: 'IAB Intel',         icon: '📡', schedule: 'Monday 7AM',   nextRun: 'Mon 7AM',         log: 'iab-agent.log',         channel: '#sasmaster-intel',   jobId: 'iab-intel' },
    { name: 'Security Watchdog', icon: '🔐', schedule: 'Daily 5:30AM', nextRun: 'Tomorrow 5:30AM', log: 'security-watchdog.log', channel: '#sasmaster-builds',  jobId: null },
    { name: 'Railway Monitor',   icon: '🛤️', schedule: 'Every 15min',  nextRun: 'In ≤15min',       log: 'railway-monitor.log',   channel: '#sasmaster-builds',  jobId: null },
    { name: 'Research Portal',   icon: '🔬', schedule: 'TBD',          nextRun: 'Pending launch',  log: 'research-portal-agent.log', channel: '#sasmaster-intel', jobId: null, descOverride: 'SCAFFOLDED — pending RESEARCH-PORTAL-001 launch' },
    { name: 'Data Guardian',     icon: '🛡️', schedule: 'Post-ingestion', nextRun: 'After next pull', log: 'data-guardian.log',         channel: '#sasmaster-builds',  jobId: null, type: 'subagent', descOverride: 'Post-ingestion integrity enforcer — snapshot → AMRLD anomaly detection (RULE-HH-01..04) → Tier 2 gate. Wired into nielsen_puller.py via _run_data_guardian(). Event-triggered (not scheduled) — excluded from live-cron liveness denominator.' },

    // ── Drafted (on-demand, no cron yet) ────────────────────
    { name: 'Gracenote OnConnect', icon: '🎬', schedule: 'on-demand (JARVIS)', nextRun: '—', log: 'gn-onconnect.log', channel: '#sasmaster-builds', jobId: null, type: 'drafted', statusOverride: 'drafted', descOverride: 'Resolve+fuse drafted · self-tests green · spine-promotion GATED (tier UNCONFIRMED)' },

    // ── SaSMaster Claude Code sub-agents ────────────────────
    { name: 'Autonomous Coder',     icon: '⚡', schedule: 'On-demand',     nextRun: 'Contextual',   log: null, channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Primary build executor. Phase I pipeline. cost-log writer (13-field schema). Reads build-discipline before every task. Model: Sonnet 4.6.' },
    { name: 'Data Modeler',         icon: '📐', schedule: 'On-demand',     nextRun: 'Contextual',   log: null, channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Schema design, S3 paths, DuckDB query patterns, Parent Key v1. Consults before any dataset onboarding or schema change. Model: Opus 4.7.' },
    // WARROOM-AGENT-RUNPLANE-001 (2026-08-27): was `type: 'subagent'`, which routed it to
    // computeAgentHealthEval()'s "N/A — on-demand, not schedule-evaluated" branch. That was
    // false: it has a real installed cron entry (`0 9 1 */3 *`, tag
    // SaSMaster-viz-evaluator-quarterly, confirmed in the live crontab), so it IS
    // schedule-evaluated and belongs in the live denominator. Its `nextRun` literal was also
    // stale-in-the-past ("1 Aug 9AM"); both fields now come from agent-registry.json (next
    // fire 2026-10-01) via applyRegistrySchedule(), so they cannot drift again.
    { name: 'Viz Evaluator',        icon: '📊', schedule: '0 9 1 */3 *',  nextRun: 'Wed, 1 Oct, 9:00 AM', log: 'viz-evaluate-cron.log', channel: '#sasmaster-builds', jobId: null, descOverride: 'Benchmarks all 14 chart renderers vs npm ecosystem. Proposes swaps via Slack. cron 0 9 1 */3 *. Never auto-swaps without approval.' },
    // WARROOM-AGENT-RUNPLANE-001 (2026-08-27): "Tue 5PM / Next Tue 5PM / launchd Tue 5PM" was
    // an unbacked claim — there is no orchestrator entry in the crontab and no
    // com.sasmaster.nielsen-orchestrator plist. The only related scheduler entry is
    // com.sasmaster.nielsen-puller (StartCalendarInterval Weekday=3, Hour=6 → WEDNESDAY 6AM),
    // and nielsen-puller-launch.sh does not invoke the orchestrator (grepped: no match). So
    // this agent has no scheduler of its own. Per GATE-C that renders as "no cadence declared"
    // — it is NOT re-labelled to the puller's Wed 6AM, which would attribute someone else's
    // schedule to it. Closing this properly is a Shiv call, tracked in the card.
    { name: 'Nielsen Orchestrator', icon: '📡', schedule: 'no scheduler entry', nextRun: 'N/A — no cadence declared', log: null, channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Staleness check → scope decision → triggers nielsen_puller.py → validates row counts → JARVIS summary. NO scheduler entry of its own (2026-08-27 audit) — the Tue 5PM claim was unbacked; nearest real entry is com.sasmaster.nielsen-puller, Wed 6AM, which does not call it.' },
    // WARROOM-AGENT-RUNPLANE-001 (2026-08-27): "5min heartbeat / In ≤5min" conflated this with
    // com.sasmaster.worker-heartbeat (a real StartInterval=300 job — a DIFFERENT launchd unit).
    // Mac Worker itself is com.sasmaster.mac-worker: KeepAlive=true, i.e. an always-on daemon
    // (agents/mac-worker.js is three setInterval loops that never exit; the 5-min figure is one
    // interval INSIDE the running process, not a scheduler cadence). Labelled always-on, and
    // deliberately left out of AGENT_HEALTH_CONFIG: a daemon's liveness is a process check, not
    // a cadence check, and giving it a fake cadence would make an alive daemon score "stale".
    { name: 'Mac Worker',           icon: '💻', schedule: 'launchd KeepAlive', nextRun: 'always on', log: 'mac-worker.log', channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Mac 64GB compute worker (persistent launchd daemon, KeepAlive). Polls Railway /tasks/pending-compute every 60s; heartbeat every 5 min in-process. Capabilities: duckdb / scraper / claude-code / ml.' },

    // ── Marketplace T1 — python-development ─────────────────
    { name: 'python-pro',           icon: '🐍', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'python-development',    descOverride: 'Master Python 3.12+ — async, performance optimization, uv/ruff/pydantic/FastAPI. T1 marketplace.' },
    { name: 'django-pro',           icon: '🌿', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'python-development',    descOverride: 'Django 5.x async views, DRF, Celery, Channels. Scalable web apps + ORM optimization. T1 marketplace.' },
    { name: 'fastapi-pro',          icon: '⚡', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'python-development',    descOverride: 'FastAPI with SQLAlchemy 2.0 and Pydantic V2. High-performance async APIs + microservices. T1 marketplace.' },

    // ── Marketplace T1 — llm-application-dev ────────────────
    { name: 'ai-engineer',          icon: '🤖', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'llm-application-dev',   descOverride: 'LLM applications, advanced RAG, intelligent agents. Vector search, multimodal AI, agent orchestration. T1 marketplace.' },
    { name: 'prompt-engineer',      icon: '💬', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'llm-application-dev',   descOverride: 'Advanced prompting, chain-of-thought, constitutional AI, production prompt strategies. T1 marketplace.' },
    { name: 'vector-db-engineer',   icon: '🔢', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'llm-application-dev',   descOverride: 'Pinecone, Weaviate, Qdrant, Milvus, pgvector. RAG apps + semantic search. T1 marketplace.' },

    // ── Marketplace T1 — observability-monitoring ────────────
    { name: 'observability-engineer', icon: '📈', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Monitoring, logging, tracing, SLI/SLO management, incident response workflows. T1 marketplace.' },
    { name: 'performance-engineer', icon: '🏎️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Profile and optimize response times, memory usage, query efficiency, scalability. T1 marketplace.' },
    { name: 'network-engineer',     icon: '🌐', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Cloud networking, CDN optimization, service mesh, zero-trust, SSL/TLS. T1 marketplace.' },
    { name: 'database-optimizer',   icon: '🗄️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Query optimization, N+1 resolution, multi-tier caching, partitioning, cloud DB. T1 marketplace.' },

    // ── Marketplace T1 — security-scanning ──────────────────
    { name: 'security-auditor',     icon: '🔐', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'security-scanning',       descOverride: 'OWASP Top 10, auth flaws, compliance, code security review. T1 marketplace.' },
    { name: 'threat-modeling',      icon: '🎯', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'security-scanning',       descOverride: 'STRIDE, PASTA, attack trees, security requirement extraction. Secure-by-design systems. T1 marketplace.' },

    // ── Marketplace T1 — agent-teams + conductor ─────────────
    { name: 'conductor-validator',  icon: '🎼', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Validates Conductor project artifacts for completeness, consistency, and correctness. T1 marketplace.' },
    { name: 'team-lead',            icon: '👥', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Team orchestrator that decomposes work into parallel tasks with file ownership boundaries. T1 marketplace.' },
    { name: 'team-implementer',     icon: '🔨', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Parallel feature builder within strict file ownership boundaries + integration coordination. T1 marketplace.' },
    { name: 'team-reviewer',        icon: '🔍', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Multi-dimensional code reviewer: security, performance, architecture, testing, accessibility. T1 marketplace.' },
    { name: 'team-debugger',        icon: '🐛', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Hypothesis-driven debugging investigator. Evidence gathering with file:line citations. T1 marketplace.' },

    // ── Marketplace T2 — backend-development ─────────────────
    { name: 'backend-architect',    icon: '🏗️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'REST/GraphQL/gRPC APIs, event-driven architectures, service mesh, microservices patterns. T2 marketplace.' },
    { name: 'event-sourcing',       icon: '📦', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'Event sourcing, CQRS, event store design, projection building, saga orchestration. T2 marketplace.' },
    { name: 'graphql-architect',    icon: '🔷', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'GraphQL federation, performance optimization, advanced caching, real-time systems. T2 marketplace.' },
    { name: 'temporal-python-pro',  icon: '⏱️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'Temporal workflow orchestration, durable workflows, saga patterns, distributed transactions. T2 marketplace.' },

    // ── Marketplace T2 — cicd-automation ─────────────────────
    { name: 'cloud-architect',      icon: '☁️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'AWS/Azure/GCP/OCI multi-cloud, Terraform/CDK, FinOps cost optimization, serverless. T2 marketplace.' },
    { name: 'deployment-engineer',  icon: '🚀', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'CI/CD pipelines, GitOps, GitHub Actions, ArgoCD/Flux, zero-downtime deployments. T2 marketplace.' },
    { name: 'devops-troubleshooter', icon: '🔧',schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'Incident response, log analysis, distributed tracing, Kubernetes debugging. T2 marketplace.' },
    { name: 'kubernetes-architect', icon: '⎈',  schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'EKS/AKS/GKE/OKE, Istio/Linkerd, progressive delivery, multi-tenancy, platform engineering. T2 marketplace.' },
    { name: 'terraform-specialist', icon: '🏔️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'IaC automation, state management, multi-cloud deployments, GitOps for infrastructure. T2 marketplace.' },

    // ── Marketplace T2 — javascript-typescript ───────────────
    { name: 'typescript-pro',       icon: '🔵', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'javascript-typescript',   descOverride: 'Advanced TypeScript, generics, strict type safety, decorators, enterprise patterns. T2 marketplace.' },
    { name: 'javascript-pro',       icon: '🟡', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'javascript-typescript',   descOverride: 'ES6+, async patterns, Node.js APIs, promises, event loops, browser/Node compat. T2 marketplace.' },

    // ── Marketplace T2 — machine-learning-ops ────────────────
    { name: 'data-scientist',       icon: '📊', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'machine-learning-ops',    descOverride: 'Advanced analytics, ML modeling, statistical analysis, data-driven insights. T2 marketplace.' },
    { name: 'ml-engineer',          icon: '🧠', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'machine-learning-ops',    descOverride: 'PyTorch 2.x, TensorFlow, model serving, feature engineering, A/B testing. T2 marketplace.' },
    { name: 'mlops-engineer',       icon: '⚙️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'machine-learning-ops',    descOverride: 'MLflow, Kubeflow, automated training pipelines, model registries, ML monitoring. T2 marketplace.' },
  ];

  const blockedSignalsByJob = readAgentBlockedSignals();
  const registrySchedule = readRegistrySchedule();
  return sortFleetByPriority(agents.map(a => {
    a = applyRegistrySchedule(a, registrySchedule);
    a = classifyAgent(a);
    const healthEval = computeAgentHealthEval(a, runLogByJob, blockedSignalsByJob);
    if (a.statusOverride) return { ...a, lastRun: null, lastOutput: a.descOverride || null, status: a.statusOverride, healthEval };
    if (!a.log) return { ...a, lastRun: null, lastOutput: a.descOverride || null, status: 'idle', healthEval };
    const logFile = path.join(LOG, a.log);
    if (!fs.existsSync(logFile)) return { ...a, lastRun: null, lastOutput: a.descOverride || null, status: 'never', healthEval };

    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const last  = lines[lines.length - 1] || '';

    const tsMatch = last.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const lastRun = tsMatch ? tsMatch[1] : null;

    const summary = a.descOverride || last.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/, '')
                        .replace(/^\[[A-Z0-9_-]+\]\s*/i, '')
                        .slice(0, 80);

    const routingErr = /not_in_channel/i.test(last);
    const hardError  = !routingErr && /error|fatal/i.test(last);
    // Preserved as-is: 'routing'/'error'/'healthy' here feed OTHER consumers outside this
    // card's scope (e.g. the DATA-tab SEC EDGAR scraper indicator, which reads
    // a.status==='routing') — not the AGENTS-tab health badge, which now reads healthEval
    // instead of this field (C6: one evaluator for the badge; this field's remaining
    // consumers are a genuinely different signal, not a second health computation).
    const status     = hardError ? 'error' : routingErr ? 'routing' : 'healthy';

    return { ...a, lastRun, lastOutput: summary, status, healthEval };
  }));
}

// ── Intel feed ───────────────────────────────────────────────────────────────
function parseIntelFeed() {
  const file = path.join(SASMASTER, 'status', 'intel-feed.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).filter(i => i.text);
  } catch { return []; }
}

// ── Target 10 ────────────────────────────────────────────────────────────────
function parseTarget10() {
  const file = path.join(SASMASTER, 'target10.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).filter(t => t.name);
  } catch { return []; }
}

// ── TMDB bulk loader progress ────────────────────────────────────────────────
function parseTMDBProgress() {
  const file = path.join(SASMASTER, 'status', 'tmdb-progress.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── S3 inventory (from scripts/s3-inventory.js cache) ────────────────────────
function parseS3Inventory() {
  const file = path.join(SASMASTER, 'status', 's3-inventory.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function parseWarroomDataS3Total() {
  // Single source of truth: artifact_metrics_latest.json (.s3), written nightly
  // by artifact_metrics_pull.py with a last-good guard, so it never regresses to
  // null on a failed scan. (Replaces the retired data/warroom-data.json, which
  // was a second competing pipeline — see WARROOM-DATA-CONSOLIDATE-001.)
  try {
    const file = path.join(__dirname, 'resources', 'artifact_metrics_latest.json');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Prefer the authoritative WHOLE-BUCKET total (measured by --full-scan, 6.5M
    // objects = 2.77 TB) over the curated-prefix sum, which undercounts because
    // it only covers the 20 dataset prefixes (not knowledge-bank/artifacts/etc.).
    if (d?.s3_bucket_total_gb > 0) return Math.round(d.s3_bucket_total_gb * 10) / 10;
    const s3 = d?.s3 || {};
    const total = Object.values(s3).reduce((sum, v) => sum + (v?.gb || 0), 0);
    return total > 0 ? Math.round(total * 10) / 10 : null;
  } catch { return null; }
}

// ── S3 entity counts — compute-on-write, read-only ───────────────────────────
// Primary: read warroom/counts.json from S3 (written by each job + nightly recompute)
// Fallback: local status/s3-entity-counts.json (written by build_data_counts.py)
function parseS3EntityCounts() {
  // Try S3 primary first
  try {
    const raw = safeExec('/opt/homebrew/bin/aws s3 cp s3://sasmaster-2026/warroom/counts.json - 2>/dev/null');
    if (raw) return JSON.parse(raw);
  } catch {}
  // Local fallback
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SASMASTER, 'status', 's3-entity-counts.json'), 'utf8'));
    return raw.prefixes || raw;
  } catch { return {}; }
}

// Staleness thresholds per prefix (hours). Missing prefix = no staleness check.
const STALE_HOURS = {
  'parent_keys/': 72,    // match jobs run on-demand; flag after 3 days of silence
  'tmdb_dev/':    360,   // biweekly delta = 15 days
  'imdb/':        840,   // monthly re-pull = 35 days
  'gracenote/':   720,   // 30 days
  'fyi/':         720,   // 30 days
  'nielsen/':     192,   // Tuesday 5PM puller = 8 days
};

function countBlockStale(prefix, computedAt) {
  const threshold = STALE_HOURS[prefix];
  if (!threshold || !computedAt) return false;
  const ageHours = (Date.now() - new Date(computedAt).getTime()) / 3_600_000;
  return ageHours > threshold;
}

// ── IMDB agent status (from scripts/imdb-agent.js post-run) ──────────────────
function parseImdbStatus() {
  const file = path.join(SASMASTER, 'status', 'imdb-status.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── EIDR v2 coverage (from eidr-progress.json) ───────────────────────────────
function parseEidrProgress() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(SASMASTER, 'status', 'eidr-progress.json'), 'utf8'));
    if (p.phase !== 'complete') return null;
    return {
      total:        parseInt(p.total,        10) || null,
      eidr_matched: parseInt(p.eidr_matched, 10) || null,
      eidr_pct:     parseFloat(p.eidr_pct)       || null,
      out_date:     p.out_date || null,
      source:       p.source   || null,
    };
  } catch { return null; }
}

// ── S3 Freshness (age in hours per key prefix) ───────────────────────────────
// ONE-SOURCE-001: this function is the SINGLE authority for S3 prefix freshness.
// The DATA tab stale badge, the War Room KPI freshness chip, and the health score
// freshness component ALL read from s3_lake[].fresh (computed here).
// No other freshness logic for S3 prefixes exists in this file.
// Authority source: `aws s3api list-objects-v2` per prefix, most-recent LastModified.
// Prefixes too large to enumerate within budget resolve via FRESHNESS_MARKER_PREFIX
// (below) instead of being reported as permanently stale.
// STATUS-PROCLEAK-001 phase 7 — prefixes that cannot be enumerated within the
// 8s budget. `nielsen/laapp/` holds millions of objects across 4,095+
// `_date_str=YYYY-MM-DD` partitions; listing it always timed out, so it has been
// silently reporting `fresh: false` forever — a permanent false-stale feeding the
// DATA tab badge, the KPI chip, and the health score.
//
// Resolve those via a small marker prefix instead. For laapp that is `_hwm/`,
// which s3-data-architect names the single source of truth for restart position:
// 13 small JSON markers, one LIST, no GETs, sub-second.
//
// Deliberately NOT `_freshness/run_manifest.json` — that records when the puller
// LAUNCHED, not when data COMMITTED. On 2026-08-27 it read 2026-08-19 while the
// newest committed data was 2026-06-20. Trusting it would have reported a fresh
// green on a prefix 67 days stale, which is worse than the false-stale it replaces.
const FRESHNESS_MARKER_PREFIX = {
  'nielsen/laapp/': 'nielsen/laapp/_hwm/',
};

function getS3Freshness(prefixes = []) {
  const result = {};
  for (const prefix of prefixes) {
    const listPrefix = FRESHNESS_MARKER_PREFIX[prefix] || prefix;
    try {
      // PROCESS-LEAK FIX (2026-08-27): this used to be
      //   execSync(`aws s3 ls ${prefix} --recursive | sort | tail -1`, { timeout: 8000 })
      // execSync's `timeout` kills ONLY the direct child (/bin/sh) — never its
      // children. So every prefix that exceeded 8s orphaned a live `aws` + `sort`
      // + `tail` trio (reparented to launchd, running forever). On big prefixes
      // like nielsen/laapp/ the recursive listing never finishes, so this leaked
      // 3 processes per such prefix PER RUN. Measured 2026-08-27: 911 orphans,
      // load average 467, box unusable — Obsidian couldn't even get scheduled.
      // Verified empirically that day: spawnSync-through-a-shell still leaked 2
      // grandchildren; a direct-binary spawnSync with no shell and no pipeline
      // leaked 0, because the timed-out process IS the direct child.
      //
      // So: no shell, no pipe. One `aws` process, sorted server-side-ish via
      // JMESPath instead of piping millions of keys through `sort`.
      const r = spawnSync(
        '/opt/homebrew/bin/aws',
        ['s3api', 'list-objects-v2',
         '--bucket', 'sasmaster-2026',
         '--prefix', listPrefix,
         '--query', 'sort_by(Contents,&LastModified)[-1].[LastModified]',
         '--output', 'text'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 8000, killSignal: 'SIGKILL' }
      );
      const out = (r.status === 0 && r.stdout) ? r.stdout : '';
      const match = out.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (!match) {
        // Distinguish 'we could not measure' from 'measured, and it is old'.
        // Both used to collapse to the same {null,false}, so a prefix too large
        // to enumerate was indistinguishable from a genuinely stale one — an
        // unmeasured prefix rendered as a confident red. `reason` is additive;
        // existing consumers reading .fresh/.age_hours are unaffected.
        const reason = r.error ? 'unmeasured:list-timeout' : 'no-objects';
        result[prefix] = { age_hours: null, fresh: false, reason };
        continue;
      }
      const lastMod = new Date(match[1] + 'Z');
      const ageHours = Math.round(((Date.now() - lastMod.getTime()) / 3600000) * 10) / 10;
      result[prefix] = { age_hours: ageHours, fresh: ageHours < 24, reason: null };
    } catch {
      result[prefix] = { age_hours: null, fresh: false, reason: 'error' };
    }
  }
  return result;
}

// ── Log mtime helper for per-scraper health ──────────────────────────────────
function logMtime(logName) {
  const p = path.join(SASMASTER, 'logs', logName);
  try { return fs.statSync(p).mtime.toISOString(); }
  catch { return null; }
}

// ── Alerts ───────────────────────────────────────────────────────────────────
function parseAlerts() {
  const file = path.join(SASMASTER, 'status', 'alerts.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

// ── Crontab parser (SaSMaster jobs only) ─────────────────────────────────────
function parseCrontab() {
  let lines;
  try { lines = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }).split('\n'); }
  catch { return []; }

  const jobs = [];
  lines.forEach(line => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    if (!/sasmaster|SaSMaster/i.test(line)) return;

    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)(?:\s*#\s*(.+))?$/);
    if (!m) return;
    const [, min, hr, dom, mon, dow, cmd, comment] = m;

    const h = parseInt(hr, 10);
    const m2 = parseInt(min, 10);
    let timeStr;
    if (isNaN(h) || isNaN(m2)) timeStr = `${hr}:${min}`;
    else {
      const ampm = h < 12 ? 'AM' : 'PM';
      const hh = h % 12 === 0 ? 12 : h % 12;
      timeStr = `${hh}:${String(m2).padStart(2, '0')} ${ampm}`;
    }

    const scriptMatch = cmd.match(/([a-z0-9\-]+\.(sh|js))\b/i);
    const name = comment || (scriptMatch ? scriptMatch[1] : cmd.slice(0, 40));

    let channel = '—';
    if (/intel|edgar|media-intel|tech-intel/i.test(cmd)) channel = '#sasmaster-intel';
    else if (/linkedin|content|tmdb-trending/i.test(cmd)) channel = '#sasmaster-content';
    else if (/build|jarvis|briefing|visuals/i.test(cmd)) channel = '#sasmaster-builds';

    // Weekly/monthly: any non-'*' in dow/dom/mon means this isn't a daily job
    const isWeekly = (dow !== '*' && dow !== '') || (dom !== '*' && dom !== '') || (mon !== '*' && mon !== '');

    // Today's scheduled Date for done/pending comparison
    const scheduledToday = (!isNaN(h) && !isNaN(m2)) ? (() => {
      const d = new Date(); d.setHours(h, m2, 0, 0); return d.getTime();
    })() : null;

    jobs.push({
      time: timeStr,
      name: name.replace(/^SaSMaster-/, '').replace(/-/g, ' '),
      command: cmd,
      channel,
      weekly: isWeekly,
      status: 'pending', // enriched later
      _sortKey: (isNaN(h) ? 0 : h) * 60 + (isNaN(m2) ? 0 : m2),
      _scheduledToday: scheduledToday,
      _min: min, // raw cron minute field — needed for interval-aware liveness (*/5, *, etc.)
      _hr: hr,   // raw cron hour field   — parseInt() can't handle steps/ranges
    });
  });

  return jobs.sort((a, b) => a._sortKey - b._sortKey).map(({ _sortKey, ...rest }) => rest);
}

// ── Scrapers inventory (15-scraper fleet from architecture v8) ───────────────
// Real status hydrated from (a) S3 inventory object counts, (b) agent log
// mtimes, (c) progress JSON. Designed = no data + no script exists. Landing =
// S3 has data but pipeline not fully automated. Live = automated + running.
function buildScrapers(tmdbProgress, doneEntries, s3Inv, agents, imdbStatus, runstateByJob, runstateJobMap) {
  const prefix = name => (s3Inv?.prefixes || []).find(p => p.prefix === name) || {};
  const agentByName = {};
  (agents || []).forEach(a => { agentByName[a.name] = a; });
  const eidrProgress = parseEidrProgress();

  const tmdbP   = prefix('tmdb_dev/');
  const imdbP   = prefix('imdb/');
  const imdbPrd = prefix('imdb_prd/');
  const pkP     = prefix('parent_keys/');
  const nielsenP = prefix('nielsen/');
  const nielsenMITP  = prefix('nielsen/mit/');
  const nielsenAMRLD = prefix('nielsen/amrld/');
  const eidrP   = prefix('eidr/');
  const gracP   = prefix('gracenote/');
  const fyiP    = prefix('fyi/');

  const edgarAgent = agentByName['SEC EDGAR'];

  return [
    // ── Phase 1 — Identity base
    (() => {
      // WARROOM-RUNSTATE-001 -- replaces the pre-fix status ternary
      // (`tmdbProgress?.running ? 'running' : (tmdbProgress?.phase === 'complete' ? 'live' : 'running')`)
      // whose inner ELSE branch also returned 'running' -- so a stale/never-cleared
      // tmdb-progress.json rendered 'running' no matter what. Status now derives
      // exclusively from run_state() over the run-log's terminal record for
      // 'load-tmdb-to-s3' (C3, C6). tmdbProgress.pct is still used for percent display,
      // but ONLY when run_state() itself reports the job as non-terminal (structural
      // invariant: percent is meaningless on a terminal record, WARROOM-RUNSTATE-001 test).
      const job = runstateJobMap && runstateJobMap['TMDB bulk loader'];
      const row = job && runstateByJob ? runstateByJob[job] : null;
      const rs = WarroomRunstate.run_state({
        job, now: WarroomClock.nowUtc(),
        latestRow: row ? { run_id: row.run_id, started_at: row.last_started, finished_at: row.last_finished, exit_code: row.last_exit } : null,
        terminalDurationsMs: row ? row.terminalDurationsMs : [],
        percent: tmdbProgress?.pct ?? null,
        readError: !runstateByJob,
        queryId: 'run_state:load-tmdb-to-s3',
        // WARROOM-RUNSTATE-001 gap 4 -- C4 staleness gate was wired into run_state() itself
        // but this call site (the OPS tile) never passed cadence_ms, so a TERMINAL
        // succeeded/failed TMDB record could never age into STALE here even though the
        // QUEUE/health call sites (below, via ALL_WIRED_JOBS/runStateAll) already did.
        // Same registry as those call sites (C6) -- job is not re-derived twice.
        cadence_ms: job ? JobCadence.get(job) : null,
      });
      // Map run_state()'s state vocabulary onto this tile's pre-existing render vocabulary
      // (running/live/queued/designed etc) rather than inventing a parallel one (C6): a
      // terminal succeeded run renders 'live' (this loader's steady-state, matching the
      // sibling TMDB entity-loader rows below), failed/stuck surface distinctly, non-terminal
      // stays 'running', and the bootstrap/never_run/error states pass through as-is so the
      // renderer (WARROOM-RENDER-001's contract) can apply N/A / ERROR handling.
      const statusMap = { succeeded: 'live', failed: 'failed', running: 'running', stuck: 'stuck', never_run: 'never_run', na_insufficient_history: 'na_insufficient_history', error: 'error' };
      return {
        name: 'TMDB bulk loader',
        phase: '1',
        status: statusMap[rs.state] || rs.state,
        pct: rs.percent,
        row_count: tmdbProgress?.complete ?? null,
        total: tmdbProgress?.total ?? null,
        last_run: rs.finished_at || rs.started_at || tmdbP.last_modified || null,
        s3_path: tmdbProgress?.s3_path ?? 's3://sasmaster-2026/tmdb_dev/',
        run_state: rs, // full run_state() result incl. run_id, threshold, p95, reason -- for provenance / drill-down
      };
    })(),
    { name: 'TMDB delta (biweekly)', phase: '1', status: 'queued', pct: 0, last_run: null,
      note: 'cron: 1st + 16th of month; fetches /movie|tv|person/changes since last run' },
    // TMDB expanded ingest — one scraper per entity loader
    { name: 'TMDB Configuration',    phase: '1', status: prefix('tmdb_dev/configuration/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/configuration/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/configuration/' },
    { name: 'TMDB Collections',      phase: '1', status: prefix('tmdb_dev/collections/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/collections/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/collections/' },
    { name: 'TMDB Networks',         phase: '1', status: prefix('tmdb_dev/networks/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/networks/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/networks/' },
    { name: 'TMDB Companies',        phase: '1', status: prefix('tmdb_dev/companies/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/companies/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/companies/' },
    { name: 'TMDB TV Seasons',       phase: '1', status: prefix('tmdb_dev/tv_seasons/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/tv_seasons/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/tv_seasons/' },
    { name: 'TMDB TV Episodes',      phase: '1', status: prefix('tmdb_dev/tv_episodes/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/tv_episodes/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/tv_episodes/',
      note: 'derived from tv_seasons + IMDB title_episode cross-ref (zero API calls)' },
    { name: 'TMDB Movie Enrichment', phase: '1', status: prefix('tmdb_dev/movies_enrichment/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/movies_enrichment/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/movies_enrichment/',
      note: 'sidecar adding watch_providers+videos+reviews+images to 1.18M pre-v2 movies' },
    {
      name: 'IMDb parser',
      phase: '1',
      status: imdbP.object_count > 0 ? 'live' : 'designed',
      pct: imdbP.object_count > 0 ? 100 : 0,
      row_count: imdbStatus?.counts
        ? (imdbStatus.counts.movies || 0) + (imdbStatus.counts.tv_series || 0) +
          (imdbStatus.counts.episodes || 0) + (imdbStatus.counts.people || 0)
        : 206444399,
      partition: imdbStatus?.partition || null,
      last_run: imdbStatus?.last_run || imdbP.last_modified || logMtime('imdb-parse.log'),
    },
    {
      name: 'SAS-MASTER Parent Key v1',
      phase: '1',
      status: pkP.object_count > 0 ? 'live' : 'designed',
      pct: 100,
      row_count: 861878,      // total parquet rows (589,814 matched + 272,064 synthetic)
      matched_count: 589814,  // IMDB-matched subset (68.4% match rate)
      last_run: pkP.last_modified || '2026-04-22T03:04:00Z',
    },
    {
      name: 'SEC EDGAR',
      phase: '1',
      status: edgarAgent?.status === 'routing' ? 'running' : (edgarAgent?.lastRun ? 'live' : 'designed'),
      pct: edgarAgent?.lastRun ? 100 : null,
      last_run: edgarAgent?.lastRun || logMtime('sec-edgar.log'),
    },
    // ── Phase 1b — Metadata enrichment
    {
      name: 'EIDR scraper',
      phase: '1b',
      status: eidrProgress ? 'live' : (eidrP.object_count > 0 ? 'landing' : 'designed'),
      pct: eidrProgress ? eidrProgress.eidr_pct : null,
      last_run: eidrProgress ? eidrProgress.out_date : (eidrP.last_modified || null),
      row_count: eidrProgress ? eidrProgress.eidr_matched : null,
      note: eidrProgress
        ? `v2 parent_keys: ${eidrProgress.eidr_matched?.toLocaleString()} EIDR IDs matched (${eidrProgress.eidr_pct}% of ${eidrProgress.total?.toLocaleString()} titles) — source: ${eidrProgress.source}`
        : 'Auth pending (code 4) — full backfill blocked',
    },
    { name: 'Rights scraper', phase: '1b', status: 'designed', pct: 0, last_run: null },
    // ── Phase 2a — Interim snapshots via RSG API bridge
    {
      name: 'Nielsen MIT (15 tables)',
      phase: '2a',
      status: nielsenMITP.object_count > 0 ? 'live' : 'queued',
      pct: nielsenMITP.object_count > 0 ? 100 : 0,
      last_run: nielsenMITP.last_modified || null,
      note: 'Auth0 M2M · Tue prior-week pull · 50K-row/table limit',
    },
    {
      name: 'Nielsen AMRLD (36 rec types)',
      phase: '2a',
      status: nielsenAMRLD.object_count > 0 ? 'live' : 'queued',
      pct: nielsenAMRLD.object_count > 0 ? 100 : 0,
      last_run: nielsenAMRLD.last_modified || null,
      note: 'T1×10 T2×5 T3×12(bridge-pending) NEW×9 · Tue full pull',
    },
    {
      name: 'Gracenote snapshot',
      phase: '2a',
      status: gracP.object_count > 0 ? 'landing' : 'queued',
      pct: 0,
      last_run: gracP.last_modified || null,
    },
    {
      name: 'FYI snapshot',
      phase: '2a',
      status: fyiP.object_count > 0 ? 'landing' : 'queued',
      pct: 0,
      last_run: fyiP.last_modified || null,
    },
    { name: 'Opus snapshot', phase: '2a', status: 'queued', pct: 0, last_run: null },
    // ── Phase 2b — Direct license
    { name: 'Nielsen direct',    phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'JustWatch',         phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'Wikidata',          phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'Twitter/X signals', phase: '2b', status: 'designed', pct: 0, last_run: null },
  ];
}

// ── S3 Data Lake inventory ───────────────────────────────────────────────────
// Emits ONE card per real S3 prefix with real sizes + entity counts where
// computable. Entity counts come from scripts/s3-entity-counts.json; prefixes
// flagged { note: 'deferred' } render with em-dash placeholders.
function buildS3Lake(scrapers, s3Inv, entityCounts, s3Freshness) {
  if (!s3Inv?.prefixes) return [];

  // Human label + phase classification per prefix
  const META = {
    'tmdb_dev/':     { label: 'tmdb_dev/',          phase: '1',  status_hint: 'running' },
    'imdb/':         { label: 'imdb/',              phase: '1',  status_hint: 'live'    },
    'imdb_prd/':     { label: 'imdb_prd/ (legacy)', phase: '1',  status_hint: 'live'    },
    'parent_keys/':  { label: 'parent_keys/',       phase: '1',  status_hint: 'live'    },
    'nielsen/':           { label: 'nielsen/',              phase: '2a', status_hint: 'live' },
    'nielsen/viewership/':{ label: 'nielsen/viewership/',  phase: '2a', status_hint: 'live', entities_note: '~13.3B rows · 5 tables · Databricks extract 2026-06-09' },
    'nielsen/mit/':       { label: 'nielsen/mit/',         phase: '2a', status_hint: 'live' },
    'nielsen/amrld/':     { label: 'nielsen/amrld/',       phase: '2a', status_hint: 'live' },
    'nielsen/amrld_etl/': { label: 'nielsen/amrld_etl/',   phase: '2a', status_hint: 'live' },
    'nielsen/ad_intel/':  { label: 'nielsen/ad_intel/',    phase: '2a', status_hint: 'live' },
    'nielsen/mri/':       { label: 'nielsen/mri/',         phase: '2a', status_hint: 'live' },
    'barb/barb_etl_qa/':  { label: 'barb/barb_etl_qa/',   phase: '2b', status_hint: 'live', entities_note: 'UK audience · 2018-01–2019-09 · 4 batch extract COMPLETE' },
    'barb/barb_etl_dev/': { label: 'barb/barb_etl_dev/',  phase: '2b', status_hint: 'live' },
    'gracenote/':    { label: 'gracenote/',         phase: '2a', status_hint: 'live', entities_note: '47,862 TV Series (PARENT_KEY3) · 17,210 Movies (GN_ID_ASSET, matched IMDB+EIDR)' },
    'fyi/':          { label: 'fyi/',               phase: '2a', status_hint: 'live', entities_note: '64,577 TV Series · 21,424 Other · 17,448 Movies (PROGRAM_ID, matched IMDB+EIDR)' },
    'opus/':         { label: 'opus/',              phase: '2a', status_hint: 'landing' },
    'eidr/':         { label: 'eidr/',              phase: '1b', status_hint: 'live', entities_note: '1,556 DOI spine · 1,528 certified · 14,775 candidates backlog' },
    'eidr/candidates/': { label: 'eidr/candidates/', phase: '1b', status_hint: 'live', entities_note: '14,775 unresolved (Partial-tier backlog)' },
    'shiv_curated/': { label: 'shiv_curated/',      phase: '1',  status_hint: 'live'    },
    'progress/':     { label: 'progress/',          phase: '—',  status_hint: 'live'    },
  };

  const tmdb = scrapers.find(s => s.name === 'TMDB bulk loader');

  // Hide TMDB sub-prefixes from the S3 Data Lake grid — they're nested under
  // tmdb_dev/ and their bytes are already counted in the parent tile.
  // s3-inventory.json still contains them for the scraper cards' prefix() lookup.
  const gridPrefixes = s3Inv.prefixes.filter(p =>
    p.prefix === 'tmdb_dev/' || !p.prefix.startsWith('tmdb_dev/')
  );

  return gridPrefixes.map(p => {
    const meta = META[p.prefix] || { label: p.prefix, phase: '—', status_hint: 'landing' };
    const ec   = (entityCounts || {})[p.prefix] || {};
    let status = meta.status_hint;
    // WARROOM-RUNSTATE-001 gap 3 -- DATA's tmdb_dev/ badge is the second named §2.7 lie
    // (OPS's hardcoded "Running now" RUNNING badge was the first -- see runningNow filter
    // in warroom-v5.html). META's status_hint above is a hardcoded 'running' literal for
    // tmdb_dev/ that the OLD override line only ever replaced with 'landing' -- i.e.
    // backwards for every OTHER state: succeeded/failed/stuck/stale/never_run all fell
    // through untouched to the hardcoded 'running' hint, badging a genuinely terminal
    // loader RUNNING regardless of what run_state() actually said (confirmed: with today's
    // live TMDB row terminal/succeeded, the old condition `tmdb?.status === 'running'` was
    // false, so status stayed 'running' from the literal). Now derives directly from the
    // SAME run_state()-backed `tmdb.status` OPS's own tile already computed above (C6: one
    // query, one number, same render vocabulary for both tabs) instead of an independent
    // hardcoded literal.
    if (p.prefix === 'tmdb_dev/') status = tmdb ? tmdb.status : meta.status_hint;

    const freshData = (s3Freshness || {})[p.prefix] || { age_hours: null, fresh: false, reason: 'not-checked' };
    const computedAt = ec.computed_at || null;
    const stale      = countBlockStale(p.prefix, computedAt);
    return {
      path: meta.label,
      prefix: p.prefix,
      phase: meta.phase,
      status,
      // WARROOM-RUNSTATE-001 gap 4 -- carries run_state.reason (the ONLY field with the
      // exact C2/C4 text: 'STALE <age>', 'N/A -- never run', 'ERROR -- <query id>') through
      // to the DATA badge, same object OPS's tile already exposes. null for every prefix
      // except tmdb_dev/ (the only prefix currently wired to run_state()).
      run_state: (p.prefix === 'tmdb_dev/' && tmdb) ? tmdb.run_state : null,
      size_gb: +(p.size_gb.toFixed(2)),
      object_count: p.object_count,
      last_updated: p.last_modified,
      fresh: freshData.fresh,
      age_hours: freshData.age_hours,
      freshness_reason: freshData.reason || null,
      // entity_type drives renderer: 'entity' | 'entity_funnel' | 'measurement' | 'na'
      entity_type: ec.type || null,
      // Per-type counts (entity datasets)
      entities: {
        movies:    ec.movies    ?? null,
        tv_series: ec.tv_series ?? null,
        episodes:  ec.episodes  ?? null,
        people:    ec.people    ?? null,
        sports:    ec.sports    ?? null,
        other:     ec.other     ?? null,
        telecasts: ec.telecasts ?? null,
      },
      // parent_keys funnel (entity_funnel datasets)
      funnel:  ec.funnel  || null,
      untyped: ec.untyped ?? null,
      // Compute-on-write provenance stamps
      computed_at: computedAt,
      source_job:  ec.source_job || null,
      stale,
      // Flags and notes
      flag: ec.flag || null,
      note: p.note || ec.note || meta.entities_note || null,
    };
  });
}

// ── Build events (Layer 7 audit trail) ───────────────────────────────────────
// Reads today's build-YYYY-MM-DD.jsonl (build-auto) AND deploy-events.json (Railway/Vercel).
// Returns structured events for the recent_activity feed, plus haiku_pct.
function getBuildEvents() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const buildFile  = path.join(SASMASTER, 'logs', `build-${today}.jsonl`);
  const deployFile = path.join(SASMASTER, 'logs', 'deploy-events.json');

  let buildCount  = 0;
  let haiku_pct   = 0;
  let buildEvents = [];

  // ── build-auto events ────────────────────────────────────────────────────────
  if (fs.existsSync(buildFile)) {
    try {
      const lines = fs.readFileSync(buildFile, 'utf8')
        .split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);

      buildEvents = lines.slice(-20).map(e => {
        const isSummary  = e.kind === 'run_summary';
        const isError    = e.status === 'failed' || (Array.isArray(e.errors) && e.errors.length > 0);
        const isComplete = isSummary || e.status === 'complete';

        let type = 'build';
        if (isError)         type = 'error';
        else if (isComplete) type = 'complete';

        let text;
        if (isSummary) {
          const mins = Math.round((e.wall_seconds || 0) / 60);
          text = `Build run complete — ${e.features_ok}/${e.features_total} features, $${(e.total_cost_usd || 0).toFixed(2)}, ${mins}m`;
        } else {
          const icon = isError ? '❌' : '✅';
          text = `${icon} ${(e.task || e.feat_id || '').slice(0, 70)}`;
          if (e.decisions) text += ` — ${e.decisions.slice(0, 60)}`;
        }

        return { type, text: text.slice(0, 120), ts: e.ts || '', layer: 'APP', component: 'build-auto' };
      });

      const featureLines = lines.filter(e => e.kind !== 'run_summary' && e.model_tier);
      const haikuCount   = featureLines.filter(e => e.model_tier === 'haiku').length;
      haiku_pct  = featureLines.length > 0 ? Math.round((haikuCount / featureLines.length) * 100) : 0;
      buildCount = lines.filter(e => e.kind !== 'run_summary').length;
    } catch {}
  }

  // ── deploy events (Railway POST /api/deploy-event + Vercel webhook) ──────────
  let deployCount  = 0;
  let deployEvents = [];

  // Railway deploys: synced from S3 by sync-to-s3-cache.sh every 5 min
  if (fs.existsSync(deployFile)) {
    try {
      const entries = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
      const todayEntries = (Array.isArray(entries) ? entries : [])
        .filter(e => String(e.ts || '').slice(0, 10) === today);
      deployCount += todayEntries.length;
      deployEvents = todayEntries.map(e => ({
        type:      'complete',
        text:      `🚀 Deploy ${e.target || 'platform'} — ${(e.task || '').slice(0, 60)}${e.commit ? ' @' + e.commit : ''}`,
        ts:        e.ts || '',
        layer:     'APP',
        component: 'deploy',
      }));
    } catch {}
  }

  // Vercel deploys: already in events.jsonl as deploy_completed (event_type)
  const eventsFile = path.join(SASMASTER, 'logs', 'events.jsonl');
  if (fs.existsSync(eventsFile)) {
    try {
      const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).slice(-500);
      const vercelDeploys = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && e.event_type === 'deploy_completed' && String(e.ts || '').slice(0, 10) === today);
      deployCount += vercelDeploys.length;
      deployEvents = deployEvents.concat(vercelDeploys.map(e => ({
        type:      'complete',
        text:      `🚀 Vercel deploy — ${(e.payload?.project || e.payload?.url || '').slice(0, 70)}`,
        ts:        e.ts || '',
        layer:     'APP',
        component: 'deploy',
      })));
    } catch {}
  }

  const allEvents = [...buildEvents, ...deployEvents].slice(0, 25);
  return { events: allEvents, count: buildCount + deployCount, haiku_pct };
}

// ── Build performance trends (last 7 days) ────────────────────────────────────
// Reads build-YYYY-MM-DD.jsonl files from ~/SaSMaster/logs/ for the past 7 days.
// Returns null safely if no build logs exist yet — never throws.
function getBuildTrends() {
  try {
    const now  = Date.now();
    const DAY  = 86400000;

    // Collect feature entries from each day file
    const allEntries = [];   // { date: 'YYYY-MM-DD', entry }
    const runIds     = new Set();

    for (let i = 0; i < 7; i++) {
      const d    = new Date(now - i * DAY);
      const date = d.toISOString().slice(0, 10);
      const file = path.join(SASMASTER, 'logs', `build-${date}.jsonl`);
      if (!fs.existsSync(file)) continue;

      try {
        const lines = fs.readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);

        for (const e of lines) {
          if (e.kind === 'run_summary') {
            if (e.run_id) runIds.add(e.run_id);
            continue;
          }
          if (e.run_id) runIds.add(e.run_id);
          allEntries.push({ date, entry: e });
        }
      } catch { continue; }
    }

    if (allEntries.length === 0) return null;

    // ── Aggregate over all 7 days ─────────────────────────────────────────────
    const costs     = allEntries.map(x => x.entry.cost_usd).filter(v => typeof v === 'number');
    const durations = allEntries.map(x => x.entry.duration_s).filter(v => typeof v === 'number');
    const total     = allEntries.length;
    const failed    = allEntries.filter(x => x.entry.status === 'failed' || (Array.isArray(x.entry.errors) && x.entry.errors.length > 0)).length;

    const avg_cost_usd   = costs.length     ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 10000) / 10000 : 0;
    const avg_duration_s = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : 0;
    const error_rate     = total > 0        ? Math.round((failed / total) * 1000) / 1000 : 0;

    // ── Trend: compare last 3 days vs previous 4 days error_rate ─────────────
    const recent3Days = new Set();
    for (let i = 0; i < 3; i++) {
      recent3Days.add(new Date(now - i * DAY).toISOString().slice(0, 10));
    }

    const recentEntries = allEntries.filter(x => recent3Days.has(x.date));
    const olderEntries  = allEntries.filter(x => !recent3Days.has(x.date));

    const errRate = (arr) => {
      if (!arr.length) return null;
      const f = arr.filter(x => x.entry.status === 'failed' || (Array.isArray(x.entry.errors) && x.entry.errors.length > 0)).length;
      return f / arr.length;
    };

    const recentErr = errRate(recentEntries);
    const olderErr  = errRate(olderEntries);

    let trend = 'stable';
    if (recentErr !== null && olderErr !== null) {
      if (recentErr < olderErr - 0.02)  trend = 'improving';
      else if (recentErr > olderErr + 0.02) trend = 'declining';
    }

    return {
      avg_cost_usd,
      avg_duration_s,
      error_rate,
      total_features_7d: total,
      builds_7d:         runIds.size,
      trend,
    };
  } catch { return null; }
}

// ── KPIs (derived) ───────────────────────────────────────────────────────────
// GATE-B (S5b, Shiv-only): the fleet classification is mechanically defaulted
// (WARROOM_AGENT_INVENTORY.md — every agent 'active'/'on-demand', none 'retired') but not
// yet RULED BY SHIV. Per the card: until this gate closes, the header ratio is not rendered
// as a number at all, even though a computed value exists underneath. Flip to true (and
// review WARROOM_AGENT_INVENTORY.md's expected_state column for any retired agents) once
// Shiv rules on S5b.
// GATE-B — RULED BY SHIV 2026-08-27 ("Three Classes as proposed — but we should be
// prioritizing the primary agents over the 'nice to have' agents"), WARROOM-AGENT-RUNPLANE-001.
const AGENT_FLEET_CLASSIFICATION_RULED = true;

function buildKPIs(agents, scrapers, s3_lake, tasks, pk, buildEventsCount, haikuPctToday, warroomS3Total) {
  // agents_running counts only live/cron agents (not idle sub-agents or marketplace)
  const liveAgents    = agents.filter(a => !a.type || a.type === 'live');
  // Pre-WARROOM-HEALTH-001 literal-status count — retained ONLY as the input to the
  // legacy 'routing' consumers elsewhere (DATA-tab SEC EDGAR indicator); the AGENTS-tab
  // ratio below uses healthEval.state, the computed value (C3/C6).
  const agents_running = liveAgents.filter(a => a.status === 'healthy' || a.status === 'routing').length;
  // GATE-B RULED 2026-08-27 — the health ratio is over the 'scheduled' class only: the agents
  // whose liveness is genuinely a cadence question. Before the ruling this read `liveAgents`
  // (a type-field filter), which is a different set and would have counted always-on daemons
  // and event-triggered agents in a denominator they can never score healthy against.
  // 'retired' stays excluded from BOTH numerator and denominator per the card.
  const scheduledAgents = agents.filter(a => a.classification === 'scheduled');
  const agents_healthy_computed = scheduledAgents.filter(a => a.healthEval && a.healthEval.state === 'healthy').length;
  const agents_classified_denominator = scheduledAgents.filter(a => !a.healthEval || a.healthEval.state !== 'retired').length;
  const agents_by_class = {
    scheduled: agents.filter(a => a.classification === 'scheduled').length,
    event:     agents.filter(a => a.classification === 'event').length,
    invocable: agents.filter(a => a.classification === 'invocable').length,
  };
  const scrapers_live  = scrapers.filter(s => s.status === 'live').length;
  // Prefer warroom-data.json total (4x/day refresh) over stale s3-inventory.json sum
  const s3_gb = warroomS3Total != null
    ? warroomS3Total
    : s3_lake.reduce((sum, b) => sum + (b.size_gb || 0), 0);
  const tasks_open = (tasks.highItems?.length || 0) + (tasks.medItems?.length || 0) + (tasks.exploreItems?.length || 0);
  const pkRows = pk?.row_count ?? 589814;

  return {
    agents_running,
    agents_total: agents.length,       // 51 — full fleet (live + sub-agents + marketplace)
    // 13, not 14: parseAgents() lists 14 rows in the live/cron table, but Data Guardian
    // carries type:'subagent' and is filtered out by the liveAgents filter above (it's
    // event-triggered from nielsen_puller.py, not cron-scheduled) — confirmed live
    // 2026-08-24. Re-derive from liveAgents.length, never hardcode the count again.
    agents_live_total: liveAgents.length, // live/cron only, used for health bar
    // WARROOM-HEALTH-001: the ratio C1/GATE-B actually govern. The render layer renders
    // `N/A — fleet unclassified (S5b)` while gateBRuled is false, a real number once true —
    // never a guessed value in between (renderValue()'s NA/value branches, not this file).
    agents_healthy_computed,
    agents_classified_denominator,
    agents_gate_b_ruled: AGENT_FLEET_CLASSIFICATION_RULED,
    agents_by_class,
    scrapers_live,
    scrapers_total: scrapers.length,
    s3_gb: Math.round(s3_gb * 10) / 10,
    parent_key_rows: pkRows,
    tasks_open,
    build_events_today: buildEventsCount || 0,
    model_routing: 'haiku+sonnet+opus',
    haiku_pct_today: haikuPctToday ?? 0,
    eidr_coverage_pct: pk?.eidr_pct ?? null,
    eidr_matched_rows: pk?.eidr_matched ?? null,
  };
}

// ── Recent activity (merged ticker feed) ─────────────────────────────────────
function buildRecentActivity(intelFeed, recentBuilds, scrapers) {
  const acts = [];

  (recentBuilds || []).slice(0, 6).forEach(b => {
    if (!b.task) return;
    acts.push({ type: 'build', text: b.task.slice(0, 80), ts: b.date });
  });

  (intelFeed || []).slice(0, 5).forEach(i => {
    const src = (i.source || 'INTEL').toLowerCase();
    const type = /edgar|intel|media/i.test(src) ? 'intel' : 'content';
    acts.push({ type, text: (i.text || '').slice(0, 90), ts: i.ts || '' });
  });

  const tmdb = scrapers.find(s => s.name === 'TMDB bulk loader');
  if (tmdb && tmdb.pct != null) {
    acts.push({
      type: 'pipeline',
      text: `TMDB bulk ${tmdb.pct.toFixed(1)}% — ${(tmdb.row_count/1000).toFixed(0)}K / ${(tmdb.total/1000).toFixed(0)}K titles → ${tmdb.s3_path}`,
      ts: tmdb.last_run || '',
    });
  }

  return acts.slice(0, 12);
}

// ── Cron schedule math ───────────────────────────────────────────────────────
// Expand a single cron field into the integer values it matches within [lo,hi].
// Supports: '*', '*/N', 'A-B', 'A-B/N', 'A,B,C', plain ints. Returns null on
// anything we can't reason about (caller then falls back to the legacy verdict).
function expandCronField(field, lo, hi) {
  if (field == null) return null;
  const out = new Set();
  for (const part of String(field).split(',')) {
    let m;
    if (part === '*') { for (let i = lo; i <= hi; i++) out.add(i); }
    else if ((m = part.match(/^\*\/(\d+)$/))) { const s = +m[1]; if (s > 0) for (let i = lo; i <= hi; i += s) out.add(i); }
    else if ((m = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/))) { const s = m[3] ? +m[3] : 1; if (s > 0) for (let i = +m[1]; i <= +m[2]; i += s) out.add(i); }
    else if (/^\d+$/.test(part)) { out.add(+part); }
    else return null;
  }
  return [...out].sort((a, b) => a - b);
}

// Most recent wall-clock time (ms) a job with minute=minField, hour=hrField should
// have fired at or before `now`. Correctly handles interval jobs (*/5, *, */15,
// 0 */6, 0 6-22) that parseInt() turns into NaN. Returns null if unparseable.
function mostRecentFire(minField, hrField, now) {
  const minutes = expandCronField(minField, 0, 59);
  const hours   = expandCronField(hrField, 0, 23);
  if (!minutes || !hours || !minutes.length || !hours.length) return null;
  const base = new Date(now);
  let best = null;
  // Walk today, then yesterday, until we find a fire at/before now.
  for (let dayOffset = 0; dayOffset >= -1 && best === null; dayOffset--) {
    for (const h of hours) {
      for (const mm of minutes) {
        const d = new Date(base); d.setDate(d.getDate() + dayOffset); d.setHours(h, mm, 0, 0);
        const t = d.getTime();
        if (t <= now && (best === null || t > best)) best = t;
      }
    }
  }
  return best;
}

// ── Cron status enrichment ───────────────────────────────────────────────────
// "done"    = the job's most recent scheduled fire has passed AND its agent or
//             redirected log shows activity at/after that fire (minus a grace
//             window for log-write lag).
// "pending" = next fire is still in the future, OR the fire passed with no
//             detectable activity (genuine miss / silent job we can't confirm).
// "routing" = matched agent is mid-flight.
// This replaces the old logic that scored every interval job (*/5, *, */15) as a
// permanent miss because parseInt('*/5') === NaN.
function enrichCronStatus(cronJobs, agents) {
  const now = Date.now();
  const GRACE_MS = 10 * 60 * 1000; // tolerate ≤10 min between fire and log write

  // Resolve the absolute path a cron command redirects its log to. Handles
  // `>>`/`>`, `~` expansion, and relative paths (resolved against a leading
  // `cd <dir> &&` if present, else the SaSMaster root).
  const resolveLogPath = cmd => {
    const m = cmd.match(/>>?\s*([^\s]+\.log)/);
    if (!m) return null;
    let p = m[1].replace(/^~/, process.env.HOME || '');
    if (!path.isAbsolute(p)) {
      const cd = cmd.match(/\bcd\s+([^\s]+)\s*&&/);
      const baseDir = cd ? cd[1].replace(/^~/, process.env.HOME || '') : SASMASTER;
      p = path.resolve(baseDir, p);
    }
    return p;
  };
  const logMtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };

  // Many jobs write DATED logs (e.g. score-queue-20260628.log, build-2026-06-28*.log)
  // while their crontab line redirects to a STATIC .log that only grows on stdout.
  // Pre-index today's logs once so a job that genuinely ran today is detectable even
  // when its static redirect file is silent. Keyed by the freshest mtime per file.
  let todayLogs = [];
  try {
    const dir = path.join(SASMASTER, 'logs');
    const dayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    todayLogs = fs.readdirSync(dir)
      .filter(f => f.endsWith('.log'))
      .map(f => { try { return { f, mt: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; } })
      .filter(x => x && x.mt >= dayStart);
  } catch { /* logs dir unreadable — fall back to static/agent signals only */ }
  const datedLogMtime = key => {
    if (!key) return null;
    let best = null;
    for (const { f, mt } of todayLogs) {
      // match "<key>-<date>…​.log" / "<key>.log" but avoid loose substring false hits
      if (f === `${key}.log` || f.startsWith(`${key}-`)) { if (best == null || mt > best) best = mt; }
    }
    return best;
  };

  return cronJobs.map(c => {
    const { _scheduledToday, _min, _hr, ...clean } = c;

    // Most recent fire — interval-aware, with legacy fixed-time value as fallback.
    let prevFire = mostRecentFire(_min, _hr, now);
    if (prevFire == null) prevFire = _scheduledToday;

    // Unparseable schedule, or the only fire today is still ahead → pending.
    if (prevFire == null || prevFire > now) return { ...clean, status: 'pending' };

    // Resolve the most recent activity timestamp from the matched agent + log file.
    const scriptMatch = c.command.match(/([a-z0-9\-]+)(-agent)?\.js/i);
    const bashMatch   = c.command.match(/\b([a-z0-9\-]+)\.sh\b/i);
    const key = scriptMatch ? scriptMatch[1].replace(/-agent$/, '') : (bashMatch ? bashMatch[1] : '');
    const agent = key ? agents.find(a => a.log && (a.log.includes(key) || (scriptMatch && a.log.includes(scriptMatch[1])))) : null;
    if (agent && agent.status === 'routing') return { ...clean, status: 'routing' };

    let lastActivity = null;
    if (agent && agent.lastRun) {
      const t = new Date(agent.lastRun).getTime();
      if (!isNaN(t)) lastActivity = t;
    }
    const lp = resolveLogPath(c.command);
    if (lp) { const mt = logMtime(lp); if (mt != null && (lastActivity == null || mt > lastActivity)) lastActivity = mt; }
    // Dated sibling log written today (covers silent static redirects).
    const dmt = datedLogMtime(key);
    if (dmt != null && (lastActivity == null || dmt > lastActivity)) lastActivity = dmt;

    if (lastActivity != null && lastActivity >= prevFire - GRACE_MS) return { ...clean, status: 'done' };
    return { ...clean, status: 'pending' };
  });
}

// ── Slack feed ───────────────────────────────────────────────────────────────
// Primary source: ~/SaSMaster/status/slack-feed.json (real conversations.history
// snapshot, updated every 5 min by scripts/slack-feed-cache.js).
// Fallback: log-derived tails for stale/missing cache.
function parseSlackFeedCache() {
  const file = path.join(SASMASTER, 'status', 'slack-feed.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || !d.generated) return null;
    // If stale (> 20 min old), return null and let the log-derived fallback run
    const ageMin = (Date.now() - new Date(d.generated).getTime()) / 60000;
    if (ageMin > 20) return null;
    return d;
  } catch { return null; }
}

function buildSlackFeed(recentBuilds, intelFeed) {
  // Prefer the live Slack cache if fresh
  const cache = parseSlackFeedCache();
  if (cache) {
    // Map bot-posted emoji prefixes for visual parity with the fallback
    const dress = msgs => (msgs || []).slice(0, 8).map(m => ({
      ts: m.ts,
      text: m.bot ? m.text : m.text, // both rendered the same; raw bot status preserved for styling later
    }));
    return {
      builds:  dress(cache.builds),
      intel:   dress(cache.intel),
      content: dress(cache.content),
    };
  }

  // Fallback: derive from log files
  const LOG = path.join(SASMASTER, 'logs');
  // WARROOM-CLOCK-001 (2026-08-24): this already correctly pinned
  // America/New_York (unlike the client-side bugs this card fixed), but
  // duplicated the "recent time vs older date" rule ad hoc — routed through
  // the shared module so there's exactly one implementation of that rule (C6).
  const tsShort = iso => {
    if (!iso) return '';
    if (isNaN(new Date(iso).getTime())) return String(iso).slice(0, 16);
    return WarroomClock.recentTimeOrDate(iso);
  };

  // Tail a log file and return the last N readable lines as Slack-like messages
  const tailLogAsMessages = (logName, emoji, max = 4) => {
    const p = path.join(LOG, logName);
    if (!fs.existsSync(p)) return [];
    try {
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-15).reverse();
      const out = [];
      for (const line of lines) {
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(?:\[[A-Z0-9_-]+\]\s*)?(.*)$/);
        if (!m) continue;
        const text = m[2].trim();
        if (!text) continue;
        out.push({ ts: tsShort(m[1]), text: `${emoji} ${text.slice(0, 140)}` });
        if (out.length >= max) break;
      }
      return out;
    } catch { return []; }
  };

  // #sasmaster-builds — DONE_LOG + DoneLog Analyst + daily briefing + morning package
  const buildsFromDone = (recentBuilds || []).slice(0, 4).map(b => ({
    ts: tsShort(b.date),
    text: `✅ ${(b.task || '').slice(0, 140)}`,
  })).filter(m => m.text && m.text !== '✅ ');
  const buildsFromLogs = [
    ...tailLogAsMessages('donelog-analyst.log', '📊', 2),
    ...tailLogAsMessages('briefing.log',        '☀️', 1),
    ...tailLogAsMessages('morning-package.log', '📦', 1),
  ];
  const builds = [...buildsFromDone, ...buildsFromLogs].slice(0, 8);

  // #sasmaster-intel — intel_feed + media-intel + sec-edgar + tech-intel log tails
  const intelFromFeed = (intelFeed || []).slice(0, 3).map(i => ({
    ts: tsShort(i.ts),
    text: `${/edgar/i.test(i.source || '') ? '📑' : '📡'} ${(i.text || '').slice(0, 140)}`,
  }));
  const intelFromLogs = [
    ...tailLogAsMessages('media-intel.log', '📡', 2),
    ...tailLogAsMessages('sec-edgar.log',   '📑', 2),
    ...tailLogAsMessages('tech-intel.log',  '🛰️', 2),
  ];
  const intel = [...intelFromFeed, ...intelFromLogs].slice(0, 8);

  // #sasmaster-content — LinkedIn + TMDB Trending + Weekly Review
  const content = [
    ...tailLogAsMessages('linkedin-agent.log', '✍️', 3),
    ...tailLogAsMessages('tmdb-agent.log',     '📺', 3),
    ...tailLogAsMessages('weekly-review.log',  '🗂️', 1),
  ].slice(0, 8);

  return { builds, intel, content };
}

// ── Tasks for v3 Kanban (flatten existing kanban into v3 shape) ──────────────
function buildTasksForV3(kanban) {
  const out = [];
  (kanban.backlog || []).forEach(t => out.push({ title: t.text, status: 'BACKLOG',     priority: t.priority || 'MED', tag: t.tag || '', est: '—' }));
  (kanban.inProgress || []).forEach(t => out.push({ title: t.text, status: 'IN PROGRESS', priority: t.priority || 'HIGH', tag: t.tag || '', est: '—' }));
  (kanban.review || []).forEach(t => out.push({ title: t.text, status: 'REVIEW',        priority: t.priority || 'REVIEW', tag: t.tag || '', est: '—' }));
  (kanban.done || []).slice(0, 10).forEach(t => out.push({ title: t.text, status: 'DONE', priority: t.priority || 'DONE', tag: t.tag || '', est: '—' }));
  return out;
}

// ── Assemble + write ─────────────────────────────────────────────────────────
const tasks         = parseTasks();
const { entries: recentBuilds, heatmap } = parseDoneLog();
const pendingItems  = parsePending();
const intelFeed     = parseIntelFeed();
const alerts        = parseAlerts();
// WARROOM-RUNSTATE-001 -- run-log-backed run state for jobs whose OPS/DATA/QUEUE tiles
// previously derived "running" from something other than the run-log's terminal record.
// 'TMDB bulk loader' maps to run-log job id 'load-tmdb-to-s3' -- the closest semantic match
// in docs/JOB_ID_NAMING.md (no job literally named "tmdb bulk loader" exists; this mapping
// is a judgment call, recorded here and in DONE_LOG.md, not silently assumed).
const RUNSTATE_JOB_MAP = { 'TMDB bulk loader': 'load-tmdb-to-s3' };
// WARROOM-RUNSTATE-001 remediation (gap 3, C6): ALL_WIRED_JOBS is the union of every job
// this generation cycle needs a run-state answer for -- the TMDB tile's job, PLUS every
// AGENT_HEALTH_CONFIG job (§2.1 health). ONE fetchRunLogTerminalByJob() call for all of
// them, computed here (before parseAgents()) and threaded through to (a) buildScrapers()'s
// TMDB tile, (b) parseAgents()->fetchAgentRunLog() for health, and (c) the new QUEUE
// jobs-running-or-stuck count below -- three consumers, one query, not three.
const ALL_WIRED_JOBS = Array.from(new Set([
  ...Object.values(RUNSTATE_JOB_MAP),
  ...Object.values(AGENT_HEALTH_CONFIG).map(c => c.job).filter(Boolean),
]));
const runstateByJob = fetchRunLogTerminalByJob(ALL_WIRED_JOBS);
const runstateReadError = ALL_WIRED_JOBS.length > 0 && Object.keys(runstateByJob).length === 0;
const agents        = parseAgents(runstateByJob);
const tmdbProgress  = parseTMDBProgress();
const s3Inv         = parseS3Inventory();
const warroomS3Total = parseWarroomDataS3Total();
// Counts read from S3 warroom/counts.json (compute-on-write — jobs write this, not generate-status).
// generate-status.js is READ-ONLY with respect to entity counts.
const entityCounts  = parseS3EntityCounts();
const movieUniverse = (entityCounts || {})['_movie_universe'] || null;
const imdbStatus    = parseImdbStatus();
const scrapers      = buildScrapers(tmdbProgress, recentBuilds, s3Inv, agents, imdbStatus, runstateByJob, RUNSTATE_JOB_MAP);
// WARROOM-RUNSTATE-001 gap 1 remediation -- QUEUE's "jobs currently running" count.
// Genuinely distinct concept from tasks.wipItems (TASKS.md work-item Kanban column, a real
// project-management concept the QUEUE tab's Kanban board renders as its own "IN PROGRESS"
// column and is NOT owned by this card -- see report). This is
// `COUNT(*) FROM run_state_all WHERE state IN ('running','stuck')` per the card's own VERIFY
// text, genuinely derived from run_state() over ALL_WIRED_JOBS, not merged into the WIP
// count (that would be exactly the C6 violation of collapsing two real concepts into one).
const runStateAll = ALL_WIRED_JOBS.map(job => {
  const row = runstateByJob[job];
  const rs = WarroomRunstate.run_state({
    job, now: WarroomClock.nowUtc(),
    latestRow: row ? { run_id: row.run_id, started_at: row.last_started, finished_at: row.last_finished, exit_code: row.last_exit } : null,
    terminalDurationsMs: row ? row.terminalDurationsMs : [],
    cadence_ms: JobCadence.get(job),
    readError: runstateReadError,
    queryId: `run_state:${job}`,
  });
  return { job, ...rs };
});
const jobsRunningOrStuck = runStateAll.filter(r => r.state === 'running' || r.state === 'stuck').length;
const qaDrafts      = parseQADrafts();
const { phaseStatus, pending: memoryPending } = parseMemoryContext();

// Compute freshness for each known S3 prefix (silent on AWS CLI failure)
const s3FreshnessPrefixes = (s3Inv?.prefixes || []).map(p => p.prefix);
const s3Freshness = getS3Freshness(s3FreshnessPrefixes);

const s3_lake       = buildS3Lake(scrapers, s3Inv, entityCounts, s3Freshness);
const cronJobsRaw   = parseCrontab();
const cron          = enrichCronStatus(cronJobsRaw, agents);

// Layer 7: build audit trail events
const { events: buildEventsToday, count: buildEventsCount, haiku_pct: haikuPctToday } = getBuildEvents();

// Layer 6: performance trends (last 7 days)
const buildTrends = getBuildTrends();

const kanban = {
  // Lifecycle columns (state-driven)
  backlog:    [...tasks.highItems, ...tasks.medItems, ...tasks.exploreItems],
  inProgress: tasks.wipItems,
  blocked:    tasks.blockedItems,
  review:     [...tasks.reviewItems, ...pendingItems, ...qaDrafts],
  done:       recentBuilds.map((b, i) => ({ id: `done-${i}`, text: b.task, full: b.task, sprint: '', tag: 'DONE', priority: 'DONE' })),
  // Context panels
  qaDrafts,
  memoryPending,
  phaseStatus,
  // Summary for KPI strip
  counts: {
    backlog:    tasks.highItems.length + tasks.medItems.length + tasks.exploreItems.length,
    // inProgress = TASKS.md work-item WIP count (Kanban "IN PROGRESS" column) -- a real,
    // separate project-management concept, NOT job-execution state. Kept as-is; see
    // jobsRunningOrStuck below for the genuinely distinct run_state()-derived number
    // (WARROOM-RUNSTATE-001 gap 1: two real concepts, two labeled numbers, never merged).
    inProgress: tasks.wipItems.length,
    blocked:    tasks.blockedItems.length,
    review:     tasks.reviewItems.length + pendingItems.length + qaDrafts.length,
    qaDrafts:   qaDrafts.length,
    // WARROOM-RUNSTATE-001 gap 1 -- COUNT(*) FROM run_state_all WHERE state IN
    // ('running','stuck'), across ALL_WIRED_JOBS. This is QUEUE's job-execution-state
    // number; jobsRunningOrStuckJobs carries the per-job provenance (job, state, run_id)
    // for drill-down/anti-fabrication (every rendered cell must resolve a run_id).
    jobsRunningOrStuck: jobsRunningOrStuck,
    jobsRunningOrStuckJobs: runStateAll.filter(r => r.state === 'running' || r.state === 'stuck')
      .map(r => ({ job: r.job, state: r.state, run_id: r.run_id, reason: r.reason })),
  },
};

const parentKeyScraper = scrapers.find(s => s.name === 'SAS-MASTER Parent Key v1');
const eidrV2Progress   = parseEidrProgress();
// Merge eidrProgress into parentKeyScraper so buildKPIs can read eidr_pct / eidr_matched
if (parentKeyScraper && eidrV2Progress) {
  parentKeyScraper.eidr_pct     = eidrV2Progress.eidr_pct;
  parentKeyScraper.eidr_matched = eidrV2Progress.eidr_matched;
}

// Inject trend KPIs into kpis object after buildKPIs() runs — done below inline.

// Merge build events (prepend) + existing slack_feed events (append), cap at 25
function buildMergedActivity(intelFeed, recentBuilds, scrapers, buildEvents) {
  const existing = buildRecentActivity(intelFeed, recentBuilds, scrapers);
  return [...buildEvents, ...existing].slice(0, 25);
}

// ── Cost summary from logs/cost-log.jsonl ────────────────────────────────────
// ONE-SOURCE-001: cost-log.jsonl is the SINGLE authority for all cost figures.
// ALL cost surfaces (KPI "Build Cost", COSTS tab MTD total, FINANCE tab burn) MUST
// read from this structure with different aggregations — never from separate sources.
// Root cause of $34.96 vs $0.08 discrepancy: "Build Cost" sometimes fetched from
// Railway /api/costs (MTD session cost) and sometimes fell back to cost_summary
// (all-time total from log). Fix: cost_summary.total_cost_usd = ALL-TIME from log;
// cost_summary.mtd_cost_usd = current month; token_projection.week_cost_usd = this week.
// Frontend MUST label these correctly and never swap them.
let costSummary = { total_cost_usd: 0, mtd_cost_usd: 0, entry_count: 0, model_breakdown: {} };
try {
  const costLines = fs.readFileSync(path.join(SASMASTER, 'logs', 'cost-log.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean);
  let costTotal = 0;
  const costModels = {};
  for (const cl of costLines) {
    try {
      const ce = JSON.parse(cl);
      const c = ce.cost_usd || 0;
      costTotal += c;
      const m = ce.model || ce.model_exec || 'unknown';
      costModels[m] = (costModels[m] || 0) + c;
    } catch {}
  }
  // Compute MTD separately — same log, different lens
  const nowMtd  = new Date();
  const mtdStart = new Date(nowMtd.getFullYear(), nowMtd.getMonth(), 1).getTime();
  let mtdTotal = 0;
  for (const cl of costLines) {
    try {
      const ce = JSON.parse(cl);
      const ts = new Date(ce.ts || ce.timestamp || '').getTime();
      if (ts >= mtdStart) mtdTotal += (ce.cost_usd || 0);
    } catch {}
  }
  costSummary = {
    total_cost_usd: Math.round(costTotal * 10000) / 10000,   // ALL-TIME — used for lifetime view
    mtd_cost_usd:   Math.round(mtdTotal  * 10000) / 10000,   // MTD — used for COSTS tab header
    entry_count: costLines.length,
    model_breakdown: costModels,
    authority: 'cost-log.jsonl',  // ONE-SOURCE-001: single authority tag
  };
} catch {}

// ── Usage state (manual paste from claude.ai/settings/usage) ─────────────────
let usageState = null;
try {
  const usagePath = path.join(process.env.HOME, '.sasmaster', 'usage-state.json');
  if (fs.existsSync(usagePath)) {
    usageState = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
  }
} catch (e) {
  console.warn('[generate-status] usage-state.json missing or invalid:', e.message);
}

// ── Canonical token/cost view (WARROOM-COSTCANON-001 Phase 3) ────────────────
// ONE-SOURCE-004: sasmaster.costs.v_token_cost_canonical is now the single source for
// per-agent / per-model / cache-hit token+cost aggregation feeding the COSTS, TOKENS and
// FINANCE tabs. This replaces the old per-line cost-log.jsonl `agentCost` parse (deleted
// below, in the token-projection block) — that parse duplicated per-agent attribution the
// canonical view now provides, and is one of the two rival paths this card requires
// deleted, not deprecated. It does NOT replace the weekly burn-rate total below (that stays
// on cost-log.jsonl — a different figure, not one of the named contradictions).
// The view currently carries only 2 rows (run_id NULL — a known agent_id/job naming
// mismatch, a separate finding, not fixed here); sparse/near-zero output below is the
// honest reflection of that, not a bug in this query — do not pad it.
function fetchTokenCostCanonical() {
  try {
    const token = readEnvVar('MOTHERDUCK_TOKEN');
    if (!token) return null;
    const sql = `
      WITH base AS (SELECT * FROM sasmaster.costs.v_token_cost_canonical),
      cutover AS (SELECT min(ts_utc) AS ts FROM base WHERE cache_read_input_tokens IS NOT NULL),
      agents AS (
        SELECT COALESCE(agent_id,'unattributed') AS agent_id, model,
               sum(cost_usd) AS cost_usd,
               sum(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens,
               count(*) AS calls
        FROM base GROUP BY 1,2
      ),
      models AS (
        SELECT model, sum(cost_usd) AS cost_usd, count(*) AS calls
        FROM base GROUP BY 1
      )
      SELECT
        (SELECT count(*) FROM base) AS row_count,
        (SELECT ts FROM cutover) AS v2_cutover_ts,
        (SELECT sum(cost_usd) FROM base) AS total_cost_usd,
        (SELECT sum(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) FROM base) AS total_tokens,
        (SELECT sum(COALESCE(input_tokens,0)) FROM base) AS total_input_tokens,
        (SELECT sum(COALESCE(output_tokens,0)) FROM base) AS total_output_tokens,
        (SELECT sum(cache_read_input_tokens) FROM base WHERE cache_read_input_tokens IS NOT NULL) AS cache_read_tokens,
        (SELECT sum(cache_creation_input_tokens) FROM base WHERE cache_creation_input_tokens IS NOT NULL) AS cache_write_tokens,
        (SELECT sum(COALESCE(input_tokens,0)) FROM base WHERE cache_read_input_tokens IS NOT NULL) AS cache_window_input_tokens,
        (SELECT count(*) FROM base WHERE cache_read_input_tokens IS NOT NULL) AS cache_row_count,
        (SELECT list({'agent_id':agent_id,'model':model,'cost_usd':cost_usd,'tokens':tokens,'calls':calls} ORDER BY cost_usd DESC) FROM agents) AS agents,
        (SELECT list({'model':model,'cost_usd':cost_usd,'calls':calls}) FROM models) AS models
    `;
    // STATUS-PROCLEAK-001: array-form spawnSync, NOT execSync-through-a-shell.
    // execSync's timeout kills only /bin/sh, orphaning the duckdb grandchild
    // (which holds a live MotherDuck connection) forever. Direct-binary spawn
    // makes duckdb the direct child, so killSignal actually reaps it. Passing
    // the SQL as its own argv entry also removes the shell-quoting hazard.
    const _r = spawnSync(
      '/opt/homebrew/bin/duckdb',
      ['-json', '-c', sql.replace(/\n/g, ' '), 'md:sasmaster'],
      { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, motherduck_token: token } }
    );
    const out = (_r.status === 0 && _r.stdout) ? _r.stdout : '';
    const rows = JSON.parse(out);
    return rows[0] || null;
  } catch (e) {
    console.warn('[generate-status] token cost canonical query failed:', e.message);
    return null;
  }
}

// Builds the render-ready costCanonical block. C2 (four render states) applied here, once,
// so every tab consumes an already-honest value instead of re-deriving N/A logic itself.
function buildCostCanonical() {
  const row = fetchTokenCostCanonical();
  if (!row) {
    return {
      available: false,
      reason: 'no_motherduck_token_or_query_failed',
      source: 'sasmaster.costs.v_token_cost_canonical',
      computed_at: new Date().toISOString(),
    };
  }
  const rowCount = Number(row.row_count) || 0;
  const cacheRowCount = Number(row.cache_row_count) || 0;
  const cacheDenom = (Number(row.cache_read_tokens) || 0) + (Number(row.cache_window_input_tokens) || 0);
  const hasCacheData = cacheRowCount > 0;
  // Measured zero is a valid rate (C2) — only null when no row has ever carried cache fields,
  // or the denominator is genuinely zero (no traffic in the cache-capable window).
  const cacheHitRate = hasCacheData && cacheDenom > 0
    ? (Number(row.cache_read_tokens) || 0) / cacheDenom
    : (hasCacheData ? 0 : null);
  const agents = Array.isArray(row.agents) ? row.agents : [];
  const models = Array.isArray(row.models) ? row.models : [];
  const topAgent = agents.length
    ? agents.reduce((a, b) => (Number(b.cost_usd) > Number(a.cost_usd) ? b : a))
    : null;
  return {
    available: true,
    source: 'sasmaster.costs.v_token_cost_canonical',
    computed_at: new Date().toISOString(),
    row_count: rowCount,
    v2_cutover_ts: row.v2_cutover_ts || null,
    total_cost_usd: row.total_cost_usd != null ? Number(row.total_cost_usd) : null,
    total_tokens: row.total_tokens != null ? Number(row.total_tokens) : null,
    total_input_tokens: row.total_input_tokens != null ? Number(row.total_input_tokens) : null,
    total_output_tokens: row.total_output_tokens != null ? Number(row.total_output_tokens) : null,
    cache_read_tokens: hasCacheData ? Number(row.cache_read_tokens) || 0 : null,
    cache_write_tokens: row.cache_write_tokens != null ? Number(row.cache_write_tokens) : null,
    cache_has_data: hasCacheData,
    cache_hit_rate: cacheHitRate, // 0..1, or null when no window has cache fields captured yet
    top_agent: topAgent ? topAgent.agent_id : null,
    top_agent_is_real: !!(topAgent && topAgent.agent_id && topAgent.agent_id !== 'other'),
    agents: agents,
    models: models.map(m => ({
      model: m.model,
      cost_usd: Number(m.cost_usd) || 0,
      calls: Number(m.calls) || 0,
      pct_spend: row.total_cost_usd ? (Number(m.cost_usd) || 0) / Number(row.total_cost_usd) * 100 : 0,
    })),
  };
}
const costCanonical = buildCostCanonical();

// ── Token burn rate projection from cost-log.jsonl ────────────────────────────
let tokenProjection = null;
try {
  const costLogPath = path.join(SASMASTER, 'logs', 'cost-log.jsonl');
  if (fs.existsSync(costLogPath)) {
    const allLines = fs.readFileSync(costLogPath, 'utf8').trim().split('\n').filter(Boolean);
    const now = new Date();
    // Week anchor: Monday 00:00 local
    const dayOfWeek = now.getDay();
    const diffToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMon);
    weekStart.setHours(0, 0, 0, 0);

    const resetAt = usageState ? new Date(usageState.weekly_resets_at) : new Date(weekStart.getTime() + 7 * 86400000);
    const dailyCost = {};
    let weekCostTotal = 0;
    let weekTokensTotal = 0;

    for (const line of allLines) {
      try {
        const e = JSON.parse(line);
        const ts = new Date(e.ts || e.timestamp || '');
        if (isNaN(ts) || ts < weekStart) continue;
        const c = e.cost_usd || 0;
        const t = e.tokens || 0;
        weekCostTotal += c;
        weekTokensTotal += t;
        const dayStr = ts.toISOString().slice(0, 10);
        dailyCost[dayStr] = (dailyCost[dayStr] || 0) + c;
      } catch (_) {}
    }

    const msElapsed = Math.max(1, now - weekStart);
    const msTotal = Math.max(msElapsed, resetAt - weekStart);
    const pctElapsed = Math.min(1, msElapsed / msTotal);
    const projectedCost = weekCostTotal / pctElapsed;

    // WARROOM-COSTCANON-001 Phase 3: per-agent attribution (topConsumers, R1/R2 below) used
    // to come from a second, independent parse of cost-log.jsonl (`agentCost`, deleted here)
    // — a rival path duplicating exactly what sasmaster.costs.v_token_cost_canonical now
    // provides (C6, "one source per number, enforced by deletion"). Both now read
    // costCanonical.agents, built once above from the canonical MotherDuck view.
    const topConsumers = (costCanonical.agents || [])
      .slice()
      .sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0))
      .slice(0, 10)
      .map(a => ({ id: a.agent_id, cost_usd: Number(a.cost_usd) || 0, tokens: Number(a.tokens) || 0, model: a.model }));

    // Auto-generate optimization recommendations
    const recommendations = [];

    // R1: Agents invoking Opus on low-token tasks (Sonnet would suffice)
    for (const d of (costCanonical.agents || [])) {
      const m = (d.model || '').toLowerCase();
      const avgTokens = Number(d.tokens) || 0;
      const costUsd = Number(d.cost_usd) || 0;
      if (m.includes('opus') && avgTokens < 50000 && avgTokens > 0) {
        const estSave = Math.round(costUsd * 0.6 * 100) / 100;
        recommendations.push({
          type: 'model-downgrade',
          agent: d.agent_id,
          action: `Downgrade ${d.agent_id} from Opus → Sonnet (avg ${avgTokens.toLocaleString()} tokens — below 50K threshold)`,
          est_save_usd_wk: estSave,
          severity: 'amber',
        });
      }
    }

    // R2: Agents invoking Sonnet on very low-token tasks (Haiku would suffice)
    for (const d of (costCanonical.agents || [])) {
      const m = (d.model || '').toLowerCase();
      const avgTokens = Number(d.tokens) || 0;
      const costUsd = Number(d.cost_usd) || 0;
      if (m.includes('sonnet') && avgTokens < 10000 && avgTokens > 0) {
        const estSave = Math.round(costUsd * 0.7 * 100) / 100;
        recommendations.push({
          type: 'model-downgrade',
          agent: d.agent_id,
          action: `Downgrade ${d.agent_id} from Sonnet → Haiku (avg ${avgTokens.toLocaleString()} tokens — below 10K threshold)`,
          est_save_usd_wk: estSave,
          severity: 'amber',
        });
      }
    }

    // R3: High Sonnet burn rate → throttle builds
    if (usageState && (usageState.weekly_sonnet_pct || 0) >= 85) {
      recommendations.push({
        type: 'throttle',
        agent: 'build-loop',
        action: `Sonnet at ${usageState.weekly_sonnet_pct}% — cap opportunistic build loop to 3 tasks/cycle until Thu 10PM reset`,
        est_save_usd_wk: 0,
        severity: 'red',
      });
    }

    // R4: Prompt caching — check if wired (look for cache_creation_input_tokens in recent entries)
    const entriesWithCacheTokens = allLines.reduce((n, line) => {
      try { const e = JSON.parse(line); return n + ((e.cache_creation_input_tokens > 0 || e.cache_read_input_tokens > 0) ? 1 : 0); } catch { return n; }
    }, 0);
    const entriesWithTokens = allLines.reduce((n, line) => {
      try { const e = JSON.parse(line); return n + (e.tokens > 0 ? 1 : 0); } catch { return n; }
    }, 0);
    if (entriesWithCacheTokens > 0) {
      recommendations.push({
        type: 'caching',
        agent: 'all-agents',
        action: `Prompt caching active — ${entriesWithCacheTokens} log entries with cache tokens. Verify: cache_read_input_tokens > 0 on second run within TTL window.`,
        est_save_usd_wk: 0,
        severity: 'green',
      });
    } else if (entriesWithTokens > 3) {
      recommendations.push({
        type: 'caching',
        agent: 'all-agents',
        action: 'Prompt caching wired on intel agents + Dr. Scoop — verify first cache_creation_input_tokens > 0 on next cron run',
        est_save_usd_wk: Math.round(weekCostTotal * 0.5 * 100) / 100,
        severity: 'amber',
      });
    }

    // R5: Week has active spend — recommend batching small tasks to amortize context load
    if (weekCostTotal > 0) {
      recommendations.push({
        type: 'batching',
        agent: 'build-loop',
        action: 'Batch short tasks (<5K token context) into single Claude Code sessions to amortize system-prompt overhead — reduces per-task input tokens by ~30%',
        est_save_usd_wk: Math.round(weekCostTotal * 0.3 * 100) / 100,
        severity: 'amber',
      });
    }

    // R6: Always-on — cache agent skill files on first invocation
    recommendations.push({
      type: 'caching',
      agent: 'skill-loader',
      action: 'Cache ~/.claude/skills/user/*.md reads with cache_control: ephemeral on first load — skill files are 2-15KB and re-read every session uncached',
      est_save_usd_wk: 0,
      severity: 'green',
    });

    tokenProjection = {
      week_cost_usd: Math.round(weekCostTotal * 10000) / 10000,
      week_tokens: weekTokensTotal,
      projected_week_cost_usd: Math.round(projectedCost * 10000) / 10000,
      pct_elapsed: Math.round(pctElapsed * 100),
      daily_cost: dailyCost,
      top_consumers: topConsumers,
      recommendations: recommendations.slice(0, 6),
      week_start: weekStart.toISOString(),
      reset_at: resetAt.toISOString(),
    };
  }
} catch (e) {
  console.warn('[generate-status] token projection failed:', e.message);
}

// ── Per-source freshness (WAR-ROOM-RELIABILITY-001 · WAR-ROOM-ALERT-001) ────
// Thresholds match actual cadence: JARVIS 10m · TMDB 25h · S3 26h · Nielsen 48h · Build 4h · Token 5h
// status: ok (<50% of threshold used) | warn (50-100%) | stale (>100%)
function buildSourceFreshness() {
  const now = Date.now();

  function ageMins(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return Math.round((now - d.getTime()) / 60000);
  }

  function entry(source, lastUpdated, thresholdMins) {
    const age = ageMins(lastUpdated);
    let status = 'unknown';
    if (age !== null) {
      if (age <= thresholdMins * 0.5) status = 'ok';
      else if (age <= thresholdMins)   status = 'warn';
      else                             status = 'stale';
    }
    return { source, last_updated: lastUpdated || null, threshold_mins: thresholdMins, age_mins: age, status };
  }

  // ── JARVIS / Railway heartbeat ────────────────────────────────────────────
  let jarvisLastTs = null;
  try {
    const hbFile = path.join(SASMASTER, 'status', 'railway-health.json');
    if (fs.existsSync(hbFile)) {
      const hb = JSON.parse(fs.readFileSync(hbFile, 'utf8'));
      jarvisLastTs = hb.ts || hb.checked_at || null;
    }
  } catch {}
  // Fallback: if JARVIS is alive right now, treat generated_at as its last heartbeat
  if (!jarvisLastTs && jarvisAlive()) jarvisLastTs = new Date().toISOString();

  // ── TMDB scraper ──────────────────────────────────────────────────────────
  // Take the MOST RECENT of two real signals: the bulk-loader progress file and
  // the daily-agent log. The bulk loader completed (phase:complete, Jun 2026) so
  // its progress file is permanently frozen — keying off it alone reports the live
  // daily scraper as stale forever. tmdb-agent.log mtime is the continuous signal.
  let tmdbLastTs = null;
  const _tmdbCandidates = [];
  try {
    const tf = path.join(SASMASTER, 'status', 'tmdb-progress.json');
    if (fs.existsSync(tf)) {
      const lu = JSON.parse(fs.readFileSync(tf, 'utf8')).last_updated;
      if (lu) _tmdbCandidates.push(new Date(lu).getTime());
    }
  } catch {}
  try { _tmdbCandidates.push(fs.statSync(path.join(SASMASTER, 'logs', 'tmdb-agent.log')).mtimeMs); } catch {}
  const _tmdbValid = _tmdbCandidates.filter(t => !isNaN(t));
  if (_tmdbValid.length) tmdbLastTs = new Date(Math.max(..._tmdbValid)).toISOString();

  // ── S3 Lake sizes ─────────────────────────────────────────────────────────
  let s3LastTs = null;
  try { s3LastTs = fs.statSync(path.join(SASMASTER, 'status', 's3-inventory.json')).mtime.toISOString(); } catch {}

  // ── Nielsen VIEWERSHIP ────────────────────────────────────────────────────
  let nielsenLastTs = null;
  try {
    const nf = path.join(SASMASTER, 'status', 'nielsen-progress.json');
    if (fs.existsSync(nf)) nielsenLastTs = JSON.parse(fs.readFileSync(nf, 'utf8')).last_updated || null;
  } catch {}
  if (!nielsenLastTs) {
    for (const logName of ['nielsen_puller.log', 'nielsen.log', 'data-guardian.log']) {
      try {
        const p = path.join(SASMASTER, 'logs', logName);
        if (fs.existsSync(p)) { nielsenLastTs = fs.statSync(p).mtime.toISOString(); break; }
      } catch {}
    }
  }

  // ── Build events log ──────────────────────────────────────────────────────
  let buildLastTs = null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const buildLog = path.join(SASMASTER, 'logs', `build-${today}.jsonl`);
    if (fs.existsSync(buildLog)) buildLastTs = fs.statSync(buildLog).mtime.toISOString();
  } catch {}
  if (!buildLastTs) {
    try {
      const sqLog = path.join(SASMASTER, 'logs', `score-queue-${today.replace(/-/g, '')}.log`);
      if (fs.existsSync(sqLog)) buildLastTs = fs.statSync(sqLog).mtime.toISOString();
    } catch {}
  }

  // ── Token refresh ─────────────────────────────────────────────────────────
  // Last line in token-refresh.log that does NOT contain "ERROR"
  let tokenLastTs = null;
  try {
    const refreshLog = path.join(SASMASTER, 'logs', 'token-refresh.log');
    if (fs.existsSync(refreshLog)) {
      const lines = fs.readFileSync(refreshLog, 'utf8').split('\n').filter(l => l.trim() && !l.includes('ERROR'));
      if (lines.length > 0) {
        // Date format: [Wed May 27 07:34:11 EDT 2026]
        const m = lines[lines.length - 1].match(/\[([^\]]+)\]/);
        if (m) {
          const parsed = new Date(m[1]);
          if (!isNaN(parsed.getTime())) tokenLastTs = parsed.toISOString();
        }
      }
    }
  } catch {}

  return [
    entry('JARVIS / Railway heartbeat', jarvisLastTs,  10),
    entry('TMDB scraper',               tmdbLastTs,    25 * 60),
    entry('S3 Lake sizes',              s3LastTs,      26 * 60),  // daily scraper, not polled
    entry('Nielsen VIEWERSHIP',         nielsenLastTs, 48 * 60),
    entry('Build events log',           buildLastTs,   4 * 60),   // not continuous
    entry('Token refresh',              tokenLastTs,   5 * 60),
  ];
}

const sourceFreshness = buildSourceFreshness();

// ── Phase 5: Edge-triggered stale-source Slack alerting (WAR-ROOM-ALERT-001) ─
// Fires ONCE on ok→stale transition. Fires ONCE on stale→ok recovery.
// Never repeats for an unchanged condition. Daily 9AM digest for persistent stale.
// State persisted in ~/SaSMaster/status/stale-alert-state.json.
// !ack <source> snoozes a source for 24h (handled in jarvis.js).

const STALE_STATE_FILE = path.join(SASMASTER, 'status', 'stale-alert-state.json');

function loadStaleState() {
  try { return JSON.parse(fs.readFileSync(STALE_STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveStaleState(state) {
  try { fs.writeFileSync(STALE_STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function readEnvVar(name) {
  try {
    const envLines = fs.readFileSync(path.join(SASMASTER, '.env'), 'utf8').split('\n');
    const wl = envLines.find(l => l.startsWith(`${name}=`));
    if (wl) return wl.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '');
  } catch {}
  return '';
}

// MAC-WAKE-RELIABILITY-001 — bot-token alert path. SLACK_BOT_TOKEN is populated;
// the alternate SASMASTER_SLACK_WEBHOOK path has been unset for 81+ days (confirmed
// 2026-08-27 review) and was removed (see alertStaleSources()) rather than left as
// unreachable dead code — reintroduce only with a live webhook + a canary probe (§21).
// `attachments` (optional) matches chat.postMessage's own shape.
function postSlackBot(text, attachments) {
  const token   = readEnvVar('SLACK_BOT_TOKEN');
  const channel = readEnvVar('SLACK_BUILDS_CHANNEL_ID');
  if (!token || !channel) return false;
  try {
    const https = require('https');
    const payload = { channel, text };
    if (attachments) payload.attachments = attachments;
    const body  = JSON.stringify(payload);
    const req   = https.request({
      hostname: 'slack.com',
      path:     '/api/chat.postMessage',
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
    return true;
  } catch { return false; }
}

function fmtAge(age_mins) {
  if (age_mins == null) return 'unknown';
  return (age_mins < 60 ? `${age_mins}m` : `${Math.round(age_mins / 60)}h`) + ' ago';
}

function fmtThreshold(threshold_mins) {
  return threshold_mins >= 60 ? `${Math.round(threshold_mins / 60)}h` : `${threshold_mins}m`;
}

function alertStaleSources(freshness) {
  // Was gated on readWebhook()/SASMASTER_SLACK_WEBHOOK, which has been unset for 81+ days
  // (confirmed 2026-08-27 review) — this early-return made the whole edge-triggered stale-
  // alert state machine dead code on every single run, silently. Switched to postSlackBot(),
  // the same working bot-token path already used for job-failure/S3-recovery alerts below.
  const state = loadStaleState();
  const now   = Date.now();
  // WARROOM-CLOCK-001 (2026-08-24): was raw host-local getHours/getMinutes —
  // the 9AM-digest gate below would silently fire at the wrong real-world ET
  // hour on any host whose local timezone isn't America/New_York (C5).
  const { hour: nowHr, minute: nowMin } = WarroomClock.etHourMinute();

  const transitionLines   = [];  // ok→stale or stale→ok
  const persistentStale   = [];  // still stale >24h, for 9AM digest

  for (const s of freshness) {
    const key  = s.source;
    const prev = state[key] || {};
    const snoozedUntil = prev.snoozed_until ? new Date(prev.snoozed_until).getTime() : 0;

    if (snoozedUntil > now) continue;  // user ack'd — skip until snooze expires

    const prevStatus = prev.last_known_status || 'unknown';
    const curStatus  = s.status;

    // Detect transition
    const wentStale    = curStatus === 'stale' && prevStatus !== 'stale';
    const recovered    = curStatus !== 'stale' && prevStatus === 'stale';

    if (wentStale) {
      transitionLines.push(`🔴 *STALE* — *${s.source}* last updated ${fmtAge(s.age_mins)} (threshold ${fmtThreshold(s.threshold_mins)})`);
      state[key] = { ...prev, last_known_status: curStatus, last_transition_at: new Date().toISOString(), last_alerted_at: new Date().toISOString() };
    } else if (recovered) {
      transitionLines.push(`✅ *RECOVERED* — *${s.source}* is now fresh again`);
      state[key] = { ...prev, last_known_status: curStatus, last_transition_at: new Date().toISOString(), last_alerted_at: new Date().toISOString() };
    } else {
      // No transition — just update the tracked status
      state[key] = { ...prev, last_known_status: curStatus };
    }

    // Collect for daily 9AM digest: stale for >24h and still stale now
    if (curStatus === 'stale') {
      const lastAlerted = prev.last_alerted_at ? new Date(prev.last_alerted_at).getTime() : 0;
      const staleHours  = s.age_mins != null ? s.age_mins / 60 : 0;
      if (staleHours > 24 && now - lastAlerted > 23 * 60 * 60 * 1000) {
        persistentStale.push(s);
      }
    }
  }

  // Fire transition alert immediately
  if (transitionLines.length) {
    postSlackBot(transitionLines.join('\n'), [
      { color: transitionLines.some(l => l.includes('STALE')) ? 'danger' : 'good', footer: 'generate-status.js · stale-source monitor (edge-triggered)' },
    ]);
  }

  // Daily 9AM digest for persistent stale sources (fires in the 9:00-9:14 window)
  if (persistentStale.length && nowHr === 9 && nowMin < 15) {
    const digestLines = persistentStale.map(s =>
      `⚠️ *${s.source}* — stale ${fmtAge(s.age_mins)} (threshold ${fmtThreshold(s.threshold_mins)}) · \`!ack WAR-ROOM-STALE ${s.source}\` to snooze 24h`
    );
    postSlackBot(`📋 *Daily stale-source digest* — ${persistentStale.length} source(s) still stale:`, [
      { color: 'warning', text: digestLines.join('\n'), footer: 'generate-status.js · 9AM stale digest' },
    ]);
    // Mark last_alerted_at so we don't re-digest until tomorrow
    for (const s of persistentStale) {
      if (state[s.source]) state[s.source].last_alerted_at = new Date().toISOString();
    }
  }

  saveStaleState(state);
}

alertStaleSources(sourceFreshness);

// ── TRUTHFUL-VITALS-001 ───────────────────────────────────────────────────────
// Health formula is DATA, not code. Edit HEALTH_FORMULA to change weights/thresholds.
// This block is the SOLE authority for all health scoring. No caching, no carry-forward.
// Authority: computed fresh every cycle from first principles.

const CANARY_STATE_FILE = path.join(SASMASTER, 'status', 'canary-state.json');

// Known-fail canaries are excluded from canary_health denominator (CANARIES.yaml).
const KNOWN_FAIL_CANARIES = new Set(['gracenote_onconnect', 'eidr_query_api']);

// HEALTH_FORMULA config block — reviewable in 30 seconds, changeable without deploy.
const HEALTH_FORMULA = {
  formula_version: 'v2',
  weights: {
    agents:    0.35,  // healthy live-cron agents / total live-cron agents
    canaries:  0.30,  // pass / (pass + fail) where known_fail excluded from denominator
    freshness: 0.25,  // ok+warn sources / (ok+warn+stale) from source_freshness
    cron:      0.10,  // 1 - (missed_non_weekly_today / scheduled_non_weekly_today)
  },
  amber_floor_rule: 'SUPERSEDED by v2 worst-band cap (HEALTH-RING-V2-SCORING-SPEC-001 §3.2) — a 0% component is now a "red" component band, which forces the composite to red outright, a stronger floor than this v1 amber-only rule. Kept only for the `floor` field back-compat read by index.html.',
  thresholds: { green: 85, amber: 60 },  // score out of 100 — reused as-is for per-component banding (§3.1)
};

const BAND_RANK = { green: 0, amber: 1, red: 2 };
function componentBand(pct) {
  return pct >= HEALTH_FORMULA.thresholds.green ? 'green'
       : pct >= HEALTH_FORMULA.thresholds.amber ? 'amber'
       : 'red';
}
function worseBand(a, b) { return BAND_RANK[a] >= BAND_RANK[b] ? a : b; }

// ── HEALTH-RING-V2 gate #1: sentinel_status (SUB-050/SUB-051) ────────────────
// sentinel_status is an L3 key (ops.platform_state, MotherDuck) written by
// sentinel/sentinel.py's l3_write_status() on green<->red state change — NOT
// the deadman-heartbeat file (~/SaSMaster/data/sentinel-deadman-state.json,
// a separate signal). Read fresh every cycle; never cached. MOTHERDUCK_TOKEN
// is passed as an env var to the duckdb CLI subprocess, never interpolated
// into the connection string (MD ATTACH token-leak rule).
function readSentinelStatus() {
  try {
    const token = readEnvVar('MOTHERDUCK_TOKEN');
    if (!token) return { status: 'unknown', error: 'no_motherduck_token' };
    // STATUS-PROCLEAK-001: see the note at the other duckdb call sites.
    const _r = spawnSync(
      '/opt/homebrew/bin/duckdb',
      ['-json', '-c', "SELECT value FROM ops.platform_state WHERE key = 'sentinel_status'", 'md:sasmaster'],
      { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, motherduck_token: token } }
    );
    const out = (_r.status === 0 && _r.stdout) ? _r.stdout : '';
    const rows = JSON.parse(out);
    const status = (rows[0] && rows[0].value) ? String(rows[0].value).toLowerCase() : 'unknown';
    return { status, error: null };
  } catch (e) {
    // Fail OPEN on read failure (network blip, cold start, missing table) —
    // an unreadable signal is not proof of 'red'; it just can't gate this cycle.
    return { status: 'unknown', error: e.message };
  }
}

// ── HEALTH-RING-V2 gate #2: undismissed critical/page-severity alerts ────────
// Reuses the SAME stale-alert-state.json persisted by alertStaleSources()
// above (STALE_STATE_FILE / loadStaleState()) — no new data source. An entry
// is an undismissed critical if its last known status is 'stale' (the only
// page-severity condition alertStaleSources() tracks) AND its snooze (set by
// `!ack`) is absent or has expired.
function getUndismissedCriticalAlerts() {
  const state = loadStaleState();
  const now = Date.now();
  const undismissed = [];
  for (const [source, entry] of Object.entries(state)) {
    if (!entry || entry.last_known_status !== 'stale') continue;
    const snoozedUntil = entry.snoozed_until ? new Date(entry.snoozed_until).getTime() : 0;
    if (snoozedUntil > now) continue;  // dismissed via !ack, still within snooze window
    undismissed.push(source);
  }
  return undismissed;
}

function computeHealthScore(agentList, freshnessList, cronList, sentinelStatus, undismissedCritical) {
  // ── Component 1: agents (35%) — live/cron type only ──
  const liveAgents  = agentList.filter(a => !a.type || a.type === 'live');
  const agentTotal  = liveAgents.length;
  // WARROOM-HEALTH-001: uses the computed evaluator state (C6 — same function that drives
  // the AGENTS-tab badge), not the pre-fix asserted 'healthy'/'routing' literal.
  const agentHealthy = liveAgents.filter(a => a.healthEval && a.healthEval.state === 'healthy').length;
  const agentPct    = agentTotal > 0 ? agentHealthy / agentTotal : 1;

  // ── Component 2: canaries (30%) — unexpected fails only (known_fail excluded) ──
  let canaryPct = 1;
  try {
    const state   = JSON.parse(fs.readFileSync(CANARY_STATE_FILE, 'utf8'));
    const entries = Object.entries(state).filter(([name]) => !KNOWN_FAIL_CANARIES.has(name));
    const pass    = entries.filter(([, v]) => v.ok).length;
    canaryPct     = entries.length > 0 ? pass / entries.length : 1;
  } catch { /* canary-state.json missing — score 1.0, do not block */ }

  // ── Component 3: freshness (25%) — from source_freshness (single authority) ──
  const known = (freshnessList || []).filter(s => s.status !== 'unknown');
  const notStale = known.filter(s => s.status === 'ok' || s.status === 'warn').length;
  const freshnessPct = known.length > 0 ? notStale / known.length : 1;

  // ── Component 4: cron (10%) — non-weekly jobs scheduled today ──
  const nonWeeklyToday = (cronList || []).filter(c => !c.weekly);
  const missedToday    = nonWeeklyToday.filter(c => c.status === 'pending').length;
  const cronPct        = nonWeeklyToday.length > 0 ? Math.max(0, 1 - (missedToday / nonWeeklyToday.length)) : 1;

  const w        = HEALTH_FORMULA.weights;
  const rawScore = (agentPct * w.agents) + (canaryPct * w.canaries) + (freshnessPct * w.freshness) + (cronPct * w.cron);
  const score    = Math.round(rawScore * 100);

  const components = {
    agents:    Math.round(agentPct    * 100),
    canaries:  Math.round(canaryPct   * 100),
    freshness: Math.round(freshnessPct * 100),
    cron:      Math.round(cronPct      * 100),
  };

  // v1 back-compat field — no longer drives `grade` (see amber_floor_rule note
  // above), kept only because index.html reads h.floor for a UI note.
  const anyZero = Object.values(components).some(v => v === 0);
  const floor   = anyZero ? 'amber' : null;

  // ── HEALTH-RING-V2 §3.1: per-component banding (same thresholds as composite) ──
  const component_bands = {
    agents:    componentBand(components.agents),
    canaries:  componentBand(components.canaries),
    freshness: componentBand(components.freshness),
    cron:      componentBand(components.cron),
  };
  const worst_component_band = Object.values(component_bands).reduce(worseBand, 'green');

  // ── §3.2: raw band from the numeric score — the v1 "naive" band, kept for display ──
  const rawBand = score >= HEALTH_FORMULA.thresholds.green ? 'green'
                : score >= HEALTH_FORMULA.thresholds.amber ? 'amber'
                : 'red';

  // ── §3.4: hard gates — evaluated FIRST, short-circuit straight to red ──
  const gates_triggered = [];
  if (sentinelStatus === 'red') gates_triggered.push('sentinel_status_red');
  (undismissedCritical || []).forEach(source => gates_triggered.push(`undismissed_critical: ${source}`));

  // ── §3.5: final composite band ──
  const grade = gates_triggered.length > 0
    ? 'red'
    : worseBand(rawBand, worst_component_band);  // §3.2 worst-band cap

  return {
    score,
    grade,
    worst_component_band,
    gates_triggered,
    component_bands,
    sentinel_status: sentinelStatus || 'unknown',
    floor,
    components,
    formula_version: HEALTH_FORMULA.formula_version,
    formula: HEALTH_FORMULA,
    computed_at: new Date().toISOString(),
  };
}

// Follow-up = COUNT of: ERROR agents + unexpected canary fails + freshness breaches + blocked tasks
// Authority: real-state query every cycle — no manual field, no carry-forward.
function computeFollowUp(agentList, freshnessList, blockedTasks) {
  let count = 0;
  const items = [];

  // 1. Agents in ERROR state (live/cron agents only)
  const liveAgents  = agentList.filter(a => !a.type || a.type === 'live');
  liveAgents.filter(a => a.status === 'error').forEach(a => {
    count++;
    items.push({ type: 'agent_error', name: a.name });
  });

  // 2. Unexpected canary fails (known_fail excluded — those are tracked, not followed-up)
  try {
    const state = JSON.parse(fs.readFileSync(CANARY_STATE_FILE, 'utf8'));
    Object.entries(state)
      .filter(([name, v]) => !KNOWN_FAIL_CANARIES.has(name) && !v.ok)
      .forEach(([name]) => { count++; items.push({ type: 'canary_fail', name }); });
  } catch {}

  // 3. Freshness breaches (stale status from source_freshness — single authority)
  (freshnessList || []).filter(s => s.status === 'stale').forEach(s => {
    count++;
    items.push({ type: 'freshness_breach', name: s.source });
  });

  // 4. Blocked tasks from TASKS.md
  (blockedTasks || []).forEach(t => {
    count++;
    items.push({ type: 'blocked_task', name: (t.text || '').slice(0, 60) });
  });

  return { count, items };
}

const sentinelStatusResult = readSentinelStatus();
if (sentinelStatusResult.error) console.warn(`[WARN] sentinel_status read: ${sentinelStatusResult.error}`);
const undismissedCriticalAlerts = getUndismissedCriticalAlerts();
const healthResult  = computeHealthScore(agents, sourceFreshness, cron, sentinelStatusResult.status, undismissedCriticalAlerts);
const followUpResult = computeFollowUp(agents, sourceFreshness, tasks.blockedItems);

// ── Portal coverage — reads latest report from ~/SaSMaster/reports/ ──────────
function loadPortalCoverage() {
  try {
    const reportsDir = path.join(SASMASTER, 'reports');
    const files = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith('portal-coverage-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) return null;
    const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8'));
    return {
      baseline: raw.baseline || 'unknown',
      portal_url: raw.portal_url || '',
      report_date: files[0].replace('portal-coverage-', '').replace('.json', ''),
      summary: raw.summary || {},
    };
  } catch { return null; }
}
const portalCoverage = loadPortalCoverage();

const status = {
  generated:    new Date().toISOString(),
  generated_at: new Date().toISOString(),  // alias — Railway health check reads this
  system:    { jarvis: { alive: jarvisAlive() } },

  queue: {
    high:         tasks.high,
    med:          tasks.med,
    highItems:    tasks.highItems,
    medItems:     tasks.medItems,
    exploreItems: tasks.exploreItems,
    wipItems:     tasks.wipItems,
    blockedItems: tasks.blockedItems,
    reviewItems:  tasks.reviewItems,
    // WARROOM-RUNSTATE-001 gap 1 -- run_state()-derived, genuinely distinct from wipItems
    // (TASKS.md work items) above. jobsInProgress is the count; jobsInProgressDetail carries
    // per-job run_id/state provenance so a rendered cell can always resolve a run_id.
    jobsInProgress:       jobsRunningOrStuck,
    jobsInProgressDetail: runStateAll.filter(r => r.state === 'running' || r.state === 'stuck')
      .map(r => ({ job: r.job, state: r.state, run_id: r.run_id, reason: r.reason })),
  },
  // WARROOM-RUNSTATE-001 -- the full run_state() result for every job in ALL_WIRED_JOBS,
  // one evaluation per generation cycle (C6). Source of truth for OPS/DATA/QUEUE run-state
  // cells and for the anti-fabrication + C6 delete-list VERIFY assertions (paste-able
  // per-job output, run_id always present or state is one of never_run/error).
  run_state_all: runStateAll,
  kanban,
  heatmap,
  target10: parseTarget10(),
  agents,
  recentBuilds,
  intel_feed:  intelFeed,
  claudeUsage: { claudeai: null, claudecode: null, claudedesign: null, claudemax: null },
  alerts,

  // ── New fields for v3 War Room ──
  scrapers,
  s3_lake,
  movie_universe: movieUniverse,
  kpis:                (() => {
    const kpis = buildKPIs(agents, scrapers, s3_lake, tasks, parentKeyScraper, buildEventsCount, haikuPctToday, warroomS3Total);
    kpis.builds_7d       = buildTrends?.builds_7d   || 0;
    kpis.error_rate_7d   = buildTrends?.error_rate   || 0;
    // WARROOM-RUNSTATE-001 gap 1 -- distinct KPI tile input, run_state()-derived job count.
    kpis.jobs_running_or_stuck = jobsRunningOrStuck;
    return kpis;
  })(),
  build_trends:        buildTrends,
  recent_activity:     buildMergedActivity(intelFeed, recentBuilds, scrapers, buildEventsToday),
  cron,
  tasks:               buildTasksForV3(kanban),
  recent_completions:  recentBuilds.map(b => ({
    title: b.task,
    category: (b.task || '').toLowerCase().includes('portal') ? 'Portal'
            : (b.task || '').toLowerCase().includes('scraper') || (b.task || '').toLowerCase().includes('edgar') ? 'Pipeline'
            : (b.task || '').toLowerCase().includes('agent') ? 'Agent'
            : 'Build',
    path: '',
    completed_at: b.date || '',
  })),
  slack_feed:  buildSlackFeed(recentBuilds, intelFeed),
  cost_summary: costSummary,
  portal_coverage: portalCoverage,
  usage_state: usageState,
  token_projection: tokenProjection,
  cost_canonical: costCanonical,
  source_freshness: sourceFreshness,

  // ── TRUTHFUL-VITALS-001 — derived from first principles every cycle ──────────
  // health.score / health.grade / health.components are the SINGLE authoritative
  // health truth. Frontend reads d.health.score — never computes its own formula.
  health:          healthResult,
  // follow_up_count is the SINGLE authoritative follow-up count.
  // Frontend reads d.follow_up_count — never derives its own count from kanban.
  follow_up_count: followUpResult.count,
  follow_up_items: followUpResult.items,

  // ASK platform config — key is server-side only (Vercel env), never in status.json
  // War Room calls /api/ask (Vercel proxy) which holds the key; no key flows to client.
  ask: {
    url:     '/api/ask',  // always the Vercel proxy — never Railway URL directly
    enabled: true,        // proxy is always wired; Railway liveness is its own check
  },
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);

// Push to S3 — two paths so Railway heartbeat can promote without cross-prefix IAM
// MAC-WAKE-RELIABILITY-001: failures alert #builds immediately (transition-based,
// re-alert hourly while failing, recovery ping) — downstream freshness lag is no
// longer the only signal. Root cause of the 2026-06-14 82-min blind spot.
const PUSH_STATE_FILE = path.join(__dirname, 'push-fail-state.json');
const pushFailures = [];

function pushToS3(src, dest) {
  try {
    // STATUS-PROCLEAK-001: array-form + bounded. Was unbounded, so a wedged
    // upload stalled status generation indefinitely. Non-zero is re-thrown so
    // the existing catch (which reads e.message) behaves exactly as before.
    const _r = spawnSync(
      '/opt/homebrew/bin/aws',
      ['s3', 'cp', src, dest, '--content-type', 'application/json'],
      { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (_r.error) throw _r.error;
    if (_r.status !== 0) throw new Error((_r.stderr || '').trim() || `aws s3 cp exited ${_r.status}`);
    console.log(`[generate-status] pushed to ${dest}`);
    return true;
  } catch (e) {
    console.warn(`[generate-status] S3 push FAILED for ${dest}: ${e.message}`);
    pushFailures.push({ dest, error: (e.message || '').split('\n')[0].slice(0, 200) });
    return false;
  }
}

pushToS3(OUT, 's3://sasmaster-2026/status/status.json');
pushToS3(OUT, 's3://sasmaster-2026/cache/api/status.json');

// Push skills manifest mirror to public bucket (SKILL-REGISTRY-002)
// sasmaster-public has BPA off + public-read policy; sasmaster-2026 BPA stays fully ON
const MANIFEST_SRC = path.join(__dirname, 'resources', 'skills-manifest.json');
if (fs.existsSync(MANIFEST_SRC)) {
  pushToS3(MANIFEST_SRC, 's3://sasmaster-public/skills-manifest.json');
}

// Alert on push-state transitions: ok→fail fires immediately, still-failing
// re-fires hourly (script runs every 5 min — unthrottled would be 12 alerts/hr),
// fail→ok posts recovery. State survives across runs in push-fail-state.json.
(() => {
  let pushState = {};
  try { pushState = JSON.parse(fs.readFileSync(PUSH_STATE_FILE, 'utf8')); } catch {}
  const now = Date.now();
  const REALERT_MS = 60 * 60 * 1000;

  if (pushFailures.length > 0) {
    const firstFail   = pushState.failing_since ? new Date(pushState.failing_since).getTime() : now;
    const lastAlerted = pushState.last_alerted_at ? new Date(pushState.last_alerted_at).getTime() : 0;
    const isNewFailure = !pushState.failing_since;
    if (isNewFailure || now - lastAlerted > REALERT_MS) {
      const mins  = Math.round((now - firstFail) / 60000);
      const lines = pushFailures.map(f => `• \`${f.dest}\` — ${f.error}`).join('\n');
      postSlackBot(
        `🔴 *S3 PUSH FAILURE* — generate-status.js cannot push status.json` +
        (isNewFailure ? '' : ` (failing for ${mins}m)`) +
        `\n${lines}\nWar Room will go stale until this clears. Check aws PATH/creds on the Mac.`
      );
      pushState = { failing_since: pushState.failing_since || new Date().toISOString(), last_alerted_at: new Date().toISOString() };
    }
  } else if (pushState.failing_since) {
    const mins = Math.round((now - new Date(pushState.failing_since).getTime()) / 60000);
    postSlackBot(`✅ *S3 PUSH RECOVERED* — status.json pushing again after ${mins}m of failures.`);
    pushState = {};
  }
  try { fs.writeFileSync(PUSH_STATE_FILE, JSON.stringify(pushState, null, 2)); } catch {}
})();
