const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const TrendStore = require('./trends');
const WeatherLog = require('./weather-log');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../client')));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Trend store & weather log (persistent, never autopruned)
const trendStore = new TrendStore(path.join(DATA_DIR, 'trends.json'));
trendStore.load();
const weatherLog = new WeatherLog(path.join(DATA_DIR, 'weather-log.json'));
weatherLog.load();

// State received from client
let currentState = null;
// JSON of currentState, built on the first GET after each push (readers
// often poll faster than the client pushes; the state is several MB)
let currentStateJson = null;
let eventLog = [];
let metrics = [];

// Full parameterHistory per entity id. The client sends only new entries
// each push (parameterHistory grows for an entity's whole lifetime).
let parameterHistories = new Map();

// Rebuild each entity's full parameterHistory from the pushed delta, in place.
// Entity shape served by GET /api/state is unchanged. Returns true if the
// server is missing earlier entries (e.g. after a restart) and needs a full resend.
function mergeParameterHistories(state) {
  if (!Array.isArray(state.entities)) return false;
  const next = new Map();
  let missing = false;
  for (const e of state.entities) {
    const from = e.parameterHistoryFrom || 0; // absent = full history (older clients)
    delete e.parameterHistoryFrom;
    const delta = Array.isArray(e.parameterHistory) ? e.parameterHistory : [];
    let full = delta;
    if (from > 0) {
      const prev = parameterHistories.get(e.id);
      if (prev && prev.length === from) {
        prev.push(...delta);
        full = prev;
      } else if (prev && prev.length > from) {
        // Re-sent from an older base (previous response was lost)
        full = prev.slice(0, from).concat(delta);
      } else {
        missing = true;
      }
    }
    e.parameterHistory = full;
    next.set(e.id, full);
  }
  parameterHistories = next;
  return missing;
}

// Client pushes state to server periodically
app.post('/api/state', (req, res) => {
  const resendFullHistory = mergeParameterHistories(req.body);
  currentState = req.body;
  currentState.receivedAt = Date.now();
  currentStateJson = null;
  // Detect weather events by diffing consecutive state snapshots
  weatherLog.detectAndLog(currentState);
  res.json(resendFullHistory ? { ok: true, resendFullHistory: true } : { ok: true });
});

// Client pushes events
app.post('/api/events', (req, res) => {
  const newEvents = req.body.events || [];
  eventLog.push(...newEvents);
  if (eventLog.length > 10000) eventLog = eventLog.slice(-10000);
  res.json({ ok: true, count: newEvents.length });
});

// Client pushes metrics snapshot
app.post('/api/metrics', (req, res) => {
  metrics.push(req.body);
  if (metrics.length > 2000) metrics = metrics.slice(-2000);
  // Feed into trend store for RRD-style persistence
  trendStore.push(req.body);
  res.json({ ok: true });
});

// === READ API (for Qlaude via web_fetch) ===

app.get('/api/state', (req, res) => {
  if (!currentState) return res.json({ status: 'no data yet' });
  if (currentStateJson === null) currentStateJson = JSON.stringify(currentState);
  res.type('json').send(currentStateJson);
});

app.get('/api/events', (req, res) => {
  const since = req.query.since ? parseInt(req.query.since) : 0;
  const filtered = eventLog.filter(e => e.tick > since);
  res.json({ events: filtered, total: filtered.length });
});

app.get('/api/metrics', (req, res) => {
  res.json({ snapshots: metrics });
});

app.get('/api/history', (req, res) => {
  if (!currentState || !currentState.contextMap) {
    return res.json({ status: 'no data yet' });
  }
  res.json({ contextMap: currentState.contextMap });
});

app.get('/api/config', (req, res) => {
  if (!currentState) return res.json({ status: 'no data yet' });
  res.json({ config: currentState.config || {} });
});

