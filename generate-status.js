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
// `jobId` maps to Command API /trigger VALID_JOBS — null means no Run button.
// `channel` is the primary Slack destination — used by UI without a hardcoded map.
function parseAgents() {
  const LOG = path.join(SASMASTER, 'logs');
  const agents = [
    { name: 'JARVIS',            icon: '🤖', schedule: '24/7 daemon',   nextRun: 'Always on',       log: 'jarvis.log',            channel: '24/7 daemon',        jobId: null },
    { name: 'Media Intel',       icon: '📡', schedule: '6AM daily',     nextRun: 'Tomorrow 6AM',    log: 'media-intel.log',       channel: '#sasmaster-intel',   jobId: 'media-intel' },
    { name: 'TMDB Daily',        icon: '📺', schedule: '5AM daily',     nextRun: 'Tomorrow 5AM',    log: 'tmdb-agent.log',        channel: '#sasmaster-intel',   jobId: 'tmdb-daily' },
    { name: 'DoneLog Analyst',   icon: '📊', schedule: 'Post-build',    nextRun: 'Post 12AM build', log: 'donelog-analyst.log',   channel: '#sasmaster-builds',  jobId: null },
    { name: 'LinkedIn Agent',    icon: '✍️',  schedule: 'Monday 8PM',   nextRun: 'Mon 8PM',         log: 'linkedin-agent.log',    channel: '#sasmaster-content', jobId: 'linkedin-agent' },
    { name: 'SEC EDGAR',         icon: '📑', schedule: '6:30 AM daily', nextRun: 'Tomorrow 6:30 AM',log: 'sec-edgar.log',         channel: '#sasmaster-intel',   jobId: null },
    { name: 'Tech Intel',        icon: '🛰️', schedule: 'Friday 6PM',   nextRun: 'Fri 6PM',         log: 'tech-intel.log',        channel: '#sasmaster-intel',   jobId: 'tech-intel' },
    { name: 'Financial Analyst', icon: '💰', schedule: 'Sunday 8PM',   nextRun: 'Sun 8PM',         log: 'financial-analyst.log', channel: '#sasmaster-intel',   jobId: null },
    { name: 'Weekly Review',     icon: '🗂️', schedule: 'Sunday 8PM',   nextRun: 'Sun 8PM',         log: 'weekly-review.log',     channel: '#sasmaster-builds',  jobId: 'weekly-review' },
    { name: 'IAB Intel',         icon: '📡', schedule: 'Monday 7AM',   nextRun: 'Mon 7AM',         log: 'iab-agent.log',         channel: '#sasmaster-intel',   jobId: 'iab-intel' },
  ];

  return agents.map(a => {
    const logFile = path.join(LOG, a.log);
    if (!fs.existsSync(logFile)) return { ...a, lastRun: null, lastOutput: null, status: 'never' };

    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const last  = lines[lines.length - 1] || '';

    const tsMatch = last.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const lastRun = tsMatch ? tsMatch[1] : null;

    const summary = last.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/, '')
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

// ── S3 entity counts (from scripts/s3-entity-counts.js cache) ────────────────
function parseS3EntityCounts() {
  const file = path.join(SASMASTER, 'status', 's3-entity-counts.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).prefixes || {}; }
  catch { return {}; }
}

// ── S3 Freshness (age in hours per key prefix) ───────────────────────────────
// Uses `aws s3 ls --recursive` on each prefix, picks the most-recent object.
// Returns a map: { 'tmdb_dev/': { age_hours: 3.2, fresh: true }, ... }
// Safe — returns empty map if aws CLI unavailable or any prefix times out.
function getS3Freshness(prefixes = []) {
  const result = {};
  for (const prefix of prefixes) {
    try {
      const out = execSync(
        `aws s3 ls s3://sasmaster-2026/${prefix} --recursive | sort | tail -1`,
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
function buildScrapers(tmdbProgress, doneEntries, s3Inv, agents) {
  const prefix = name => (s3Inv?.prefixes || []).find(p => p.prefix === name) || {};
  const agentByName = {};
  (agents || []).forEach(a => { agentByName[a.name] = a; });

  const tmdbP   = prefix('tmdb_dev/');
  const imdbP   = prefix('imdb/');
  const imdbPrd = prefix('imdb_prd/');
  const pkP     = prefix('parent_keys/');
  const nielsenP = prefix('Nielsen/');
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
      row_count: 206444399, // measured at Phase 1 milestone 2026-04-22
      last_run: imdbP.last_modified || logMtime('imdb-parse.log'),
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
      status: eidrP.object_count > 0 ? 'landing' : 'designed',
      pct: null,
      last_run: eidrP.last_modified || null,
      row_count: null,
    },
    { name: 'Rights scraper', phase: '1b', status: 'designed', pct: 0, last_run: null },
    // ── Phase 2a — Interim snapshots via RSG API bridge
    {
      name: 'Nielsen snapshot',
      phase: '2a',
      status: nielsenP.object_count > 0 ? 'landing' : 'queued',
      pct: null,
      last_run: nielsenP.last_modified || null,
      size_gb: nielsenP.size_gb || null,
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
    'Nielsen/':      { label: 'Nielsen/',           phase: '2a', status_hint: 'landing' },
    'gracenote/':    { label: 'gracenote/',         phase: '2a', status_hint: 'landing' },
    'fyi/':          { label: 'fyi/',               phase: '2a', status_hint: 'landing' },
    'opus/':         { label: 'opus/',              phase: '2a', status_hint: 'landing' },
    'eidr/':         { label: 'eidr/',              phase: '1b', status_hint: 'landing' },
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
      entities: {
        movies:    ec.movies    ?? null,
        tv_series: ec.tv_series ?? null,
        episodes:  ec.episodes  ?? null,
        people:    ec.people    ?? null,
        telecasts: ec.telecasts ?? null,
      },
      note: ec.note || null,
    };
  });
}

// ── Build events (Layer 7 audit trail) ───────────────────────────────────────
// Reads today's build-YYYY-MM-DD.jsonl written by runner.py.
// Returns structured events for the recent_activity feed.
function getBuildEvents() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const file = path.join(SASMASTER, 'logs', `build-${today}.jsonl`);
  if (!fs.existsSync(file)) return { events: [], count: 0 };

  try {
    const lines = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const events = lines.slice(-20).map(e => {
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

      return {
        type,
        text:      text.slice(0, 120),
        ts:        e.ts || '',
        layer:     'APP',
        component: 'build-auto',
      };
    });

    return { events, count: lines.filter(e => e.kind !== 'run_summary').length };
  } catch { return { events: [], count: 0 }; }
}

// ── KPIs (derived) ───────────────────────────────────────────────────────────
function buildKPIs(agents, scrapers, s3_lake, tasks, pk, buildEventsCount) {
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
    build_events_today: buildEventsCount || 0,
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
const reviewItems   = parsePending();
const intelFeed     = parseIntelFeed();
const alerts        = parseAlerts();
const agents        = parseAgents();
const tmdbProgress  = parseTMDBProgress();
const s3Inv         = parseS3Inventory();
const entityCounts  = parseS3EntityCounts();
const scrapers      = buildScrapers(tmdbProgress, recentBuilds, s3Inv, agents);

// Compute freshness for each known S3 prefix (silent on AWS CLI failure)
const s3FreshnessPrefixes = (s3Inv?.prefixes || []).map(p => p.prefix);
const s3Freshness = getS3Freshness(s3FreshnessPrefixes);

const s3_lake       = buildS3Lake(scrapers, s3Inv, entityCounts, s3Freshness);
const cronJobsRaw   = parseCrontab();
const cron          = enrichCronStatus(cronJobsRaw, agents);

// Layer 7: build audit trail events
const { events: buildEventsToday, count: buildEventsCount } = getBuildEvents();

const kanban = {
  backlog:    [...tasks.medItems, ...tasks.exploreItems],
  inProgress: [],
  review:     reviewItems,
  done:       recentBuilds.map((b, i) => ({ id: `done-${i}`, text: b.task, full: b.task, sprint: '', tag: 'DONE', priority: 'DONE' })),
};

const parentKeyScraper = scrapers.find(s => s.name === 'SAS-MASTER Parent Key v1');

// Merge build events (prepend) + existing slack_feed events (append), cap at 25
function buildMergedActivity(intelFeed, recentBuilds, scrapers, buildEvents) {
  const existing = buildRecentActivity(intelFeed, recentBuilds, scrapers);
  return [...buildEvents, ...existing].slice(0, 25);
}

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
  kpis:                buildKPIs(agents, scrapers, s3_lake, tasks, parentKeyScraper, buildEventsCount),
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
  slack_feed: buildSlackFeed(recentBuilds, intelFeed),
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);
