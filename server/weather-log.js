const fs = require('fs');
const path = require('path');

const FLUSH_EVENT_COUNT = 50;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Client weather events (client/js/weather.js) -> weather log entries.
// The client says "fade" where the log has always said "end".
const CLIENT_WEATHER_EVENTS = {
  bloom_spawn:   { kind: 'bloom',   phase: 'spawn', idKey: 'bloomId' },
  bloom_peak:    { kind: 'bloom',   phase: 'peak',  idKey: 'bloomId' },
  bloom_fade:    { kind: 'bloom',   phase: 'end',   idKey: 'bloomId' },
  storm_spawn:   { kind: 'storm',   phase: 'spawn', idKey: 'stormId' },
  storm_peak:    { kind: 'storm',   phase: 'peak',  idKey: 'stormId' },
  storm_fade:    { kind: 'storm',   phase: 'end',   idKey: 'stormId' },
  current_spawn: { kind: 'current', phase: 'spawn', idKey: 'currentId' },
  current_fade:  { kind: 'current', phase: 'end',   idKey: 'currentId' },
};

// A tracked bloom/storm/current missing from this many consecutive state
// snapshots is forgotten (its end event was lost, or a new run started)
const MISSING_SNAPSHOTS_TO_FORGET = 2;

class WeatherLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.unflushed = 0;
    this.lastFlush = Date.now();
    this.previousSeason = null;
    // Active blooms, storms and currents by id: what is known about each, so
    // an end event (which only carries id and lifetime) can say where it was
    this.active = new Map();
  }

  append(event) {
    this.events.push(event);
    this.unflushed++;
    if (this.unflushed >= FLUSH_EVENT_COUNT || Date.now() - this.lastFlush >= FLUSH_INTERVAL_MS) {
      this.save();
    }
  }

  // Events the client posts to /api/events. Weather lifecycles are taken from
  // here rather than diffed from state snapshots: exact ticks, every bloom
  // even if it lives between two pushes, and no false spawns or ends when a
  // save is loaded or a new run starts.
  logClientEvents(events) {
    for (const event of events) {
      if (event.type === 'cosmic_flip') this.logCosmicFlip(event);
      else if (CLIENT_WEATHER_EVENTS[event.type]) this._logWeatherEvent(event, CLIENT_WEATHER_EVENTS[event.type]);
    }
  }

  // Cosmic rays are weather: each flip the client reports is logged here too
  logCosmicFlip(event) {
    this.append({
      tick: event.tick,
      timestamp: new Date(event.timestamp || Date.now()).toISOString(),
      event_type: 'cosmic_flip',
      details: event.data,
    });
  }

  _logWeatherEvent(event, { kind, phase, idKey }) {
    const data = event.data || {};
    const id = data[idKey];
    if (id == null) return;
    let record = this.active.get(id);
    let details;

    if (phase === 'spawn') {
      // (a state snapshot may have shown it first)
      if (!record) {
        record = { kind, missing: 0, details: { id } };
        this.active.set(id, record);
      }
      if (kind === 'current') {
        record.details.origin = data.origin;
        record.details.direction = data.direction;
      } else {
        record.details.center = data.center;
        record.details.radius = data.radius;
      }
      details = { ...record.details };
    } else if (phase === 'peak') {
      if (record) {
        record.details.peakIntensity = data.intensity;
        record.missing = 0;
      }
      details = { id, center: data.center, radius: data.radius, intensity: data.intensity };
    } else {
      this.active.delete(id);
      details = { ...(record ? record.details : { id }), lifetime: data.lifetime };
    }

    this.append({
      tick: event.tick,
      timestamp: new Date(event.timestamp || Date.now()).toISOString(),
      event_type: `${kind}_${phase}`,
      details,
    });
  }

  // Called with each state snapshot the client pushes
  detectAndLog(currentState) {
    const currW = currentState && currentState.weather;
    if (!currW) return;
    const tick = currentState.tick || currentState.currentTick || 0;

    // Season changes (the client logs quarters; the log keeps the finer
    // early/late names from the snapshot)
    const currSeason = currW.season && currW.season.name;
    const prevSeason = this.previousSeason;
    this.previousSeason = currSeason || null;
    if (currSeason && prevSeason && currSeason !== prevSeason) {
      this.append({
        tick, timestamp: new Date().toISOString(),
        event_type: 'season_change',
        details: {
          from: prevSeason,
          to: currSeason,
          warmth: currW.season.warmth || 0,
        }
      });
    }

    this._trackActive(currW);

    // Auto-flush on timer
    if (Date.now() - this.lastFlush >= FLUSH_INTERVAL_MS && this.unflushed > 0) {
      this.save();
    }
  }

  // Refresh what is known about each active bloom/storm/current from the
  // snapshot. Also picks up ones whose spawn this server never saw (it was
  // restarted, or a save was loaded), so their end can still say where.
  _trackActive(weather) {
    const seen = new Set();
    const track = (kind, items) => {
      for (const item of items || []) {
        if (!item || item.id == null) continue;
        seen.add(item.id);
        let record = this.active.get(item.id);
        if (!record) {
          record = { kind, missing: 0, details: { id: item.id } };
          if (kind === 'current') {
            record.details.origin = item.origin;
            record.details.direction = item.direction;
          } else {
            record.details.center = item.center;
            record.details.radius = item.radius;
          }
          this.active.set(item.id, record);
        }
        record.missing = 0;
        const d = record.details;
        if (kind === 'current') {
          d.width = item.width;
          d.peakStrength = Math.max(d.peakStrength || 0, item.strength || 0);
        } else {
          d.peakIntensity = Math.max(d.peakIntensity || 0, item.intensity || 0);
        }
      }
    };
    track('bloom', weather.blooms);
    track('storm', weather.storms);
    track('current', weather.currents);

    for (const [id, record] of this.active) {
      if (!seen.has(id) && ++record.missing >= MISSING_SNAPSHOTS_TO_FORGET) this.active.delete(id);
    }
  }

  query({ since, type, last_n } = {}) {
    let filtered = this.events;
    if (since != null) {
      filtered = filtered.filter(e => e.tick > since);
    }
    if (type) {
      filtered = filtered.filter(e => e.event_type === type);
    }
    const total = filtered.length;
    if (last_n != null) {
      filtered = filtered.slice(-last_n);
    }
    return { events: filtered, total };
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ events: this.events, savedAt: new Date().toISOString() }));
      this.unflushed = 0;
      this.lastFlush = Date.now();
      return true;
    } catch (err) {
      console.warn('WeatherLog save error:', err.message);
      return false;
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.events = raw.events || [];
      console.log(`WeatherLog loaded: ${this.events.length} events`);
    } catch (err) {
      console.warn('WeatherLog load error:', err.message);
    }
  }
}

module.exports = WeatherLog;
