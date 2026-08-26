/**
 * WARROOM-RUNSTATE-001 -- the one run-state evaluator (C6).
 *
 * Replaces three independent, disagreeing derivations of "is this job running":
 *   1. OPS "TMDB bulk loader" tile (generate-status.js buildScrapers()): status computed
 *      from status/tmdb-progress.json via
 *        `tmdbProgress?.running ? 'running' : (tmdbProgress?.phase === 'complete' ? 'live' : 'running')`
 *      -- note the ELSE branch on the inner ternary defaults to 'running' too. If the
 *      progress file is stale (job finished 8 days ago, .running never got cleared, .phase
 *      never got set to 'complete'), every branch of this expression still returns
 *      'running'. This is the exact "start marker that nothing clears" the spec diagnosed --
 *      confirmed on disk, not assumed.
 *   2. DATA "tmdb_dev/" badge (warroom-v5.html client-side fallback `vm` defaults,
 *      s3lake/s3prefixes arrays): hardcoded `status:'running'` literal in the pre-load
 *      placeholder object -- a WARROOM-INVENTORY-001 MOCK row (register row already exists
 *      for this), out of scope to re-classify here, but confirmed NOT read from run-log.
 *   3. QUEUE "IN PROGRESS" count (generate-status.js line ~1375: `inProgress: tasks.wipItems`):
 *      a TASKS.md work-item parse, entirely unrelated to job execution state -- it happened
 *      to read 0 while OPS/DATA both said "running" because it was never answering the same
 *      question. This card adds a second, run-log-derived in-progress count
 *      (`runningJobsCount`) alongside the existing WIP count rather than deleting the WIP
 *      concept, which is real and used elsewhere (Kanban board) -- see report for the
 *      naming/semantics call this leaves open.
 *
 * State machine (card Phase 2), derived from the run-log's TERMINAL record only:
 *   terminal record, exit_code === 0        -> succeeded
 *   terminal record, exit_code !== 0        -> failed
 *   no terminal record, within threshold    -> running
 *   no terminal record, beyond threshold    -> stuck
 *   no record at all                        -> never_run  (renders "N/A -- never run")
 *   query/read error                        -> error      (renders "ERROR -- <query id>")
 *
 * "threshold" and "stuck" require a bootstrap strategy (card CONSTRAINTS, yellow item,
 * NOT a S5 gate): p95 needs N terminal runs the run-log may not have yet for a given job.
 * Ships as bootstrap=iii (the card's own mandated interim): fewer than N terminal records
 * for a job -> no STUCK verdict is possible, state renders
 * "N/A -- insufficient history (<k>/<N> runs)" -- explicitly NOT 'running' as a silent
 * fallback, since that would reproduce the exact defect this card exists to remove.
 *
 * C6: this module is also the shared source generate-status.js's computeAgentHealthEval()
 * reads job-history from (see fetchRunLogTerminalByJob(), which fetchAgentRunLog() now
 * wraps) -- one query, two consumers (tile color + run-state cell), not two.
 *
 * Dual-environment (CommonJS for generate-status.js, global for warroom-v5.html), same
 * pattern as lib/warroom-clock.js and lib/warroom-health.js.
 */
