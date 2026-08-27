# `/api/status` payload classification

**Card:** SC2-P0-EGRESS-001 · **Classified:** 2026-08-22 · **Method:** machine-generated
from the live document; every row below corresponds to a path measured in the payload,
not to a path anyone believed was there.

This document is the card's durable artefact. **The next person to add a field to the
status document reads it and decides which bucket the field lands in BEFORE it ships.**
That decision, made in advance and written down, is the only mechanism that stops the
public payload regrowing to 140KB one convenient field at a time.

---

## 1. What was measured

| Fact | Value | How established |
|---|---|---|
| Live payload size | **146,375 bytes** | `wc -c status.json`, 2026-08-22T09:22Z, the document `/api/status` relays |
| Card's recorded size | 140,180 bytes | live probe 2026-08-18, re-confirmed 2026-08-22 |
| Size delta | +6,195 bytes (+4.4%) | the document is regenerated every 5 minutes; the delta is drift, not a different endpoint |
| Distinct scalar paths | **257** | leaf-path walk of the live document |
| Authentication before this card | **none** | `api/status.js` @ b51ea7d — no key, cookie, session, or Origin check anywhere in the handler |
| Public payload after this card | **156 bytes** | measured at the handler, driven with the real 146,375-byte document as upstream |

**Re-verification of the card's premise (§44):** the card records 140,180 bytes; the
document measured today is 146,375. A materially different number would have meant the
endpoint changed and Phase 2 needed re-planning. 4.4% across four days on a document
regenerated every 5 minutes is drift. **The premise holds.**

---

## 2. Credential screen — the highest-value step in the card

Run 2026-08-22 over the live document. **Counts and paths only; no matched value was
recorded, pasted, or transmitted anywhere.**

| Pattern | Hits |
|---|---|
| `(AKIA\|ASIA)[A-Z0-9]{16}` — AWS access key ids | **0** |
| `xox[baprs]-[A-Za-z0-9-]{10,}` — Slack tokens | **0** |
| `sk-[A-Za-z0-9_-]{20,}` — OpenAI/Anthropic-shaped | **0** |
| `gh[pousr]_[A-Za-z0-9]{20,}` — GitHub tokens | **0** |
| `[a-z]+://[^:/@"]+:[^@"]+@` — credentials in a URL | **0** |
| `X-Amz-Signature=` / `X-Amz-Credential=` — presigned URLs | **0** |
| `arn:aws:[a-z0-9-]+:` — ARNs | **0** |
| `eyJ…\.[…]\.` — JWTs | **0** |

**VERDICT: no §51 rotation is triggered by this endpoint.** The card correctly required
this screen before any code was written — a hit would have changed the card's priority
from "close a leak" to "rotate a compromised secret", and closing the endpoint does
nothing about what has already been served.

One infrastructure pointer **is** disclosed and is not credential-shaped: the S3 bucket
name, 14 occurrences, one distinct bucket. It is classified **S** and withheld.

---

## 3. The buckets

| Bucket | Meaning | Paths | Disposition |
|---|---|---|---|
| **P — Public** | A stranger knowing it costs nothing | **7** | in the allow-list |
| **O — Operational** | Internal topology: job names, task ids, agent names, schedules, queue depths, filesystem paths | **204** | internal only |
| **S — Sensitive** | A direct pointer to infrastructure (bucket/prefix names, log paths, shell command lines) | **6** | internal only |
| **L — Licensed** | Names, sizes, object counts or refresh cadences over a source whose `gov.source_provenance.commercial_redistribution = false` | **40** | internal only + **⏸️ licensing ruling** |
| **U — Unclassifiable** | Provenance genuinely unknown | **0** | would be withheld and rendered `—` with a note (§39) |

### 3.1 The seven P paths — this is the entire public document

```
checked_at                      <- health.computed_at, else generated_at
status                          <- health.grade, mapped green|amber|red -> ok|degraded|down
components.agents               <- health.component_bands.agents, same mapping
components.canaries             <- health.component_bands.canaries
components.cron                 <- health.component_bands.cron
components.freshness            <- health.component_bands.freshness
schema_version                  <- constant 1
```

