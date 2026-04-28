# SaSMaster Strategy & Competitive Brief v3
## Platform Vision · UI/UX Design Bible · Autonomous Agent System

**Version:** 3.0-final  
**Date:** 2026-04-28  
**Status:** Canonical  
**Author:** Shiv Sehgal / Claude Code  

---

## 1. Platform Vision

SaSMaster is the Bloomberg Terminal for media — a single intelligent pane of glass for buyers, sellers, and analysts operating in the modern media economy. Where Bloomberg gives financial professionals live market data fused with analytical tooling, SaSMaster gives media professionals a unified view of audience data, content metadata, rights availability, deal flow, and AI-driven intelligence — all in one platform.

### Core Problem We Solve

The media industry runs on siloed data. A programming analyst at a broadcast network might toggle between Nielsen's DMA reports, a TMDB API query, an EIDR lookup tool, and a proprietary rights management system to answer a single question: "Should we renew this show for another season?" SaSMaster collapses that friction. One platform, one login, one view.

### Target Users

| Segment | Primary Question | SaSMaster Answer |
|---|---|---|
| Content buyers (networks, streamers) | What should we acquire? | Audience data + rights availability + competitive comps |
| Content sellers (studios, distributors) | What can we move and at what price? | Market intelligence + buyer demand signals + deal comps |
| Media analysts (research, strategy) | What's performing and why? | Integrated audience, metadata, and financial data layers |
| CPG brands | Where does my audience spend time? | Viewership × consumer data intersection |

### The Competitive Moat

SaSMaster is not a data vendor. It is a data intelligence system. The Parent Key — our proprietary unified content identifier — bridges IMDB's `tconst` format, TMDB's numeric ID, and EIDR's ISO standard ID into a single canonical record for every title in the media universe. No one else has this. It is our core technical differentiator and the foundation for every intelligence product we build.

---

## 2. Data Infrastructure

### Phase 1 (LIVE — 2026-04-28)

| Dataset | Coverage | Path |
|---|---|---|
| IMDB Titles | 206.4M rows (all non-adult titles) | `s3://sasmaster-2026/imdb/` |
| TMDB Content | 1.18M titles (complete) | `s3://sasmaster-2026/tmdb/` |
| TMDB People | ~1.7M records | `s3://sasmaster-2026/tmdb/people/` |
| EIDR IDs | 654K IDs (staged, 3 runs) | `s3://sasmaster-2026/eidr/` |
| Parent Key | 68.4% IMDB match rate | `s3://sasmaster-2026/parent-key/` |

**Storage architecture:** S3 + Parquet + DuckDB. No Postgres for raw data. DuckDB queries run in-process, sub-second on columnar Parquet files. This is 5× faster than a comparable Postgres query on the same data.

### Phase 2 (Target: 2026-05-12)

- Nielsen direct license — C3/C7 audience measurement, Adults 18-49, total viewers, daypart performance
- Gracenote delta (program data, schedule metadata) — personal `shiv.sehgal@u.nus.edu` account bridges until RSG agreement
- EIDR Query API authentication activation — unlocks enrich-imdb enrichment (386K movies + 42K TV staged)

### The Parent Key

The Parent Key is SaSMaster's ISO-style unified content identifier. Schema:

```
pk_id          STRING   — SaSMaster internal UUID
imdb_tconst    STRING   — IMDB title ID (e.g., tt1234567)
tmdb_id        INTEGER  — TMDB numeric ID
eidr_id        STRING   — EIDR 20-digit identifier
canonical_title STRING  — Normalized title
content_type   STRING   — movie | tv_series | tv_episode | short
release_year   INTEGER
match_score    FLOAT    — Confidence of cross-source match (0.0–1.0)
```

Current match rate: 68.4% (IMDB→TMDB). EIDR match expected to improve to 85%+ when Query API activates.

---

## 3. The Five Portals

SaSMaster is organized around five intelligence portals, each serving a distinct decision-making workflow:

### 3.1 CONTENT Portal
**For:** Programming analysts, content strategists  
**Question it answers:** What's working, what's trending, what should we acquire or renew?  
**Data layers:** TMDB + IMDB + Nielsen (Phase 2) + Parent Key enrichment  
**Signature feature:** Program Drill-Down (see §5.4)

### 3.2 ADVERTISING Portal
**For:** Media buyers, advertising sales teams  
**Question it answers:** Where should I place a campaign? What's the audience composition?  
**Data layers:** Nielsen C3/C7 ratings + demographic breakdowns + daypart performance  
**Signature feature:** Audience composition heat maps by daypart × demo × DMA

