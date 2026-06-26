#!/usr/bin/env node
/**
 * generate-status.js — writes status.json for sasmaster-status v3
 * All data sourced from real files — no mocks.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SASMASTER   = path.join(process.env.HOME, 'SaSMaster');
const PENDING     = path.join(SASMASTER, 'pending-approvals.json');
const TASKS_FILE  = path.join(SASMASTER, 'TASKS.md');
const DONE_FILE   = path.join(SASMASTER, 'DONE_LOG.md');
const OUT         = path.join(__dirname, 'status.json');

// ── JARVIS ───────────────────────────────────────────────────────────────────
// Socket Mode daemon is dead (JARVIS-ARCH-001). JARVIS is alive when Railway
// HTTP Events API responds to /health.
function jarvisAlive() {
  try {
    const out = execSync(
      'curl -sf --max-time 4 https://api.sasmaster.dev/health',
      { encoding: 'utf8' }
    );
    return out.includes('"status"') && out.includes('"ok"');
  } catch { return false; }
}

// ── TASKS.md parser (v2) ──────────────────────────────────────────────────────
// Supports: - [HIGH|MED|EXPLORE] [WIP|BLOCK:reason|REVIEW] [TAG] text {meta} ^id
// Backward compatible: lines without state/id still parse as BACKLOG with auto-tag.

const STATE_RE = /\[(WIP|BLOCK:([^\]]*)|REVIEW)\]/i;
const ID_RE    = /\^([a-f0-9]{6})\s*$/;
const META_RE  = /\{([^}]+)\}/;

function detectTag(text) {
  if (/edgar|financial|s3|postgresql|scraper|financial.anal/i.test(text)) return 'EDGAR';
  if (/tmdb|imdb|trending|content.*load/i.test(text)) return 'DATA';
  if (/agent|cron|jarvis|slack|webhook|build\.sh/i.test(text)) return 'AGENT';
  if (/ui|portal|nav|design|html|css|homepage|archive|sasmaster\.html/i.test(text)) return 'UI';
  if (/qa|test|check|puppeteer/i.test(text)) return 'QA';
  return 'INFRA';
}

function parseTasks() {
  if (!fs.existsSync(TASKS_FILE)) return { high: 0, med: 0, highItems: [], medItems: [], exploreItems: [], wipItems: [], blockedItems: [], reviewItems: [] };
  const lines = fs.readFileSync(TASKS_FILE, 'utf8').split('\n');

  let sprint = 'Backlog';
  const highItems = [], medItems = [], exploreItems = [];
  const wipItems = [], blockedItems = [], reviewItems = [];

  lines.forEach((line, idx) => {
    // Sprint headers (skip DRAFT headers — those go to parseQADrafts)
    if (/^##/.test(line) && !/^##\s*\[DRAFT\]/.test(line)) {
      sprint = line.replace(/^#+\s*/, '').trim();
      return;
    }

    const pm = line.match(/^\s*-\s*\[(HIGH|MED|EXPLORE)\]/i);
    if (!pm) return;

    const priority = pm[1].toUpperCase();
    let rest = line.slice(line.indexOf(`[${pm[1]}]`) + pm[1].length + 2).trim();

    // Skip historical DONE lines
    if (/^\[DONE/i.test(rest)) return;

    // State tag
    let state = 'BACKLOG', blockReason = '';
    const sm = rest.match(STATE_RE);
    if (sm) {
      const sr = sm[1].toUpperCase();
      if (sr === 'WIP')               state = 'WIP';
      else if (sr.startsWith('BLOCK')){ state = 'BLOCKED'; blockReason = sm[2] || ''; }
      else if (sr === 'REVIEW')        state = 'REVIEW';
      rest = rest.replace(STATE_RE, '').trim();
    }

    // Explicit tag override [DATA|AGENT|UI|INFRA|EDGAR|QA]
    let tag = '';
    const tgm = rest.match(/^\[([A-Z]+)\]/);
    if (tgm && ['DATA','AGENT','UI','INFRA','EDGAR','QA'].includes(tgm[1])) {
      tag = tgm[1];
      rest = rest.slice(tgm[0].length).trim();
    }

    // Inline metadata {key:val}
    const meta = {};
    const mm = rest.match(META_RE);
    if (mm) {
      mm[1].split(',').forEach(pair => {
        const [k, v] = pair.split(':').map(s => s.trim());
        if (k && v) meta[k] = v;
      });
      rest = rest.replace(META_RE, '').trim();
    }

    // ^id
    let id = `t${idx}`;
    const im = rest.match(ID_RE);
    if (im) { id = im[1]; rest = rest.replace(ID_RE, '').trim(); }

    const full = rest.replace(/—\s*injected.*$/i, '').trim();
    if (!full) return;
    const text = full.length > 120 ? full.slice(0, 120) + '…' : full;
    if (!tag) tag = detectTag(full);

    const item = { id, lineIndex: idx, text, full, sprint, tag, priority, state, blockReason, meta };

    // Route by state first, then priority for BACKLOG
    if      (state === 'WIP')     wipItems.push(item);
    else if (state === 'BLOCKED') blockedItems.push(item);
    else if (state === 'REVIEW')  reviewItems.push(item);
    else if (priority === 'HIGH') highItems.push(item);
    else if (priority === 'MED')  medItems.push(item);
    else                          exploreItems.push(item);
  });

  return {
    high: highItems.length, med: medItems.length,
    highItems, medItems, exploreItems,   // no caps — return all
    wipItems, blockedItems, reviewItems,
  };
}

// ── QA draft tasks ────────────────────────────────────────────────────────────
function parseQADrafts() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  const content = fs.readFileSync(TASKS_FILE, 'utf8');
  const drafts  = [];
  const blocks  = content.split(/\n(?=## \[DRAFT\])/);
  blocks.forEach(block => {
    if (!/^## \[DRAFT\]/i.test(block)) return;
    const header   = (block.match(/^## \[DRAFT\]\s*(.+)/) || [])[1] || 'QA Draft';
    const checkId  = (header.match(/·\s*([\w-]+)\s*·/) || [])[1] || '';
    const buildId  = (header.match(/build:([\w-]+)/) || [])[1] || '';
    const desc     = (block.match(/- description:\s*(.+)/) || [])[1] || '';
    const fixDesc  = (block.match(/- fix_description:\s*(.+)/) || [])[1] || '';
    drafts.push({ id: `qa-${checkId}`, checkId, buildId, text: desc || header, fixDesc, tag: 'QA', state: 'REVIEW', priority: 'HIGH', sprint: 'QA Drafts' });
  });
  return drafts;
}

// ── Memory pending + phase strip ──────────────────────────────────────────────
function parseMemoryContext() {
  const memFile = path.join(SASMASTER, 'CLAUDE_MEMORY.md');
  if (!fs.existsSync(memFile)) return { phaseStatus: {}, pending: [] };
  const content = fs.readFileSync(memFile, 'utf8');

  // Phase status lines: phase_1: LIVE — description
  const phaseStatus = {};
  content.split('\n').forEach(line => {
    const m = line.match(/^(phase_\w+):\s*(\S+)\s*(?:—\s*(.*))?/);
    if (m) phaseStatus[m[1]] = { status: m[2], desc: (m[3] || '').trim() };
  });

  // Pending block (lines starting with "- " after a "# Pending" header)
  const pendingMatch = content.match(/# Pending\n([\s\S]*?)(?:\n#|$)/);
  const pending = pendingMatch
    ? pendingMatch[1].split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean)
    : [];

  return { phaseStatus, pending };
}

// ── DONE_LOG.md ──────────────────────────────────────────────────────────────
function parseDoneLog() {
  if (!fs.existsSync(DONE_FILE)) return { entries: [], heatmap: {} };
  const content = fs.readFileSync(DONE_FILE, 'utf8');
  const blocks  = content.split('---').map(b => b.trim()).filter(Boolean);

  const heatmap = {};
  const entries = blocks.reverse().slice(0, 10).map(block => {
    const date  = (block.match(/Date:\s*(.+)/) || [])[1]?.trim() || '';
    const task  = (block.match(/Task:\s*(.+)/) || [])[1]?.trim() || '';
    const notes = (block.match(/Notes:\s*([\s\S]+?)(?:\n[A-Z]|$)/) || [])[1]?.trim().slice(0, 120) || '';

    // Count builds per date for heatmap
    if (date) {
      const key = date.slice(0, 10);
      heatmap[key] = (heatmap[key] || 0) + 1;
    }
    return { task, date, notes, status: 'DONE' };
  }).filter(e => e.task);

  // Also count from all blocks for heatmap depth
  blocks.forEach(block => {
    const date = (block.match(/Date:\s*(.+)/) || [])[1]?.trim() || '';
    if (date) {
      const key = date.slice(0, 10);
      heatmap[key] = (heatmap[key] || 0) + 1;
    }
  });

  return { entries, heatmap };
}

// ── Pending approvals → Review column ───────────────────────────────────────
function parsePending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING, 'utf8')).map((p, i) => ({
      id: `review-${i}`,
      text: (p.description || p.type || 'Pending item').slice(0, 88),
      full: p.description || p.type || 'Pending item',
      sprint: 'Review',
      tag: 'PENDING',
      priority: 'REVIEW',
      approvalId: p.id,
    }));
  } catch { return []; }
}

