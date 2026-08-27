// Vercel serverless route: GET /api/ops/cron-today
// WARROOM-OPSTIMELINE-001 — Cron Today sidebar's dot states. Same shape and
// same shared join as api/ops/timeline.js (lib/warroom-ops-join.js), scoped
// to a short trailing window (today only, not the full 24h look-back) since
// the sidebar answers "how did today's schedule go", not "show me the day".

const WarroomReadplane = require('../../lib/warroom-readplane');
const WarroomOpsJoin = require('../../lib/warroom-ops-join');
const cronRegistry = require('../../warroom/ops-cron-registry.json');
const jobsRegistry = require('../../warroom/jobs.json');

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

  const now = new Date();
  let blob = null;
  let fetchError = null;
  try {
    blob = await WarroomReadplane.fetchTabBlob('ops');
  } catch (e) {
    fetchError = e && e.message ? e.message : 'unknown_fetch_error';
  }

  if (fetchError || (blob && blob.error)) {
    res.status(200).json({
      computed_at: now.toISOString(),
      state: 'error',
      query_id: 'ops-cron-today:run-log-unreachable',
      reason: 'ERROR — ' + (fetchError || (blob && blob.error)),
      rows: []
    });
    return;
  }

  // Same join as timeline.js, then collapsed to ONE row per job (the
  // sidebar shows one dot per job, matching the pre-existing static
  // markup's shape — a sub-hourly job like process-jobs would otherwise
  // flood the sidebar with ~1440 rows/day, which is real data but the
  // wrong shape for this surface).
  const rows = WarroomOpsJoin.collapseToOnePerJob(
    WarroomOpsJoin.buildOpsRows({ cronRegistry, jobsRegistry, runSummaryByJobId: runSummaryLookup(blob), windowHours: 24, now }),
    now
  );

  res.status(200).json({
    computed_at: now.toISOString(),
    source: (blob && blob.source) || 'unknown',
    rows
  });
};