// Param validation ranges for set_params API
const PARAM_RANGES = {
  ticksPerFrame: { min: 1, max: 5 },
  bondRadius: { min: 20, max: 80 },
  bondDuration: { min: 20, max: 120 },
  disruptionThreshold: { min: 0.3, max: 0.9 },
  disruptionRadius: { min: 40, max: 150 },
  disruptionRegenCap: { min: 0.3, max: 1.0 },
  bondHardeningAge: { min: 50, max: 500 },
  bondHardeningResistance: { min: 0.05, max: 0.5 },
  bondRestDistance: { min: 10, max: 60 },
  bondedSociabilityFloor: { min: 0.0, max: 0.4 },
  bondedVolatilityFloor: { min: 0.0, max: 0.4 },
  spawnThreshold: { min: 3, max: 10 },
  communityThreshold: { min: 0.2, max: 0.8 },
  lonelinessThreshold: { min: 200, max: 800 },
  crushThreshold: { min: 6, max: 20 },
  maxPopulation: { min: 100, max: 800 },
  maxAge: { min: 5000, max: 50000 },
  halfLifeTicks: { min: 1000, max: 20000 },
  trailDecayRate: { min: 0.001, max: 0.01 },
  seasonLength: { min: 2000, max: 50000 },
  seasonAmplitude: { min: 0.0, max: 1.0 },
  currentCount: { min: 0, max: 5 },
  currentStrength: { min: 0.0, max: 1.0 },
  currentWidth: { min: 50, max: 500 },
  currentLifetime: { min: 1000, max: 20000 },
  currentSpawnRate: { min: 0.0001, max: 0.002 },
  bloomSpawnRate: { min: 0.00005, max: 0.001 },
  bloomRadiusMin: { min: 50, max: 200 },
  bloomRadiusMax: { min: 100, max: 400 },
  bloomLifetimeMin: { min: 500, max: 5000 },
  bloomLifetimeMax: { min: 1000, max: 10000 },
  bloomIntensity: { min: 0.5, max: 3.0 },
  bloomMax: { min: 0, max: 5 },
  stormSpawnRate: { min: 0.00002, max: 0.0005 },
  stormRadiusMin: { min: 40, max: 200 },
  stormRadiusMax: { min: 80, max: 400 },
  stormLifetimeMin: { min: 300, max: 3000 },
  stormLifetimeMax: { min: 500, max: 5000 },
  stormIntensity: { min: 0.5, max: 3.0 },
  stormMax: { min: 0, max: 3 },
  // Hue drift
  hueDriftRate: { min: 0.0, max: 0.1 },
  hueDriftBondForm: { min: 0.0, max: 5.0 },
  hueDriftBondBreak: { min: 0.0, max: 5.0 },
  hueDriftDisruption: { min: 0.0, max: 2.0 },
  hueDriftTravel: { min: 0.0, max: 1.0 },
  // Size variance
  sizeGrowthDuration: { min: 100, max: 3000 },
  sizeBondScale: { min: 0.0, max: 0.5 },
  // Parameter overhaul
  cabinFeverThreshold: { min: 100, max: 2000 },
  cabinFeverRate: { min: 0.00005, max: 0.002 },
  homeostasisRate: { min: 0.0, max: 0.001 },
  volatilityFloor: { min: 0.0, max: 0.3 },
  inertiaCeiling: { min: 0.5, max: 1.0 },
  bondAffinityCeiling: { min: 0.5, max: 1.0 },
  disruptionPostFireDrop: { min: 0.05, max: 0.8 },
  driftNoiseScale: { min: 0.0, max: 0.01 },
  noveltyThreshold: { min: 200, max: 5000 },
  noveltyBoost: { min: 0.0, max: 0.1 },
  // Bond topology
  secondDegreeStrength: { min: 0.0, max: 1.0 },
  sharedNeighborBonus: { min: 0.0, max: 0.5 },
  secondDegreeMaxRange: { min: 50, max: 400 },
  introductionFactor: { min: 0.0, max: 0.8 },
};

// Qlaude can adjust parameters
app.post('/api/params', (req, res) => {
  const validated = {};
  const errors = [];

  for (const [key, value] of Object.entries(req.body)) {
    const range = PARAM_RANGES[key];
    if (!range) {
      errors.push(`Unknown param: ${key}`);
      continue;
    }
    const num = Number(value);
    if (isNaN(num)) {
      errors.push(`${key}: not a number`);
      continue;
    }
    validated[key] = Math.max(range.min, Math.min(range.max, num));
  }

  if (Object.keys(validated).length > 0) {
    const paramsFile = path.join(DATA_DIR, 'pending-params.json');
    fs.writeFileSync(paramsFile, JSON.stringify(validated));
  }

  res.json({
    ok: true,
    message: 'Params queued for next client poll',
    applied: validated,
    errors: errors.length > 0 ? errors : undefined
  });
});

// Qlaude can send control commands
app.post('/api/control', (req, res) => {
  const controlFile = path.join(DATA_DIR, 'pending-control.json');
  fs.writeFileSync(controlFile, JSON.stringify(req.body));
  res.json({ ok: true });
});

