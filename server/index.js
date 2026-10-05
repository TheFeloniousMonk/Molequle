const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { pathToFileURL } = require('url');
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

// Tunable parameter ranges and client defaults live in client/js/params.js
// (an ES module shared with the client); loaded at startup, before listening.
let PARAM_RANGES = {};
let DEFAULT_CONFIG = {};

// Published for API clients (the MCP server validates against this)
app.get('/api/param-ranges', (req, res) => {
  const params = {};
  for (const [key, range] of Object.entries(PARAM_RANGES)) {
    params[key] = { ...range, default: DEFAULT_CONFIG[key] };
  }
  res.json({ params });
});

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
    if (range.type === 'enum') {
      if (!range.values.includes(value)) {
        errors.push(`${key}: must be one of ${range.values.join(', ')}`);
        continue;
      }
      validated[key] = value;
      continue;
    }
    if (range.type === 'boolean') {
      if (value === true || value === 'true') validated[key] = true;
      else if (value === false || value === 'false') validated[key] = false;
      else errors.push(`${key}: must be true or false`);
      continue;
    }
    const num = typeof value === 'boolean' ? NaN : Number(value);
    if (isNaN(num)) {
      errors.push(`${key}: not a number`);
      continue;
    }
    const clamped = Math.max(range.min, Math.min(range.max, num));
    validated[key] = range.integer ? Math.round(clamped) : clamped;
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
  // Seed in the filename so saves can be told apart by world (filename-safe chars only)
  const seed = req.body.seed != null ? String(req.body.seed).replace(/[^A-Za-z0-9_]/g, '') : '';
  const filename = `${prefix}-state-${Date.now()}${seed ? `-seed-${seed}` : ''}.json`;
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

// ── Trend & weather persistence ───────────────────────────────────────
// Both stores otherwise save only when enough new data arrives, so anything
// since their last save is lost if the server is stopped without a graceful
// shutdown (e.g. killed while no client is pushing). Save on a timer, and on
// request before a restart.

const PERSIST_INTERVAL_MS = Number(process.env.PERSIST_INTERVAL_MS) || 5 * 60 * 1000;

function persistHistory() {
  const saved = [];
  const failed = [];
  if (trendStore.unsaved > 0) (trendStore.save() ? saved : failed).push('trends');
  if (weatherLog.unflushed > 0) (weatherLog.save() ? saved : failed).push('weatherLog');
  return { saved, failed };
}

setInterval(persistHistory, PERSIST_INTERVAL_MS).unref();

// Save trends and the weather log now (call before stopping the server)
app.post('/api/flush', (req, res) => {
  const { saved, failed } = persistHistory();
  res.status(failed.length ? 500 : 200).json({ ok: failed.length === 0, saved, failed });
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

import(pathToFileURL(path.join(__dirname, '../client/js/params.js')).href)
  .then(params => {
    PARAM_RANGES = params.PARAM_RANGES;
    DEFAULT_CONFIG = params.DEFAULT_CONFIG;
    // The client only applies keys present in its config: catch a range added without a default
    const orphans = Object.keys(PARAM_RANGES).filter(k => !(k in DEFAULT_CONFIG));
    if (orphans.length) throw new Error(`params.js: ranges without defaults: ${orphans.join(', ')}`);
    app.listen(PORT, () => console.log(`Molequle server running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Failed to load client/js/params.js:', err);
    process.exit(1);
  });
