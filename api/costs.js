// Vercel serverless route: GET /api/costs
// Fetches latest.json from s3://sasmaster-2026/_observe/costs/latest.json
// Uses AWS SDK v3 signed request — no public bucket policy needed.
// Requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION in Vercel env.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const S3_BUCKET = 'sasmaster-2026';
const S3_KEY    = '_observe/costs/latest.json';

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
    res.status(503).json({ error: 'costs unavailable', detail: err.message });
  }
};