Emitted verbatim to `docs/status-public-allowlist.txt`, **generated from
`lib/status-public-view.js` itself** so the allow-list file and the code cannot drift.

**Component-name disclosure ruling (card Phase 2, item 3):** publish the four names as
written. They are generic subsystem categories — not service names, hostnames, job ids
or agent names — and the existence of a status page already implies the platform has
agents, canaries, cron and data-freshness checks. Opaque labels would make the endpoint
useless for its one legitimate purpose without materially reducing disclosure. The
values published are **bands**, never the numeric component scores (`health.score` = 94
and `health.components.cron` = 68 are both **O** and withheld).

### 3.2 The worst of what was public — named, because "140KB of internal state" is abstract

| Path | What an anonymous caller received |
|---|---|
| `cron.[].command` | the **full shell command line** of every scheduled job |
| `agents.[].log` | absolute filesystem paths on the founder's machine |
| `agents.[].schedule`, `.jobId`, `.name` | 51 agent definitions with their schedules |
| `queue.highItems.[].id`, `tasks.[].id` | live job-queue **task identifiers** |
| `system.jarvis.alive` | JARVIS liveness |
| `s3_lake.[].prefix`, `.size_gb`, `.object_count` | the data-lake inventory, by dataset, with sizes |

### 3.3 ⏸️ THE LICENSING FINDING — needs a ruling, not a patch

40 paths are **L**. The public endpoint has been publishing, to anyone, the **names,
sizes, object counts and refresh cadences** of datasets derived from sources that
`gov.source_provenance` marks `commercial_redistribution = false`:

- `s3_lake[].prefix` includes `nielsen/amrld/`, `nielsen/amrld_etl/`, `nielsen/ad_intel/`,
  `nielsen/mri/`, `nielsen/viewership/`, `gracenote/`, `barb/barb_etl_qa/`,
  `barb/barb_etl_dev/`, `imdb/`, `imdb_prd/`, `eidr/` — each with `size_gb`,
  `object_count`, `last_updated`, `fresh`, `age_hours`.
- `source_freshness[].name` includes **"Nielsen VIEWERSHIP"** with its freshness state.
- `scrapers[].name` includes **"Nielsen MIT (15 tables)"**, Nielsen AMRLD, Gracenote,
  EIDR, IMDb parser.
- `kpis.parent_key_rows`, `kpis.eidr_coverage_pct`, `kpis.eidr_matched_rows`,
  `kpis.s3_gb` are row counts and coverage percentages over the spine those sources
  feed.

`gov.source_provenance` clears **exactly 1 of 16** sources for commercial
redistribution (`wikidata_sparql_seed`, CC0). Nielsen and Gracenote are explicitly
`false`.

**This code change removes all 40 from the public document.** It does **not** undo the
disclosure: the payload has been publicly served for an unknown period, to unknown
clients, and is plausibly in third-party caches, crawler indexes and scrapes.
**That residue is a contractual question and needs a ruling from Shiv, not a patch.**

---

## 4. Consumers — enumerated before the change, because a blank panel costs hours (§39)

`grep -rn "/api/status" --include=*.js --include=*.html . | grep -v node_modules`

| Consumer | Reads | Status |
|---|---|---|
| `index.html:2548-2551` | `/api/status`, then `/status.json` | **routed to 404 by `vercel.json`** (`{"src":"^/index\\.html$","status":404}` and `^/$` → 404). Not reachable. |
| `index.RETIRED.html` | same | retired by filename |
| `generate-status.js:2086` | writes the S3 cache object | producer, not consumer |
| `warroom-v5.html:2766` | **`fetch('status.json?t='+Date.now())`** | **the live War Room — reads the STATIC FILE, not `/api/status`** |

**Result: `/api/status` has ZERO live consumers.** No in-repo caller renders it, and no
cron calls it (`crontab -l \| grep api/status` → no match). Narrowing it to the
allow-list therefore breaks nothing that is running. The operator's tool is preserved on
the authenticated route regardless.

---

## 5. ⚠️ THE SECOND DOOR — this card alone does not close the leak

