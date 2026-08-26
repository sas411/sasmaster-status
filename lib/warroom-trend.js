// WARROOM-TREND-001 — single trend evaluator: sign(glyph) must equal sign(current - prior),
// always, mechanically enforced. Root cause of the two named historical failures
// (AWS $5.00->$111.87 rendered "->", Anthropic $0.00->$11.27 rendered "v"): NEITHER arrow
// was ever computed by any code. warroom-v5.html's FINANCE cost-breakdown table
// (~line 1060) is static HTML; renderFinance() (warroom-v5.html:2866) writes the CURRENT
// column via setTd(rows[n],1,...) but never touches column 2 (prior) or column 3 (the
// arrow glyph/class) -- those three cells are exactly whatever was baked into the page
// template and never change regardless of what the live current value becomes. This is
// not an inverted-sign bug; it is total absence of a trend computation. This card supplies
// the one that was always missing.
//
// Dual-environment like lib/warroom-clock.js / lib/warroom-render.js: CommonJS export for
// generate-status.js, global window.WarroomTrend for warroom-v5.html.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WarroomTrend = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATE = { UP: 'up', DOWN: 'down', FLAT: 'flat', ANOMALY: 'anomaly', NA_NO_PRIOR: 'na_no_prior', ERROR: 'error' };
  var GLYPH = { UP: '↑', DOWN: '↓', FLAT: '→' };

  // Dead-band (SS 24-b, config value, not a floating-point accident): a delta smaller than
  // this many dollars never renders as a trend, it renders flat. $0.01 is chosen because it
  // is the smallest unit currency actually carries in this system (cents) -- anything below
  // a cent is float noise from the upstream sum, not a real signal. FLAGGED FOR SHIV: this
  // value has never been reviewed by a human; it is this card's own default, not a spec
  // number. [QUESTION] should the dead-band instead be a *relative* band (e.g. 1% of prior)
  // rather than an absolute $0.01 -- an absolute cent is invisible on a $10,000 AWS bill but
  // would swallow small real movement on a near-zero category. Recorded in DONE_LOG.md.
  var DEAD_BAND_USD = 0.01;

  // Zero-prior anomaly rule (SS 24-c, config value, explicit, not silent): ratio is
  // mathematically undefined when prior=0, so the >3x anomaly rule (R6) cannot evaluate
  // there by ratio. Without an explicit rule, the Anthropic case ($0.00 -> $11.27) would
  // silently NOT be flagged anomaly even though it is exactly the kind of move R6 exists to
  // catch (a brand-new cost category appearing at meaningful size). Rule chosen: prior=0 AND
  // current > this threshold => anomaly. Threshold picked at $10 (an arbitrary but
  // documented value -- real spend, not noise, at this system's actual cost scale, where
  // "Tools" and "Railway" categories sit at $20/mo flat). FLAGGED FOR SHIV: this $10 number
  // is this card's own default, never reviewed. [QUESTION] recorded in DONE_LOG.md.
  var ZERO_PRIOR_ANOMALY_THRESHOLD_USD = 10;

  var ANOMALY_RATIO = 3;

  function sign(n) { return n > 0 ? 1 : (n < 0 ? -1 : 0); }

  // trend(current, prior) -> {glyph, state, ratio}
  // prior may be: a number (including 0), null/undefined (genuinely absent -- no prior
  // period exists at all, distinct in TYPE from a real zero, per C2/C1).
  function trend(current, prior) {
    if (current === null || current === undefined || typeof current !== 'number' || isNaN(current)) {
      throw new Error('WarroomTrend.trend requires a numeric current value');
    }
    if (prior === null || prior === undefined) {
      return { glyph: null, state: STATE.NA_NO_PRIOR, ratio: null };
    }
    if (typeof prior !== 'number' || isNaN(prior)) {
      throw new Error('WarroomTrend.trend requires prior to be a number, null, or undefined');
    }

    var delta = current - prior;
    var ratio = prior > 0 ? (current / prior) : null;

    // Dead-band applies universally, BEFORE the zero-prior special case -- a delta smaller
    // than the configured band is never a trend regardless of whether prior happens to be
    // zero. (Bug caught by this card's own property test: (-0.005, 0) must render flat, not
    // down -- the zero-prior branch must not bypass the dead-band.)
    if (Math.abs(delta) < DEAD_BAND_USD) {
      return { glyph: GLYPH.FLAT, state: STATE.FLAT, ratio: ratio };
    }

    // prior=0, current clears the dead-band: always 'up' or 'down' (or 'anomaly' if the
    // zero-prior rule matches on the up side), NEVER 'na' -- a real recorded zero is a real
    // prior, not a missing one.
    if (prior === 0) {
      if (current > 0) {
        var zeroPriorAnomaly = current > ZERO_PRIOR_ANOMALY_THRESHOLD_USD;
        return { glyph: GLYPH.UP, state: zeroPriorAnomaly ? STATE.ANOMALY : STATE.UP, ratio: null };
      }
      // current < 0 with prior 0 -- real but exotic (a refund/credit exceeding the period).
      return { glyph: GLYPH.DOWN, state: STATE.DOWN, ratio: null };
    }

    var anomaly = ratio !== null && ratio > ANOMALY_RATIO;
    var glyph = sign(delta) > 0 ? GLYPH.UP : GLYPH.DOWN;
    var state = anomaly ? STATE.ANOMALY : (sign(delta) > 0 ? STATE.UP : STATE.DOWN);
    return { glyph: glyph, state: state, ratio: ratio };
  }

  return {
    trend: trend,
    STATE: STATE,
    GLYPH: GLYPH,
    DEAD_BAND_USD: DEAD_BAND_USD,
    ZERO_PRIOR_ANOMALY_THRESHOLD_USD: ZERO_PRIOR_ANOMALY_THRESHOLD_USD,
    ANOMALY_RATIO: ANOMALY_RATIO
  };
});
