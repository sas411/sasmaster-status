/**
 * WARROOM-OPSTIMELINE-001 Phase 2/3 — the ONE join+evaluate path shared by
 * both GET /api/ops/timeline and GET /api/ops/cron-today (C4/C6: two call
 * sites, one function, never two independent evaluations of the same slot).
 *
 * buildOpsRows(opts) -> [{job, scheduled_at, run_id, started_at, finished_at,
 *   exit_code, trigger, state, reason}] — exactly the card's declared
 * response shape (`Layer:` line), state via lib/warroom-ops-timeline.js.
 *
 * REAL, DISCLOSED LIMITATION (not silently worked around): the only
 * execution-side source this repo's Vercel functions can reach today is the
 * SAME per-job LATEST-run-state blob api/state/ops.js already fetches
 * (WarroomReadplane.fetchTabBlob('ops') -> blob.jobs, one run_state()-shaped
 * summary per job — see that file's header + lib/warroom-runstate.js).
 * There is no raw multi-row run_log feed reachable from this repo's
 * serverless layer (lib/warroom-readplane.js's own header: no MotherDuck
 * client wired here). For a daily-or-slower cadence job this is sufficient
 * — "latest run" and "today's one slot" are the same question. For the
 * sub-hourly infra jobs (sync-to-s3-cache, process-jobs, build-auto-reaper,
 * generate-status, rules-engine-5min) it is NOT sufficient: only the single
 * most-recent slot within the match window can ever resolve to ran_ok/
 * ran_failed/running/stuck from this data; every OLDER same-day slot for
 * those jobs has no matching run to inspect and falls through to the
 * elapsed-slot branch (grace_unset today, since every grace_minutes is
 * UNSET — see warroom/jobs.json). This is C1-honest (no fabricated
 * per-slot currency) but IS a real gap for whoever next wants a true
 * per-slot history once grace is set — flagged in DONE_LOG, not hidden here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./warroom-ops-schedule'),
      require('./warroom-ops-timeline')
    );
  } else {
    root.WarroomOpsJoin = factory(root.WarroomOpsSchedule, root.WarroomOpsTimeline);
  }
})(typeof self !== 'undefined' ? self : this, function (WarroomOpsSchedule, WarroomOpsTimeline) {
  'use strict';

  // Half the job's own cadence (capped 30min..12h) is the tolerance used to
  // decide whether a job's single latest-run summary belongs to a GIVEN
  // slot rather than some other slot of the same job. A documented design
  // choice (this repo has no raw per-slot run rows to match against
  // exactly, per the header note), not a fabricated fact.
  function _matchToleranceMs(expectedCadenceSeconds) {
    var DEFAULT_MS = 12 * 3600000;
    if (typeof expectedCadenceSeconds !== 'number' || expectedCadenceSeconds <= 0) return DEFAULT_MS;
    var half = (expectedCadenceSeconds * 1000) / 2;
    return Math.max(30 * 60000, Math.min(DEFAULT_MS, half));
  }

  function _graceMinutesFor(graceJobId, jobsRegistry) {
    if (!graceJobId || !jobsRegistry || !jobsRegistry.jobs) return 'UNSET';
    var found = null;
    Object.keys(jobsRegistry.jobs).forEach(function (k) {
      var row = jobsRegistry.jobs[k];
      if (row && row.job_id === graceJobId) found = row;
    });
    if (!found) return 'UNSET';
    return found.grace_minutes; // literal 'UNSET' string or a real number once Shiv sets it
  }

  /**
   * buildOpsRows(opts):
   *   cronRegistry      warroom/ops-cron-registry.json's parsed contents
   *   jobsRegistry      warroom/jobs.json's parsed contents (grace_minutes source)
   *   runSummaryByJobId map keyed by grace_job_id (or job_id fallback) -> the
   *                     run_state()-shaped summary from the OPS blob's
   *                     `jobs` array (job/state/reason/run_id/started_at/
   *                     finished_at/exit_code/trigger — whichever the proxy
   *                     actually carries; missing fields are simply absent,
   *                     never fabricated)
   *   windowHours       size of the trailing window (card default 24)
   *   now               injected Date (C5)
   */
  function buildOpsRows(opts) {
    opts = opts || {};
    var now = opts.now instanceof Date ? opts.now : new Date(opts.now);
    var slots = WarroomOpsSchedule.expandSlotsForWindow(opts.cronRegistry && opts.cronRegistry.jobs, opts.windowHours || 24, now);
    var runByJob = opts.runSummaryByJobId || {};

    return slots.map(function (slot) {
      var lookupKey = slot.grace_job_id || slot.job_id;
      var run = runByJob[lookupKey] || runByJob[slot.job_id] || null;

      var matched = null;
      if (run && slot.scheduled_at) {
        var startedMs = run.started_at ? Date.parse(run.started_at) : NaN;
        var slotMs = Date.parse(slot.scheduled_at);
        var tol = _matchToleranceMs(slot.expected_cadence_seconds);
        if (!isNaN(startedMs) && Math.abs(startedMs - slotMs) <= tol) matched = run;
      } else if (run && !slot.scheduled_at && (slot.alwaysOn || !slot.hasCadence)) {
        // No discrete slot to match against (JARVIS-shaped / no-cadence rows)
        // — still surface whatever run info exists, evaluator decides.
        matched = run;
      }

      var graceMinutes = _graceMinutesFor(slot.grace_job_id, opts.jobsRegistry);

      var evald = WarroomOpsTimeline.computeSlotState({
        job: slot.job_id,
        scheduledAtIso: slot.scheduled_at,
        now: now,
        hasCadence: slot.hasCadence,
        alwaysOn: slot.alwaysOn,
        fleetClassified: slot.fleetClassified,
        graceMinutes: graceMinutes,
        matchedRun: matched,
        terminalDurationsMs: (matched && matched.terminalDurationsMs) || null
      });

      return {
        job: slot.job_id,
        display_name: slot.display_name,
        scheduled_at: slot.scheduled_at,
        run_id: evald.run_id,
        started_at: evald.started_at,
        finished_at: evald.finished_at,
        exit_code: (matched && typeof matched.exit_code !== 'undefined') ? matched.exit_code : null,
        trigger: (matched && matched.trigger) || null,
        state: evald.state,
        reason: evald.reason || null
      };
    });
  }

  /**
   * collapseToOnePerJob(rows, now) -> one row per distinct `job`, for
   * surfaces (Cron Today sidebar) that show one dot per job, not one per
   * slot. Picks the MOST RECENT slot whose scheduled_at <= now (the last
   * occurrence that should already have happened); if a job has no past
   * slot yet today, picks its EARLIEST upcoming slot instead (renders
   * pending). No-cadence rows (already exactly one row) pass through.
   * Never averages or invents a state across slots — always a real,
   * single row from the join above.
   */
  function collapseToOnePerJob(rows, now) {
    var nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    var byJob = {};
    rows.forEach(function (r) {
      if (!byJob[r.job]) byJob[r.job] = [];
      byJob[r.job].push(r);
    });
    return Object.keys(byJob).map(function (job) {
      var list = byJob[job];
      if (list.length === 1) return list[0];
      var past = list.filter(function (r) { return r.scheduled_at && Date.parse(r.scheduled_at) <= nowMs; });
      if (past.length > 0) {
        return past.reduce(function (a, b) { return Date.parse(b.scheduled_at) > Date.parse(a.scheduled_at) ? b : a; });
      }
      var future = list.filter(function (r) { return r.scheduled_at; });
      if (future.length > 0) {
        return future.reduce(function (a, b) { return Date.parse(b.scheduled_at) < Date.parse(a.scheduled_at) ? b : a; });
      }
      return list[0];
    });
  }

  return { buildOpsRows: buildOpsRows, collapseToOnePerJob: collapseToOnePerJob };
});
