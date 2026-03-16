const fs = require('fs');
const path = require('path');

const FLUSH_EVENT_COUNT = 50;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class WeatherLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.unflushed = 0;
    this.lastFlush = Date.now();
    this.previousState = null;
  }

  append(event) {
    this.events.push(event);
    this.unflushed++;
    if (this.unflushed >= FLUSH_EVENT_COUNT || Date.now() - this.lastFlush >= FLUSH_INTERVAL_MS) {
      this.save();
    }
  }

  detectAndLog(currentState) {
    const prev = this.previousState;
    this.previousState = currentState;

    if (!prev || !currentState) return;
    const currW = currentState.weather;
    const prevW = prev.weather;
    if (!currW || !prevW) return;

    const tick = currentState.tick || currentState.currentTick || 0;
    const timestamp = new Date().toISOString();

    // Season changes
    const currSeason = currW.season && currW.season.name;
    const prevSeason = prevW.season && prevW.season.name;
    if (currSeason && prevSeason && currSeason !== prevSeason) {
      this.append({
        tick, timestamp,
        event_type: 'season_change',
        details: {
          from: prevSeason,
          to: currSeason,
          warmth: currW.season.warmth || 0,
        }
      });
    }

    // Bloom spawn/end
    this._detectWeatherDiff(
      prevW.blooms || [], currW.blooms || [],
      (b) => `${Math.round(b.x)},${Math.round(b.y)}`,
      'bloom', tick, timestamp
    );

    // Storm spawn/end
    this._detectWeatherDiff(
      prevW.storms || [], currW.storms || [],
      (s) => `${Math.round(s.x)},${Math.round(s.y)}`,
      'storm', tick, timestamp
    );

    // Current spawn/end
    this._detectWeatherDiff(
      prevW.currents || [], currW.currents || [],
      (c) => `${Math.round(c.x1)},${Math.round(c.y1)}`,
      'current', tick, timestamp
    );

    // Auto-flush on timer
    if (Date.now() - this.lastFlush >= FLUSH_INTERVAL_MS && this.unflushed > 0) {
      this.save();
    }
  }

  _detectWeatherDiff(prevArr, currArr, keyFn, typeName, tick, timestamp) {
    const prevKeys = new Set(prevArr.map(keyFn));
    const currKeys = new Set(currArr.map(keyFn));
    const prevMap = {};
    for (const item of prevArr) prevMap[keyFn(item)] = item;
    const currMap = {};
    for (const item of currArr) currMap[keyFn(item)] = item;

    // Spawns: in current but not previous
    for (const key of currKeys) {
      if (!prevKeys.has(key)) {
        const item = currMap[key];
        this.append({
          tick, timestamp,
          event_type: `${typeName}_spawn`,
          details: this._extractDetails(item, typeName),
        });
      }
    }

    // Ends: in previous but not current
    for (const key of prevKeys) {
      if (!currKeys.has(key)) {
        const item = prevMap[key];
        this.append({
          tick, timestamp,
          event_type: `${typeName}_end`,
          details: this._extractDetails(item, typeName),
        });
      }
    }
  }

  _extractDetails(item, typeName) {
    if (typeName === 'current') {
      return {
        x1: item.x1, y1: item.y1,
        x2: item.x2, y2: item.y2,
        strength: item.strength, width: item.width,
      };
    }
    // bloom or storm
    return {
      x: item.x, y: item.y,
      radius: item.radius, intensity: item.intensity,
    };
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
    } catch (err) {
      console.warn('WeatherLog save error:', err.message);
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