app.get('/api/control', (req, res) => {
  const controlFile = path.join(DATA_DIR, 'pending-control.json');
  if (fs.existsSync(controlFile)) {
    const data = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    fs.unlinkSync(controlFile);
    res.json(data);
  } else {
    res.json({ command: null });
  }
});

app.get('/api/pending-params', (req, res) => {
  const paramsFile = path.join(DATA_DIR, 'pending-params.json');
  if (fs.existsSync(paramsFile)) {
    const data = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
    fs.unlinkSync(paramsFile);
    res.json(data);
  } else {
    res.json({});
  }
});

// Full state save/load for persistence across restarts.
// Saves are several MB: write asynchronously so the event loop keeps serving,
// one save at a time so concurrent saves can't interleave writes to latest.json.
let saveQueue = Promise.resolve();

app.post('/api/save', (req, res) => {
  const saveType = req.body._saveType || 'manual'; // default to manual for direct API calls
  delete req.body._saveType; // Don't persist the meta flag
  const prefix = saveType === 'manual' ? 'save' : 'auto';
  const filename = `${prefix}-state-${Date.now()}.json`;
  const filepath = path.join(DATA_DIR, filename);
  const json = JSON.stringify(req.body); // compact — no pretty-print
  saveQueue = saveQueue
    .then(async () => {
      await fs.promises.writeFile(filepath, json);
      await fs.promises.writeFile(path.join(DATA_DIR, 'latest.json'), json);
      await pruneAutoSaves();
    })
    .then(
      () => res.json({ ok: true, filename }),
      err => {
        console.warn('save error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
      }
    );
});

app.get('/api/load', async (req, res) => {
  // latest.json is compact JSON written by /api/save: send it as-is rather
  // than parsing and re-serializing several MB
  try {
    const data = await fs.promises.readFile(path.join(DATA_DIR, 'latest.json'));
    res.type('json').send(data);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('load error:', err.message);
    res.json({ status: 'no saved state' });
  }
});

app.get('/api/saves', (req, res) => {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && (f.startsWith('auto-state-') || f.startsWith('save-state-') || f.startsWith('state-')))
    .sort()
    .reverse();
  res.json({ saves: files });
});

// ── Trend & Weather API ───────────────────────────────────────────────

app.get('/api/trends', (req, res) => {
  const tier = req.query.tier || 'all';
  const since = req.query.since ? parseInt(req.query.since) : undefined;
  const last_n = req.query.last_n ? parseInt(req.query.last_n) : undefined;
  res.json(trendStore.query({ tier, since, last_n }));
});

app.get('/api/weather-log', (req, res) => {
  const since = req.query.since ? parseInt(req.query.since) : undefined;
  const type = req.query.type || undefined;
  const last_n = req.query.last_n ? parseInt(req.query.last_n) : 50;
  res.json(weatherLog.query({ since, type, last_n }));
});

// ── Auto-save pruning ─────────────────────────────────────────────────
const DISK_CAP_BYTES = 100 * 1024 * 1024; // 100MB

async function pruneAutoSaves() {
  try {
    const names = (await fs.promises.readdir(DATA_DIR))
      .filter(f => f.endsWith('.json') && f !== 'latest.json' && f !== 'pending-params.json' && f !== 'pending-control.json' && f !== 'trends.json' && f !== 'weather-log.json');
    const files = (await Promise.all(names.map(async f => {
      const fp = path.join(DATA_DIR, f);
      const stat = await fs.promises.stat(fp);
      return { name: f, path: fp, size: stat.size, mtime: stat.mtimeMs };
    }))).sort((a, b) => a.mtime - b.mtime); // oldest first

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize <= DISK_CAP_BYTES) return;

    // Delete oldest files first (regardless of prefix) until under cap
    // Always keep the 2 most recent files
    const deletable = files.slice(0, -2);
    let currentTotal = totalSize;
    for (const f of deletable) {
      if (currentTotal <= DISK_CAP_BYTES) break;
      await fs.promises.unlink(f.path);
      currentTotal -= f.size;
    }
  } catch (err) {
    console.warn('pruneAutoSaves error:', err.message);
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────

function shutdown() {
  console.log('\nSaving trend store and weather log...');
  trendStore.save();
  weatherLog.save();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => console.log(`Molequle server running on http://localhost:${PORT}`));
