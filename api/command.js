// Vercel serverless proxy — forwards War Room action requests to api.sasmaster.dev
// Token lives in Vercel env vars, never exposed to the browser

const https = require('https');

const UPSTREAM = 'api.sasmaster.dev';
const TOKEN = process.env.COMMAND_API_TOKEN;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!TOKEN) { res.status(503).json({ error: 'COMMAND_API_TOKEN not configured in Vercel env' }); return; }

  // path comes from query: /api/command?path=/trigger
  const path = req.query.path || '/health';
  const allowed = ['/trigger', '/add-task', '/logs', '/queue', '/jobs', '/health', '/status', '/done-log', '/tasks', '/approvals', '/api/scoop', '/cost-log'];
  if (!allowed.some(p => path.startsWith(p))) {
    res.status(403).json({ error: 'path not allowed' }); return;
  }

  const url = `https://${UPSTREAM}${path}`;
  const body = req.method === 'POST' ? JSON.stringify(req.body) : undefined;

  try {
    const r = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      ...(body ? { body } : {}),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'upstream unreachable', detail: err.message });
  }
};
