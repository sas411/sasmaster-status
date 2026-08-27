// Vercel serverless route: GET /api/work-queue
//
// WARROOM-WORKQUEUE-001 — the one work_queue model, exposed at the one
// endpoint every one of CANVAS/AGENTS/QUEUE/OPS calls (C6, VERIFY "one
// model"). No surface computes its own count from a second source.
//
// Sources (house pattern — same as api/costs.js/api/status.js: serverless
// functions here never read the local repo filesystem at runtime, they fetch
// live data the same way the browser would):
//   - status.json — s3://sasmaster-2026/status/status.json (same object
//     api/status.js already serves; generated locally by generate-status.js,
//     which this card also touched — see its parsePending() `openedAt` line
//     for the `review` kind's real timestamp).
//   - bless queue  — https://sasmaster-public.s3.amazonaws.com/catalog/index.json
//     (public, unauthenticated — same URL warroom-v5.html's fetchTodayPiece()
//     already reads client-side for CANVAS TODAY).
//
// Both fetches are independent: a catalog outage does not blank the other
// three kinds, and a status.json outage fails the whole response (blocked_agent,
// review, and ops_task all derive from it) — reported via lib/safe_upstream_error
// (§23/§41, consumed unmodified, never forked).

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const { sanitize } = require('../lib/safe_upstream_error');
const WorkQueue = require('../lib/work-queue');
const WarroomRender = require('../lib/warroom-render');
const WarroomClock = require('../lib/warroom-clock');
const cadenceRegistry = require('../warroom/cadence-registry.json');

const STATUS_S3_BUCKET = 'sasmaster-2026';
const STATUS_S3_KEY = 'status/status.json';
const CATALOG_URL = 'https://sasmaster-public.s3.amazonaws.com/catalog/index.json';

const UPSTREAM = 'aws_s3';
const PUBLIC_LABEL = 'work_queue';

function fetchJsonHttps(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs || 8000 }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        reject(new Error('catalog fetch HTTP ' + resp.statusCode));
        return;
      }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('catalog fetch timeout')); });
    req.on('error', reject);
  });
}

async function fetchStatusJson() {
  const region = process.env.AWS_REGION || 'us-east-1';
  const s3 = new S3Client({ region });
  const resp = await s3.send(new GetObjectCommand({ Bucket: STATUS_S3_BUCKET, Key: STATUS_S3_KEY }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

async function fetchCatalog() {
  try {
    const idx = await fetchJsonHttps(CATALOG_URL);
    if (!idx || !Array.isArray(idx.entries)) {
      return { ok: false, query_id: 'bless-catalog-shape', reason: 'catalog index.json missing entries array' };
    }
    return { ok: true, entries: idx.entries };
  } catch (e) {
    return { ok: false, query_id: 'bless-catalog-fetch-failed', reason: e.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const [statusJson, catalog] = await Promise.all([fetchStatusJson(), fetchCatalog()]);

    const model = WorkQueue.assemble({
      now: WarroomClock.nowUtc(),
      catalog: catalog,
      agents: statusJson.agents || [],
      reviewRows: (statusJson.kanban && statusJson.kanban.review) || [],
      highItems: (statusJson.queue && statusJson.queue.highItems) || [],
      cadenceRegistry: cadenceRegistry,
      formatOpsQueueItem: WarroomRender.formatOpsQueueItem,
      renderStates: WarroomRender.STATE
    });

    res.status(200).json(model);
  } catch (err) {
    const { status, body, log } = sanitize(err, {
      upstream: UPSTREAM,
      publicLabel: PUBLIC_LABEL,
      publicMessage: 'Work queue is temporarily unavailable.',
      refPrefix: 'wkq',
    });
    try { console.error(JSON.stringify(log)); } catch (_) { /* never mask the fault */ }
    res.status(status).json(body);
  }
};