`api/status.js` is **one of two ways this payload reaches the public.**

`status.json` (146,375 bytes) is committed at the repo root. `vercel.json` sets
`"outputDirectory": "."` and routes `{"handle": "filesystem"}`, and 404s only `/` and
`/index.html`. **`GET /status.json` therefore serves the entire internal document with
no authentication**, and `warroom-v5.html:2766` depends on exactly that path.

- **Confidence:** structural inference from `vercel.json` + `outputDirectory` + the file
  being committed and regenerated every 5 minutes. **UNVERIFIED by live probe** — this
  session has no network egress to the origin. `scripts/probe-status-egress.sh` checks
  it, and the exact one-line curl is in the close-out.
- **Neither `vercel.json` nor `warroom-v5.html` is owned by SC2-P0-EGRESS-001 (§23),
  and an ownership check across all 20 cards shows neither is owned by ANY card.**
  The diffs are handed to the orchestrator rather than applied here.
- **Order matters:** 404ing `/status.json` before moving `warroom-v5.html` onto the
  authenticated route blanks the War Room.

---

## 6. §34 — falsifying the card's stated root cause

The card's implied cause is "the endpoint was never gated"; the competing explanation is
"it was gated and the gate regressed or was disabled for debugging."

```
$ git log --oneline -- api/status.js
2e5f834 feat: live status via api.sasmaster.dev + S3 fallback
```

**One commit, ever.** No gate existed and was removed. **Greenfield confirmed — the
hypothesis survives**, and the fix is a new gate, not a restoration.

---

## 7. Phase 0 — ⏸️ UNRULED, implemented as a fail-closed precedence

"Reuse `ASK_API_KEY` or mint `STATUS_API_KEY`?" is Shiv's call and has not been made.
`api/status.js` implements **both**, so the ruling is a pure environment action:

```
STATUS_API_KEY set    -> it guards the internal document (option b, mint)
STATUS_API_KEY unset  -> ASK_API_KEY guards it          (option a, reuse)
both unset            -> the internal route returns 503, NEVER the document
```

Fail closed: an unconfigured gate must not degrade into an open one.

**If option (b) is chosen**, two registrations are required and **neither file is owned
by this card** — they are handed over, not silently skipped (an unregistered secret is
invisible to the canary sweep, which is how a key rots undetected):

`SECRETS-MAP.md` (owned by **SC2-P0-AWSKEY-001**):

```
| STATUS_API_KEY | Vercel `sasmaster-status` (production) | Guards GET /api/status?scope=internal (the full platform status document). Minted by SC2-P0-EGRESS-001. |
```

`canaries.yaml` (owned by **SC2-P0-CANARY-001**):

```yaml
  - name: status-internal
    secret_key_ref: STATUS_API_KEY
    method: GET
    probe_url: "https://sasmaster-status.vercel.app/api/status?scope=internal"
    expected_status: 200
    quota_cost: "none — reads a cached status document, no upstream spend"
    notes: >
      401 = key drift between the Vercel env and this registry (the SC2-P0-ASKKEY-001
      failure mode). 503 with body {"error":"internal_not_configured"} = neither
      STATUS_API_KEY nor ASK_API_KEY is set on the deployment; the gate is closed but
      the operator has lost the tool. A 200 whose body is under 500 bytes means the
      internal scope silently fell through to the public projection — treat as FAIL.
```

---

## 8. Every measured path, classified

`type` is the JSON type of the value at that path in the live document. Array indices
are collapsed to `[]`, so 51 agents are one row.

