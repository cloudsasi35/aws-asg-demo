'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const http = require('http');
const { Worker } = require('worker_threads');

const PORT = process.env.PORT || 3000;
const IMDS_HOST = '169.254.169.254';
const IMDS_TOKEN_TTL = '300';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory cache for EC2 instance metadata (IMDSv2)
// ---------------------------------------------------------------------------
const instanceMeta = {
  instanceId: 'unknown',
  privateIp: 'unknown',
  availabilityZone: 'unknown',
  instanceType: 'unknown',
  region: 'unknown',
  fetchedAt: null,
};

function imdsRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`IMDS ${options.path} -> HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('IMDS timeout')));
    req.end();
  });
}

async function getImdsToken() {
  return imdsRequest({
    host: IMDS_HOST,
    path: '/latest/api/token',
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': IMDS_TOKEN_TTL },
  });
}

async function getMetadataItem(token, itemPath) {
  return imdsRequest({
    host: IMDS_HOST,
    path: `/latest/meta-data/${itemPath}`,
    method: 'GET',
    headers: { 'X-aws-ec2-metadata-token': token },
  });
}

async function refreshInstanceMetadata() {
  try {
    const token = await getImdsToken();
    const [instanceId, privateIp, az, instanceType] = await Promise.all([
      getMetadataItem(token, 'instance-id'),
      getMetadataItem(token, 'local-ipv4'),
      getMetadataItem(token, 'placement/availability-zone'),
      getMetadataItem(token, 'instance-type'),
    ]);
    instanceMeta.instanceId = instanceId.trim();
    instanceMeta.privateIp = privateIp.trim();
    instanceMeta.availabilityZone = az.trim();
    instanceMeta.instanceType = instanceType.trim();
    instanceMeta.region = az.trim().replace(/[a-z]$/i, '');
    instanceMeta.fetchedAt = new Date().toISOString();
    console.log(`[imds] metadata refreshed: ${instanceMeta.instanceId} ${instanceMeta.privateIp}`);
  } catch (err) {
    // Likely running outside EC2 (local dev). Fill with sensible defaults.
    instanceMeta.instanceId = process.env.INSTANCE_ID || 'i-local-dev';
    instanceMeta.privateIp =
      Object.values(os.networkInterfaces())
        .flat()
        .find((n) => n && n.family === 'IPv4' && !n.internal)?.address || '127.0.0.1';
    instanceMeta.availabilityZone = process.env.AZ || 'local';
    instanceMeta.instanceType = process.env.INSTANCE_TYPE || 'local';
    instanceMeta.region = process.env.AWS_REGION || 'local';
    instanceMeta.fetchedAt = new Date().toISOString();
    console.warn(`[imds] using local fallback: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// CPU usage sampling (process-wide, averaged over a 1s window)
// ---------------------------------------------------------------------------
let cpuUsagePercent = 0;
function sampleCpu() {
  const startUsage = process.cpuUsage();
  const startTime = Date.now();
  setTimeout(() => {
    const elapsedMs = Date.now() - startTime;
    const diff = process.cpuUsage(startUsage); // microseconds
    const totalCpuMs = (diff.user + diff.system) / 1000;
    const cores = os.cpus().length || 1;
    const pct = (totalCpuMs / (elapsedMs * cores)) * 100;
    cpuUsagePercent = Math.min(100, Math.max(0, Number(pct.toFixed(1))));
  }, 1000);
}
setInterval(sampleCpu, 2000);
sampleCpu();

// ---------------------------------------------------------------------------
// Background CPU load workers
// ---------------------------------------------------------------------------
const activeJobs = new Map(); // id -> { size, startedAt, endsAt, workers: [] }
let jobCounter = 0;

const LOAD_PRESETS = {
  long: { label: 'Load (15m)', durationSec: 15 * 60 },
};

function startLoad(size) {
  const preset = LOAD_PRESETS[size];
  if (!preset) throw new Error(`unknown load size: ${size}`);

  const id = `job-${++jobCounter}`;
  const cores = Math.max(1, os.cpus().length);
  const workers = [];
  const startedAt = Date.now();
  const endsAt = startedAt + preset.durationSec * 1000;

  for (let i = 0; i < cores; i++) {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { durationMs: preset.durationSec * 1000 },
    });
    worker.on('error', (err) => console.error(`[${id}] worker error:`, err.message));
    worker.on('exit', () => {
      const job = activeJobs.get(id);
      if (!job) return;
      job.workers = job.workers.filter((w) => w !== worker);
      if (job.workers.length === 0) {
        activeJobs.delete(id);
        console.log(`[${id}] completed`);
      }
    });
    workers.push(worker);
  }

  activeJobs.set(id, { id, size, label: preset.label, startedAt, endsAt, workers });
  console.log(`[${id}] started ${preset.label} for ${preset.durationSec}s on ${cores} workers`);
  return { id, size, label: preset.label, durationSec: preset.durationSec };
}

function listJobs() {
  const now = Date.now();
  return Array.from(activeJobs.values()).map((j) => ({
    id: j.id,
    size: j.size,
    label: j.label,
    startedAt: new Date(j.startedAt).toISOString(),
    endsAt: new Date(j.endsAt).toISOString(),
    remainingSec: Math.max(0, Math.ceil((j.endsAt - now) / 1000)),
    workers: j.workers.length,
  }));
}

async function stopAllLoads() {
  const jobs = Array.from(activeJobs.values());
  let terminated = 0;
  await Promise.all(
    jobs.flatMap((job) =>
      job.workers.map((w) =>
        w.terminate().then(() => {
          terminated++;
        }).catch(() => {})
      )
    )
  );
  activeJobs.clear();
  console.log(`[reset] terminated ${terminated} worker(s) across ${jobs.length} job(s)`);
  return { jobs: jobs.length, workers: terminated };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/api/info', (_req, res) => {
  res.json({
    hostname: os.hostname(),
    instanceId: instanceMeta.instanceId,
    privateIp: instanceMeta.privateIp,
    availabilityZone: instanceMeta.availabilityZone,
    instanceType: instanceMeta.instanceType,
    region: instanceMeta.region,
    cpuUsagePercent,
    cpuCores: os.cpus().length,
    loadAverage: os.loadavg(),
    uptimeSec: Math.round(process.uptime()),
    serverTime: new Date().toISOString(),
    activeJobs: listJobs(),
  });
});

app.post('/api/load/:size', (req, res) => {
  const size = req.params.size;
  if (!LOAD_PRESETS[size]) {
    return res.status(400).json({ error: `invalid size '${size}'. use small|medium|heavy` });
  }
  try {
    const job = startLoad(size);
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset', async (_req, res) => {
  try {
    const result = await stopAllLoads();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.render('index', {
    hostname: os.hostname(),
    instance: instanceMeta,
    cpuUsagePercent,
    cpuCores: os.cpus().length,
    serverTime: new Date().toISOString(),
    activeJobs: listJobs(),
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

(async () => {
  await refreshInstanceMetadata();
  app.listen(PORT, () => {
    console.log(`aws-asg-demo listening on port ${PORT}`);
    console.log(`instance: ${instanceMeta.instanceId} (${instanceMeta.privateIp}) ${instanceMeta.availabilityZone}`);
  });
})();