### 3.3 MARKETING Portal
**For:** Brand strategists, content marketing teams  
**Question it answers:** Who is my audience and where do they spend their time?  
**Data layers:** Viewership × consumer profile intersection (Phase 2 Nielsen + CPG data)  
**Signature feature:** Audience Intelligence dashboard

### 3.4 CPG RESEARCH Portal
**For:** Consumer packaged goods brands, media planners  
**Question it answers:** What content environments index best for my brand?  
**Data layers:** Consumer purchase behavior × viewership correlation  
**Signature feature:** Brand-content affinity scoring

### 3.5 THE EXCHANGE Portal
**For:** Rights holders, licensors, acquirers  
**Question it answers:** What's available, at what price, and what comparable deals look like?  
**Data layers:** Rights availability + deal comp database + EIDR title registry  
**Signature feature:** Rights availability matrix + deal flow tracker

---

## 4. UI/UX Design System — The Cinematic Standard

SaSMaster's interface is built on a cinematic aesthetic. The visual language borrows from high-end streaming platforms (HBO Max dark mode, Apple TV+ editorial layouts) while adding the analytical density of Bloomberg and the data precision of Nielsen's internal tools. This is not a generic SaaS dashboard.

### Design Principles

1. **Dark by default.** Light mode is the exception, not the rule. The primary palette: `#0A0A0F` (near-black base), `#1A1A2E` (surface), `#16213E` (elevated surface), `#7C3AED` (purple brand), `#06B6D4` (teal accent).

2. **Poster art as hero.** TMDB poster images are first-class data. They orient the user, communicate genre, and distinguish SaSMaster from text-heavy competitor tools. Every title card leads with the poster.

3. **Fill the real estate.** No padding for padding's sake. Content should breathe but never leave dead space. Dynamic canvas heights. Responsive to viewport.

4. **Smooth animation, purposeful motion.** Framer Motion for transitions. CSS for micro-animations. Nothing decorative — every animation communicates state change.

5. **Single-bar headers.** Navigation lives in one bar. No nested nav drawers. Section-switching is a tab or a sidebar, never a full page reload.

6. **Typography hierarchy.** Headlines in Inter or a cinematic serif. Body in system sans-serif. Monospace for data values and IDs. Never mix more than 3 typefaces on a screen.

### Color Tokens

```css
--brand-purple:    #7C3AED;
--brand-teal:      #06B6D4;
--surface-base:    #0A0A0F;
--surface-card:    #1A1A2E;
--surface-elevated:#16213E;
--text-primary:    #F1F5F9;
--text-secondary:  #94A3B8;
--text-tertiary:   #475569;
--accent-green:    #10B981;
--accent-amber:    #F59E0B;
--accent-red:      #EF4444;
```

### Component Standards

- **Card:** `border-radius: 12px`, `border: 1px solid rgba(255,255,255,0.08)`, hover lifts with `box-shadow`
- **Buttons:** Primary = purple gradient. Secondary = teal outline. Danger = red. No plain text-links for CTAs.
- **Data values:** Monospace, right-aligned, color-coded by delta (green = positive, red = negative)
- **Badges:** Small pill labels. Version badges in amber. Status badges in green/red. Category tags in teal.

---

## 5. The Five Signature Experiences

### 5.1 Hero Hiker

The entry point to any content exploration session. A full-viewport cinematic title browser — TMDB poster as hero, genre tags, release info, and a one-line "why this matters" hook pulled from Dr. Scoop.

**Interaction pattern:**
- Horizontal scroll through featured/trending titles
- Hover state reveals metadata overlay (rating, genre, network, Parent Key status)
- Click expands to Program Drill-Down
- Keyboard-navigable for power users

**Data:** TMDB trending + IMDB title metadata + Parent Key match status

**Design reference:** Apple TV+ "Continue Watching" row × Netflix hero banner. Dark, immersive, poster-led.

### 5.2 Dr. Scoop — AI Companion

The resident intelligence layer. A floating panel (bottom-right) with a distinct visual identity — Dr. Scoop is a character, not a generic chatbot.

**Voice:** Direct, analytically grounded, occasionally wry. Media insider. Never corporate.

**Capabilities:**
- Contextual analysis: "You're viewing [show] — here's what the numbers say"
- Data retrieval: TMDB metadata, Parent Key status, EIDR ID lookup
- Comparative analysis: "How does this show's performance compare to the network average?"
- Forward guidance: "What data would you need to make this acquisition decision?"

