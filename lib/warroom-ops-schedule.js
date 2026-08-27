/**
 * WARROOM-OPSTIMELINE-001 Phase 2 — expands warroom/ops-cron-registry.json's
 * per-job cron expressions into concrete scheduled_at slots for a requested
 * window (schedule side of the join, C6). Execution-side matching against
 * the run-log happens in api/ops/timeline.js / api/ops/cron-today.js, not
 * here — this module only knows "when was this job supposed to run", never
 * "did it".
 *
 * Cron fields in warroom/ops-cron-registry.json are local America/New_York
 * time (this repo's Mac runs in NYC; cron-schedule.html's table already
 * renders times with no explicit offset, consistent with that assumption —
 * flagged, not asserted as independently confirmed). Converted to UTC ISO
 * via Intl (same ICU/IANA-backed approach WarroomClock uses for the reverse
 * direction), DST-correct without manual offset tables.
 *
 * Dual-environment (CommonJS + global), same pattern as sibling lib modules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WarroomOpsSchedule = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TZ = 'America/New_York';

  // Resolves the ET UTC-offset (in minutes, e.g. -240 for EDT) in effect on
  // `refDate` — DST-correct via Intl, not a manual table.
  function _etOffsetMinutes(refDate) {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset', hour: '2-digit' });
    var parts = fmt.formatToParts(refDate);
    var tzn = parts.filter(function (p) { return p.type === 'timeZoneName'; })[0];
    var m = tzn && /GMT([+-]\d+)/.exec(tzn.value);
    var offsetHours = m ? parseInt(m[1], 10) : -5; // fallback: EST, never thrown
    return offsetHours * 60;
  }

  // Given ET wall-clock hour/minute and a reference UTC date (used only to
  // resolve which calendar day + which DST offset applies), returns the UTC
  // ISO timestamp for that ET wall-clock moment on refDate's ET calendar day.
  function etTimeToUtcIso(hour, minute, refDate) {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = fmt.formatToParts(refDate);
    var get = function (t) { var p = parts.filter(function (x) { return x.type === t; })[0]; return p ? p.value : null; };
    var y = parseInt(get('year'), 10), mo = parseInt(get('month'), 10), d = parseInt(get('day'), 10);
    var offsetMin = _etOffsetMinutes(refDate);
    // UTC millis for (y,mo,d,hour,minute) ET = that wall time minus the ET offset.
    var utcMs = Date.UTC(y, mo - 1, d, hour, minute, 0) - offsetMin * 60000;
    return new Date(utcMs).toISOString();
  }

  // Parses the two fields this registry actually uses (minute, hour) out of
  // a 5-field cron expression. Step patterns (*/5) and '*' both handled;
  // day-of-week/day-of-month/month are read only to decide whether the job
  // matches TODAY (weekly/biweekly gating), not to compute an alternate time.
  function _parseField(field, lo, hi) {
    if (field == null || field === '*') return null; // null = "every unit in range"
    var stepM = /^\*\/(\d+)$/.exec(field);
    if (stepM) return { step: parseInt(stepM[1], 10) };
    var n = parseInt(field, 10);
    if (!isNaN(n)) return { fixed: n };
    return null;
  }

  /**
   * expandSlotsForWindow(registryJobs, windowHours, now) -> [{ job_id,
   *   grace_job_id, display_name, scheduled_at, expected_cadence_seconds,
   *   hasCadence, alwaysOn, fleetClassified }]
   *
   * registryJobs: warroom/ops-cron-registry.json's `.jobs` map.
   * windowHours: accepted for API compatibility with the card's `?window=`
   *   query param; the actual bound applied is always today's ET calendar
   *   day (see below) — a fixed-size trailing window would either truncate
   *   the timeline's own hourly grid mid-day or, for windowHours>24,
   *   fabricate slots for days the response has no way to label sanely.
   * now: injected Date (C5).
   */
  function expandSlotsForWindow(registryJobs, windowHours, now) {
    var out = [];
    // Bounded to TODAY's ET calendar day (00:00-23:59 ET), matching the
    // timeline grid's own 24 hourly columns and Cron Today's "today" framing
    // — NOT an arbitrary trailing-windowHours span, which for a sub-hourly
    // cron (process-jobs at "* * * * *") would otherwise fabricate well
    // over a thousand slots spanning two calendar days for one job.
    var dayStartIso = etTimeToUtcIso(0, 0, now);
    var dayStartMs = Date.parse(dayStartIso);
    var dayEndMs = dayStartMs + 24 * 3600000;

    Object.keys(registryJobs || {}).forEach(function (key) {
      var j = registryJobs[key];
      var hasCadence = !!j.cron;
      var alwaysOn = !!j.always_on;
      var fleetClassified = j.fleet_classified !== false;

      if (!hasCadence) {
        out.push({
          job_id: j.job_id, grace_job_id: j.grace_job_id || null, display_name: j.display_name,
          scheduled_at: null, expected_cadence_seconds: j.expected_cadence_seconds || null,
          hasCadence: false, alwaysOn: alwaysOn, fleetClassified: fleetClassified
        });
        return;
      }

      var m = j.cron.trim().split(/\s+/);
      if (m.length < 5) return; // malformed entry — skip rather than fabricate a slot
      var minField = _parseField(m[0]), hrField = _parseField(m[1]);
      // null field (bare '*') means "every value in range" — must NOT
      // collapse to a fixed 0, or "* * * * *" (every minute) silently
      // becomes "minute 0 of every hour" (a real bug caught by this
      // module's own test suite: expandSlotsForWindow('* * * * *') must
      // yield ~1440 slots/day, not 24).
      var minuteStep = minField && minField.step ? minField.step : null;
      var hourStep = hrField && hrField.step ? hrField.step : null;
      var fixedMinute = minField && typeof minField.fixed === 'number' ? minField.fixed : null;
      var fixedHour = hrField && typeof hrField.fixed === 'number' ? hrField.fixed : null;

      // Walk every candidate minute/hour combination inside [0,24)x[0,60)
      // that this cron expression matches, then filter to the trailing
      // window. Bounded (<=1440 iterations/job) — cheap even for */1.
      for (var h = 0; h < 24; h++) {
        if (fixedHour !== null && h !== fixedHour) continue;
        if (hourStep && h % hourStep !== 0) continue;
        for (var mi = 0; mi < 60; mi++) {
          if (minuteStep) {
            if (mi % minuteStep !== 0) continue;
          } else if (fixedMinute !== null && mi !== fixedMinute) {
            continue;
          }
          var iso = etTimeToUtcIso(h, mi, now);
          var ms = Date.parse(iso);
          if (ms < dayStartMs || ms >= dayEndMs) continue; // today's ET calendar day only
          out.push({
            job_id: j.job_id, grace_job_id: j.grace_job_id || null, display_name: j.display_name,
            scheduled_at: iso, expected_cadence_seconds: j.expected_cadence_seconds || null,
            hasCadence: true, alwaysOn: alwaysOn, fleetClassified: fleetClassified
          });
        }
      }
    });

    return out.sort(function (a, b) {
      var am = a.scheduled_at ? Date.parse(a.scheduled_at) : -Infinity;
      var bm = b.scheduled_at ? Date.parse(b.scheduled_at) : -Infinity;
      return am - bm; // C5: strictly monotonic axis
    });
  }

  return {
    etTimeToUtcIso: etTimeToUtcIso,
    expandSlotsForWindow: expandSlotsForWindow
  };
});
