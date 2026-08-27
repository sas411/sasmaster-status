/**
 * WARROOM-DAILY-001 — the per-tab `as_of(tab_id)` read-plane contract.
 *
 * Authority note (build-discipline §22): as_of is the run-log-derived
 * successor to `source_freshness` / `buildSourceFreshness()` in
 * generate-status.js for the tabs this card's registry (warroom/refresh-
 * jobs.json) actually covers with a wired job. It does NOT yet supersede
 * `source_freshness` everywhere — see the annotation this card adds at
 * generate-status.js's buildSourceFreshness() call site instead of a
 * blanket deletion, because most of this registry's rows are documented
 * gaps (no owner_script, or an owner_script not yet wired to run_log), and
 * a second authority silently going dark for those tiles would be worse
 * than two named authorities with one marked non-authoritative per tile
 * it doesn't yet cover.
 *
 * C4/C6: `computeFreshness` is READPLANE-001's per-TAB fresh/late/stale
 * classifier (cadence-registry.json `tabs.<TAB>` cadence/stale thresholds).
 * It is reused here, not reimplemented, for the freshness BAND. It is
 * explicitly NOT WARROOM-FRESHNESS-001's speced `evaluateFreshness()` —
 * that function (per-`source_id` cadence resolution + `dependent_tiles`
 * propagation + a formatted `STALE <age>` string) does not exist on disk
 * as of this pass (confirmed: no `evaluateFreshness` export anywhere in
 * this repo's lib/, no `warroom/cadence-registry.json` consumer of that
 * name). Anywhere this contract would need source-level propagation
 * through `dependent_tiles`, it renders reason:'freshness_evaluator_missing'
 * rather than approximating with the tab-level function and calling it
 * the same thing — a wrong equivalence here is exactly the kind of
 * fabricated-completeness bug C1 forbids.
 *
 * C2 — four render states, always one of:
 *   'na'    — never refreshed (no successful run_log row for this job at all)
 *   'error' — the last attempt failed, or the registry has no job entry
 *   'value' — a successful run exists; `freshness` (fresh/late/stale) and
 *             `age_display` are attached from the tab's cadence-registry
 *             thresholds via computeFreshness/WarroomClock.ageFrom
 *   (a future finished_at is always 'error' — clock skew, per C5, checked
 *    before anything else)
 *
 * This module is pure: it takes already-fetched run_log rows and registry
 * data as arguments and returns render objects. It does not open a
 * MotherDuck connection itself — per warroom-readplane.js's own header,
 * this repo's Vercel functions have no MotherDuck client wired in yet, so
 * the caller (a future api/state/<tab>.js route, or a CLI/cron script that
 * *does* have MotherDuck access) is responsible for supplying the rows.
 * This keeps the contract testable and honest about that real gap instead
 * of hiding it behind a lazily-thrown error deep in a fetch call.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./warroom-clock'), require('./warroom-readplane'));
  } else {
    root.WarroomAsOf = factory(root.WarroomClock, root.WarroomReadplane);
  }
})(typeof self !== 'undefined' ? self : this, function (WarroomClock, WarroomReadplane) {
  'use strict';

  /**
   * as_of(tab_id, opts)
   *
   * opts.registryJobs      — array of warroom/refresh-jobs.json `.jobs` rows
   *                           for this tab_id (caller filters/passes them).
   * opts.runLogRowsByJob    — { [refresh_job_id]: { finished_at_iso, exit_code } | null }
   *                           the caller's live query result:
   *                           SELECT max(finished_at) FROM sasmaster.ops.run_log
   *                           WHERE job = <refresh_job_id> AND exit_code = 0
   *                           (null/absent = no successful run row at all).
   * opts.cadenceForTab      — cadence-registry.json `tabs[tab_id]` object
   *                           ({ cadence_seconds, stale_at_seconds }) or null.
   * opts.now                — Date, defaults to WarroomClock.nowUtc().
   * opts.needsSourcePropagation — true if this tab's honest render requires
   *                           WARROOM-FRESHNESS-001's evaluateFreshness()
   *                           (per-source cadence + dependent_tiles), which
   *                           does not exist yet — forces the N/A branch
   *                           below regardless of run_log data.
   */
  function asOf(tabId, opts) {
    opts = opts || {};
    var jobs = opts.registryJobs || [];
    var runLogRowsByJob = opts.runLogRowsByJob || {};
    var cadence = opts.cadenceForTab || null;
    var now = opts.now || WarroomClock.nowUtc();

    if (opts.needsSourcePropagation) {
      return {
        tab_id: tabId,
        state: 'na',
        reason: 'freshness evaluator not yet built',
        detail: 'WARROOM-FRESHNESS-001 evaluateFreshness() (per-source_id cadence + dependent_tiles propagation) does not exist on disk. This tab’s honest freshness render requires it and is not approximated with the tab-level computeFreshness substitute.',
        as_of: null
      };
    }

    if (!jobs.length) {
      return {
        tab_id: tabId,
        state: 'na',
        reason: 'no registered refresh job',
        detail: 'warroom/refresh-jobs.json has no entry with a refresh_job_id for this tab (a gap row, or the tab is missing from the registry entirely).',
        as_of: null
      };
    }

    // Multiple jobs can feed one tab (see refresh-jobs.json). The tab's
    // as_of is the MOST RECENT successful run among ITS OWN registered
    // jobs only — never render time, never a file mtime, never another
    // tab's timestamp (C4/C6 — "one query, two renders" for the board-level
    // chip, never a second count here).
    var best = null; // { job_id, finished_at (Date) }
    var anyGapOnly = true;
    jobs.forEach(function (j) {
      var jobId = j.refresh_job_id;
      if (!jobId) return; // gap row, contributes nothing to as_of
      anyGapOnly = false;
      var row = runLogRowsByJob[jobId];
      if (!row || !row.finished_at_iso) return; // no successful run recorded
      var finishedAt = new Date(row.finished_at_iso);
      if (!best || finishedAt.getTime() > best.finished_at.getTime()) {
        best = { job_id: jobId, finished_at: finishedAt };
      }
    });

    if (anyGapOnly) {
      return {
        tab_id: tabId,
        state: 'na',
        reason: 'no registered refresh job',
        detail: 'Every registry row for this tab is a gap row (refresh_job_id: null) — see gap_reason in warroom/refresh-jobs.json.',
        as_of: null
      };
    }

    if (!best) {
      return {
        tab_id: tabId,
        state: 'na',
        reason: 'never refreshed',
        detail: 'One or more refresh jobs are registered for this tab, but sasmaster.ops.run_log has no row with exit_code = 0 for any of them.',
        as_of: null
      };
    }

    // C5 — a future finished_at is a clock-skew defect, never a value.
    if (best.finished_at.getTime() > now.getTime()) {
      return {
        tab_id: tabId,
        state: 'error',
        reason: 'ERROR — clock skew',
        detail: 'job=' + best.job_id + ' finished_at resolves to the future relative to the render clock.',
        as_of: best.finished_at.toISOString()
      };
    }

    var age = WarroomClock.ageFrom(best.finished_at, now);
    var freshnessBand = 'fresh';
    if (cadence) {
      freshnessBand = WarroomReadplane.computeFreshness(
        best.finished_at.toISOString(),
        cadence.cadence_seconds,
        now,
        cadence.stale_at_seconds
      );
    }

    return {
      tab_id: tabId,
      state: 'value',
      job_id: best.job_id,
      as_of: best.finished_at.toISOString(),
      age_display: age.state === 'ok' ? age.display : null,
      freshness: freshnessBand,
      freshness_source: cadence
        ? 'WarroomReadplane.computeFreshness (READPLANE-001, tab-level cadence-registry.json)'
        : 'unavailable — no cadence entry for this tab'
    };
  }

  /**
   * boardRefreshChip(tabIds, perTabAsOf)
   * "N of M tabs refreshed today" — one query (the same as_of() calls this
   * module already required), two renders, never a second count (C6/§🟢).
   * "Today" = the tab's as_of falls on the current ET calendar day.
   */
  function boardRefreshChip(perTabAsOf, now) {
    now = now || WarroomClock.nowUtc();
    var total = perTabAsOf.length;
    var refreshedToday = perTabAsOf.filter(function (r) {
      return r.state === 'value' && r.as_of && WarroomClock.isSameEtCalendarDay(r.as_of, now);
    }).length;
    return { refreshed: refreshedToday, total: total, display: refreshedToday + ' of ' + total + ' tabs refreshed today' };
  }

  return { asOf: asOf, boardRefreshChip: boardRefreshChip };
});
