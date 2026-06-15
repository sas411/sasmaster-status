// Vercel serverless route: POST /api/ask
// Proxies to Railway ASK service, holding ASK_API_KEY server-side.
// War Room calls /api/ask instead of Railway directly — key never reaches client.
//
// Env vars (Vercel project settings, server-side only):
//   ASK_RAILWAY_URL  — Railway ASK base URL
//   ASK_API_KEY      — x-api-key header value for Railway ASK auth
//
// CORS: same-origin only (Vercel domain) — no cross-origin access to this proxy.

const https = require('https');
const { URL } = require('url');

const RAILWAY_URL = process.env.ASK_RAILWAY_URL || 'https://sasmaster-ask-production.up.railway.app';
const API_KEY     = process.env.ASK_API_KEY     || '';
const TIMEOUT_MS  = 29000; // Vercel function limit is 30s; leave 1s headroom

function upstream(path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, RAILWAY_URL);
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type':  'application/json',
      'x-api-key':     API_KEY,
      'x-forwarded-by': 'vercel-ask-proxy',
      ...headers,
    };
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(
      { hostname: target.hostname, path: target.pathname + target.search,
        method, headers: reqHeaders, timeout: TIMEOUT_MS },
      (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve({ status: r.statusCode, body: data, headers: r.headers }));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = async (req, res) => {
  // CORS — allow same Vercel origin only
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!API_KEY) {
    return res.status(503).json({ error: 'ASK proxy not configured — ASK_API_KEY missing' });
  }

  // Route: POST /api/ask → POST /ask on Railway
  //        GET  /api/ask?path=/catalog → GET /catalog on Railway
  const proxyPath = req.query.path || '/ask';

  try {
    let body = null;
    if (req.method === 'POST') {
      // Collect body (Vercel doesn't stream by default)
      body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
      });
    }

    const result = await upstream(proxyPath, req.method, body, {});

    // Pass through content-type from Railway
    const ct = result.headers['content-type'] || 'application/json';
    res.setHeader('Content-Type', ct);
    res.status(result.status).send(result.body);
  } catch (e) {
    console.error('[ask-proxy] upstream error:', e.message);
    res.status(502).json({ error: 'ASK upstream unavailable', detail: e.message });
  }
};
