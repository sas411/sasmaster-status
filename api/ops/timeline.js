// Vercel serverless route: GET /api/ops/timeline?window=24h
// WARROOM-OPSTIMELINE-001 — schedule+execution overlay for the OPS 24h
// timeline. Response shape per the card's own `Layer:` line:
//   [{job, scheduled_at, run_id|null, started_at, finished_at, exit_code,
//     trigger, state}]
//
// One join, shared with cron-today.js (lib/warroom-ops-join.js) — C4/C6:
// never two independent evaluators of the same slot.

const WarroomReadplane = require('../../lib/warroom-readplane');
const WarroomOpsJoin = require('../../lib/warroom-ops-join');
const cronRegistry = require('../../warroom/ops-cron-registry.json');
const jobsRegistry = require('../../warroom/jobs.json');

function parseWindowHours(q) {
  if (!q) return 24;
  const m = /^(\d+)h$/.exec(String(q).trim());
  if (!m) return 24;
  const n = parseInt(m[1], 10);
  return (n > 0 && n <= 168) ? n : 24;
}

// Projects the OPS blob's per-job run_state()-shaped rows into the lookup
// this join needs. Never invents fields the blob doesn't carry (C1) — a
// missing started_at/exit_code/trigger simply stays absent.
function runSummaryLookup(blob) {
  const out = {};
  (blob && blob.jobs || []).forEach((j) => {
    if (!j || !j.job) return;
    out[j.job] = j;
  });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const windowHours = parseWindowHours(req.query && req.query.window);
  const now = new Date();

  let blob = null;
  let fetchError = null;
  try {
    blob = await WarroomReadplane.fetchTabBlob('ops');
  } catch (e) {
    fetchError = e && e.message ? e.message : 'unknown_fetch_error';
  }

  if (fetchError || (blob && blob.error)) {
    // C1: an unreadable execution source must render ERROR for every row,
    // never a fabricated schedule-only view (the exact §4 OPS defect this
    // card exists to remove).
    res.status(200).json({
      window: windowHours + 'h',
      computed_at: now.toISOString(),
      state: 'error',
      query_id: 'ops-timeline:run-log-unreachable',
      reason: 'ERROR — ' + (fetchError || (blob && blob.error)),
      rows: []
    });
    return;
  }

  const rows = WarroomOpsJoin.buildOpsRows({
    cronRegistry,
    jobsRegistry,
    runSummaryByJobId: runSummaryLookup(blob),
    windowHours,
    now
  });

  res.status(200).json({
    window: windowHours + 'h',
    computed_at: now.toISOString(),
    source: (blob && blob.source) || 'unknown',
    rows
  });
};
