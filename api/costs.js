// Vercel serverless route: GET /api/costs
// Fetches latest.json from s3://sasmaster-2026/_observe/costs/latest.json
// Uses AWS SDK v3 signed request — no public bucket policy needed.
// Requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION in Vercel env.
//
// SC2-P0-AWSKEY-001 Track B (2026-08-27): was `res.status(503).json({error:'costs
// unavailable', detail: err.message})` — the AWS SDK's raw provider error string
// (currently "The AWS Access Key Id you provided does not exist in our records.")
// reached an unauthenticated public response verbatim, confirmed live. Routed through
// the shared sanitizer (api/work-queue.js's own precedent) — never forked, per that
// module's own §23 ownership note.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { sanitize } = require('../lib/safe_upstream_error');

const S3_BUCKET = 'sasmaster-2026';
const S3_KEY    = '_observe/costs/latest.json';
const UPSTREAM = 'aws_s3';
const PUBLIC_LABEL = 'costs';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const region = process.env.AWS_REGION || 'us-east-1';
  const s3 = new S3Client({ region });

  try {
    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: S3_KEY });
    const resp = await s3.send(cmd);

    // Stream body to string
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf-8');

    const data = JSON.parse(body);
    res.setHeader('X-Cost-Source', 'live');
    res.status(200).json(data);
  } catch (err) {
    const { status, body: errBody, log } = sanitize(err, {
      upstream: UPSTREAM,
      publicLabel: PUBLIC_LABEL,
      publicMessage: 'Cost data is temporarily unavailable.',
      refPrefix: 'cst',
    });
    try { console.error(JSON.stringify(log)); } catch (_) { /* never mask the fault */ }
    res.status(status).json(errBody);
  }
};
