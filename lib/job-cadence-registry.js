/**
 * WARROOM-RUNSTATE-001 -- one cadence registry for run_state()'s C4 staleness gate AND
 * the STUCK-watchdog alert rule (~/SaSMaster/scripts/alert-engine.js). Same discipline
 * alert-engine.js's own CADENCE_REGISTRY already uses (R2): every entry MUST cite where
 * the cadence came from -- a real cron line or a real config table -- never a guessed
 * default. cadence_ms: null (an entry simply absent) means "unknown", which callers must
 * treat as "gate disabled for this job", not "assume some default".
 *
 * Keyed by run-log `job` id (docs/JOB_ID_NAMING.md / docs/RUN_LOG_COVERAGE.md), NOT by
 * agent display name -- generate-status.js's AGENT_HEALTH_CONFIG is keyed by agent name
 * for a different consumer (§2.1 health) and is not reused here to avoid coupling two
 * independently-evolving tables; values are kept consistent by citation, not by import,
 * since AGENT_HEALTH_CONFIG doesn't carry job-id-keyed cadences at all for several rows
 * (e.g. 'load-tmdb-to-s3' has no AGENT_HEALTH_CONFIG entry -- it's not an "agent").
 *
 * Dual-environment (CommonJS for generate-status.js / alert-engine.js, global for
 * warroom-v5.html), same pattern as lib/warroom-clock.js (C6 -- one house style).
 */
(function (root) {
  'use strict';

  var JOB_CADENCE_MS = {
    'load-tmdb-to-s3':        { cadence_ms: 24 * 3600000,      source: "cron '0 2 * * *' -- SaSMaster/docs/RUN_LOG_COVERAGE.md row 12" },
    'media-intel-agent':      { cadence_ms: 24 * 3600000,      source: 'generate-status.js AGENT_HEALTH_CONFIG["Media Intel"].cadence_ms' },
    'tmdb-daily-agent':       { cadence_ms: 24 * 3600000,      source: 'generate-status.js AGENT_HEALTH_CONFIG["TMDB Daily"].cadence_ms' },
    'donelog-analyst':        { cadence_ms: 24 * 3600000,      source: 'generate-status.js AGENT_HEALTH_CONFIG["DoneLog Analyst"].cadence_ms' },
    'linkedin-agent':         { cadence_ms: 7 * 24 * 3600000,  source: 'generate-status.js AGENT_HEALTH_CONFIG["LinkedIn Agent"].cadence_ms' },
    'edgar-scraper':          { cadence_ms: 24 * 3600000,      source: 'generate-status.js AGENT_HEALTH_CONFIG["SEC EDGAR"].cadence_ms' },
    'tech-intel-agent':       { cadence_ms: 7 * 24 * 3600000,  source: 'generate-status.js AGENT_HEALTH_CONFIG["Tech Intel"].cadence_ms' },
    'financial-analyst':      { cadence_ms: 7 * 24 * 3600000,  source: 'generate-status.js AGENT_HEALTH_CONFIG["Financial Analyst"].cadence_ms' },
    'weekly-review-agent':    { cadence_ms: 7 * 24 * 3600000,  source: 'generate-status.js AGENT_HEALTH_CONFIG["Weekly Review"].cadence_ms' },
    'iab-agent':              { cadence_ms: 7 * 24 * 3600000,  source: 'generate-status.js AGENT_HEALTH_CONFIG["IAB Intel"].cadence_ms' },
    'security-watchdog':      { cadence_ms: 24 * 3600000,      source: 'generate-status.js AGENT_HEALTH_CONFIG["Security Watchdog"].cadence_ms' },
    'railway-monitor':        { cadence_ms: 15 * 60000,        source: 'generate-status.js AGENT_HEALTH_CONFIG["Railway Monitor"].cadence_ms' },
    // WARROOM-PIPELINE-RESTORE-001 (2026-08-27): TASKS.MD command-API ingest, restored as a
    // scheduled job (~/SaSMaster/scripts/tasks-md-ingest.js) — see docs/JOB_ID_NAMING.md §2b
    // in SaSMaster for the full root-cause writeup.
    'tasks-md-ingest':        { cadence_ms: 5 * 60000,         source: "cron '*/5 * * * *' -- SaSMaster/docs/JOB_ID_NAMING.md row 97" },
    // NOTE: a 'runlog-selftest-stuck-runstate001' fixture entry lived here during the
    // WARROOM-RUNSTATE-001 remediation self-check (2026-08-25/26) to prove the watchdog
    // against live MotherDuck data. Removed deliberately: leaving a test job permanently in
    // the production cadence registry means alert-engine.js re-evaluates it forever and its
    // 'stuck' alert (rule_id='stuck', subject='runlog-selftest-stuck-runstate001') never
    // resolves, since its seeded run_log row has no terminal record by design. Removing the
    // entry is self-cleaning and does NOT touch data (never-delete-data rule): the next
    // `node scripts/alert-engine.js run` simply stops emitting it, and persist()'s own
    // resolve sweep (any open alert whose id isn't in this run's seenIds) marks the row
    // state='resolved' -- verified below, not asserted. The seeded run_log rows themselves
    // are left in place, namespaced and harmless (see the gap-2 commit message).
  };

  function get(job) {
    var e = JOB_CADENCE_MS[job];
    return e ? e.cadence_ms : null;
  }

  var api = { JOB_CADENCE_MS: JOB_CADENCE_MS, get: get };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.WarroomJobCadence = api;
  }
})(typeof window !== 'undefined' ? window : this);