| Path | type | Bucket | Disposition |
|---|---|---|---|
| `agents.[].channel` | string | **O** | internal only |
| `agents.[].descOverride` | string | **O** | internal only |
| `agents.[].icon` | string | **O** | internal only |
| `agents.[].jobId` | object | **O** | internal only |
| `agents.[].lastOutput` | string | **O** | internal only |
| `agents.[].lastRun` | string | **O** | internal only |
| `agents.[].log` | string | **S** | internal only — infrastructure pointer — absolute filesystem path on the founder's machine |
| `agents.[].name` | string | **O** | internal only |
| `agents.[].nextRun` | string | **O** | internal only |
| `agents.[].schedule` | string | **O** | internal only |
| `agents.[].status` | string | **O** | internal only |
| `alerts.[].detail` | string | **O** | internal only |
| `alerts.[].dismissed` | boolean | **O** | internal only |
| `alerts.[].dismissed_at` | string | **O** | internal only |
| `alerts.[].dismissed_by` | string | **O** | internal only |
| `alerts.[].id` | number | **O** | internal only |
| `alerts.[].level` | string | **O** | internal only |
| `alerts.[].message` | string | **O** | internal only |
| `alerts.[].timestamp` | string | **O** | internal only |
| `ask.enabled` | boolean | **O** | internal only |
| `ask.url` | string | **O** | internal only |
| `build_trends` | object | **O** | internal only |
| `claudeUsage.claudeai` | object | **O** | internal only |
| `claudeUsage.claudecode` | object | **O** | internal only |
| `claudeUsage.claudedesign` | object | **O** | internal only |
| `claudeUsage.claudemax` | object | **O** | internal only |
| `cost_summary.authority` | string | **O** | internal only |
| `cost_summary.entry_count` | number | **O** | internal only |
| `cost_summary.model_breakdown.claude-haiku-4-5-20251001` | number | **O** | internal only |
| `cost_summary.model_breakdown.claude-sonnet-4-6` | number | **O** | internal only |
| `cost_summary.model_breakdown.none` | number | **O** | internal only |
| `cost_summary.model_breakdown.unknown` | number | **O** | internal only |
| `cost_summary.mtd_cost_usd` | number | **O** | internal only |
| `cost_summary.total_cost_usd` | number | **O** | internal only |
| `cron.[].channel` | string | **O** | internal only |
| `cron.[].command` | string | **S** | internal only — infrastructure pointer — the full shell command line of every scheduled job |
| `cron.[].name` | string | **O** | internal only |
| `cron.[].status` | string | **O** | internal only |
| `cron.[].time` | string | **O** | internal only |
| `cron.[].weekly` | boolean | **O** | internal only |
| `follow_up_count` | number | **O** | internal only |
| `follow_up_items.[].name` | string | **O** | internal only |
| `follow_up_items.[].type` | string | **O** | internal only |
| `generated` | string | **O** | internal only |
| `generated_at` | string | **P** | goes in the allow-list |
| `health.component_bands.agents` | string | **P** | goes in the allow-list |
| `health.component_bands.canaries` | string | **P** | goes in the allow-list |
| `health.component_bands.cron` | string | **P** | goes in the allow-list |
| `health.component_bands.freshness` | string | **P** | goes in the allow-list |
| `health.components.agents` | number | **O** | internal only |
| `health.components.canaries` | number | **O** | internal only |
| `health.components.cron` | number | **O** | internal only |
| `health.components.freshness` | number | **O** | internal only |
| `health.computed_at` | string | **P** | goes in the allow-list — when the health verdict was computed |
| `health.floor` | object | **O** | internal only |
| `health.formula.amber_floor_rule` | string | **O** | internal only |
| `health.formula.formula_version` | string | **O** | internal only |
| `health.formula.thresholds.amber` | number | **O** | internal only |
| `health.formula.thresholds.green` | number | **O** | internal only |
| `health.formula.weights.agents` | number | **O** | internal only |
| `health.formula.weights.canaries` | number | **O** | internal only |
| `health.formula.weights.cron` | number | **O** | internal only |
| `health.formula.weights.freshness` | number | **O** | internal only |
| `health.formula_version` | string | **O** | internal only |
| `health.gates_triggered.[]` | string | **O** | internal only |
| `health.grade` | string | **P** | goes in the allow-list — the platform's own overall verdict (ONE-SOURCE-001 health authority) |
| `health.score` | number | **O** | internal only — numeric score derived from internal component weights; the BAND is published instead |
| `health.sentinel_status` | string | **O** | internal only |
| `health.worst_component_band` | string | **O** | internal only |
| `heatmap.2026-08-03` | number | **O** | internal only |
| `intel_feed.[].source` | string | **O** | internal only |
| `intel_feed.[].text` | string | **O** | internal only |
| `intel_feed.[].ts` | string | **O** | internal only |
| `kanban.backlog.[].blockReason` | string | **O** | internal only |
| `kanban.backlog.[].full` | string | **O** | internal only |
| `kanban.backlog.[].id` | string | **O** | internal only |
| `kanban.backlog.[].lineIndex` | number | **O** | internal only |
| `kanban.backlog.[].priority` | string | **O** | internal only |
| `kanban.backlog.[].sprint` | string | **O** | internal only |
| `kanban.backlog.[].state` | string | **O** | internal only |
| `kanban.backlog.[].tag` | string | **O** | internal only |
| `kanban.backlog.[].text` | string | **O** | internal only |
| `kanban.blocked.[]` | undefined | **O** | internal only |
| `kanban.counts.backlog` | number | **O** | internal only |
| `kanban.counts.blocked` | number | **O** | internal only |
| `kanban.counts.inProgress` | number | **O** | internal only |
| `kanban.counts.qaDrafts` | number | **O** | internal only |
| `kanban.counts.review` | number | **O** | internal only |
| `kanban.done.[].full` | string | **O** | internal only |
| `kanban.done.[].id` | string | **O** | internal only |
| `kanban.done.[].priority` | string | **O** | internal only |
| `kanban.done.[].sprint` | string | **O** | internal only |
| `kanban.done.[].tag` | string | **O** | internal only |
| `kanban.done.[].text` | string | **O** | internal only |
| `kanban.inProgress.[]` | undefined | **O** | internal only |
| `kanban.memoryPending.[]` | undefined | **O** | internal only |
| `kanban.qaDrafts.[]` | undefined | **O** | internal only |
| `kanban.review.[].approvalId` | string | **O** | internal only |
| `kanban.review.[].full` | string | **O** | internal only |
| `kanban.review.[].id` | string | **O** | internal only |
| `kanban.review.[].priority` | string | **O** | internal only |
| `kanban.review.[].sprint` | string | **O** | internal only |
| `kanban.review.[].tag` | string | **O** | internal only |
| `kanban.review.[].text` | string | **O** | internal only |
| `kpis.agents_live_total` | number | **O** | internal only |
| `kpis.agents_running` | number | **O** | internal only |
| `kpis.agents_total` | number | **O** | internal only |
| `kpis.build_events_today` | number | **O** | internal only |
| `kpis.builds_7d` | number | **O** | internal only |
| `kpis.eidr_coverage_pct` | number | **L** | internal only — **licensing ruling required** |
| `kpis.eidr_matched_rows` | number | **L** | internal only — **licensing ruling required** |
| `kpis.error_rate_7d` | number | **O** | internal only |
| `kpis.haiku_pct_today` | number | **O** | internal only |
| `kpis.model_routing` | string | **O** | internal only |
| `kpis.parent_key_rows` | number | **L** | internal only — **licensing ruling required** |
| `kpis.s3_gb` | number | **L** | internal only — **licensing ruling required** |
| `kpis.scrapers_live` | number | **O** | internal only |
| `kpis.scrapers_total` | number | **O** | internal only |
| `kpis.tasks_open` | number | **O** | internal only |
| `movie_universe` | object | **O** | internal only |
| `portal_coverage.baseline` | string | **O** | internal only |
| `portal_coverage.portal_url` | string | **S** | internal only — infrastructure pointer |
| `portal_coverage.report_date` | string | **O** | internal only |
| `portal_coverage.summary.Advertising` | number | **O** | internal only |
| `portal_coverage.summary.CPG` | number | **O** | internal only |
| `portal_coverage.summary.Content` | number | **O** | internal only |
| `portal_coverage.summary.DrScoop` | number | **O** | internal only |
| `portal_coverage.summary.Exchange` | number | **O** | internal only |
| `portal_coverage.summary.Marketing` | number | **O** | internal only |
| `portal_coverage.summary.overall_avg` | number | **O** | internal only |
| `queue.blockedItems.[]` | undefined | **O** | internal only |
| `queue.exploreItems.[]` | undefined | **O** | internal only |
| `queue.high` | number | **O** | internal only |
| `queue.highItems.[].blockReason` | string | **O** | internal only |
| `queue.highItems.[].full` | string | **O** | internal only |
| `queue.highItems.[].id` | string | **O** | internal only — live job-queue task identifier |
| `queue.highItems.[].lineIndex` | number | **O** | internal only |
| `queue.highItems.[].priority` | string | **O** | internal only |
| `queue.highItems.[].sprint` | string | **O** | internal only |
| `queue.highItems.[].state` | string | **O** | internal only |
| `queue.highItems.[].tag` | string | **O** | internal only |
| `queue.highItems.[].text` | string | **O** | internal only |
| `queue.med` | number | **O** | internal only |
| `queue.medItems.[].blockReason` | string | **O** | internal only |
| `queue.medItems.[].full` | string | **O** | internal only |
| `queue.medItems.[].id` | string | **O** | internal only |
| `queue.medItems.[].lineIndex` | number | **O** | internal only |
| `queue.medItems.[].priority` | string | **O** | internal only |
| `queue.medItems.[].sprint` | string | **O** | internal only |
| `queue.medItems.[].state` | string | **O** | internal only |
| `queue.medItems.[].tag` | string | **O** | internal only |
| `queue.medItems.[].text` | string | **O** | internal only |
| `queue.reviewItems.[]` | undefined | **O** | internal only |
| `queue.wipItems.[]` | undefined | **O** | internal only |
| `recentBuilds.[].date` | string | **O** | internal only |
| `recentBuilds.[].notes` | string | **O** | internal only |
| `recentBuilds.[].status` | string | **O** | internal only |
| `recentBuilds.[].task` | string | **O** | internal only |
| `recent_activity.[].text` | string | **O** | internal only |
| `recent_activity.[].ts` | string | **O** | internal only |
| `recent_activity.[].type` | string | **O** | internal only |
| `recent_completions.[].category` | string | **O** | internal only |
| `recent_completions.[].completed_at` | string | **O** | internal only |
| `recent_completions.[].path` | string | **S** | internal only — infrastructure pointer |
| `recent_completions.[].title` | string | **O** | internal only |
| `s3_lake.[].age_hours` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].computed_at` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entities.episodes` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entities.movies` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entities.other` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entities.people` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entities.sports` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entities.telecasts` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entities.tv_series` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].entity_type` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].flag` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].fresh` | boolean | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].funnel` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].last_updated` | string | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].note` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].object_count` | number | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].path` | string | **S** | internal only — infrastructure pointer |
| `s3_lake.[].phase` | string | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].prefix` | string | **S** | internal only — infrastructure pointer |
| `s3_lake.[].size_gb` | number | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].source_job` | object | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].stale` | boolean | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].status` | string | **L** | internal only — **licensing ruling required** |
| `s3_lake.[].untyped` | object | **L** | internal only — **licensing ruling required** |
| `scrapers.[].last_run` | string | **L** | internal only — **licensing ruling required** |
| `scrapers.[].name` | string | **L** | internal only — **licensing ruling required** |
| `scrapers.[].note` | undefined | **L** | internal only — **licensing ruling required** |
| `scrapers.[].pct` | number | **L** | internal only — **licensing ruling required** |
| `scrapers.[].phase` | string | **L** | internal only — **licensing ruling required** |
| `scrapers.[].row_count` | number | **L** | internal only — **licensing ruling required** |
| `scrapers.[].s3_path` | string | **L** | internal only — **licensing ruling required** |
| `scrapers.[].status` | string | **L** | internal only — **licensing ruling required** |
| `scrapers.[].total` | number | **L** | internal only — **licensing ruling required** |
| `slack_feed.builds.[].text` | string | **O** | internal only |
| `slack_feed.builds.[].ts` | string | **O** | internal only |
| `slack_feed.content.[].text` | string | **O** | internal only |
| `slack_feed.content.[].ts` | string | **O** | internal only |
| `slack_feed.intel.[].text` | string | **O** | internal only |
| `slack_feed.intel.[].ts` | string | **O** | internal only |
| `source_freshness.[].age_mins` | object | **L** | internal only — **licensing ruling required** |
| `source_freshness.[].last_updated` | object | **L** | internal only — **licensing ruling required** |
| `source_freshness.[].source` | string | **L** | internal only — **licensing ruling required** |
| `source_freshness.[].status` | string | **L** | internal only — **licensing ruling required** |
| `source_freshness.[].threshold_mins` | number | **L** | internal only — **licensing ruling required** |
| `system.jarvis.alive` | boolean | **O** | internal only — JARVIS liveness — named in the card as a known leaked field |
| `target10.[]` | undefined | **O** | internal only |
| `tasks.[].est` | string | **O** | internal only |
| `tasks.[].priority` | string | **O** | internal only |
| `tasks.[].status` | string | **O** | internal only |
| `tasks.[].tag` | string | **O** | internal only |
| `tasks.[].title` | string | **O** | internal only |
| `token_projection.daily_cost.2026-08-17` | number | **O** | internal only |
| `token_projection.daily_cost.2026-08-18` | number | **O** | internal only |
| `token_projection.daily_cost.2026-08-19` | number | **O** | internal only |
| `token_projection.daily_cost.2026-08-20` | number | **O** | internal only |
| `token_projection.daily_cost.2026-08-21` | number | **O** | internal only |
| `token_projection.daily_cost.2026-08-22` | number | **O** | internal only |
| `token_projection.pct_elapsed` | number | **O** | internal only |
| `token_projection.projected_week_cost_usd` | number | **O** | internal only |
| `token_projection.recommendations.[].action` | string | **O** | internal only |
| `token_projection.recommendations.[].agent` | string | **O** | internal only |
| `token_projection.recommendations.[].est_save_usd_wk` | number | **O** | internal only |
| `token_projection.recommendations.[].severity` | string | **O** | internal only |
| `token_projection.recommendations.[].type` | string | **O** | internal only |
| `token_projection.reset_at` | string | **O** | internal only |
| `token_projection.top_consumers.[].cost_usd` | number | **O** | internal only |
| `token_projection.top_consumers.[].id` | string | **O** | internal only |
| `token_projection.top_consumers.[].model` | string | **O** | internal only |
| `token_projection.top_consumers.[].tokens` | number | **O** | internal only |
| `token_projection.week_cost_usd` | number | **O** | internal only |
| `token_projection.week_start` | string | **O** | internal only |
| `token_projection.week_tokens` | number | **O** | internal only |
| `usage_state._deprecates` | string | **O** | internal only |
| `usage_state._scope_note` | string | **O** | internal only |
| `usage_state._tier_logic` | string | **O** | internal only |
| `usage_state._updated` | string | **O** | internal only |
| `usage_state.billing_mode` | string | **O** | internal only |
| `usage_state.cache_hit_rate_pct` | number | **O** | internal only |
| `usage_state.cache_hit_updated` | string | **O** | internal only |
| `usage_state.daily_tiers.fallback` | number | **O** | internal only |
| `usage_state.daily_tiers.pause` | number | **O** | internal only |
| `usage_state.daily_tiers.warn` | number | **O** | internal only |
| `usage_state.monthly_cap_usd` | number | **O** | internal only |
| `usage_state.monthly_pace_warn_usd` | number | **O** | internal only |
| `usage_state.pause_requires_human_resume` | boolean | **O** | internal only |
| `usage_state.resume_on.[]` | string | **O** | internal only |
| `usage_state.session_used_pct` | number | **O** | internal only |
| `usage_state.updated_at` | string | **O** | internal only |
| `usage_state.weekly_all_models_pct` | number | **O** | internal only |
| `usage_state.weekly_claude_design_pct` | number | **O** | internal only |
| `usage_state.weekly_resets_at` | string | **O** | internal only |
| `usage_state.weekly_sonnet_pct` | object | **O** | internal only |

---

**Row count check (ACCEPTANCE):** 257 measured paths, 257 table rows.
P=7 · O=204 · S=6 · L=40 · U=0.
No path is unclassified; there is nothing withheld for want of provenance.
