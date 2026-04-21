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

  const extract = (tag) => lines
    .filter(l => new RegExp(`\\[${tag}\\]`, 'i').test(l) && /^\s*-/.test(l))
    .map(l => l.replace(/^\s*-\s*\[.*?\]\s*/i, '').replace(/—\s*injected.*$/i, '').trim())
    .filter(Boolean);

  const highItems    = extract('HIGH').slice(0, 8);
  const medItems     = extract('MED').slice(0, 6);
  const exploreItems = extract('EXPLORE').slice(0, 4);

  return {
    high:        highItems.length,
    med:         medItems.length,
    highItems,
    medItems,
    exploreItems,
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
    return JSON.parse(fs.readFileSync(PENDING, 'utf8'))
      .map(p => p.description || p.type || 'Pending item');
  } catch { return []; }
}

// ── Agent fleet ──────────────────────────────────────────────────────────────
function parseAgents() {
  const LOG = path.join(SASMASTER, 'logs');
  const agents = [
    { name: 'JARVIS',          icon: '🤖', schedule: '24/7 daemon',  log: 'jarvis.log' },
    { name: 'Media Intel',     icon: '📡', schedule: '6AM daily',     log: 'media-intel.log' },
    { name: 'TMDB Trending',   icon: '📺', schedule: '12AM nightly',  log: 'tmdb-agent.log' },
    { name: 'DoneLog Analyst', icon: '📊', schedule: 'Post-build',    log: 'donelog-analyst.log' },
    { name: 'LinkedIn Agent',  icon: '✍️', schedule: 'Monday 8PM',   log: 'linkedin-agent.log' },
  ];

  return agents.map(a => {
    const logFile = path.join(LOG, a.log);
    if (!fs.existsSync(logFile)) return { ...a, lastRun: null, status: 'never' };
    const lines   = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const last    = lines[lines.length - 1] || '';
    const tsMatch = last.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const lastRun = tsMatch ? tsMatch[1] : null;
    const error   = /error|fatal/i.test(last);
    return { ...a, lastRun, status: error ? 'error' : 'healthy' };
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
    inProgress: [],        // populated when JARVIS flags active build
    review:     reviewItems,
    done:       recentBuilds.map(b => b.task),
  },
  heatmap,
  target10: parseTarget10(),
  agents:       parseAgents(),
  recentBuilds,
  claudeUsage:  { claudeai: null, claudecode: null, claudedesign: null, claudemax: null },
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);
