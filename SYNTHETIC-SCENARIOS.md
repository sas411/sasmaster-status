# SYNTHETIC-SCENARIOS.md — WARROOM-SYNTHETIC-001

The synthetic degradation suite for WARROOM-OPS-V5's Phase 1 exit gate. It
breaks things on purpose against a staging fixture (never production) and
asserts the board's Phase-1 evaluators notice — both in rendered state and,
where a real alert-plane rule exists for that condition today, in the alert
plane.

**Machine-readable table:** `warroom/synthetic-scenarios.json` (name,
injection, expected tile state, expected alert, teardown — one row per
scenario; an eighth scenario is a new row plus one new handler function).

**Test files:**
- `test/warroom-synthetic-suite.test.mjs` — all 7 scenarios (S1–S7, plus
  S3b as a sub-assertion of S3).
- `test/warroom-synthetic-negative-controls.test.mjs` — PHASE 5b (hardcoded
  health) and PHASE 5c (S7 substitute) negative controls.

**Gold-example transcripts:** `warroom/synthetic-gold/S1.md` … `S7.md` — one
per scenario, each with **C7 sign-off: PENDING — requires Shiv observing.**
No scenario is enabled for unattended/scheduled operation until Shiv signs
off on all seven.

## Real result summary (2026-08-27, this session)

| Scenario | Render half | Alert half | Notes |
|---|---|---|---|
| S1 — killed cron, 3-stage | ✅ real, pass | ⚠️ documents real gap (GATE-A blocks per-job alerting in production R1 today) | evaluateHealth() drives both this suite and production |
| S2 — non-zero exit (Tech Intel) | ✅ real, pass | ✅ real, pass (R4, provenance=run_id) | both halves fully wired and tested |
| S3 — stalled run / STUCK | ✅ real, pass | ✅ real, pass (stuck rule, provenance=run_id) | both halves fully wired and tested |
| S3b — cross-source agreement | ✅ real, pass | n/a (structural check) | asserted at the state-endpoint / computed-value level per the card's Phase-2 deferral |
| S4 — stale feed propagation | ✅ real, pass | ✅ real, pass (R2, provenance=staging path) | denominator (WARROOM_TILE_INVENTORY.md) does not exist — flipped-dependent count is N/A, not fabricated |
| S5 — unrenderable payload (5x) | ✅ real, pass | ⚠️ documents real gap (counter exists, not yet read by any alert rule) | |
| S6 — clock skew | ✅ real, pass | ⚠️ documents real gap (no named clock-skew rule in §2.2's implemented set) | |
| S7 — single source per number | 🔴 BLOCKED | 🔴 BLOCKED | WARROOM-COSTCANON-001's canonical view is not present in committed code at HEAD — no live runtime path exists to test |

Negative controls: **2/2 demonstrated** —
1. Hardcoding `evaluateHealth()`/`run_state()` to a fixed state makes S1/S2's
   and S3's real assertions throw (proven against temp mutant copies; the
   committed files are verified byte-identical afterward via SHA-256).
2. A second, disagreeing source fed into the shared `computeSlotState()`
   evaluator makes the S3b-shaped agreement assertion throw (S7's own
   negative control is blocked for the same reason S7 itself is — see
   `warroom/synthetic-gold/S7.md`).

## Production-write guard (mechanical proof)

`sasmaster.ops.run_log` / `sasmaster.ops.alerts` row counts were queried
immediately before and after a full suite run (this session, read-only
MotherDuck access): **8677 / 13 rows, unchanged** in both cases. The suite
never opens a MotherDuck connection at all — every scenario drives pure
functions with synthetic in-memory/temp-file data (`lib/warroom-synthetic-fixture.js`'s
`assertStagingRoot()` refuses any `md:` target or any path inside the live
repo/`~/SaSMaster` before permitting a write).

## Cadence and routing — explicitly UNRULED

- **§5c (cadence):** UNRULED — awaiting Shiv. `warroom/synthetic-scheduler.stub.json`
  is present and `"enabled": false`. No cron/launchd registration exists.
- **§5d (delivery routing):** UNRULED — awaiting Shiv. No Slack delivery is
  implemented or assumed by this suite; results write to the run-log/on-board
  surface only (per the card's own constraint, this suite does not even call
  `persist()`/`deliverAlerts()` — see the disclosed architecture note at the
  top of `test/warroom-synthetic-suite.test.mjs`).