(function (root) {
  'use strict';

  // Bootstrap N -- card's own instruction: "the value of N" is an open, non-blocking
  // [QUESTION], not a S5 gate. 5 terminal runs chosen as a round, defensible floor for a
  // meaningful p95 (below 5 samples, p95 collapses to max(observed), which is just
  // max(observed) with extra steps) -- flagged in DONE_LOG.md as builder-default, not
  // Shiv-ruled.
  var BOOTSTRAP_N = 5;

  function _daysAge(ms) {
    var d = ms / 86400000;
    if (d < 1) return Math.round(ms / 3600000) + 'h';
    return Math.round(d) + 'd';
  }

  /**
   * computeP95(terminalDurationsMs) -> number|null
   * terminalDurationsMs: array of (finished_at - started_at) in ms, from terminal
   * records only, most-recent-first or unordered (sorted internally).
   * Returns null if array is empty (caller must treat as bootstrap-insufficient).
   */
  function computeP95(terminalDurationsMs) {
    if (!terminalDurationsMs || terminalDurationsMs.length === 0) return null;
    var sorted = terminalDurationsMs.slice().sort(function (a, b) { return a - b; });
    var idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  }

  /**
   * run_state(input) -> {state, run_id, started_at, finished_at, percent, threshold, p95,
   *                       bootstrap_mode, source_age, reason}
   *
   * input:
   *   job                string            -- run-log job id, for error/id reporting only
   *   latestRow          object|null|undefined
   *                       -- most recent run_log row for this job: {run_id, started_at,
   *                          finished_at, exit_code, rows_written}, or null/undefined if no
   *                          record at all. finished_at is null/undefined while in flight.
   *   terminalDurationsMs array|null       -- durations (ms) of the job's terminal runs,
   *                       for p95. null/[] triggers bootstrap mode.
   *   now                Date              -- injected, from WarroomClock.nowUtc() (C5),
   *                       never computed internally.
   *   percent            number|null       -- % complete, meaningful only for a non-terminal
   *                       (running) record; caller must not pass this for a terminal row.
   *   readError          boolean           -- true if the run-log query itself failed. When
   *                       true, all other fields are ignored and state is forced to 'error'.
   *   queryId            string            -- id surfaced in the ERROR render string.
   *   cadence_ms         number|null       -- C4 staleness gate. The job's declared cadence
   *                       (a cited cron schedule / job-registry entry), never a guessed
   *                       default -- omit/null when no cadence is known, which disables the
   *                       gate for that job instead of fabricating a threshold. When
   *                       present, a TERMINAL record (succeeded/failed) whose last write
   *                       (finished_at) is older than cadence_ms x 2 is overridden to
   *                       'stale' -- "the run-log's own freshness gates these cells" (C4):
   *                       an empty/dark run-log must not keep rendering a confident
   *                       succeeded/failed forever. Does not touch running/stuck/never_run/
   *                       error/na_insufficient_history -- those states are already honest
   *                       about their own freshness by construction.
   */
  function run_state(input) {
    input = input || {};
    var job = input.job;
    var now = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now);

    if (input.readError) {
      return {
        state: 'error', run_id: null, started_at: null, finished_at: null, percent: null,
        threshold: null, p95: null, bootstrap_mode: null, source_age: null,
        reason: 'ERROR -- ' + (input.queryId || job || 'run_state'),
      };
    }

    var row = input.latestRow;

    // C5 -- a started_at in the future is a clock-skew defect, not a valid run. Excluded
    // from p95 by the caller (never passed into terminalDurationsMs), and this specific
    // record renders ERROR, not a fabricated running/stuck/succeeded state.
    if (row && row.started_at) {
      var startedMs = Date.parse(row.started_at);
      if (!isNaN(startedMs) && startedMs > now) {
        return {
          state: 'error', run_id: row.run_id || null, started_at: row.started_at,
          finished_at: row.finished_at || null, percent: null, threshold: null, p95: null,
          bootstrap_mode: null, source_age: null, reason: 'ERROR -- clock skew',
        };
      }
    }

    if (!row) {
      return {
        state: 'never_run', run_id: null, started_at: null, finished_at: null,
        percent: null, threshold: null, p95: null, bootstrap_mode: null, source_age: null,
        reason: 'N/A -- never run',
      };
    }

    var isTerminal = !!row.finished_at;

    if (isTerminal) {
      var exitOk = row.exit_code === 0 || row.exit_code === '0';

      // C4 -- staleness gate on the run-log's OWN freshness for this job, independent of
      // the terminal record being a legitimate succeeded/failed answer for its own run.
      // Only evaluated when the caller supplied a real cadence_ms (cited source, never a
      // guessed default) -- no cadence means this gate cannot fire, same "na" discipline
      // WarroomHealth uses when cadence is undeclared.
      if (typeof input.cadence_ms === 'number' && input.cadence_ms > 0) {
        var lastWriteMs = Date.parse(row.finished_at);
        if (!isNaN(lastWriteMs)) {
          var writeAge = now - lastWriteMs;
          if (writeAge > input.cadence_ms * 2) {
            return {
              state: 'stale',
              run_id: row.run_id || null,
              started_at: row.started_at,
              finished_at: row.finished_at,
              percent: null,
              threshold: null,
              p95: computeP95(input.terminalDurationsMs),
              bootstrap_mode: null,
              source_age: writeAge,
              reason: 'STALE ' + _daysAge(writeAge),
            };
          }
        }
      }

      return {
        state: exitOk ? 'succeeded' : 'failed',
        run_id: row.run_id || null,
        started_at: row.started_at,
        finished_at: row.finished_at,
        percent: null, // C2/structural invariant: percent is only meaningful for a non-terminal record
        threshold: null,
        p95: computeP95(input.terminalDurationsMs),
        bootstrap_mode: null,
        source_age: null,
        reason: null,
      };
    }

    // Non-terminal (no finished_at) -- running or stuck, gated by bootstrap availability.
    var p95 = computeP95(input.terminalDurationsMs);
    var nTerminal = (input.terminalDurationsMs || []).length;
    var startedMsNonTerminal = Date.parse(row.started_at);
    var age = now - startedMsNonTerminal;

    if (nTerminal < BOOTSTRAP_N || p95 === null) {
      return {
        state: 'na_insufficient_history',
        run_id: row.run_id || null,
        started_at: row.started_at,
        finished_at: null,
        percent: (typeof input.percent === 'number') ? input.percent : null,
        threshold: null,
        p95: p95,
        bootstrap_mode: 'iii_interim',
        source_age: age,
        reason: 'N/A -- insufficient history (' + nTerminal + '/' + BOOTSTRAP_N + ' runs)',
      };
    }

    var threshold = 2 * p95;
    var stuck = age > threshold;

    return {
      state: stuck ? 'stuck' : 'running',
      run_id: row.run_id || null,
      started_at: row.started_at,
      finished_at: null,
      percent: (typeof input.percent === 'number') ? input.percent : null,
      threshold: threshold,
      p95: p95,
      bootstrap_mode: null,
      source_age: age,
      reason: stuck ? ('STUCK ' + _daysAge(age)) : null,
    };
  }

  var api = { run_state: run_state, computeP95: computeP95, BOOTSTRAP_N: BOOTSTRAP_N };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WarroomRunstate = api;
  }
})(typeof window !== 'undefined' ? window : this);