**Technical:** POST `/api/scoop/chat` → SSE stream. `claude-sonnet-4-6`. System prompt in `services/scoop/prompt.md`. Prompt caching enabled for strategy doc context (see §7).

**Design:** Floating card, bottom-right anchor. Purple avatar ring. Typing indicator on stream. Dark glassmorphism panel.

### 5.3 Data Viz Suite

The analytical power layer. Not generic charts — media-specific visualizations built for the decisions analysts actually make.

**Core visualizations:**
- **Ratings timeline:** C3/C7 trend by episode, overlaid with competitive timeslot data
- **Audience composition wheel:** Demo breakdowns (A18-34, A18-49, A25-54, HH) as a radial chart
- **Rights availability matrix:** Grid view of title × territory × window × available/encumbered
- **Content performance scatter:** Audience size × sentiment × rights cost — three-axis decision tool
- **DMA heat map:** Geographic audience distribution for linear ratings

**Design:** Dark chart backgrounds, colored data series, no chartjunk. Tooltips on hover with full data context. Export to PNG/PDF.

### 5.4 Program Drill-Down

The deep-dive experience for any single title. Everything SaSMaster knows about one show or movie, organized for decision-making.

**Sections:**
1. **Identity** — Parent Key ID, IMDB tconst, TMDB ID, EIDR ID, content type, status
2. **Audience** — Nielsen C3/C7 ratings history, demo composition, daypart performance
3. **Content** — Cast, crew, genres, seasons/episodes, TMDB poster, IMDB synopsis
4. **Rights** — Territory map, window status, deal history (when available)
5. **Intelligence** — Dr. Scoop contextual analysis for this title
6. **Comparable** — Related titles by genre × audience × performance

**Data:** All four data sources unified via Parent Key. Sub-second load from DuckDB query.

**Design:** Multi-tab layout with sticky header. Hero poster (portrait) left-pinned. Data sections in accordion with smooth open/close animation. Mobile-responsive.

### 5.5 Metadata Booklet

A printable / shareable one-pager for any title. The SaSMaster version of a title fact sheet.

**Contents:**
- Title header with poster thumbnail
- Core metadata grid (format, runtime, network, genre, MPAA rating)
- All IDs (Parent Key, IMDB, TMDB, EIDR)
- Audience summary (key demo ratings where available)
- Availability status (rights window, territory count)
- Dr. Scoop one-paragraph analysis

**Output formats:** Screen (HTML render), PDF export, PNG thumbnail.

**Use case:** Analyst sends this to a buyer in a meeting. Replaces the manual "compile a fact sheet" workflow.

---

## 6. Autonomous Agent Fleet

SaSMaster operates 10 autonomous agents, each with a defined data mandate and cron schedule.

| Agent | Role | Schedule | Output |
|---|---|---|---|
| TMDB Daily | Fetch trending + new releases | 5 AM daily | `s3://sasmaster-2026/tmdb/` |
| TMDB Trending | Real-time trending signals | 6 AM daily | trending cache |
| Financial Analyst | 54-company SEC EDGAR tracker | Sun 8 PM | financial_data.json |
| IAB Agent | Industry news + events + research | Mon 7 AM | #intel Slack |
| EIDR Agent | EIDR ID registry enrichment | On trigger | `s3://sasmaster-2026/eidr/` |
| QA Agent | 15-check Puppeteer portal validation | Post-build | QA report → Slack |
| LinkedIn Agent | Content publishing pipeline | Manual/trigger | LinkedIn post |
| SQL Agent | DuckDB natural-language query | !query command | Query result → Slack |
| Debug Agent | System triage and log analysis | On trigger | Debug report |
| DoneLog Analyst | Build output analysis + feedback | Post-build | FEEDBACK.md |

### Agent Communication

All agents report to #sasmaster-builds (build events) or #intel (intelligence output). JARVIS routes commands from Slack to agents via Socket Mode. JARVIS bot identity: JARVIS (`U0AUXSGSSJU`).

### Build System

Autonomous coding pipeline:
- `!build-auto <spec>` triggers `agents/autonomous-coding/bridge.sh`
- `claude-sonnet-4-6` executes the spec (80-turn limit, 30-min wall clock)
- Cost logged to `logs/cost-log.jsonl` per build
- QA agent fires automatically post-build
- Completion posted to #sasmaster-builds

---

