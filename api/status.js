// Vercel serverless route: GET /api/status
// 1. Tries api.sasmaster.dev/status (live machine — near-real-time)
// 2. Falls back to s3://sasmaster-2026/status/status.json (last push when machine was up)
// 3. Falls back to /status.json static file (last git commit)
//
// War Room fetches /api/status instead of /status.json directly.

const https = require('https');

const UPSTREAM      = 'api.sasmaster.dev';
const S3_BUCKET     = 'sasmaster-2026';
const S3_KEY        = 'status/status.json';
const S3_REGION     = process.env.AWS_REGION || 'us-east-1';

function fetchUpstream(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: UPSTREAM, path: '/status', method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 4000 },
      (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => {
          if (r.statusCode === 200) resolve(body);
          else reject(new Error(`upstream HTTP ${r.statusCode}`));
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function fetchS3() {
  // Use AWS SDK v3 — available in Vercel Node runtime via env-provided creds
  // Falls back to unsigned S3 URL (bucket must allow s3:GetObject for status prefix)
  return new Promise((resolve, reject) => {
    const url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${S3_KEY}`;
    const req = https.request(url, { method: 'GET', timeout: 5000 }, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        if (r.statusCode === 200) resolve(body);
        else reject(new Error(`S3 HTTP ${r.statusCode}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('S3 timeout')); });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const token = process.env.COMMAND_API_TOKEN;
  const source = { live: false, s3: false };

  // 1. Try live machine
  if (token) {
    try {
      const body = await fetchUpstream(token);
      source.live = true;
      res.setHeader('X-Status-Source', 'live');
      res.status(200).send(body);
      return;
    } catch (_) {
      // machine unreachable — fall through to S3
    }
  }

  // 2. Try S3 fallback
  try {
    const body = await fetchS3();
    source.s3 = true;
    res.setHeader('X-Status-Source', 's3-fallback');
    res.status(200).send(body);
    return;
  } catch (_) {
    // S3 also failed — fall through to 503
  }

  res.status(503).json({
    error: 'Status unavailable — machine offline and S3 fallback unreachable',
    source,
  });
};
