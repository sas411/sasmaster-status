// Vercel serverless proxy — forwards War Room action requests to api.sasmaster.dev
// Token lives in Vercel env vars, never exposed to the browser

const https = require('https');

const UPSTREAM = 'api.sasmaster.dev';
const TOKEN = process.env.COMMAND_API_TOKEN;
const CLIENT_TOKEN = process.env.WARROOM_CLIENT_TOKEN;

// Paths that mutate state or trigger jobs — every one of these MUST require the client token.
// Read-only paths stay open to the dashboard's unauthenticated polling until Vercel Deployment
// Protection is enabled on the project (WARROOM-SEC-001, blocked on Vercel plan/permissions as
// of 2026-08-03 — see project memory).
const MUTATING_PREFIXES = ['/trigger', '/add-task', '/canvas/bless', '/canvas/annotate', '/jarvis', '/financial/rebuild', '/api/fix-queue'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://sasmaster-status.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!TOKEN) { res.status(503).json({ error: 'COMMAND_API_TOKEN not configured in Vercel env' }); return; }

  // path comes from query: /api/command?path=/trigger
  const path = req.query.path || '/health';
  const allowed = ['/trigger', '/add-task', '/logs', '/queue', '/jobs', '/health', '/status', '/done-log', '/tasks', '/approvals', '/api/scoop', '/cost-log', '/api/events/recent', '/api/build-log/recent', '/api/fix-queue', '/api/jobs', '/canvas', '/jarvis', '/financial'];
  if (!allowed.some(p => path.startsWith(p))) {
    res.status(403).json({ error: 'path not allowed' }); return;
  }

  const isMutating = req.method === 'POST' || MUTATING_PREFIXES.some(p => path.startsWith(p));
  if (isMutating) {
    if (!CLIENT_TOKEN) { res.status(503).json({ error: 'WARROOM_CLIENT_TOKEN not configured in Vercel env' }); return; }
    const auth = req.headers['authorization'] || '';
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (supplied !== CLIENT_TOKEN) {
      res.status(401).json({ error: 'unauthorized — valid Bearer token required for this action' }); return;
    }
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
    // Pass retry-after header through so browser apiFetch wrapper can back off correctly
    if (r.status === 429) {
      const retryAfter = r.headers.get('retry-after') || '60';
      res.setHeader('retry-after', retryAfter);
      res.status(429).json({ error: 'rate_limited', retry_after: parseInt(retryAfter, 10) });
      return;
    }
    let data;
    const text = await r.text();
    try { data = JSON.parse(text); }
    catch { data = { error: `upstream returned non-JSON (HTTP ${r.status})`, body: text.slice(0, 300) }; }
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'upstream unreachable', detail: err.message });
  }
};
