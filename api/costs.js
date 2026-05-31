// Vercel serverless route: GET /api/costs
// Fetches latest.json from s3://sasmaster-2026/_observe/costs/latest.json
// Pattern matches api/status.js — unsigned S3 URL (bucket must allow s3:GetObject on _observe/costs/)

const https = require('https');

const S3_BUCKET = 'sasmaster-2026';
const S3_KEY    = '_observe/costs/latest.json';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';

function fetchS3Costs() {
  return new Promise((resolve, reject) => {
    const url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${S3_KEY}`;
    const req = https.request(url, { method: 'GET', timeout: 6000 }, (r) => {
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

  try {
    const body = await fetchS3Costs();
    const data = JSON.parse(body);
    // Mark source so War Room can show "live" vs "stale"
    res.setHeader('X-Cost-Source', 'live');
    res.status(200).json(data);
  } catch (err) {
    res.status(503).json({ error: 'costs unavailable', detail: err.message });
  }
};
