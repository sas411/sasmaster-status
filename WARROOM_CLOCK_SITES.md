# WARROOM_CLOCK_SITES.md — WARROOM-CLOCK-001 ground truth

Phase 1 deliverable. This is the sanctioned source for paths cited by later
WARROOM-OPS-V5 cards (WARROOM-RENDER-001, WARROOM-HEALTH-001,
WARROOM-ALERT-001, all Phase 2 freshness work) — do not re-derive these paths,
read them from here.

## Repo / render surface (confirmed by inspection, 2026-08-24)

- **Repo root:** `~/sasmaster-status` (confirmed — `git remote -v` →
  `https://github.com/sas411/sasmaster-status.git`).
- **Page:** `warroom-v5.html` (3,918 lines pre-card; browser-rendered, all
  JS is inline `<script>` blocks — no bundler, no external JS modules).
- **Generator:** `generate-status.js` (CommonJS, Node, `require`/`module.exports`).
- **Module system:** none (no `"type": "module"` in `package.json`; `.js` is
  CommonJS by default, `.mjs` test files force ESM regardless).
- **Package manager:** npm (`package.json` present, no lockfile-specific
  alternate manager detected).
- **Test runner:** Node's built-in `node:test` (no jest/vitest/mocha in
  `package.json` deps; existing `test/ask-guard.test.mjs` already uses this
  pattern — this card's `test/warroom-clock.test.mjs` follows it).
- **Pre-commit mechanism:** `.pre-commit-config.yaml` exists (framework:
  pre-commit) but **is NOT installed** as live git hooks in this repo —
  confirmed via `ls .git/hooks/` (SWEEPING audit, 2026-08-24): zero non-sample
  hook files. `git status`/commits currently pass through with no mechanical
  gate at all.
- **CI provider:** GitHub Actions exists (`.github/workflows/claude-review.yml`,
  `org-health.yml`) but **neither runs `npm test` or any gate script on
  push** — `claude-review.yml` is an independent LLM code review
  (report-only), `org-health.yml` regenerates an unrelated JSON on a nightly
  cron. **Confirmed: no CI provider currently enforces this or any other
  render gate.** Per the card's own instruction, the gate therefore ships as
  a pre-commit hook definition only — reported here, not silently dropped
  and not silently wired into CI that doesn't check it.

## Deliverables this card shipped