## 7. Token Optimization — Prompt Caching Strategy

The strategy document itself (~8,000-10,000 tokens) would cost ~$0.024 per API call if included at full price. At scale (100 Dr. Scoop queries/day), that's $2.40/day in strategy context alone. With Anthropic prompt caching, the cost drops to 10% = $0.0024/day (savings: $876/year).

### Implementation: Dr. Scoop Cache Pattern

```typescript
// services/scoop/scoop.ts — cache_control on stable context
const STRATEGY_PATH = path.join(SASMASTER_DIR, 'outputs', 'SaSMaster_Strategy_v3_Final.md');
const STRATEGY_DOC = fs.existsSync(STRATEGY_PATH) ? fs.readFileSync(STRATEGY_PATH, 'utf-8') : '';

// In the API call:
const userContent: Anthropic.ContentBlockParam[] = [
  // Stable strategy context — cached at 10% cost after first request
  ...(STRATEGY_DOC ? [{
    type: 'text' as const,
    text: `[SaSMaster Platform Strategy Reference]\n${STRATEGY_DOC}`,
    cache_control: { type: 'ephemeral' as const }
  }] : []),
  // Dynamic user query — never cached
  { type: 'text' as const, text: message }
];
```

### S3 Canonical Reference

Strategy doc canonical location (accessible to all agents):
```
s3://sasmaster-2026/strategy/canonical/v3_final.md
```

Agents that need strategy context read from S3 rather than local filesystem — ensures consistency across machines and cron-spawned processes.

---

## 8. Competitive Positioning

### vs. Gracenote/TMS
Gracenote has the deepest program guide data but no audience intelligence, no rights layer, no AI. SaSMaster wraps Gracenote data (delta enrichment) with intelligence layers Gracenote can't provide.

### vs. Nielsen ONE
Nielsen owns the measurement currency but their UI is internal-facing, not designed for external distribution, and priced for enterprise-only. SaSMaster democratizes Nielsen data within a licensed framework.

### vs. Parrot Analytics
Parrot has demand analytics but not operational data (rights, deals, schedules). They're a research tool, not a workflow tool. SaSMaster is both.

### vs. Canvs AI / audience sentiment tools
Narrow scope — social sentiment only. SaSMaster's Dr. Scoop delivers broader intelligence: audience, rights, competitive context, financial performance.

### Our Wedge
**The Parent Key.** No competitor has a unified content identifier that spans IMDB + TMDB + EIDR. Our bridge puts SaSMaster at the center of a data graph that others can't replicate without years of matching work.

---

## 9. Roadmap

### Now (2026-Q2)
- [LIVE] IMDB 206.4M rows in S3
- [LIVE] TMDB 1.18M titles complete
- [LIVE] Dr. Scoop AI companion
- [LIVE] Portal v9 — 12 sections, 20 verified TMDB IDs
- [LIVE] War Room v5 — all actions live
- [LIVE] QA pipeline — 15-check Puppeteer suite
- [LIVE] 10-agent fleet with full cron coverage
- [IN PROGRESS] EIDR enrichment (654K IDs staged)
- [IN PROGRESS] TMDB People (1.7M records in flight)

### Next (2026-Q3)
- Nielsen direct license → audience data layer live
- Gracenote delta → program guide completion
- EIDR Query API → 85%+ Parent Key match rate
- The Exchange portal → rights marketplace MVP
- Financial Intelligence dashboard → 54-company tracker promoted to portal
- Portal v10 → The Exchange wired + Nielsen overlay on Program Drill-Down

### Later (2026-Q4)
- Multi-user access (analyst seat licenses)
- API access tier (for enterprise clients)
- Deal flow module → rights transaction tracking
- Mobile companion app → Dr. Scoop on the go

---

## 10. North Star Metric

**Parent Key coverage at 95%+ across IMDB × TMDB × EIDR.**

When we reach 95% match coverage, SaSMaster has the most comprehensive media content identity graph in existence — outside of the studios themselves. That is the moat. That is the product. Everything else — the portals, the agents, the visualizations — is surface area for that data graph.

Every build decision, every data acquisition, every product choice should be evaluated against one question: does this get us closer to 95%?

---

*SaSMaster Strategy v3 Final — 2026-04-28*  
*Shiv Sehgal / Claude Code*  
*Canonical path: `~/SaSMaster/outputs/SaSMaster_Strategy_v3_Final.md`*  
*S3 mirror: `s3://sasmaster-2026/strategy/canonical/v3_final.md`*