// ── Agent fleet ──────────────────────────────────────────────────────────────
// `jobId` maps to Command API /trigger VALID_JOBS — null means no Run button.
// `channel` is the primary Slack destination — used by UI without a hardcoded map.
function parseAgents() {
  const LOG = path.join(SASMASTER, 'logs');
  const agents = [
    { name: 'JARVIS',            icon: '🤖', schedule: 'HTTP API',      nextRun: 'Always on',       log: 'jarvis.log',            channel: 'HTTP Events API',    jobId: null, descOverride: 'HTTP Events API (Railway) — Socket Mode daemon retired' },
    { name: 'Media Intel',       icon: '📡', schedule: '6AM daily',     nextRun: 'Tomorrow 6AM',    log: 'media-intel.log',       channel: '#sasmaster-intel',   jobId: 'media-intel' },
    { name: 'TMDB Daily',        icon: '📺', schedule: '5AM daily',     nextRun: 'Tomorrow 5AM',    log: 'tmdb-agent.log',        channel: '#sasmaster-intel',   jobId: 'tmdb-daily' },
    { name: 'DoneLog Analyst',   icon: '📊', schedule: 'Post-build',    nextRun: 'Post 12AM build', log: 'donelog-analyst.log',   channel: '#sasmaster-builds',  jobId: null },
    { name: 'LinkedIn Agent',    icon: '✍️',  schedule: 'Monday 8PM',   nextRun: 'Mon 8PM',         log: 'linkedin-agent.log',    channel: '#sasmaster-content', jobId: 'linkedin-agent' },
    { name: 'SEC EDGAR',         icon: '📑', schedule: '6:30 AM daily', nextRun: 'Tomorrow 6:30 AM',log: 'sec-edgar.log',         channel: '#sasmaster-intel',   jobId: null },
    { name: 'Tech Intel',        icon: '🛰️', schedule: 'Friday 6PM',   nextRun: 'Fri 6PM',         log: 'tech-intel.log',        channel: '#sasmaster-intel',   jobId: 'tech-intel' },
    { name: 'Financial Analyst', icon: '💰', schedule: 'Sunday 8PM',   nextRun: 'Sun 8PM',         log: 'financial-analyst.log', channel: '#sasmaster-intel',   jobId: null },
    { name: 'Weekly Review',     icon: '🗂️', schedule: 'Sunday 8PM',   nextRun: 'Sun 8PM',         log: 'weekly-review.log',     channel: '#sasmaster-content', jobId: 'weekly-review' },
    { name: 'IAB Intel',         icon: '📡', schedule: 'Monday 7AM',   nextRun: 'Mon 7AM',         log: 'iab-agent.log',         channel: '#sasmaster-intel',   jobId: 'iab-intel' },
    { name: 'Security Watchdog', icon: '🔐', schedule: 'Daily 5:30AM', nextRun: 'Tomorrow 5:30AM', log: 'security-watchdog.log', channel: '#sasmaster-builds',  jobId: null },
    { name: 'Railway Monitor',   icon: '🛤️', schedule: 'Every 15min',  nextRun: 'In ≤15min',       log: 'railway-monitor.log',   channel: '#sasmaster-builds',  jobId: null },
    { name: 'Research Portal',   icon: '🔬', schedule: 'TBD',          nextRun: 'Pending launch',  log: 'research-portal-agent.log', channel: '#sasmaster-intel', jobId: null, descOverride: 'SCAFFOLDED — pending RESEARCH-PORTAL-001 launch' },
    { name: 'Data Guardian',     icon: '🛡️', schedule: 'Post-ingestion', nextRun: 'After next pull', log: 'data-guardian.log',         channel: '#sasmaster-builds',  jobId: null, descOverride: 'Post-ingestion integrity enforcer — snapshot → AMRLD anomaly detection (RULE-HH-01..04) → Tier 2 gate. Wired into nielsen_puller.py via _run_data_guardian().' },

    // ── Drafted (on-demand, no cron yet) ────────────────────
    { name: 'Gracenote OnConnect', icon: '🎬', schedule: 'on-demand (JARVIS)', nextRun: '—', log: 'gn-onconnect.log', channel: '#sasmaster-builds', jobId: null, type: 'drafted', statusOverride: 'drafted', descOverride: 'Resolve+fuse drafted · self-tests green · spine-promotion GATED (tier UNCONFIRMED)' },

    // ── SaSMaster Claude Code sub-agents ────────────────────
    { name: 'Autonomous Coder',     icon: '⚡', schedule: 'On-demand',     nextRun: 'Contextual',   log: null, channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Primary build executor. Phase I pipeline. cost-log writer (13-field schema). Reads build-discipline before every task. Model: Sonnet 4.6.' },
    { name: 'Data Modeler',         icon: '📐', schedule: 'On-demand',     nextRun: 'Contextual',   log: null, channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Schema design, S3 paths, DuckDB query patterns, Parent Key v1. Consults before any dataset onboarding or schema change. Model: Opus 4.7.' },
    { name: 'Viz Evaluator',        icon: '📊', schedule: 'Quarterly',     nextRun: '1 Aug 9AM',    log: null, channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Benchmarks all 14 chart renderers vs npm ecosystem. Proposes swaps via Slack. cron 0 9 1 */3 *. Never auto-swaps without approval.' },
    { name: 'Nielsen Orchestrator', icon: '📡', schedule: 'Tue 5PM',       nextRun: 'Next Tue 5PM', log: null, channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Staleness check → scope decision → triggers nielsen_puller.py → validates row counts → JARVIS summary. launchd Tue 5PM.' },
    { name: 'Mac Worker',           icon: '💻', schedule: '5min heartbeat',nextRun: 'In ≤5min',     log: 'mac-worker.log', channel: '#sasmaster-builds', jobId: null, type: 'subagent', descOverride: 'Mac 64GB compute worker. Polls Railway /tasks/pending-compute. Capabilities: duckdb / scraper / claude-code / ml.' },

    // ── Marketplace T1 — python-development ─────────────────
    { name: 'python-pro',           icon: '🐍', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'python-development',    descOverride: 'Master Python 3.12+ — async, performance optimization, uv/ruff/pydantic/FastAPI. T1 marketplace.' },
    { name: 'django-pro',           icon: '🌿', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'python-development',    descOverride: 'Django 5.x async views, DRF, Celery, Channels. Scalable web apps + ORM optimization. T1 marketplace.' },
    { name: 'fastapi-pro',          icon: '⚡', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'python-development',    descOverride: 'FastAPI with SQLAlchemy 2.0 and Pydantic V2. High-performance async APIs + microservices. T1 marketplace.' },

    // ── Marketplace T1 — llm-application-dev ────────────────
    { name: 'ai-engineer',          icon: '🤖', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'llm-application-dev',   descOverride: 'LLM applications, advanced RAG, intelligent agents. Vector search, multimodal AI, agent orchestration. T1 marketplace.' },
    { name: 'prompt-engineer',      icon: '💬', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'llm-application-dev',   descOverride: 'Advanced prompting, chain-of-thought, constitutional AI, production prompt strategies. T1 marketplace.' },
    { name: 'vector-db-engineer',   icon: '🔢', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'llm-application-dev',   descOverride: 'Pinecone, Weaviate, Qdrant, Milvus, pgvector. RAG apps + semantic search. T1 marketplace.' },

    // ── Marketplace T1 — observability-monitoring ────────────
    { name: 'observability-engineer', icon: '📈', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Monitoring, logging, tracing, SLI/SLO management, incident response workflows. T1 marketplace.' },
    { name: 'performance-engineer', icon: '🏎️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Profile and optimize response times, memory usage, query efficiency, scalability. T1 marketplace.' },
    { name: 'network-engineer',     icon: '🌐', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Cloud networking, CDN optimization, service mesh, zero-trust, SSL/TLS. T1 marketplace.' },
    { name: 'database-optimizer',   icon: '🗄️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'observability-monitoring', descOverride: 'Query optimization, N+1 resolution, multi-tier caching, partitioning, cloud DB. T1 marketplace.' },

    // ── Marketplace T1 — security-scanning ──────────────────
    { name: 'security-auditor',     icon: '🔐', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'security-scanning',       descOverride: 'OWASP Top 10, auth flaws, compliance, code security review. T1 marketplace.' },
    { name: 'threat-modeling',      icon: '🎯', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'security-scanning',       descOverride: 'STRIDE, PASTA, attack trees, security requirement extraction. Secure-by-design systems. T1 marketplace.' },

    // ── Marketplace T1 — agent-teams + conductor ─────────────
    { name: 'conductor-validator',  icon: '🎼', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Validates Conductor project artifacts for completeness, consistency, and correctness. T1 marketplace.' },
    { name: 'team-lead',            icon: '👥', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Team orchestrator that decomposes work into parallel tasks with file ownership boundaries. T1 marketplace.' },
    { name: 'team-implementer',     icon: '🔨', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Parallel feature builder within strict file ownership boundaries + integration coordination. T1 marketplace.' },
    { name: 'team-reviewer',        icon: '🔍', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Multi-dimensional code reviewer: security, performance, architecture, testing, accessibility. T1 marketplace.' },
    { name: 'team-debugger',        icon: '🐛', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T1', plugin: 'agent-teams',            descOverride: 'Hypothesis-driven debugging investigator. Evidence gathering with file:line citations. T1 marketplace.' },

    // ── Marketplace T2 — backend-development ─────────────────
    { name: 'backend-architect',    icon: '🏗️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'REST/GraphQL/gRPC APIs, event-driven architectures, service mesh, microservices patterns. T2 marketplace.' },
    { name: 'event-sourcing',       icon: '📦', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'Event sourcing, CQRS, event store design, projection building, saga orchestration. T2 marketplace.' },
    { name: 'graphql-architect',    icon: '🔷', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'GraphQL federation, performance optimization, advanced caching, real-time systems. T2 marketplace.' },
    { name: 'temporal-python-pro',  icon: '⏱️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'backend-development',    descOverride: 'Temporal workflow orchestration, durable workflows, saga patterns, distributed transactions. T2 marketplace.' },

    // ── Marketplace T2 — cicd-automation ─────────────────────
    { name: 'cloud-architect',      icon: '☁️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'AWS/Azure/GCP/OCI multi-cloud, Terraform/CDK, FinOps cost optimization, serverless. T2 marketplace.' },
    { name: 'deployment-engineer',  icon: '🚀', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'CI/CD pipelines, GitOps, GitHub Actions, ArgoCD/Flux, zero-downtime deployments. T2 marketplace.' },
    { name: 'devops-troubleshooter', icon: '🔧',schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'Incident response, log analysis, distributed tracing, Kubernetes debugging. T2 marketplace.' },
    { name: 'kubernetes-architect', icon: '⎈',  schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'EKS/AKS/GKE/OKE, Istio/Linkerd, progressive delivery, multi-tenancy, platform engineering. T2 marketplace.' },
    { name: 'terraform-specialist', icon: '🏔️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'cicd-automation',        descOverride: 'IaC automation, state management, multi-cloud deployments, GitOps for infrastructure. T2 marketplace.' },

    // ── Marketplace T2 — javascript-typescript ───────────────
    { name: 'typescript-pro',       icon: '🔵', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'javascript-typescript',   descOverride: 'Advanced TypeScript, generics, strict type safety, decorators, enterprise patterns. T2 marketplace.' },
    { name: 'javascript-pro',       icon: '🟡', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'javascript-typescript',   descOverride: 'ES6+, async patterns, Node.js APIs, promises, event loops, browser/Node compat. T2 marketplace.' },

    // ── Marketplace T2 — machine-learning-ops ────────────────
    { name: 'data-scientist',       icon: '📊', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'machine-learning-ops',    descOverride: 'Advanced analytics, ML modeling, statistical analysis, data-driven insights. T2 marketplace.' },
    { name: 'ml-engineer',          icon: '🧠', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'machine-learning-ops',    descOverride: 'PyTorch 2.x, TensorFlow, model serving, feature engineering, A/B testing. T2 marketplace.' },
    { name: 'mlops-engineer',       icon: '⚙️', schedule: 'On-demand', nextRun: 'Contextual', log: null, channel: null, jobId: null, type: 'marketplace', tier: 'T2', plugin: 'machine-learning-ops',    descOverride: 'MLflow, Kubeflow, automated training pipelines, model registries, ML monitoring. T2 marketplace.' },
  ];

  return agents.map(a => {
    if (a.statusOverride) return { ...a, lastRun: null, lastOutput: a.descOverride || null, status: a.statusOverride };
    if (!a.log) return { ...a, lastRun: null, lastOutput: a.descOverride || null, status: 'idle' };
    const logFile = path.join(LOG, a.log);
    if (!fs.existsSync(logFile)) return { ...a, lastRun: null, lastOutput: a.descOverride || null, status: 'never' };

    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const last  = lines[lines.length - 1] || '';

    const tsMatch = last.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const lastRun = tsMatch ? tsMatch[1] : null;

    const summary = a.descOverride || last.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/, '')
                        .replace(/^\[[A-Z0-9_-]+\]\s*/i, '')
                        .slice(0, 80);

    const routingErr = /not_in_channel/i.test(last);
    const hardError  = !routingErr && /error|fatal/i.test(last);
    const status     = hardError ? 'error' : routingErr ? 'routing' : 'healthy';

    return { ...a, lastRun, lastOutput: summary, status };
  });
}

// ── Intel feed ───────────────────────────────────────────────────────────────
function parseIntelFeed() {
  const file = path.join(SASMASTER, 'status', 'intel-feed.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).filter(i => i.text);
  } catch { return []; }
}

// ── Target 10 ────────────────────────────────────────────────────────────────
function parseTarget10() {
  const file = path.join(SASMASTER, 'target10.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).filter(t => t.name);
  } catch { return []; }
}

// ── TMDB bulk loader progress ────────────────────────────────────────────────
function parseTMDBProgress() {
  const file = path.join(SASMASTER, 'status', 'tmdb-progress.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── S3 inventory (from scripts/s3-inventory.js cache) ────────────────────────
function parseS3Inventory() {
  const file = path.join(SASMASTER, 'status', 's3-inventory.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function parseWarroomDataS3Total() {
  // Single source of truth: artifact_metrics_latest.json (.s3), written nightly
  // by artifact_metrics_pull.py with a last-good guard, so it never regresses to
  // null on a failed scan. (Replaces the retired data/warroom-data.json, which
  // was a second competing pipeline — see WARROOM-DATA-CONSOLIDATE-001.)
  try {
    const file = path.join(__dirname, 'resources', 'artifact_metrics_latest.json');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Prefer the authoritative WHOLE-BUCKET total (measured by --full-scan, 6.5M
    // objects = 2.77 TB) over the curated-prefix sum, which undercounts because
    // it only covers the 20 dataset prefixes (not knowledge-bank/artifacts/etc.).
    if (d?.s3_bucket_total_gb > 0) return Math.round(d.s3_bucket_total_gb * 10) / 10;
    const s3 = d?.s3 || {};
    const total = Object.values(s3).reduce((sum, v) => sum + (v?.gb || 0), 0);
    return total > 0 ? Math.round(total * 10) / 10 : null;
  } catch { return null; }
}

// ── S3 entity counts — compute-on-write, read-only ───────────────────────────
// Primary: read warroom/counts.json from S3 (written by each job + nightly recompute)
// Fallback: local status/s3-entity-counts.json (written by build_data_counts.py)
function parseS3EntityCounts() {
  // Try S3 primary first
  try {
    const raw = safeExec('/opt/homebrew/bin/aws s3 cp s3://sasmaster-2026/warroom/counts.json - 2>/dev/null');
    if (raw) return JSON.parse(raw);
  } catch {}
  // Local fallback
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SASMASTER, 'status', 's3-entity-counts.json'), 'utf8'));
    return raw.prefixes || raw;
  } catch { return {}; }
}

// Staleness thresholds per prefix (hours). Missing prefix = no staleness check.
const STALE_HOURS = {
  'parent_keys/': 72,    // match jobs run on-demand; flag after 3 days of silence
  'tmdb_dev/':    360,   // biweekly delta = 15 days
  'imdb/':        840,   // monthly re-pull = 35 days
  'gracenote/':   720,   // 30 days
  'fyi/':         720,   // 30 days
  'nielsen/':     192,   // Tuesday 5PM puller = 8 days
};

function countBlockStale(prefix, computedAt) {
  const threshold = STALE_HOURS[prefix];
  if (!threshold || !computedAt) return false;
  const ageHours = (Date.now() - new Date(computedAt).getTime()) / 3_600_000;
  return ageHours > threshold;
}

// ── IMDB agent status (from scripts/imdb-agent.js post-run) ──────────────────
function parseImdbStatus() {
  const file = path.join(SASMASTER, 'status', 'imdb-status.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── EIDR v2 coverage (from eidr-progress.json) ───────────────────────────────
function parseEidrProgress() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(SASMASTER, 'status', 'eidr-progress.json'), 'utf8'));
    if (p.phase !== 'complete') return null;
    return {
      total:        parseInt(p.total,        10) || null,
      eidr_matched: parseInt(p.eidr_matched, 10) || null,
      eidr_pct:     parseFloat(p.eidr_pct)       || null,
      out_date:     p.out_date || null,
      source:       p.source   || null,
    };
  } catch { return null; }
}

// ── S3 Freshness (age in hours per key prefix) ───────────────────────────────
// ONE-SOURCE-001: this function is the SINGLE authority for S3 prefix freshness.
// The DATA tab stale badge, the War Room KPI freshness chip, and the health score
// freshness component ALL read from s3_lake[].fresh (computed here).
// No other freshness logic for S3 prefixes exists in this file.
// Authority source: aws s3 ls --recursive per prefix, most-recent object timestamp.
function getS3Freshness(prefixes = []) {
  const result = {};
  for (const prefix of prefixes) {
    try {
      const out = execSync(
        `/opt/homebrew/bin/aws s3 ls s3://sasmaster-2026/${prefix} --recursive | sort | tail -1`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 }
      );
      const match = out.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (!match) { result[prefix] = { age_hours: null, fresh: false }; continue; }
      const lastMod = new Date(match[1] + ' UTC');
      const ageHours = Math.round(((Date.now() - lastMod.getTime()) / 3600000) * 10) / 10;
      result[prefix] = { age_hours: ageHours, fresh: ageHours < 24 };
    } catch {
      result[prefix] = { age_hours: null, fresh: false };
    }
  }
  return result;
}

// ── Log mtime helper for per-scraper health ──────────────────────────────────
function logMtime(logName) {
  const p = path.join(SASMASTER, 'logs', logName);
  try { return fs.statSync(p).mtime.toISOString(); }
  catch { return null; }
}

// ── Alerts ───────────────────────────────────────────────────────────────────
function parseAlerts() {
  const file = path.join(SASMASTER, 'status', 'alerts.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

// ── Crontab parser (SaSMaster jobs only) ─────────────────────────────────────
function parseCrontab() {
  let lines;
  try { lines = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }).split('\n'); }
  catch { return []; }

  const jobs = [];
  lines.forEach(line => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    if (!/sasmaster|SaSMaster/i.test(line)) return;

    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)(?:\s*#\s*(.+))?$/);
    if (!m) return;
    const [, min, hr, dom, mon, dow, cmd, comment] = m;

    const h = parseInt(hr, 10);
    const m2 = parseInt(min, 10);
    let timeStr;
    if (isNaN(h) || isNaN(m2)) timeStr = `${hr}:${min}`;
    else {
      const ampm = h < 12 ? 'AM' : 'PM';
      const hh = h % 12 === 0 ? 12 : h % 12;
      timeStr = `${hh}:${String(m2).padStart(2, '0')} ${ampm}`;
    }

    const scriptMatch = cmd.match(/([a-z0-9\-]+\.(sh|js))\b/i);
    const name = comment || (scriptMatch ? scriptMatch[1] : cmd.slice(0, 40));

    let channel = '—';
    if (/intel|edgar|media-intel|tech-intel/i.test(cmd)) channel = '#sasmaster-intel';
    else if (/linkedin|content|tmdb-trending/i.test(cmd)) channel = '#sasmaster-content';
    else if (/build|jarvis|briefing|visuals/i.test(cmd)) channel = '#sasmaster-builds';

    // Weekly/monthly: any non-'*' in dow/dom/mon means this isn't a daily job
    const isWeekly = (dow !== '*' && dow !== '') || (dom !== '*' && dom !== '') || (mon !== '*' && mon !== '');

    // Today's scheduled Date for done/pending comparison
    const scheduledToday = (!isNaN(h) && !isNaN(m2)) ? (() => {
      const d = new Date(); d.setHours(h, m2, 0, 0); return d.getTime();
    })() : null;

    jobs.push({
      time: timeStr,
      name: name.replace(/^SaSMaster-/, '').replace(/-/g, ' '),
      command: cmd,
      channel,
      weekly: isWeekly,
      status: 'pending', // enriched later
      _sortKey: (isNaN(h) ? 0 : h) * 60 + (isNaN(m2) ? 0 : m2),
      _scheduledToday: scheduledToday,
    });
  });

  return jobs.sort((a, b) => a._sortKey - b._sortKey).map(({ _sortKey, ...rest }) => rest);
}

// ── Scrapers inventory (15-scraper fleet from architecture v8) ───────────────
// Real status hydrated from (a) S3 inventory object counts, (b) agent log
// mtimes, (c) progress JSON. Designed = no data + no script exists. Landing =
// S3 has data but pipeline not fully automated. Live = automated + running.
function buildScrapers(tmdbProgress, doneEntries, s3Inv, agents, imdbStatus) {
  const prefix = name => (s3Inv?.prefixes || []).find(p => p.prefix === name) || {};
  const agentByName = {};
  (agents || []).forEach(a => { agentByName[a.name] = a; });
  const eidrProgress = parseEidrProgress();

  const tmdbP   = prefix('tmdb_dev/');
  const imdbP   = prefix('imdb/');
  const imdbPrd = prefix('imdb_prd/');
  const pkP     = prefix('parent_keys/');
  const nielsenP = prefix('nielsen/');
  const nielsenMITP  = prefix('nielsen/mit/');
  const nielsenAMRLD = prefix('nielsen/amrld/');
  const eidrP   = prefix('eidr/');
  const gracP   = prefix('gracenote/');
  const fyiP    = prefix('fyi/');

  const edgarAgent = agentByName['SEC EDGAR'];

  return [
    // ── Phase 1 — Identity base
    {
      name: 'TMDB bulk loader',
      phase: '1',
      status: tmdbProgress?.running ? 'running' : (tmdbProgress?.phase === 'complete' ? 'live' : 'running'),
      pct: tmdbProgress?.pct ?? null,
      row_count: tmdbProgress?.complete ?? null,
      total: tmdbProgress?.total ?? null,
      last_run: tmdbProgress?.last_updated ?? tmdbP.last_modified ?? null,
      s3_path: tmdbProgress?.s3_path ?? 's3://sasmaster-2026/tmdb_dev/',
    },
    { name: 'TMDB delta (biweekly)', phase: '1', status: 'queued', pct: 0, last_run: null,
      note: 'cron: 1st + 16th of month; fetches /movie|tv|person/changes since last run' },
    // TMDB expanded ingest — one scraper per entity loader
    { name: 'TMDB Configuration',    phase: '1', status: prefix('tmdb_dev/configuration/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/configuration/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/configuration/' },
    { name: 'TMDB Collections',      phase: '1', status: prefix('tmdb_dev/collections/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/collections/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/collections/' },
    { name: 'TMDB Networks',         phase: '1', status: prefix('tmdb_dev/networks/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/networks/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/networks/' },
    { name: 'TMDB Companies',        phase: '1', status: prefix('tmdb_dev/companies/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/companies/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/companies/' },
    { name: 'TMDB TV Seasons',       phase: '1', status: prefix('tmdb_dev/tv_seasons/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/tv_seasons/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/tv_seasons/' },
    { name: 'TMDB TV Episodes',      phase: '1', status: prefix('tmdb_dev/tv_episodes/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/tv_episodes/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/tv_episodes/',
      note: 'derived from tv_seasons + IMDB title_episode cross-ref (zero API calls)' },
    { name: 'TMDB Movie Enrichment', phase: '1', status: prefix('tmdb_dev/movies_enrichment/').object_count > 0 ? 'live' : 'queued',
      pct: null, last_run: prefix('tmdb_dev/movies_enrichment/').last_modified || null,
      s3_path: 's3://sasmaster-2026/tmdb_dev/movies_enrichment/',
      note: 'sidecar adding watch_providers+videos+reviews+images to 1.18M pre-v2 movies' },
    {
      name: 'IMDb parser',
      phase: '1',
      status: imdbP.object_count > 0 ? 'live' : 'designed',
      pct: imdbP.object_count > 0 ? 100 : 0,
      row_count: imdbStatus?.counts
        ? (imdbStatus.counts.movies || 0) + (imdbStatus.counts.tv_series || 0) +
          (imdbStatus.counts.episodes || 0) + (imdbStatus.counts.people || 0)
        : 206444399,
      partition: imdbStatus?.partition || null,
      last_run: imdbStatus?.last_run || imdbP.last_modified || logMtime('imdb-parse.log'),
    },
    {
      name: 'SAS-MASTER Parent Key v1',
      phase: '1',
      status: pkP.object_count > 0 ? 'live' : 'designed',
      pct: 100,
      row_count: 861878,      // total parquet rows (589,814 matched + 272,064 synthetic)
      matched_count: 589814,  // IMDB-matched subset (68.4% match rate)
      last_run: pkP.last_modified || '2026-04-22T03:04:00Z',
    },
    {
      name: 'SEC EDGAR',
      phase: '1',
      status: edgarAgent?.status === 'routing' ? 'running' : (edgarAgent?.lastRun ? 'live' : 'designed'),
      pct: edgarAgent?.lastRun ? 100 : null,
      last_run: edgarAgent?.lastRun || logMtime('sec-edgar.log'),
    },
    // ── Phase 1b — Metadata enrichment
    {
      name: 'EIDR scraper',
      phase: '1b',
      status: eidrProgress ? 'live' : (eidrP.object_count > 0 ? 'landing' : 'designed'),
      pct: eidrProgress ? eidrProgress.eidr_pct : null,
      last_run: eidrProgress ? eidrProgress.out_date : (eidrP.last_modified || null),
      row_count: eidrProgress ? eidrProgress.eidr_matched : null,
      note: eidrProgress
        ? `v2 parent_keys: ${eidrProgress.eidr_matched?.toLocaleString()} EIDR IDs matched (${eidrProgress.eidr_pct}% of ${eidrProgress.total?.toLocaleString()} titles) — source: ${eidrProgress.source}`
        : 'Auth pending (code 4) — full backfill blocked',
    },
    { name: 'Rights scraper', phase: '1b', status: 'designed', pct: 0, last_run: null },
    // ── Phase 2a — Interim snapshots via RSG API bridge
    {
      name: 'Nielsen MIT (15 tables)',
      phase: '2a',
      status: nielsenMITP.object_count > 0 ? 'live' : 'queued',
      pct: nielsenMITP.object_count > 0 ? 100 : 0,
      last_run: nielsenMITP.last_modified || null,
      note: 'Auth0 M2M · Tue prior-week pull · 50K-row/table limit',
    },
    {
      name: 'Nielsen AMRLD (36 rec types)',
      phase: '2a',
      status: nielsenAMRLD.object_count > 0 ? 'live' : 'queued',
      pct: nielsenAMRLD.object_count > 0 ? 100 : 0,
      last_run: nielsenAMRLD.last_modified || null,
      note: 'T1×10 T2×5 T3×12(bridge-pending) NEW×9 · Tue full pull',
    },
    {
      name: 'Gracenote snapshot',
      phase: '2a',
      status: gracP.object_count > 0 ? 'landing' : 'queued',
      pct: 0,
      last_run: gracP.last_modified || null,
    },
    {
      name: 'FYI snapshot',
      phase: '2a',
      status: fyiP.object_count > 0 ? 'landing' : 'queued',
      pct: 0,
      last_run: fyiP.last_modified || null,
    },
    { name: 'Opus snapshot', phase: '2a', status: 'queued', pct: 0, last_run: null },
    // ── Phase 2b — Direct license
    { name: 'Nielsen direct',    phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'JustWatch',         phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'Wikidata',          phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'Twitter/X signals', phase: '2b', status: 'designed', pct: 0, last_run: null },
  ];
}

// ── S3 Data Lake inventory ───────────────────────────────────────────────────
// Emits ONE card per real S3 prefix with real sizes + entity counts where
// computable. Entity counts come from scripts/s3-entity-counts.json; prefixes
// flagged { note: 'deferred' } render with em-dash placeholders.
function buildS3Lake(scrapers, s3Inv, entityCounts, s3Freshness) {
  if (!s3Inv?.prefixes) return [];

  // Human label + phase classification per prefix
  const META = {
    'tmdb_dev/':     { label: 'tmdb_dev/',          phase: '1',  status_hint: 'running' },
    'imdb/':         { label: 'imdb/',              phase: '1',  status_hint: 'live'    },
    'imdb_prd/':     { label: 'imdb_prd/ (legacy)', phase: '1',  status_hint: 'live'    },
    'parent_keys/':  { label: 'parent_keys/',       phase: '1',  status_hint: 'live'    },
    'nielsen/':           { label: 'nielsen/',              phase: '2a', status_hint: 'live' },
    'nielsen/viewership/':{ label: 'nielsen/viewership/',  phase: '2a', status_hint: 'live', entities_note: '~13.3B rows · 5 tables · Databricks extract 2026-06-09' },
    'nielsen/mit/':       { label: 'nielsen/mit/',         phase: '2a', status_hint: 'live' },
    'nielsen/amrld/':     { label: 'nielsen/amrld/',       phase: '2a', status_hint: 'live' },
    'nielsen/amrld_etl/': { label: 'nielsen/amrld_etl/',   phase: '2a', status_hint: 'live' },
    'nielsen/ad_intel/':  { label: 'nielsen/ad_intel/',    phase: '2a', status_hint: 'live' },
    'nielsen/mri/':       { label: 'nielsen/mri/',         phase: '2a', status_hint: 'live' },
    'barb/barb_etl_qa/':  { label: 'barb/barb_etl_qa/',   phase: '2b', status_hint: 'live', entities_note: 'UK audience · 2018-01–2019-09 · 4 batch extract COMPLETE' },
    'barb/barb_etl_dev/': { label: 'barb/barb_etl_dev/',  phase: '2b', status_hint: 'live' },
    'gracenote/':    { label: 'gracenote/',         phase: '2a', status_hint: 'live', entities_note: '47,862 TV Series (PARENT_KEY3) · 17,210 Movies (GN_ID_ASSET, matched IMDB+EIDR)' },
    'fyi/':          { label: 'fyi/',               phase: '2a', status_hint: 'live', entities_note: '64,577 TV Series · 21,424 Other · 17,448 Movies (PROGRAM_ID, matched IMDB+EIDR)' },
    'opus/':         { label: 'opus/',              phase: '2a', status_hint: 'landing' },
    'eidr/':         { label: 'eidr/',              phase: '1b', status_hint: 'live', entities_note: '1,556 DOI spine · 1,528 certified · 14,775 candidates backlog' },
    'eidr/candidates/': { label: 'eidr/candidates/', phase: '1b', status_hint: 'live', entities_note: '14,775 unresolved (Partial-tier backlog)' },
    'shiv_curated/': { label: 'shiv_curated/',      phase: '1',  status_hint: 'live'    },
    'progress/':     { label: 'progress/',          phase: '—',  status_hint: 'live'    },
  };

  const tmdb = scrapers.find(s => s.name === 'TMDB bulk loader');

  // Hide TMDB sub-prefixes from the S3 Data Lake grid — they're nested under
  // tmdb_dev/ and their bytes are already counted in the parent tile.
  // s3-inventory.json still contains them for the scraper cards' prefix() lookup.
  const gridPrefixes = s3Inv.prefixes.filter(p =>
    p.prefix === 'tmdb_dev/' || !p.prefix.startsWith('tmdb_dev/')
  );

  return gridPrefixes.map(p => {
    const meta = META[p.prefix] || { label: p.prefix, phase: '—', status_hint: 'landing' };
    const ec   = (entityCounts || {})[p.prefix] || {};
    // TMDB prefix: while bulk loader is running, status=landing not live
    let status = meta.status_hint;
    if (p.prefix === 'tmdb_dev/' && tmdb?.status === 'running') status = 'landing';

    const freshData = (s3Freshness || {})[p.prefix] || { age_hours: null, fresh: false };
    const computedAt = ec.computed_at || null;
    const stale      = countBlockStale(p.prefix, computedAt);
    return {
      path: meta.label,
      prefix: p.prefix,
      phase: meta.phase,
      status,
      size_gb: +(p.size_gb.toFixed(2)),
      object_count: p.object_count,
      last_updated: p.last_modified,
      fresh: freshData.fresh,
      age_hours: freshData.age_hours,
      // entity_type drives renderer: 'entity' | 'entity_funnel' | 'measurement' | 'na'
      entity_type: ec.type || null,
      // Per-type counts (entity datasets)
      entities: {
        movies:    ec.movies    ?? null,
        tv_series: ec.tv_series ?? null,
        episodes:  ec.episodes  ?? null,
        people:    ec.people    ?? null,
        sports:    ec.sports    ?? null,
        other:     ec.other     ?? null,
        telecasts: ec.telecasts ?? null,
      },
      // parent_keys funnel (entity_funnel datasets)
      funnel:  ec.funnel  || null,
      untyped: ec.untyped ?? null,
      // Compute-on-write provenance stamps
      computed_at: computedAt,
      source_job:  ec.source_job || null,
      stale,
      // Flags and notes
      flag: ec.flag || null,
      note: p.note || ec.note || meta.entities_note || null,
    };
  });
}

// ── Build events (Layer 7 audit trail) ───────────────────────────────────────
// Reads today's build-YYYY-MM-DD.jsonl (build-auto) AND deploy-events.json (Railway/Vercel).
// Returns structured events for the recent_activity feed, plus haiku_pct.
function getBuildEvents() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const buildFile  = path.join(SASMASTER, 'logs', `build-${today}.jsonl`);
  const deployFile = path.join(SASMASTER, 'logs', 'deploy-events.json');

  let buildCount  = 0;
  let haiku_pct   = 0;
  let buildEvents = [];

  // ── build-auto events ────────────────────────────────────────────────────────
  if (fs.existsSync(buildFile)) {
    try {
      const lines = fs.readFileSync(buildFile, 'utf8')
        .split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);

      buildEvents = lines.slice(-20).map(e => {
        const isSummary  = e.kind === 'run_summary';
        const isError    = e.status === 'failed' || (Array.isArray(e.errors) && e.errors.length > 0);
        const isComplete = isSummary || e.status === 'complete';

        let type = 'build';
        if (isError)         type = 'error';
        else if (isComplete) type = 'complete';

        let text;
        if (isSummary) {
          const mins = Math.round((e.wall_seconds || 0) / 60);
          text = `Build run complete — ${e.features_ok}/${e.features_total} features, $${(e.total_cost_usd || 0).toFixed(2)}, ${mins}m`;
        } else {
          const icon = isError ? '❌' : '✅';
          text = `${icon} ${(e.task || e.feat_id || '').slice(0, 70)}`;
          if (e.decisions) text += ` — ${e.decisions.slice(0, 60)}`;
        }

        return { type, text: text.slice(0, 120), ts: e.ts || '', layer: 'APP', component: 'build-auto' };
      });

      const featureLines = lines.filter(e => e.kind !== 'run_summary' && e.model_tier);
      const haikuCount   = featureLines.filter(e => e.model_tier === 'haiku').length;
      haiku_pct  = featureLines.length > 0 ? Math.round((haikuCount / featureLines.length) * 100) : 0;
      buildCount = lines.filter(e => e.kind !== 'run_summary').length;
    } catch {}
  }

  // ── deploy events (Railway POST /api/deploy-event + Vercel webhook) ──────────
  let deployCount  = 0;
  let deployEvents = [];

  // Railway deploys: synced from S3 by sync-to-s3-cache.sh every 5 min
  if (fs.existsSync(deployFile)) {
    try {
      const entries = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
      const todayEntries = (Array.isArray(entries) ? entries : [])
        .filter(e => String(e.ts || '').slice(0, 10) === today);
      deployCount += todayEntries.length;
      deployEvents = todayEntries.map(e => ({
        type:      'complete',
        text:      `🚀 Deploy ${e.target || 'platform'} — ${(e.task || '').slice(0, 60)}${e.commit ? ' @' + e.commit : ''}`,
        ts:        e.ts || '',
        layer:     'APP',
        component: 'deploy',
      }));
    } catch {}
  }

  // Vercel deploys: already in events.jsonl as deploy_completed (event_type)
  const eventsFile = path.join(SASMASTER, 'logs', 'events.jsonl');
  if (fs.existsSync(eventsFile)) {
    try {
      const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).slice(-500);
      const vercelDeploys = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && e.event_type === 'deploy_completed' && String(e.ts || '').slice(0, 10) === today);
      deployCount += vercelDeploys.length;
      deployEvents = deployEvents.concat(vercelDeploys.map(e => ({
        type:      'complete',
        text:      `🚀 Vercel deploy — ${(e.payload?.project || e.payload?.url || '').slice(0, 70)}`,
        ts:        e.ts || '',
        layer:     'APP',
        component: 'deploy',
      })));
    } catch {}
  }

  const allEvents = [...buildEvents, ...deployEvents].slice(0, 25);
  return { events: allEvents, count: buildCount + deployCount, haiku_pct };
}

// ── Build performance trends (last 7 days) ────────────────────────────────────
// Reads build-YYYY-MM-DD.jsonl files from ~/SaSMaster/logs/ for the past 7 days.
// Returns null safely if no build logs exist yet — never throws.
function getBuildTrends() {
  try {
    const now  = Date.now();
    const DAY  = 86400000;

    // Collect feature entries from each day file
    const allEntries = [];   // { date: 'YYYY-MM-DD', entry }
    const runIds     = new Set();

    for (let i = 0; i < 7; i++) {
      const d    = new Date(now - i * DAY);
      const date = d.toISOString().slice(0, 10);
      const file = path.join(SASMASTER, 'logs', `build-${date}.jsonl`);
      if (!fs.existsSync(file)) continue;

      try {
        const lines = fs.readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);

        for (const e of lines) {
          if (e.kind === 'run_summary') {
            if (e.run_id) runIds.add(e.run_id);
            continue;
          }
          if (e.run_id) runIds.add(e.run_id);
          allEntries.push({ date, entry: e });
        }
      } catch { continue; }
    }

    if (allEntries.length === 0) return null;

    // ── Aggregate over all 7 days ─────────────────────────────────────────────
    const costs     = allEntries.map(x => x.entry.cost_usd).filter(v => typeof v === 'number');
    const durations = allEntries.map(x => x.entry.duration_s).filter(v => typeof v === 'number');
    const total     = allEntries.length;
    const failed    = allEntries.filter(x => x.entry.status === 'failed' || (Array.isArray(x.entry.errors) && x.entry.errors.length > 0)).length;

    const avg_cost_usd   = costs.length     ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 10000) / 10000 : 0;
    const avg_duration_s = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : 0;
    const error_rate     = total > 0        ? Math.round((failed / total) * 1000) / 1000 : 0;

    // ── Trend: compare last 3 days vs previous 4 days error_rate ─────────────
    const recent3Days = new Set();
    for (let i = 0; i < 3; i++) {
      recent3Days.add(new Date(now - i * DAY).toISOString().slice(0, 10));
    }

    const recentEntries = allEntries.filter(x => recent3Days.has(x.date));
    const olderEntries  = allEntries.filter(x => !recent3Days.has(x.date));

    const errRate = (arr) => {
      if (!arr.length) return null;
      const f = arr.filter(x => x.entry.status === 'failed' || (Array.isArray(x.entry.errors) && x.entry.errors.length > 0)).length;
      return f / arr.length;
    };

    const recentErr = errRate(recentEntries);
    const olderErr  = errRate(olderEntries);

    let trend = 'stable';
    if (recentErr !== null && olderErr !== null) {
      if (recentErr < olderErr - 0.02)  trend = 'improving';
      else if (recentErr > olderErr + 0.02) trend = 'declining';
    }

    return {
      avg_cost_usd,
      avg_duration_s,
      error_rate,
      total_features_7d: total,
      builds_7d:         runIds.size,
      trend,
    };
  } catch { return null; }
}

// ── KPIs (derived) ───────────────────────────────────────────────────────────
function buildKPIs(agents, scrapers, s3_lake, tasks, pk, buildEventsCount, haikuPctToday, warroomS3Total) {
  // agents_running counts only live/cron agents (not idle sub-agents or marketplace)
  const liveAgents    = agents.filter(a => !a.type || a.type === 'live');
  const agents_running = liveAgents.filter(a => a.status === 'healthy' || a.status === 'routing').length;
  const scrapers_live  = scrapers.filter(s => s.status === 'live').length;
  // Prefer warroom-data.json total (4x/day refresh) over stale s3-inventory.json sum
  const s3_gb = warroomS3Total != null
    ? warroomS3Total
    : s3_lake.reduce((sum, b) => sum + (b.size_gb || 0), 0);
  const tasks_open = (tasks.highItems?.length || 0) + (tasks.medItems?.length || 0) + (tasks.exploreItems?.length || 0);
  const pkRows = pk?.row_count ?? 589814;

  return {
    agents_running,
    agents_total: agents.length,       // 50 — full fleet (live + sub-agents + marketplace)
    agents_live_total: liveAgents.length, // 14 — live/cron only, used for health bar
    scrapers_live,
    scrapers_total: scrapers.length,
    s3_gb: Math.round(s3_gb * 10) / 10,
    parent_key_rows: pkRows,
    tasks_open,
    build_events_today: buildEventsCount || 0,
    model_routing: 'haiku+sonnet+opus',
    haiku_pct_today: haikuPctToday ?? 0,
    eidr_coverage_pct: pk?.eidr_pct ?? null,
    eidr_matched_rows: pk?.eidr_matched ?? null,
  };
}

// ── Recent activity (merged ticker feed) ─────────────────────────────────────
function buildRecentActivity(intelFeed, recentBuilds, scrapers) {
  const acts = [];

  (recentBuilds || []).slice(0, 6).forEach(b => {
    if (!b.task) return;
    acts.push({ type: 'build', text: b.task.slice(0, 80), ts: b.date });
  });

  (intelFeed || []).slice(0, 5).forEach(i => {
    const src = (i.source || 'INTEL').toLowerCase();
    const type = /edgar|intel|media/i.test(src) ? 'intel' : 'content';
    acts.push({ type, text: (i.text || '').slice(0, 90), ts: i.ts || '' });
  });

  const tmdb = scrapers.find(s => s.name === 'TMDB bulk loader');
  if (tmdb && tmdb.pct != null) {
    acts.push({
      type: 'pipeline',
      text: `TMDB bulk ${tmdb.pct.toFixed(1)}% — ${(tmdb.row_count/1000).toFixed(0)}K / ${(tmdb.total/1000).toFixed(0)}K titles → ${tmdb.s3_path}`,
      ts: tmdb.last_run || '',
    });
  }

  return acts.slice(0, 12);
}

// ── Cron status enrichment ───────────────────────────────────────────────────
// Correct semantics: "done" = today's scheduled time has passed AND the agent
// (or the log file) shows activity on/after that scheduled time.
// "pending" = scheduled time is still in the future, OR scheduled time passed
// but no activity since then (missed run).
function enrichCronStatus(cronJobs, agents) {
  const now = Date.now();

  return cronJobs.map(c => {
    const sched = c._scheduledToday;
    const { _scheduledToday, ...clean } = c;

    // No scheduled time parsed → fall back to 'pending'
    if (!sched) return { ...clean, status: 'pending' };

    // Future today → pending
    if (sched > now) return { ...clean, status: 'pending' };

    // Past today → check agent or log mtime
    const scriptMatch = c.command.match(/([a-z0-9\-]+)(-agent)?\.js/i);
    const bashMatch   = c.command.match(/\b([a-z0-9\-]+)\.sh\b/i);
    const key         = scriptMatch ? scriptMatch[1].replace(/-agent$/, '') : (bashMatch ? bashMatch[1] : '');
    const agent = key ? agents.find(a => a.log && (a.log.includes(key) || (scriptMatch && a.log.includes(scriptMatch[1])))) : null;

    if (agent && agent.status === 'routing') return { ...clean, status: 'routing' };
    if (agent && agent.lastRun && new Date(agent.lastRun).getTime() >= sched) {
      return { ...clean, status: 'done' };
    }

    // No agent match — check the redirected log file's mtime
    const logMatch = c.command.match(/>>\s*([^\s]+\.log)/);
    if (logMatch) {
      const logPath = logMatch[1];
      try {
        const mtime = fs.statSync(logPath).mtime.getTime();
        if (mtime >= sched) return { ...clean, status: 'done' };
      } catch { /* log file missing */ }
    }

    // Scheduled fired but no activity detected
    return { ...clean, status: 'pending' };
  });
}

// ── Slack feed ───────────────────────────────────────────────────────────────
// Primary source: ~/SaSMaster/status/slack-feed.json (real conversations.history
// snapshot, updated every 5 min by scripts/slack-feed-cache.js).
// Fallback: log-derived tails for stale/missing cache.
function parseSlackFeedCache() {
  const file = path.join(SASMASTER, 'status', 'slack-feed.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || !d.generated) return null;
    // If stale (> 20 min old), return null and let the log-derived fallback run
    const ageMin = (Date.now() - new Date(d.generated).getTime()) / 60000;
    if (ageMin > 20) return null;
    return d;
  } catch { return null; }
}

function buildSlackFeed(recentBuilds, intelFeed) {
  // Prefer the live Slack cache if fresh
  const cache = parseSlackFeedCache();
  if (cache) {
    // Map bot-posted emoji prefixes for visual parity with the fallback
    const dress = msgs => (msgs || []).slice(0, 8).map(m => ({
      ts: m.ts,
      text: m.bot ? m.text : m.text, // both rendered the same; raw bot status preserved for styling later
    }));
    return {
      builds:  dress(cache.builds),
      intel:   dress(cache.intel),
      content: dress(cache.content),
    };
  }

  // Fallback: derive from log files
  const LOG = path.join(SASMASTER, 'logs');
  const tsShort = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    // Format: "HH:MM AM/PM EDT" vs "Apr 22" for older
    const diffHours = (Date.now() - d.getTime()) / 36e5;
    if (diffHours < 24) {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  };

  // Tail a log file and return the last N readable lines as Slack-like messages
  const tailLogAsMessages = (logName, emoji, max = 4) => {
    const p = path.join(LOG, logName);
    if (!fs.existsSync(p)) return [];
    try {
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-15).reverse();
      const out = [];
      for (const line of lines) {
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(?:\[[A-Z0-9_-]+\]\s*)?(.*)$/);
        if (!m) continue;
        const text = m[2].trim();
        if (!text) continue;
        out.push({ ts: tsShort(m[1]), text: `${emoji} ${text.slice(0, 140)}` });
        if (out.length >= max) break;
      }
      return out;
    } catch { return []; }
  };

  // #sasmaster-builds — DONE_LOG + DoneLog Analyst + daily briefing + morning package
  const buildsFromDone = (recentBuilds || []).slice(0, 4).map(b => ({
    ts: tsShort(b.date),
    text: `✅ ${(b.task || '').slice(0, 140)}`,
  })).filter(m => m.text && m.text !== '✅ ');
  const buildsFromLogs = [
    ...tailLogAsMessages('donelog-analyst.log', '📊', 2),
    ...tailLogAsMessages('briefing.log',        '☀️', 1),
    ...tailLogAsMessages('morning-package.log', '📦', 1),
  ];
  const builds = [...buildsFromDone, ...buildsFromLogs].slice(0, 8);

  // #sasmaster-intel — intel_feed + media-intel + sec-edgar + tech-intel log tails
  const intelFromFeed = (intelFeed || []).slice(0, 3).map(i => ({
    ts: tsShort(i.ts),
    text: `${/edgar/i.test(i.source || '') ? '📑' : '📡'} ${(i.text || '').slice(0, 140)}`,
  }));
  const intelFromLogs = [
    ...tailLogAsMessages('media-intel.log', '📡', 2),
    ...tailLogAsMessages('sec-edgar.log',   '📑', 2),
    ...tailLogAsMessages('tech-intel.log',  '🛰️', 2),
  ];
  const intel = [...intelFromFeed, ...intelFromLogs].slice(0, 8);

  // #sasmaster-content — LinkedIn + TMDB Trending + Weekly Review
  const content = [
    ...tailLogAsMessages('linkedin-agent.log', '✍️', 3),
    ...tailLogAsMessages('tmdb-agent.log',     '📺', 3),
    ...tailLogAsMessages('weekly-review.log',  '🗂️', 1),
  ].slice(0, 8);

  return { builds, intel, content };
}

// ── Tasks for v3 Kanban (flatten existing kanban into v3 shape) ──────────────
function buildTasksForV3(kanban) {
  const out = [];
  (kanban.backlog || []).forEach(t => out.push({ title: t.text, status: 'BACKLOG',     priority: t.priority || 'MED', tag: t.tag || '', est: '—' }));
  (kanban.inProgress || []).forEach(t => out.push({ title: t.text, status: 'IN PROGRESS', priority: t.priority || 'HIGH', tag: t.tag || '', est: '—' }));
  (kanban.review || []).forEach(t => out.push({ title: t.text, status: 'REVIEW',        priority: t.priority || 'REVIEW', tag: t.tag || '', est: '—' }));
  (kanban.done || []).slice(0, 10).forEach(t => out.push({ title: t.text, status: 'DONE', priority: t.priority || 'DONE', tag: t.tag || '', est: '—' }));
  return out;
}

// ── Assemble + write ─────────────────────────────────────────────────────────
const tasks         = parseTasks();
const { entries: recentBuilds, heatmap } = parseDoneLog();
const pendingItems  = parsePending();
const intelFeed     = parseIntelFeed();
const alerts        = parseAlerts();
const agents        = parseAgents();
const tmdbProgress  = parseTMDBProgress();
const s3Inv         = parseS3Inventory();
const warroomS3Total = parseWarroomDataS3Total();
// Counts read from S3 warroom/counts.json (compute-on-write — jobs write this, not generate-status).
// generate-status.js is READ-ONLY with respect to entity counts.
const entityCounts  = parseS3EntityCounts();
const movieUniverse = (entityCounts || {})['_movie_universe'] || null;
const imdbStatus    = parseImdbStatus();
const scrapers      = buildScrapers(tmdbProgress, recentBuilds, s3Inv, agents, imdbStatus);
const qaDrafts      = parseQADrafts();
const { phaseStatus, pending: memoryPending } = parseMemoryContext();

// Compute freshness for each known S3 prefix (silent on AWS CLI failure)
const s3FreshnessPrefixes = (s3Inv?.prefixes || []).map(p => p.prefix);
const s3Freshness = getS3Freshness(s3FreshnessPrefixes);

const s3_lake       = buildS3Lake(scrapers, s3Inv, entityCounts, s3Freshness);
const cronJobsRaw   = parseCrontab();
const cron          = enrichCronStatus(cronJobsRaw, agents);

// Layer 7: build audit trail events
const { events: buildEventsToday, count: buildEventsCount, haiku_pct: haikuPctToday } = getBuildEvents();

// Layer 6: performance trends (last 7 days)
const buildTrends = getBuildTrends();

const kanban = {
  // Lifecycle columns (state-driven)
  backlog:    [...tasks.highItems, ...tasks.medItems, ...tasks.exploreItems],
  inProgress: tasks.wipItems,
  blocked:    tasks.blockedItems,
  review:     [...tasks.reviewItems, ...pendingItems, ...qaDrafts],
  done:       recentBuilds.map((b, i) => ({ id: `done-${i}`, text: b.task, full: b.task, sprint: '', tag: 'DONE', priority: 'DONE' })),
  // Context panels
  qaDrafts,
  memoryPending,
  phaseStatus,
  // Summary for KPI strip
  counts: {
    backlog:    tasks.highItems.length + tasks.medItems.length + tasks.exploreItems.length,
    inProgress: tasks.wipItems.length,
    blocked:    tasks.blockedItems.length,
    review:     tasks.reviewItems.length + pendingItems.length + qaDrafts.length,
    qaDrafts:   qaDrafts.length,
  },
};

const parentKeyScraper = scrapers.find(s => s.name === 'SAS-MASTER Parent Key v1');
const eidrV2Progress   = parseEidrProgress();
// Merge eidrProgress into parentKeyScraper so buildKPIs can read eidr_pct / eidr_matched
if (parentKeyScraper && eidrV2Progress) {
  parentKeyScraper.eidr_pct     = eidrV2Progress.eidr_pct;
  parentKeyScraper.eidr_matched = eidrV2Progress.eidr_matched;
}

// Inject trend KPIs into kpis object after buildKPIs() runs — done below inline.

// Merge build events (prepend) + existing slack_feed events (append), cap at 25
function buildMergedActivity(intelFeed, recentBuilds, scrapers, buildEvents) {
  const existing = buildRecentActivity(intelFeed, recentBuilds, scrapers);
  return [...buildEvents, ...existing].slice(0, 25);
}

// ── Cost summary from logs/cost-log.jsonl ────────────────────────────────────
// ONE-SOURCE-001: cost-log.jsonl is the SINGLE authority for all cost figures.
// ALL cost surfaces (KPI "Build Cost", COSTS tab MTD total, FINANCE tab burn) MUST
// read from this structure with different aggregations — never from separate sources.
// Root cause of $34.96 vs $0.08 discrepancy: "Build Cost" sometimes fetched from
// Railway /api/costs (MTD session cost) and sometimes fell back to cost_summary
// (all-time total from log). Fix: cost_summary.total_cost_usd = ALL-TIME from log;
// cost_summary.mtd_cost_usd = current month; token_projection.week_cost_usd = this week.
// Frontend MUST label these correctly and never swap them.
let costSummary = { total_cost_usd: 0, mtd_cost_usd: 0, entry_count: 0, model_breakdown: {} };
try {
  const costLines = fs.readFileSync(path.join(SASMASTER, 'logs', 'cost-log.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean);
  let costTotal = 0;
  const costModels = {};
  for (const cl of costLines) {
    try {
      const ce = JSON.parse(cl);
      const c = ce.cost_usd || 0;
      costTotal += c;
      const m = ce.model || ce.model_exec || 'unknown';
      costModels[m] = (costModels[m] || 0) + c;
    } catch {}
  }
  // Compute MTD separately — same log, different lens
  const nowMtd  = new Date();
  const mtdStart = new Date(nowMtd.getFullYear(), nowMtd.getMonth(), 1).getTime();
  let mtdTotal = 0;
  for (const cl of costLines) {
    try {
      const ce = JSON.parse(cl);
      const ts = new Date(ce.ts || ce.timestamp || '').getTime();
      if (ts >= mtdStart) mtdTotal += (ce.cost_usd || 0);
    } catch {}
  }
  costSummary = {
    total_cost_usd: Math.round(costTotal * 10000) / 10000,   // ALL-TIME — used for lifetime view
    mtd_cost_usd:   Math.round(mtdTotal  * 10000) / 10000,   // MTD — used for COSTS tab header
    entry_count: costLines.length,
    model_breakdown: costModels,
    authority: 'cost-log.jsonl',  // ONE-SOURCE-001: single authority tag
  };
} catch {}

// ── Usage state (manual paste from claude.ai/settings/usage) ─────────────────
let usageState = null;
try {
  const usagePath = path.join(process.env.HOME, '.sasmaster', 'usage-state.json');
  if (fs.existsSync(usagePath)) {
    usageState = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
  }
} catch (e) {
  console.warn('[generate-status] usage-state.json missing or invalid:', e.message);
}

// ── Token burn rate projection from cost-log.jsonl ────────────────────────────
let tokenProjection = null;
try {
  const costLogPath = path.join(SASMASTER, 'logs', 'cost-log.jsonl');
  if (fs.existsSync(costLogPath)) {
    const allLines = fs.readFileSync(costLogPath, 'utf8').trim().split('\n').filter(Boolean);
    const now = new Date();
    // Week anchor: Monday 00:00 local
    const dayOfWeek = now.getDay();
    const diffToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMon);
    weekStart.setHours(0, 0, 0, 0);

    const resetAt = usageState ? new Date(usageState.weekly_resets_at) : new Date(weekStart.getTime() + 7 * 86400000);
    const dailyCost = {};
    const agentCost = {};
    let weekCostTotal = 0;
    let weekTokensTotal = 0;

    for (const line of allLines) {
      try {
        const e = JSON.parse(line);
        const ts = new Date(e.ts || e.timestamp || '');
        if (isNaN(ts) || ts < weekStart) continue;
        const c = e.cost_usd || 0;
        const t = e.tokens || 0;
        weekCostTotal += c;
        weekTokensTotal += t;
        const dayStr = ts.toISOString().slice(0, 10);
        dailyCost[dayStr] = (dailyCost[dayStr] || 0) + c;
        const ag = e.agent_id || e.agent || e.task_id || 'unknown';
        if (!agentCost[ag]) agentCost[ag] = { cost_usd: 0, tokens: 0, model: e.model || 'unknown' };
        agentCost[ag].cost_usd += c;
        agentCost[ag].tokens += t;
      } catch (_) {}
    }

    const msElapsed = Math.max(1, now - weekStart);
    const msTotal = Math.max(msElapsed, resetAt - weekStart);
    const pctElapsed = Math.min(1, msElapsed / msTotal);
    const projectedCost = weekCostTotal / pctElapsed;

    const topConsumers = Object.entries(agentCost)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 10)
      .map(([id, d]) => ({ id, ...d }));

    // Auto-generate optimization recommendations
    const recommendations = [];

    // R1: Agents invoking Opus on low-token tasks (Sonnet would suffice)
    for (const [id, d] of Object.entries(agentCost)) {
      const m = (d.model || '').toLowerCase();
      const avgTokens = d.tokens;
      if (m.includes('opus') && avgTokens < 50000 && avgTokens > 0) {
        const estSave = Math.round(d.cost_usd * 0.6 * 100) / 100;
        recommendations.push({
          type: 'model-downgrade',
          agent: id,
          action: `Downgrade ${id} from Opus → Sonnet (avg ${d.tokens.toLocaleString()} tokens — below 50K threshold)`,
          est_save_usd_wk: estSave,
          severity: 'amber',
        });
      }
    }

    // R2: Agents invoking Sonnet on very low-token tasks (Haiku would suffice)
    for (const [id, d] of Object.entries(agentCost)) {
      const m = (d.model || '').toLowerCase();
      if (m.includes('sonnet') && d.tokens < 10000 && d.tokens > 0) {
        const estSave = Math.round(d.cost_usd * 0.7 * 100) / 100;
        recommendations.push({
          type: 'model-downgrade',
          agent: id,
          action: `Downgrade ${id} from Sonnet → Haiku (avg ${d.tokens.toLocaleString()} tokens — below 10K threshold)`,
          est_save_usd_wk: estSave,
          severity: 'amber',
        });
      }
    }

    // R3: High Sonnet burn rate → throttle builds
    if (usageState && (usageState.weekly_sonnet_pct || 0) >= 85) {
      recommendations.push({
        type: 'throttle',
        agent: 'build-loop',
        action: `Sonnet at ${usageState.weekly_sonnet_pct}% — cap opportunistic build loop to 3 tasks/cycle until Thu 10PM reset`,
        est_save_usd_wk: 0,
        severity: 'red',
      });
    }

    // R4: Prompt caching — check if wired (look for cache_creation_input_tokens in recent entries)
    const entriesWithCacheTokens = allLines.reduce((n, line) => {
      try { const e = JSON.parse(line); return n + ((e.cache_creation_input_tokens > 0 || e.cache_read_input_tokens > 0) ? 1 : 0); } catch { return n; }
    }, 0);
    const entriesWithTokens = allLines.reduce((n, line) => {
      try { const e = JSON.parse(line); return n + (e.tokens > 0 ? 1 : 0); } catch { return n; }
    }, 0);
    if (entriesWithCacheTokens > 0) {
      recommendations.push({
        type: 'caching',
        agent: 'all-agents',
        action: `Prompt caching active — ${entriesWithCacheTokens} log entries with cache tokens. Verify: cache_read_input_tokens > 0 on second run within TTL window.`,
        est_save_usd_wk: 0,
        severity: 'green',
      });
    } else if (entriesWithTokens > 3) {
      recommendations.push({
        type: 'caching',
        agent: 'all-agents',
        action: 'Prompt caching wired on intel agents + Dr. Scoop — verify first cache_creation_input_tokens > 0 on next cron run',
        est_save_usd_wk: Math.round(weekCostTotal * 0.5 * 100) / 100,
        severity: 'amber',
      });
    }

    // R5: Week has active spend — recommend batching small tasks to amortize context load
    if (weekCostTotal > 0) {
      recommendations.push({
        type: 'batching',
        agent: 'build-loop',
        action: 'Batch short tasks (<5K token context) into single Claude Code sessions to amortize system-prompt overhead — reduces per-task input tokens by ~30%',
        est_save_usd_wk: Math.round(weekCostTotal * 0.3 * 100) / 100,
        severity: 'amber',
      });
    }

    // R6: Always-on — cache agent skill files on first invocation
    recommendations.push({
      type: 'caching',
      agent: 'skill-loader',
      action: 'Cache ~/.claude/skills/user/*.md reads with cache_control: ephemeral on first load — skill files are 2-15KB and re-read every session uncached',
      est_save_usd_wk: 0,
      severity: 'green',
    });

    tokenProjection = {
      week_cost_usd: Math.round(weekCostTotal * 10000) / 10000,
      week_tokens: weekTokensTotal,
      projected_week_cost_usd: Math.round(projectedCost * 10000) / 10000,
      pct_elapsed: Math.round(pctElapsed * 100),
      daily_cost: dailyCost,
      top_consumers: topConsumers,
      recommendations: recommendations.slice(0, 6),
      week_start: weekStart.toISOString(),
      reset_at: resetAt.toISOString(),
    };
  }
} catch (e) {
  console.warn('[generate-status] token projection failed:', e.message);
}

// ── Per-source freshness (WAR-ROOM-RELIABILITY-001 · WAR-ROOM-ALERT-001) ────
// Thresholds match actual cadence: JARVIS 10m · TMDB 25h · S3 26h · Nielsen 48h · Build 4h · Token 5h
// status: ok (<50% of threshold used) | warn (50-100%) | stale (>100%)
function buildSourceFreshness() {
  const now = Date.now();

  function ageMins(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return Math.round((now - d.getTime()) / 60000);
  }

  function entry(source, lastUpdated, thresholdMins) {
    const age = ageMins(lastUpdated);
    let status = 'unknown';
    if (age !== null) {
      if (age <= thresholdMins * 0.5) status = 'ok';
      else if (age <= thresholdMins)   status = 'warn';
      else                             status = 'stale';
    }
    return { source, last_updated: lastUpdated || null, threshold_mins: thresholdMins, age_mins: age, status };
  }

  // ── JARVIS / Railway heartbeat ────────────────────────────────────────────
  let jarvisLastTs = null;
  try {
    const hbFile = path.join(SASMASTER, 'status', 'railway-health.json');
    if (fs.existsSync(hbFile)) {
      const hb = JSON.parse(fs.readFileSync(hbFile, 'utf8'));
      jarvisLastTs = hb.ts || hb.checked_at || null;
    }
  } catch {}
  // Fallback: if JARVIS is alive right now, treat generated_at as its last heartbeat
  if (!jarvisLastTs && jarvisAlive()) jarvisLastTs = new Date().toISOString();

  // ── TMDB scraper ──────────────────────────────────────────────────────────
  let tmdbLastTs = null;
  try {
    const tf = path.join(SASMASTER, 'status', 'tmdb-progress.json');
    if (fs.existsSync(tf)) tmdbLastTs = JSON.parse(fs.readFileSync(tf, 'utf8')).last_updated || null;
  } catch {}
  if (!tmdbLastTs) {
    try { tmdbLastTs = fs.statSync(path.join(SASMASTER, 'logs', 'tmdb-agent.log')).mtime.toISOString(); } catch {}
  }

  // ── S3 Lake sizes ─────────────────────────────────────────────────────────
  let s3LastTs = null;
  try { s3LastTs = fs.statSync(path.join(SASMASTER, 'status', 's3-inventory.json')).mtime.toISOString(); } catch {}

  // ── Nielsen VIEWERSHIP ────────────────────────────────────────────────────
  let nielsenLastTs = null;
  try {
    const nf = path.join(SASMASTER, 'status', 'nielsen-progress.json');
    if (fs.existsSync(nf)) nielsenLastTs = JSON.parse(fs.readFileSync(nf, 'utf8')).last_updated || null;
  } catch {}
  if (!nielsenLastTs) {
    for (const logName of ['nielsen_puller.log', 'nielsen.log', 'data-guardian.log']) {
      try {
        const p = path.join(SASMASTER, 'logs', logName);
        if (fs.existsSync(p)) { nielsenLastTs = fs.statSync(p).mtime.toISOString(); break; }
      } catch {}
    }
  }

  // ── Build events log ──────────────────────────────────────────────────────
  let buildLastTs = null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const buildLog = path.join(SASMASTER, 'logs', `build-${today}.jsonl`);
    if (fs.existsSync(buildLog)) buildLastTs = fs.statSync(buildLog).mtime.toISOString();
  } catch {}
  if (!buildLastTs) {
    try {
      const sqLog = path.join(SASMASTER, 'logs', `score-queue-${today.replace(/-/g, '')}.log`);
      if (fs.existsSync(sqLog)) buildLastTs = fs.statSync(sqLog).mtime.toISOString();
    } catch {}
  }

  // ── Token refresh ─────────────────────────────────────────────────────────
  // Last line in token-refresh.log that does NOT contain "ERROR"
  let tokenLastTs = null;
  try {
    const refreshLog = path.join(SASMASTER, 'logs', 'token-refresh.log');
    if (fs.existsSync(refreshLog)) {
      const lines = fs.readFileSync(refreshLog, 'utf8').split('\n').filter(l => l.trim() && !l.includes('ERROR'));
      if (lines.length > 0) {
        // Date format: [Wed May 27 07:34:11 EDT 2026]
        const m = lines[lines.length - 1].match(/\[([^\]]+)\]/);
        if (m) {
          const parsed = new Date(m[1]);
          if (!isNaN(parsed.getTime())) tokenLastTs = parsed.toISOString();
        }
      }
    }
  } catch {}

  return [
    entry('JARVIS / Railway heartbeat', jarvisLastTs,  10),
    entry('TMDB scraper',               tmdbLastTs,    25 * 60),
    entry('S3 Lake sizes',              s3LastTs,      26 * 60),  // daily scraper, not polled
    entry('Nielsen VIEWERSHIP',         nielsenLastTs, 48 * 60),
    entry('Build events log',           buildLastTs,   4 * 60),   // not continuous
    entry('Token refresh',              tokenLastTs,   5 * 60),
  ];
}

const sourceFreshness = buildSourceFreshness();

// ── Phase 5: Edge-triggered stale-source Slack alerting (WAR-ROOM-ALERT-001) ─
// Fires ONCE on ok→stale transition. Fires ONCE on stale→ok recovery.
// Never repeats for an unchanged condition. Daily 9AM digest for persistent stale.
// State persisted in ~/SaSMaster/status/stale-alert-state.json.
// !ack <source> snoozes a source for 24h (handled in jarvis.js).

const STALE_STATE_FILE = path.join(SASMASTER, 'status', 'stale-alert-state.json');

function loadStaleState() {
  try { return JSON.parse(fs.readFileSync(STALE_STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveStaleState(state) {
  try { fs.writeFileSync(STALE_STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function readWebhook() {
  try {
    const envLines = fs.readFileSync(path.join(SASMASTER, '.env'), 'utf8').split('\n');
    const wl = envLines.find(l => l.startsWith('SASMASTER_SLACK_WEBHOOK='));
    if (wl) return wl.slice('SASMASTER_SLACK_WEBHOOK='.length).trim().replace(/^['"]|['"]$/g, '');
  } catch {}
  return '';
}

function postSlackWebhook(webhook, body) {
  try {
    const https = require('https');
    const url   = new URL(webhook);
    const req   = https.request({
      hostname: url.hostname,
      path:     url.pathname + (url.search || ''),
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch {}
}

function fmtAge(age_mins) {
  if (age_mins == null) return 'unknown';
  return (age_mins < 60 ? `${age_mins}m` : `${Math.round(age_mins / 60)}h`) + ' ago';
}

function fmtThreshold(threshold_mins) {
  return threshold_mins >= 60 ? `${Math.round(threshold_mins / 60)}h` : `${threshold_mins}m`;
}

function alertStaleSources(freshness) {
  const webhook = readWebhook();
  if (!webhook) return;

  const state = loadStaleState();
  const now   = Date.now();
  const nowHr = new Date().getHours();
  const nowMin = new Date().getMinutes();

  const transitionLines   = [];  // ok→stale or stale→ok
  const persistentStale   = [];  // still stale >24h, for 9AM digest

  for (const s of freshness) {
    const key  = s.source;
    const prev = state[key] || {};
    const snoozedUntil = prev.snoozed_until ? new Date(prev.snoozed_until).getTime() : 0;

    if (snoozedUntil > now) continue;  // user ack'd — skip until snooze expires

    const prevStatus = prev.last_known_status || 'unknown';
    const curStatus  = s.status;

    // Detect transition
    const wentStale    = curStatus === 'stale' && prevStatus !== 'stale';
    const recovered    = curStatus !== 'stale' && prevStatus === 'stale';

    if (wentStale) {
      transitionLines.push(`🔴 *STALE* — *${s.source}* last updated ${fmtAge(s.age_mins)} (threshold ${fmtThreshold(s.threshold_mins)})`);
      state[key] = { ...prev, last_known_status: curStatus, last_transition_at: new Date().toISOString(), last_alerted_at: new Date().toISOString() };
    } else if (recovered) {
      transitionLines.push(`✅ *RECOVERED* — *${s.source}* is now fresh again`);
      state[key] = { ...prev, last_known_status: curStatus, last_transition_at: new Date().toISOString(), last_alerted_at: new Date().toISOString() };
    } else {
      // No transition — just update the tracked status
      state[key] = { ...prev, last_known_status: curStatus };
    }

    // Collect for daily 9AM digest: stale for >24h and still stale now
    if (curStatus === 'stale') {
      const lastAlerted = prev.last_alerted_at ? new Date(prev.last_alerted_at).getTime() : 0;
      const staleHours  = s.age_mins != null ? s.age_mins / 60 : 0;
      if (staleHours > 24 && now - lastAlerted > 23 * 60 * 60 * 1000) {
        persistentStale.push(s);
      }
    }
  }

  // Fire transition alert immediately
  if (transitionLines.length) {
    const body = JSON.stringify({
      text: transitionLines.join('\n'),
      attachments: [{ color: transitionLines.some(l => l.includes('STALE')) ? 'danger' : 'good', footer: 'generate-status.js · stale-source monitor (edge-triggered)' }],
    });
    postSlackWebhook(webhook, body);
  }

  // Daily 9AM digest for persistent stale sources (fires in the 9:00-9:14 window)
  if (persistentStale.length && nowHr === 9 && nowMin < 15) {
    const digestLines = persistentStale.map(s =>
      `⚠️ *${s.source}* — stale ${fmtAge(s.age_mins)} (threshold ${fmtThreshold(s.threshold_mins)}) · \`!ack WAR-ROOM-STALE ${s.source}\` to snooze 24h`
    );
    const body = JSON.stringify({
      text: `📋 *Daily stale-source digest* — ${persistentStale.length} source(s) still stale:`,
      attachments: [{
        color: 'warning',
        text: digestLines.join('\n'),
        footer: 'generate-status.js · 9AM stale digest',
      }],
    });
    postSlackWebhook(webhook, body);
    // Mark last_alerted_at so we don't re-digest until tomorrow
    for (const s of persistentStale) {
      if (state[s.source]) state[s.source].last_alerted_at = new Date().toISOString();
    }
  }

  saveStaleState(state);
}

alertStaleSources(sourceFreshness);

// ── TRUTHFUL-VITALS-001 ───────────────────────────────────────────────────────
// Health formula is DATA, not code. Edit HEALTH_FORMULA to change weights/thresholds.
// This block is the SOLE authority for all health scoring. No caching, no carry-forward.
// Authority: computed fresh every cycle from first principles.

const CANARY_STATE_FILE = path.join(SASMASTER, 'status', 'canary-state.json');

// Known-fail canaries are excluded from canary_health denominator (CANARIES.yaml).
const KNOWN_FAIL_CANARIES = new Set(['gracenote_onconnect', 'eidr_query_api']);

// HEALTH_FORMULA config block — reviewable in 30 seconds, changeable without deploy.
const HEALTH_FORMULA = {
  formula_version: 'v1',
  weights: {
    agents:    0.35,  // healthy live-cron agents / total live-cron agents
    canaries:  0.30,  // pass / (pass + fail) where known_fail excluded from denominator
    freshness: 0.25,  // ok+warn sources / (ok+warn+stale) from source_freshness
    cron:      0.10,  // 1 - (missed_non_weekly_today / scheduled_non_weekly_today)
  },
  amber_floor_rule: 'any component at 0% forces health ring to amber minimum regardless of aggregate',
  thresholds: { green: 85, amber: 60 },  // score out of 100
};

function computeHealthScore(agentList, freshnessList, cronList) {
  // ── Component 1: agents (35%) — live/cron type only ──
  const liveAgents  = agentList.filter(a => !a.type || a.type === 'live');
  const agentTotal  = liveAgents.length;
  const agentHealthy = liveAgents.filter(a => a.status === 'healthy' || a.status === 'routing').length;
  const agentPct    = agentTotal > 0 ? agentHealthy / agentTotal : 1;

  // ── Component 2: canaries (30%) — unexpected fails only (known_fail excluded) ──
  let canaryPct = 1;
  try {
    const state   = JSON.parse(fs.readFileSync(CANARY_STATE_FILE, 'utf8'));
    const entries = Object.entries(state).filter(([name]) => !KNOWN_FAIL_CANARIES.has(name));
    const pass    = entries.filter(([, v]) => v.ok).length;
    canaryPct     = entries.length > 0 ? pass / entries.length : 1;
  } catch { /* canary-state.json missing — score 1.0, do not block */ }

  // ── Component 3: freshness (25%) — from source_freshness (single authority) ──
  const known = (freshnessList || []).filter(s => s.status !== 'unknown');
  const notStale = known.filter(s => s.status === 'ok' || s.status === 'warn').length;
  const freshnessPct = known.length > 0 ? notStale / known.length : 1;

  // ── Component 4: cron (10%) — non-weekly jobs scheduled today ──
  const nonWeeklyToday = (cronList || []).filter(c => !c.weekly);
  const missedToday    = nonWeeklyToday.filter(c => c.status === 'pending').length;
  const cronPct        = nonWeeklyToday.length > 0 ? Math.max(0, 1 - (missedToday / nonWeeklyToday.length)) : 1;

  const w        = HEALTH_FORMULA.weights;
  const rawScore = (agentPct * w.agents) + (canaryPct * w.canaries) + (freshnessPct * w.freshness) + (cronPct * w.cron);
  const score    = Math.round(rawScore * 100);

  const components = {
    agents:    Math.round(agentPct    * 100),
    canaries:  Math.round(canaryPct   * 100),
    freshness: Math.round(freshnessPct * 100),
    cron:      Math.round(cronPct      * 100),
  };

  // Override rule: any component at 0% → amber floor regardless of aggregate score
  const anyZero = Object.values(components).some(v => v === 0);
  const floor   = anyZero ? 'amber' : null;
  // Raw grade from score
  const rawGrade = score >= HEALTH_FORMULA.thresholds.green ? 'green'
                 : score >= HEALTH_FORMULA.thresholds.amber ? 'amber'
                 : 'red';
  // Apply floor: amber floor means grade can't be 'green' if any component is 0%
  const grade = (floor === 'amber' && rawGrade === 'green') ? 'amber' : rawGrade;

  return {
    score,
    grade,
    floor,
    components,
    formula_version: HEALTH_FORMULA.formula_version,
    formula: HEALTH_FORMULA,
    computed_at: new Date().toISOString(),
  };
}

// Follow-up = COUNT of: ERROR agents + unexpected canary fails + freshness breaches + blocked tasks
// Authority: real-state query every cycle — no manual field, no carry-forward.
function computeFollowUp(agentList, freshnessList, blockedTasks) {
  let count = 0;
  const items = [];

  // 1. Agents in ERROR state (live/cron agents only)
  const liveAgents  = agentList.filter(a => !a.type || a.type === 'live');
  liveAgents.filter(a => a.status === 'error').forEach(a => {
    count++;
    items.push({ type: 'agent_error', name: a.name });
  });

  // 2. Unexpected canary fails (known_fail excluded — those are tracked, not followed-up)
  try {
    const state = JSON.parse(fs.readFileSync(CANARY_STATE_FILE, 'utf8'));
    Object.entries(state)
      .filter(([name, v]) => !KNOWN_FAIL_CANARIES.has(name) && !v.ok)
      .forEach(([name]) => { count++; items.push({ type: 'canary_fail', name }); });
  } catch {}

  // 3. Freshness breaches (stale status from source_freshness — single authority)
  (freshnessList || []).filter(s => s.status === 'stale').forEach(s => {
    count++;
    items.push({ type: 'freshness_breach', name: s.source });
  });

  // 4. Blocked tasks from TASKS.md
  (blockedTasks || []).forEach(t => {
    count++;
    items.push({ type: 'blocked_task', name: (t.text || '').slice(0, 60) });
  });

  return { count, items };
}

const healthResult  = computeHealthScore(agents, sourceFreshness, cron);
const followUpResult = computeFollowUp(agents, sourceFreshness, tasks.blockedItems);

// ── Portal coverage — reads latest report from ~/SaSMaster/reports/ ──────────
function loadPortalCoverage() {
  try {
    const reportsDir = path.join(SASMASTER, 'reports');
    const files = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith('portal-coverage-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) return null;
    const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8'));
    return {
      baseline: raw.baseline || 'unknown',
      portal_url: raw.portal_url || '',
      report_date: files[0].replace('portal-coverage-', '').replace('.json', ''),
      summary: raw.summary || {},
    };
  } catch { return null; }
}
const portalCoverage = loadPortalCoverage();

const status = {
  generated:    new Date().toISOString(),
  generated_at: new Date().toISOString(),  // alias — Railway health check reads this
  system:    { jarvis: { alive: jarvisAlive() } },

  queue: {
    high:         tasks.high,
    med:          tasks.med,
    highItems:    tasks.highItems,
    medItems:     tasks.medItems,
    exploreItems: tasks.exploreItems,
    wipItems:     tasks.wipItems,
    blockedItems: tasks.blockedItems,
    reviewItems:  tasks.reviewItems,
  },
  kanban,
  heatmap,
  target10: parseTarget10(),
  agents,
  recentBuilds,
  intel_feed:  intelFeed,
  claudeUsage: { claudeai: null, claudecode: null, claudedesign: null, claudemax: null },
  alerts,

  // ── New fields for v3 War Room ──
  scrapers,
  s3_lake,
  movie_universe: movieUniverse,
  kpis:                (() => {
    const kpis = buildKPIs(agents, scrapers, s3_lake, tasks, parentKeyScraper, buildEventsCount, haikuPctToday, warroomS3Total);
    kpis.builds_7d       = buildTrends?.builds_7d   || 0;
    kpis.error_rate_7d   = buildTrends?.error_rate   || 0;
    return kpis;
  })(),
  build_trends:        buildTrends,
  recent_activity:     buildMergedActivity(intelFeed, recentBuilds, scrapers, buildEventsToday),
  cron,
  tasks:               buildTasksForV3(kanban),
  recent_completions:  recentBuilds.map(b => ({
    title: b.task,
    category: (b.task || '').toLowerCase().includes('portal') ? 'Portal'
            : (b.task || '').toLowerCase().includes('scraper') || (b.task || '').toLowerCase().includes('edgar') ? 'Pipeline'
            : (b.task || '').toLowerCase().includes('agent') ? 'Agent'
            : 'Build',
    path: '',
    completed_at: b.date || '',
  })),
  slack_feed:  buildSlackFeed(recentBuilds, intelFeed),
  cost_summary: costSummary,
  portal_coverage: portalCoverage,
  usage_state: usageState,
  token_projection: tokenProjection,
  source_freshness: sourceFreshness,

  // ── TRUTHFUL-VITALS-001 — derived from first principles every cycle ──────────
  // health.score / health.grade / health.components are the SINGLE authoritative
  // health truth. Frontend reads d.health.score — never computes its own formula.
  health:          healthResult,
  // follow_up_count is the SINGLE authoritative follow-up count.
  // Frontend reads d.follow_up_count — never derives its own count from kanban.
  follow_up_count: followUpResult.count,
  follow_up_items: followUpResult.items,

  // ASK platform config — key is server-side only (Vercel env), never in status.json
  // War Room calls /api/ask (Vercel proxy) which holds the key; no key flows to client.
  ask: {
    url:     '/api/ask',  // always the Vercel proxy — never Railway URL directly
    enabled: true,        // proxy is always wired; Railway liveness is its own check
  },
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);

// Push to S3 — two paths so Railway heartbeat can promote without cross-prefix IAM
try {
  execSync(`/opt/homebrew/bin/aws s3 cp "${OUT}" s3://sasmaster-2026/status/status.json --content-type application/json`, { stdio: 'pipe' });
  console.log(`[generate-status] pushed to s3://sasmaster-2026/status/status.json`);
} catch (e) {
  console.warn(`[generate-status] S3 push failed (non-fatal): ${e.message}`);
}
try {
  execSync(`/opt/homebrew/bin/aws s3 cp "${OUT}" s3://sasmaster-2026/cache/api/status.json --content-type application/json`, { stdio: 'pipe' });
  console.log(`[generate-status] pushed to s3://sasmaster-2026/cache/api/status.json`);
} catch (e) {
  console.warn(`[generate-status] S3 cache/api push failed (non-fatal): ${e.message}`);
}

// Push skills manifest mirror to public bucket (SKILL-REGISTRY-002)
// sasmaster-public has BPA off + public-read policy; sasmaster-2026 BPA stays fully ON
const MANIFEST_SRC = path.join(__dirname, 'resources', 'skills-manifest.json');
if (fs.existsSync(MANIFEST_SRC)) {
  try {
    execSync(
      `/opt/homebrew/bin/aws s3 cp "${MANIFEST_SRC}" s3://sasmaster-public/skills-manifest.json --content-type application/json`,
      { stdio: 'pipe' }
    );
    console.log(`[generate-status] pushed skills manifest to s3://sasmaster-public/skills-manifest.json`);
  } catch (e) {
    console.warn(`[generate-status] skills manifest S3 push failed (non-fatal): ${e.message}`);
  }
}
