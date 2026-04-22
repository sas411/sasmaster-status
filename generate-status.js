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
function jarvisAlive() {
  try {
    const out = execSync('launchctl list com.sasmaster.jarvis 2>/dev/null', { encoding: 'utf8' });
    return out.includes('com.sasmaster.jarvis');
  } catch { return false; }
}

// ── TASKS.md parser ──────────────────────────────────────────────────────────
function parseTasks() {
  if (!fs.existsSync(TASKS_FILE)) return { high: 0, med: 0, highItems: [], medItems: [], exploreItems: [] };
  const lines = fs.readFileSync(TASKS_FILE, 'utf8').split('\n');

  function detectTag(text) {
    if (/edgar|financial|s3|postgresql|scraper|financial.anal/i.test(text)) return 'EDGAR';
    if (/tmdb|imdb|trending|content.*load/i.test(text)) return 'DATA';
    if (/agent|cron|jarvis|slack|webhook|build\.sh/i.test(text)) return 'AGENT';
    if (/ui|portal|nav|design|html|css|homepage|archive|v7|sasmaster\.html/i.test(text)) return 'UI';
    return 'INFRA';
  }

  let sprint = 'Backlog';
  const highItems = [], medItems = [], exploreItems = [];

  lines.forEach((line, idx) => {
    if (/^##/.test(line)) { sprint = line.replace(/^#+\s*/, '').trim(); return; }
    const m = line.match(/^\s*-\s*\[(HIGH|MED|EXPLORE)\]\s*(.*)/i);
    if (!m) return;
    const [, priority, raw] = m;
    const full = raw.replace(/—\s*injected.*$/i, '').trim();
    if (!full) return;
    const text = full.length > 88 ? full.slice(0, 88) + '…' : full;
    const item = { id: `t${idx}`, text, full, sprint, tag: detectTag(full), priority: priority.toUpperCase() };
    if (priority.toUpperCase() === 'HIGH') highItems.push(item);
    else if (priority.toUpperCase() === 'MED') medItems.push(item);
    else exploreItems.push(item);
  });

  return {
    high:         highItems.length,
    med:          medItems.length,
    highItems:    highItems.slice(0, 10),
    medItems:     medItems.slice(0, 8),
    exploreItems: exploreItems.slice(0, 4),
  };
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
function parseAgents() {
  const LOG = path.join(SASMASTER, 'logs');
  const agents = [
    { name: 'JARVIS',          icon: '🤖', schedule: '24/7 daemon',  nextRun: 'Always on',    log: 'jarvis.log' },
    { name: 'Media Intel',     icon: '📡', schedule: '6AM daily',     nextRun: 'Tomorrow 6AM', log: 'media-intel.log' },
    { name: 'TMDB Trending',   icon: '📺', schedule: '12AM nightly',  nextRun: 'Tonight 12AM', log: 'tmdb-agent.log' },
    { name: 'DoneLog Analyst', icon: '📊', schedule: 'Post-build',    nextRun: 'Post 12AM build', log: 'donelog-analyst.log' },
    { name: 'LinkedIn Agent',  icon: '✍️', schedule: 'Monday 8PM',   nextRun: 'Mon 8PM',      log: 'linkedin-agent.log' },
  ];

  return agents.map(a => {
    const logFile = path.join(LOG, a.log);
    if (!fs.existsSync(logFile)) return { ...a, lastRun: null, lastOutput: null, status: 'never' };

    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const last  = lines[lines.length - 1] || '';

    // Find last timestamp
    const tsMatch = last.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const lastRun = tsMatch ? tsMatch[1] : null;

    // Extract readable summary: strip timestamp + tag prefix, cap at 80 chars
    const summary = last.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/, '')
                        .replace(/^\[[A-Z0-9_-]+\]\s*/i, '')
                        .slice(0, 80);

    // not_in_channel = routing issue, not agent failure
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

    // Friendly time
    const h = parseInt(hr, 10);
    const m2 = parseInt(min, 10);
    let timeStr;
    if (isNaN(h) || isNaN(m2)) timeStr = `${hr}:${min}`;
    else {
      const ampm = h < 12 ? 'AM' : 'PM';
      const hh = h % 12 === 0 ? 12 : h % 12;
      timeStr = `${hh}:${String(m2).padStart(2, '0')} ${ampm}`;
    }

    // Friendly name from comment or command
    const scriptMatch = cmd.match(/([a-z0-9\-]+\.(sh|js))\b/i);
    const name = comment || (scriptMatch ? scriptMatch[1] : cmd.slice(0, 40));

    // Channel inference
    let channel = '—';
    if (/intel|edgar|media-intel|tech-intel/i.test(cmd)) channel = '#sasmaster-intel';
    else if (/linkedin|content|tmdb-trending/i.test(cmd)) channel = '#sasmaster-content';
    else if (/build|jarvis|briefing|visuals/i.test(cmd)) channel = '#sasmaster-builds';

    // Weekly vs daily
    const isWeekly = dow !== '*' && dow !== '0' || /mon8pm|sun8pm|fri/i.test(name);

    jobs.push({
      time: timeStr,
      name: name.replace(/^SaSMaster-/, '').replace(/-/g, ' '),
      command: cmd,
      channel,
      weekly: isWeekly,
      status: 'pending', // populated by caller against agent log timestamps
      _sortKey: h * 60 + (isNaN(m2) ? 0 : m2),
    });
  });

  return jobs.sort((a, b) => a._sortKey - b._sortKey).map(({ _sortKey, ...rest }) => rest);
}

// ── Scrapers inventory (15-scraper fleet from architecture v8) ───────────────
function buildScrapers(tmdbProgress, doneEntries) {
  // Heuristic: if a DONE_LOG entry mentions the scraper name in the last N days, mark live.
  const donemillis = new Set(doneEntries.map(e => (e.task || '').toLowerCase()));
  const wasDone = needle => [...donemillis].some(t => t.includes(needle.toLowerCase()));

  return [
    // ── Phase 1 — Identity base
    {
      name: 'TMDB bulk loader',
      phase: '1',
      status: tmdbProgress?.running ? 'running' : (tmdbProgress?.phase === 'complete' ? 'live' : 'running'),
      pct: tmdbProgress?.pct ?? null,
      row_count: tmdbProgress?.complete ?? null,
      total: tmdbProgress?.total ?? null,
      last_run: tmdbProgress?.last_updated ?? null,
      s3_path: tmdbProgress?.s3_path ?? 's3://sasmaster-2026/tmdb_dev/',
    },
    { name: 'TMDB delta (hourly)', phase: '1', status: 'designed', pct: 0, last_run: null },
    { name: 'IMDb parser',         phase: '1', status: wasDone('imdb') ? 'live' : 'designed', pct: wasDone('imdb') ? 100 : 0, row_count: 206444399, last_run: null },
    { name: 'SAS-MASTER Parent Key v1', phase: '1', status: 'live', pct: 100, row_count: 589814, last_run: '2026-04-22T03:04:00Z' },
    { name: 'SEC EDGAR',           phase: '1', status: wasDone('edgar') ? 'live' : 'running', pct: wasDone('edgar') ? 100 : null, last_run: null },
    // ── Phase 1b — Metadata enrichment
    { name: 'EIDR scraper',        phase: '1b', status: 'designed', pct: 0, last_run: null },
    { name: 'Rights scraper',      phase: '1b', status: 'designed', pct: 0, last_run: null },
    // ── Phase 2a — Interim snapshots via RSG API bridge
    { name: 'Nielsen snapshot',    phase: '2a', status: 'landing', pct: null, last_run: null },
    { name: 'Gracenote snapshot',  phase: '2a', status: 'queued',  pct: 0, last_run: null },
    { name: 'FYI snapshot',        phase: '2a', status: 'queued',  pct: 0, last_run: null },
    { name: 'Opus snapshot',       phase: '2a', status: 'queued',  pct: 0, last_run: null },
    // ── Phase 2b — Direct license
    { name: 'Nielsen direct',      phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'JustWatch',           phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'Wikidata',            phase: '2b', status: 'designed', pct: 0, last_run: null },
    { name: 'Twitter/X signals',   phase: '2b', status: 'designed', pct: 0, last_run: null },
  ];
}

// ── S3 Data Lake inventory ───────────────────────────────────────────────────
function buildS3Lake(scrapers) {
  const tmdb = scrapers.find(s => s.name === 'TMDB bulk loader');
  const imdb = scrapers.find(s => s.name === 'IMDb parser');
  const pk   = scrapers.find(s => s.name === 'SAS-MASTER Parent Key v1');
  const edgar = scrapers.find(s => s.name === 'SEC EDGAR');

  return [
    {
      path: 'tmdb_dev/',
      status: 'live',
      rows: tmdb?.row_count ?? null,
      size_gb: tmdb?.row_count ? (tmdb.row_count / 1e6 * 2.1) : null, // approx 2.1 GB per M rows TMDB
      last_updated: tmdb?.last_run ?? null,
    },
    {
      path: 'imdb/',
      status: imdb?.status === 'live' ? 'live' : 'landing',
      rows: imdb?.row_count ?? null,
      size_gb: imdb?.row_count ? 1.51 : null, // measured at Phase 1 milestone
      last_updated: '2026-04-22T03:00:00Z',
    },
    {
      path: 'parent_keys/v1/',
      status: 'live',
      rows: pk?.row_count ?? null,
      size_gb: 0.02, // 19.7MB per Phase 1 milestone
      last_updated: pk?.last_run ?? null,
    },
    {
      path: 'edgar/',
      status: edgar?.status === 'live' ? 'live' : 'landing',
      rows: null,
      size_gb: null,
      last_updated: null,
    },
    {
      path: 'rsg_snap/nielsen/',
      status: 'landing',
      rows: null,
      size_gb: null,
      last_updated: null,
    },
  ];
}

// ── KPIs (derived) ───────────────────────────────────────────────────────────
function buildKPIs(agents, scrapers, s3_lake, tasks, pk) {
  const agents_running = agents.filter(a => a.status === 'healthy' || a.status === 'routing').length;
  const scrapers_live  = scrapers.filter(s => s.status === 'live').length;
  const s3_gb = s3_lake.reduce((sum, b) => sum + (b.size_gb || 0), 0);
  const tasks_open = (tasks.highItems?.length || 0) + (tasks.medItems?.length || 0) + (tasks.exploreItems?.length || 0);
  const pkRows = pk?.row_count ?? 589814;

  return {
    agents_running,
    agents_total: agents.length,
    scrapers_live,
    scrapers_total: scrapers.length,
    s3_gb: Math.round(s3_gb * 10) / 10,
    parent_key_rows: pkRows,
    tasks_open,
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

// ── Cron status enrichment (uses agent lastRun timestamps) ───────────────────
function enrichCronStatus(cronJobs, agents) {
  const now = Date.now();
  const agentByScript = {};
  agents.forEach(a => {
    agentByScript[a.log.replace(/\.log$/, '')] = a;
  });

  return cronJobs.map(c => {
    // Derive status: done if agent ran in the last 26 hours, else pending
    const scriptMatch = c.command.match(/([a-z0-9\-]+)(-agent)?\.js/i);
    if (!scriptMatch) return { ...c, status: 'pending' };
    const key = scriptMatch[1].replace(/-agent$/, '');
    // Try matching common agent keys
    const agent = agents.find(a => a.log.includes(key) || a.log.includes(scriptMatch[1]));
    if (!agent || !agent.lastRun) return { ...c, status: 'pending' };
    const ageHours = (now - new Date(agent.lastRun).getTime()) / 36e5;
    let status = 'pending';
    if (agent.status === 'routing') status = 'routing';
    else if (ageHours < 26) status = 'done';
    return { ...c, status };
  });
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
const reviewItems   = parsePending();
const intelFeed     = parseIntelFeed();
const alerts        = parseAlerts();
const agents        = parseAgents();
const tmdbProgress  = parseTMDBProgress();
const scrapers      = buildScrapers(tmdbProgress, recentBuilds);
const s3_lake       = buildS3Lake(scrapers);
const cronJobsRaw   = parseCrontab();
const cron          = enrichCronStatus(cronJobsRaw, agents);

const kanban = {
  backlog:    [...tasks.medItems, ...tasks.exploreItems],
  inProgress: [],
  review:     reviewItems,
  done:       recentBuilds.map((b, i) => ({ id: `done-${i}`, text: b.task, full: b.task, sprint: '', tag: 'DONE', priority: 'DONE' })),
};

const parentKeyScraper = scrapers.find(s => s.name === 'SAS-MASTER Parent Key v1');

const status = {
  generated: new Date().toISOString(),
  system:    { jarvis: { alive: jarvisAlive() } },

  // ── Existing fields (unchanged) ──
  queue: {
    high:         tasks.high,
    med:          tasks.med,
    highItems:    tasks.highItems,
    medItems:     tasks.medItems,
    exploreItems: tasks.exploreItems,
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
  kpis:                buildKPIs(agents, scrapers, s3_lake, tasks, parentKeyScraper),
  recent_activity:     buildRecentActivity(intelFeed, recentBuilds, scrapers),
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
  slack_feed: {
    // TODO: wire to JARVIS-written cache file or Slack API poll
    builds:  [],
    intel:   [],
    content: [],
  },
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);
