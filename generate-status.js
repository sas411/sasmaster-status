#!/usr/bin/env node
/**
 * generate-status.js — writes status.json for the live status page
 * Run after every build via on-complete.sh
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SASMASTER = path.join(process.env.HOME, 'SaSMaster');
const OUT       = path.join(__dirname, 'status.json');

// ── JARVIS online check ──────────────────────────────────────────────────────
function jarvisOnline() {
  try {
    const plist = 'com.sasmaster.jarvis';
    const out = execSync(`launchctl list ${plist} 2>/dev/null`, { encoding: 'utf8' });
    return out.includes(plist);
  } catch { return false; }
}

// ── Parse TASKS.md ───────────────────────────────────────────────────────────
function parseTasks() {
  const file = path.join(SASMASTER, 'TASKS.md');
  if (!fs.existsSync(file)) return { high: [], all_count: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const high = lines
    .filter(l => /\[HIGH\]/i.test(l) && /^\s*-/.test(l))
    .map(l => l.replace(/^\s*-\s*/, '').trim())
    .slice(0, 8);
  const all_count = lines.filter(l => /^\s*-/.test(l)).length;
  return { high, all_count };
}

// ── Parse DONE_LOG.md — last 5 entries ──────────────────────────────────────
function parseDoneLog() {
  const file = path.join(SASMASTER, 'DONE_LOG.md');
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const entries = content.split('---').map(b => b.trim()).filter(Boolean);
  return entries.slice(-5).reverse().map(block => {
    const date  = (block.match(/Date:\s*(.+)/) || [])[1]?.trim() || '';
    const task  = (block.match(/Task:\s*(.+)/) || [])[1]?.trim() || '';
    const notes = (block.match(/Notes:\s*([\s\S]+?)(?:\n[A-Z]|$)/) || [])[1]?.trim().slice(0, 120) || '';
    return { date, task, notes };
  }).filter(e => e.task);
}

// ── Agent fleet status ───────────────────────────────────────────────────────
function agentStatus() {
  const LOG = path.join(SASMASTER, 'logs');
  const agents = [
    { name: 'JARVIS',         log: 'jarvis.log',          label: 'Socket Mode Daemon' },
    { name: 'Media Intel',    log: 'media-intel.log',     label: 'Evan + M&E feeds' },
    { name: 'TMDB Trending',  log: 'tmdb-agent.log',      label: 'Content trends' },
    { name: 'DoneLog Analyst',log: 'donelog-analyst.log', label: 'Portal gap filler' },
    { name: 'LinkedIn Agent', log: 'linkedin-agent.log',  label: 'Post drafts' },
  ];

  return agents.map(a => {
    const logFile = path.join(LOG, a.log);
    if (!fs.existsSync(logFile)) return { ...a, last_run: null, status: 'never' };
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const last = lines[lines.length - 1] || '';
    const tsMatch = last.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const last_run = tsMatch ? tsMatch[1] : null;
    const error = /error|fatal/i.test(last);
    return { ...a, last_run, status: error ? 'error' : 'ok' };
  });
}

// ── Pending approvals ────────────────────────────────────────────────────────
function pendingApprovals() {
  const file = path.join(SASMASTER, 'pending-approvals.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

// ── Write status.json ────────────────────────────────────────────────────────
const status = {
  generated_at: new Date().toISOString(),
  jarvis_online: jarvisOnline(),
  tasks: parseTasks(),
  recent_done: parseDoneLog(),
  agents: agentStatus(),
  pending_approvals: pendingApprovals(),
};

fs.writeFileSync(OUT, JSON.stringify(status, null, 2));
console.log(`[generate-status] wrote status.json — ${new Date().toISOString()}`);
