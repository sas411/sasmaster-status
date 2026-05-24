# AGENT-PARALLEL-001 — Parallel Agent Architecture Design

**Task:** HARDEN-010  
**Date:** 2026-05-24  
**Status:** DESIGN v1.0

---

## Problem Statement

Current SaSMaster build loop is sequential: one Claude Code session, one agent context, one task at a time. For complex multi-component builds (e.g., Research Portal with scraper + API + UI + QA), this creates bottlenecks. The RESEARCH-PORTAL-001 milestone is the first natural candidate for parallelism.

---

## Execution Model Options

### Option A — Sequential (current)
```
orchestrator → task1 → task2 → task3 → done
```
- Cost: 1x
- Speed: 1x
- Failure: stops on first error

### Option B — Fan-out shell parallelism
```
orchestrator → spawn task1 &
             → spawn task2 &
             → spawn task3 &
             → wait all → collect results
```
- Cost: 3x (parallel Claude sessions)
- Speed: ~1x wall-clock (bounded by slowest task)
- Failure: independent; parent collects exit codes
- Implementation: `parallel-agent-run.sh`

### Option C — Claude Code Task tool (recommended for complex work)
```
orchestrator (main Claude session)
  └── Agent("research scraper") → returns result
  └── Agent("API endpoint")    → returns result  [parallel]
  └── Agent("UI component")    → returns result  [parallel]
  └── synthesize → QA agent
```
- Cost: 3-5x (sub-agent sessions billed separately)
- Speed: ~1.5-2x wall-clock (true parallel where tasks are independent)
- Failure: orchestrator catches sub-agent errors individually
- Implementation: Claude Code `Agent` tool in orchestrator prompt

### Option D — Async S3 job queue (current HARDEN-006 pattern)
```
JARVIS !task → POST /api/jobs → Mac cron → process → result
```
- Cost: 1x (serial on Mac)
- Speed: minutes (cron latency)
- Failure: isolated; queue persists
- Best for: background work that doesn't block the user

---

## Recommended Architecture for RESEARCH-PORTAL-001

Use **Option C** (Claude Code Task tool) for the build, **Option D** (async queue) for the recurring data pipeline.

```
research-portal orchestrator session
  ├── [parallel] Agent(subagent_type="Explore") → scraper architecture research
  ├── [parallel] Agent(subagent_type="architect") → API + data model design
  └── [waits for both] → synthesize design
       └── Agent(subagent_type="claude") → implement scraper
       └── Agent(subagent_type="claude") → implement API        [parallel]
       └── Agent(subagent_type="ui-designer") → implement UI    [parallel]
            └── [waits for all 3] → Agent(subagent_type="qa-agent") → QA
```

### Cost Model
Rough estimate per portal build with 4-agent fan-out:
- Explore: ~$0.02
- Architect: ~$0.05
- 3x implement: ~$0.15 each → $0.45
- QA: ~$0.03
- **Total: ~$0.55 vs ~$0.25 sequential**
- Speed gain: ~40% wall-clock reduction

Decision rule: only fan-out when tasks are genuinely independent (no shared mutable state). If task B reads task A's output, keep them sequential.

---

## Inter-Agent Communication Patterns

### 1. Return value passing (synchronous)
Sub-agent returns result as text → orchestrator parses → passes to next agent.
- Best for: research results, design specs, file paths
- Limitation: sub-agent output truncated at ~10K tokens

### 2. S3 file handoff (async)
Agent A writes to `s3://sasmaster-2026/agent-handoff/{session_id}/{artifact}.json`.
Agent B reads from same path.
- Best for: large artifacts (schemas, full HTML files, data samples)
- Pattern: already used for jobs/queue.json

### 3. Shared file system (same Mac session only)
Agent writes to `~/SaSMaster/tmp/{artifact}`, orchestrator or next agent reads.
- Best for: local builds where agents share the same filesystem
- Not available in Railway/cloud agent context

---

## Failure Handling Rules

1. **Partial failure is not total failure** — if 1 of 3 parallel agents fails, collect the 2 successes and retry the failed one with error context.
2. **Never auto-retry more than once** — log the failure to DONE_LOG.md and surface to Shiv.
3. **QA is always the final gate** — no fan-out result is accepted without QA agent sign-off.
4. **Cost guard applies per sub-agent** — each sub-agent session is independently token-budgeted.

---

## Prototype — parallel-agent-run.sh

Shell-level prototype for running independent JARVIS tasks in parallel.
Use when spinning up multiple `claude -p` invocations on Mac for background research.

```bash
#!/bin/bash
# parallel-agent-run.sh — run N independent claude tasks in parallel
# Usage: ./parallel-agent-run.sh "task1 prompt" "task2 prompt" "task3 prompt"
# Output: ~/SaSMaster/tmp/parallel-{n}.out per task

set -uo pipefail
SASMASTER="$HOME/SaSMaster"
TMP="$SASMASTER/tmp/parallel-run-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TMP"

PIDS=()
N=0
for PROMPT in "$@"; do
  N=$((N+1))
  OUT="$TMP/task-${N}.out"
  echo "[$N] spawning: ${PROMPT:0:60}..."
  claude --model claude-sonnet-4-6 -p "$PROMPT" > "$OUT" 2>&1 &
  PIDS+=($!)
done

# Wait and collect
FAIL=0
for I in "${!PIDS[@]}"; do
  PID="${PIDS[$I]}"
  N=$((I+1))
  if wait "$PID"; then
    echo "[$N] PASS"
  else
    echo "[$N] FAIL (exit $?)"
    FAIL=$((FAIL+1))
  fi
done

echo ""
echo "Results in $TMP/"
ls "$TMP/"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
```

---

## First Application: RESEARCH-PORTAL-001

**Planned fan-out:**

| Agent | Task | Parallel with |
|-------|------|---------------|
| Explore | Map existing SaSMaster scrapers + API patterns | Architect |
| Architect | Design Research Portal data model + API surface | Explore |
| claude | Implement /api/research endpoints | ui-designer |
| ui-designer | Build Research Portal UI shell | claude (API) |
| qa-agent | Full QA gate | — (final) |

**Session handoff protocol:**
- Explore + Architect agents both write summaries to `tmp/research-portal-context.md`
- Orchestrator synthesizes → injects into implement agent prompts as context
- UI agent gets API spec (OpenAPI fragment) from implement agent via file handoff

---

## Next Steps

- [ ] Implement `parallel-agent-run.sh` (from prototype above)
- [ ] Add `!parallel` JARVIS command → triggers 2+ `claude -p` subprocesses
- [ ] RESEARCH-PORTAL-001 sprint: apply fan-out pattern as first production use
- [ ] Post-build cost comparison: measure actual vs. projected cost/time gain
