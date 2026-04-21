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

// ── Target 10 ────────────────────────────────────────────────────────────────
function parseTarget10() {
  const file = path.join(SASMASTER, 'target10.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).filter(t => t.name);
  } catch { return []; }
}

// ── Assemble + write ─────────────────────────────────────────────────────────
const tasks         = parseTasks();
const { entries: recentBuilds, heatmap } = parseDoneLog();
const reviewItems   = parsePending();

const status = {
  generated: new Date().toISOString(),
  system:    { jarvis: { alive: jarvisAlive() } },
  queue: {
    high:        tasks.high,
    med:         tasks.med,
    highItems:   tasks.highItems,
    medItems:    tasks.medItems,
    exploreItems: tasks.exploreItems,
  },
  kanban: {
    backlog:    [...tasks.medItems, ...tasks.exploreItems],
    inProgress: [],
    review:     reviewItems,
    done:       recentBuilds.map((b, i) => ({ id: `done-${i}`, text: b.task, full: b.task, sprint: '', tag: 'DONE', priority: 'DONE' })),
  },
  heatmap,
  target10: parseTarget10(),
  agents:       parseAgents(),
  recentBuilds,
  claudeUsage:  { claudeai: null, claudecode: null, claudedesign: null, claudemax: null },
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);
