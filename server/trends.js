const fs = require('fs');
const path = require('path');

// Fields that get SUMMED during rollup (not averaged)
const SUM_FIELDS = ['births', 'deaths', 'disruptions'];
// Fields that take the LATEST value during rollup
const LATEST_FIELDS = ['season'];
// All other numeric fields get averaged

class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = [];
    this.writePtr = 0;
    this.full = false;
  }

  push(entry) {
    if (this.capacity === Infinity) {
      // Unlimited tier (Tier 3)
      this.buffer.push(entry);
      return;
    }
    if (!this.full) {
      this.buffer.push(entry);
      if (this.buffer.length >= this.capacity) this.full = true;
      this.writePtr = this.buffer.length % this.capacity;
    } else {
      this.buffer[this.writePtr] = entry;
      this.writePtr = (this.writePtr + 1) % this.capacity;
    }
  }

  // Return entries in chronological order
  entries() {
    if (this.capacity === Infinity || !this.full) return this.buffer.slice();
    // Ring is full: oldest is at writePtr, wrap around
    return this.buffer.slice(this.writePtr).concat(this.buffer.slice(0, this.writePtr));
  }

  // Get last N entries in chronological order
  lastN(n) {
    const all = this.entries();
    return n >= all.length ? all : all.slice(-n);
  }

  size() {
    return this.buffer.length;
  }

  toJSON() {
    return { capacity: this.capacity, buffer: this.buffer, writePtr: this.writePtr, full: this.full };
  }

  static fromJSON(data) {
    const rb = new RingBuffer(data.capacity === null ? Infinity : data.capacity);
    rb.buffer = data.buffer || [];
    rb.writePtr = data.writePtr || 0;
    rb.full = data.full || false;
    return rb;
  }
}

function normalizeSnapshot(raw) {
  const avg = raw.avgParams || {};
  const std = raw.paramStdDev || {};
  const weather = raw.weather || {};
  const season = weather.season || {};

  return {
    tick: raw.tick || 0,
    timestamp: new Date().toISOString(),
    population: raw.population || 0,
    bonds: raw.bonds || 0,
    births: raw.births || 0,
    deaths: raw.deaths || 0,
    disruptions: raw.disruptionEvents || 0,
    mean_S: avg.sociability || 0,
    mean_I: avg.inertia || 0,
    mean_V: avg.volatility || 0,
    mean_B: avg.bondAffinity || 0,
    mean_D: avg.disruptionCharge || 0,
    std_S: std.sociability || 0,
    std_I: std.inertia || 0,
    std_V: std.volatility || 0,
    std_B: std.bondAffinity || 0,
    std_D: std.disruptionCharge || 0,
    fertile_cells: raw.fertileCount || 0,
    scarred_cells: raw.scarredCount || 0,
    ghost_cells: raw.ghostCount || 0,
    season: season.name || raw.season || '',
    warmth: season.warmth != null ? season.warmth : (raw.warmth || 0),
    active_blooms: raw.activeBlooms != null ? raw.activeBlooms : (weather.blooms ? weather.blooms.length : 0),
    active_storms: raw.activeStorms != null ? raw.activeStorms : (weather.storms ? weather.storms.length : 0),
    active_currents: raw.activeCurrents != null ? raw.activeCurrents : (weather.currents ? weather.currents.length : 0),
    bond_density: raw.population > 0 ? (raw.bonds || 0) / raw.population : 0,
    avg_entity_age: raw.avgEntityAge || 0,
  };
}

function rollup(entries) {
  if (!entries.length) return null;

  const result = {};
  const last = entries[entries.length - 1];
  const keys = Object.keys(last);

  for (const key of keys) {
    if (key === 'tick') {
      // Use the latest tick
      result.tick = last.tick;
    } else if (key === 'timestamp') {
      result.timestamp = last.timestamp;
    } else if (LATEST_FIELDS.includes(key)) {
      result[key] = last[key];
    } else if (SUM_FIELDS.includes(key)) {
      result[key] = entries.reduce((sum, e) => sum + (e[key] || 0), 0);
    } else if (typeof last[key] === 'number') {
      result[key] = entries.reduce((sum, e) => sum + (e[key] || 0), 0) / entries.length;
    } else {
      result[key] = last[key];
    }
  }

  return result;
}

class TrendStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tier1 = new RingBuffer(2400);
    this.tier2 = new RingBuffer(1728);
    this.tier3 = new RingBuffer(Infinity);
    this.t1Counter = 0; // counts T1 pushes since last T2 rollup
    this.t2Counter = 0; // counts T2 pushes since last T3 rollup
  }

  push(rawMetrics) {
    const snapshot = normalizeSnapshot(rawMetrics);
    this.tier1.push(snapshot);
    this.t1Counter++;

    if (this.t1Counter >= 20) {
      const window = this.tier1.lastN(20);
      const rolled = rollup(window);
      if (rolled) {
        this.tier2.push(rolled);
        this.t2Counter++;
      }
      this.t1Counter = 0;

      if (this.t2Counter >= 12) {
        const window2 = this.tier2.lastN(12);
        const rolled2 = rollup(window2);
        if (rolled2) {
          this.tier3.push(rolled2);
          this.save();
        }
        this.t2Counter = 0;
      }
    }
  }

  getTier(n) {
    if (n === 1) return this.tier1.entries();
    if (n === 2) return this.tier2.entries();
    if (n === 3) return this.tier3.entries();
    return [];
  }

  query({ tier, since, last_n } = {}) {
    const result = {};
    const tiers = tier === 'all' || !tier ? [1, 2, 3] : [parseInt(tier)];

    for (const t of tiers) {
      let entries = this.getTier(t);
      if (since != null) {
        entries = entries.filter(e => e.tick > since);
      }
      if (last_n != null) {
        entries = entries.slice(-last_n);
      }
      result[`tier${t}`] = entries;
    }
    return result;
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        tier1: this.tier1.toJSON(),
        tier2: this.tier2.toJSON(),
        tier3: this.tier3.toJSON(),
        t1Counter: this.t1Counter,
        t2Counter: this.t2Counter,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data));
    } catch (err) {
      console.warn('TrendStore save error:', err.message);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.tier1 = RingBuffer.fromJSON(raw.tier1);
      this.tier2 = RingBuffer.fromJSON(raw.tier2);
      this.tier3 = RingBuffer.fromJSON(raw.tier3);
      this.t1Counter = raw.t1Counter || 0;
      this.t2Counter = raw.t2Counter || 0;
      console.log(`TrendStore loaded: T1=${this.tier1.size()} T2=${this.tier2.size()} T3=${this.tier3.size()}`);
    } catch (err) {
      console.warn('TrendStore load error:', err.message);
    }
  }
}

module.exports = TrendStore;
