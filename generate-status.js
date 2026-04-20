#!/usr/bin/env node
/**
 * generate-status.js — writes status.json for sasmaster-status v3
 * Schema matches sasmaster-status-v3.html expectations
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SASMASTER = path.join(process.env.HOME, 'SaSMaster');
const OUT       = path.join(__dirname, 'status.json');

// ── JARVIS online check ──────────────────────────────────────────────────────
function jarvisAlive() {
  try {
    const out = execSync('launchctl list com.sasmaster.jarvis 2>/dev/null', { encoding: 'utf8' });
    return out.includes('com.sasmaster.jarvis');
  } catch { return false; }
}

// ── Parse TASKS.md ───────────────────────────────────────────────────────────
function parseQueue() {
  const file = path.join(SASMASTER, 'TASKS.md');
  if (!fs.existsSync(file)) return { high: 0, med: 0, highItems: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const highItems = lines
    .filter(l => /\[HIGH\]/i.test(l) && /^\s*-/.test(l))
    .map(l => l.replace(/^\s*-\s*\[HIGH\]\s*/i, '').trim())
    .slice(0, 8);
  const med = lines.filter(l => /\[MED\]/i.test(l) && /^\s*-/.test(l)).length;
  return { high: highItems.length, med, highItems };
}

// ── Parse DONE_LOG.md — last 10 entries ─────────────────────────────────────
function parseRecentBuilds() {
  const file = path.join(SASMASTER, 'DONE_LOG.md');
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const entries = content.split('---').map(b => b.trim()).filter(Boolean);
  return entries.slice(-10).reverse().map(block => {
    const date   = (block.match(/Date:\s*(.+)/) || [])[1]?.trim() || '';
    const task   = (block.match(/Task:\s*(.+)/) || [])[1]?.trim() || '';
    const notes  = (block.match(/Notes:\s*([\s\S]+?)(?:\n[A-Z]|$)/) || [])[1]?.trim().slice(0, 120) || '';
    return { task, date, notes, status: 'DONE' };
  }).filter(e => e.task);
}

// ── Agent fleet ──────────────────────────────────────────────────────────────
function parseAgents() {
  const LOG = path.join(SASMASTER, 'logs');
  const agents = [
    { name: 'JARVIS',          icon: '🤖', schedule: '24/7 daemon',      log: 'jarvis.log' },
    { name: 'Media Intel',     icon: '📡', schedule: '6AM daily',         log: 'media-intel.log' },
    { name: 'TMDB Trending',   icon: '📺', schedule: '12AM nightly',      log: 'tmdb-agent.log' },
    { name: 'DoneLog Analyst', icon: '📊', schedule: 'Post-build',        log: 'donelog-analyst.log' },
    { name: 'LinkedIn Agent',  icon: '✍️', schedule: 'Monday 8PM',        log: 'linkedin-agent.log' },
  ];

  return agents.map(a => {
    const logFile = path.join(LOG, a.log);
    if (!fs.existsSync(logFile)) return { ...a, lastRun: null, status: 'never' };
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const last  = lines[lines.length - 1] || '';
    const tsMatch = last.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const lastRun = tsMatch ? tsMatch[1] : null;
    const error = /error|fatal/i.test(last);
    return { ...a, lastRun, status: error ? 'error' : 'healthy' };
  });
}

// ── Write status.json ────────────────────────────────────────────────────────
const status = {
  generated: new Date().toISOString(),
  system: {
    jarvis: { alive: jarvisAlive() }
  },
  queue:        parseQueue(),
  agents:       parseAgents(),
  recentBuilds: parseRecentBuilds(),
  claudeUsage: {
    claudeai:     null,
    claudecode:   null,
    claudedesign: null,
    claudemax:    null
  }
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);