- `lib/warroom-clock.js` — the one time module (C5). Dual-environment:
  `module.exports` for `generate-status.js` (CommonJS `require`), global
  `window.WarroomClock` for `warroom-v5.html` (loaded via
  `<script src="lib/warroom-clock.js">` before the page's inline scripts —
  static file, served via `vercel.json`'s `"handle": "filesystem"` rule).
  Uses `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` for all
  ET conversion — DST handled by the ICU/IANA tz database, no manual offset
  math.
- `test/warroom-clock.test.mjs` — the frozen-clock unit suite (C7 gold
  example), all 9 lettered VERIFY fixtures from the card, `node --test`
  green (builder sanity run — see BUILDER report for the "not the official
  VERIFY" caveat).
- `scripts/check-clock-gate.sh` — the value-render gate runner. Bans
  `.toLocaleTimeString()`/`.toLocaleDateString()` and raw
  `.getHours()/.getMinutes()/.getSeconds()` outside `lib/warroom-clock.js`.
  Deliberately does **not** ban plain `.toLocaleString()` — that method
  exists on both `Date` and `Number`, this codebase uses it extensively for
  legitimate number formatting (thousands separators), and a grep-based gate
  can't disambiguate the receiver type. WARROOM-RENDER-001 extends this same
  script with the em-dash rule — do not create a second gate script.
- `.pre-commit-config.yaml` — added the `warroom-clock-gate` local hook
  definition (stages: `[pre-commit]`). **Not installed** (`pre-commit
  install` not run) — this repo currently has zero live hooks and flipping
  that is an operational decision left to Shiv, same staging pattern
  `OPS-PREPUSH-GATE-004` used above it in this same file.
- `package.json` — added `"test"` (`node --test test/`) and `"verify"`
  (`npm test && bash scripts/check-clock-gate.sh`) scripts.

## Root cause of the reported skew (Phase 3)

**Neither the header clock nor the cache-updated bar was ever actually pinned
to `America/New_York`.** Both used raw `new Date()` browser-local time
(`getHours()/getMinutes()/getSeconds()` for the header; `toLocaleTimeString()`
with no `timeZone` option for the cache bar) and labeled the result "ET"
regardless of what timezone the rendering browser/runtime was actually in.
This is the mislabeled-instant branch the card named as the leading
hypothesis, not a genuinely-future write — `cache_hit_updated` itself was a
real past timestamp; the bug was purely in how it was displayed. Fixed by
routing both through `WarroomClock.toEt()`, which explicitly converts via
`Intl.DateTimeFormat({timeZone:'America/New_York'})` and shows the offset.
A **genuinely** future timestamp (real clock skew, not a labeling bug) now
correctly renders `ERROR — clock skew` per C5 — both branches are covered by
VERIFY(a) and VERIFY(i) in the test suite.

## Timestamp render sites / feed sorts / window computations (file:line)

Sites the card's Phase 4 named and this pass wired:

| Site | File:line (post-fix) | Fix |
|---|---|---|
| Header clock | `warroom-v5.html` ~1729 (`setInterval` clock tick) | `WarroomClock.toEt(d)` + `weekdayLabel(d)`, was raw local `getHours/getMinutes/getSeconds` |
| Cache/memory bar | `warroom-v5.html` ~1817 (`renderMemoryBar`) | `WarroomClock.toEt(us.cache_hit_updated)`, was `toLocaleTimeString` with no `timeZone` |
| TELEMETRY event feed | `warroom-v5.html` ~2390 (`renderTelemetry`) | `WarroomClock.sortFeedDesc(rawItems,'ts')` before slicing to 12 — was concatenated + sliced with **no sort at all** (the "seven rows sorted by nothing" finding); missing-timestamp rows now render inline `ERROR` instead of silently sorting to an arbitrary position |
| FINANCE Token Intelligence period | `warroom-v5.html` ~1035 (static span, id added: `fin-token-period`) + `renderFinance()` | Was **hardcoded literal `2026-06`, never touched by any JS** — wired to live `fd.period` from `finance-data.json` (currently `2026-08`), falls back to `WarroomClock.monthBuckets(1)[0]` only if the field is ever absent |
| FINANCE 6-month forecast | `warroom-v5.html` ~1072 (`.cash` bars) + `renderFinance()` | Was **hardcoded static bars for months 06-11, never touched by any JS**. `fd.forecast` (real array in `finance-data.json`, currently 6 fixed months Jun–Nov) is now filtered to `month >= currentEtMonth`, sorted ascending, rendered live |
| CANVAS TODAY filter | `warroom-v5.html` ~3005 (`fetchTodayPiece`) | Added `WarroomClock.isSameEtCalendarDay(e.built_at, now)` filter before picking newest pending/certified — was picking newest-by-status with **no date filter at all** (the `BUILT Jun 15` bug) |
| `data-health-run` label | `warroom-v5.html` ~2140 | `WarroomClock.dateLabel()`, was `toLocaleDateString` with no `timeZone` |
| `generate-status.js` recency formatter (`tsShort`) | `generate-status.js` ~1145 | Delegated to `WarroomClock.recentTimeOrDate()` — was already correctly pinned to `America/New_York` (no user-facing bug here) but duplicated the shared rule; now one implementation (C6) |
| `generate-status.js` 9AM digest gate | `generate-status.js` ~1699 | `WarroomClock.etHourMinute()`, was raw host-local `getHours()/getMinutes()` — real risk if this script ever runs on a non-ET host (currently runs on Shiv's Mac, so likely coincidentally correct today, but not guaranteed by the code) |

## Known gap — NOT fixed in this card, reported per C1 (no fabrication)

**COST LEDGER "31d window"** (`warroom-v5.html` ~968, `<table class="dt">`
under the COSTS tab): this table is **entirely static hardcoded HTML** — two
literal `<tr>` rows (`2026-06-01`, `2026-06-12`) with no backing live data
feed and no JS touching it at all. This matches the audit finding (June-only
entries under a "31d window" label on an August board) but the underlying
defect is that **there is no live cost-ledger data source to filter** — not
a broken window computation this card can wire. `WarroomClock.rollingWindow()`
and `WarroomClock.inRollingWindow()` are built and tested (VERIFY(f)) and
ready for whichever card wires a real cost-ledger feed (WARROOM-COSTCANON-001,
§2.3, is the canonical-cost-view card and the most likely owner). Fabricating
a live-looking filtered window over two static rows would itself be a C1
violation — flagged here instead, not silently built around.

## Not touched — out of this card's Phase 4 scope

`warroom-v5.html:2546,3176,3415,3478,3713` and various `.toLocaleString()`
call sites in the archive/catalog/skills-routing panels use
`Date.prototype.toLocaleString()` with date-shaped options (not banned by
the gate — see `scripts/check-clock-gate.sh` comment on why plain
`toLocaleString()` isn't banned). These are pre-existing, not named in the
card's Phase 4 list of seven sites, and not migrated in this pass to avoid
scope creep into WARROOM-RENDER-001's territory (tile value-states) and
other tabs' data-wiring. Flagged for MAINTAINER/GROWER follow-up, not
silently left undocumented.

## DST coverage

`toEt()`/`monthBuckets()`/`rollingWindow()` all resolve via
`Intl.DateTimeFormat({timeZone:'America/New_York'})`, which uses the host's
ICU/IANA tz database — EST (`UTC−05:00`) in January, EDT (`UTC−04:00`) in
August, verified directly in `test/warroom-clock.test.mjs` VERIFY(e) against
both an EST date (2026-01-15) and an EDT date (2026-08-23). No hardcoded
offset anywhere in `lib/warroom-clock.js`.
