// EventSystem — bridge between browser simulation and Node/Express server
// Handles event logging, batching, metrics, state snapshots, save/load, and polling

export class EventSystem {
  constructor() {
    this.eventBuffer = [];
    this.birthsSinceSnapshot = 0;
    this.deathsSinceSnapshot = 0;
    this.disruptionsSinceSnapshot = 0;
  }

  // ── Event logging ──────────────────────────────────────────────────

  logEvent(type, tick, data) {
    this.eventBuffer.push({
      type,
      tick,
      timestamp: Date.now(),
      data
    });

    if (type === 'entity_spawned') this.birthsSinceSnapshot++;
    else if (type === 'entity_died') this.deathsSinceSnapshot++;
    else if (type === 'disruption_cascade') this.disruptionsSinceSnapshot++;
  }

  // ── Flush buffered events (fire-and-forget) ────────────────────────

  flushEvents() {
    if (this.eventBuffer.length === 0) return;
    const events = this.eventBuffer;
    this.eventBuffer = [];
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    }).catch(err => console.warn('EventSystem: failed to flush events', err));
  }

  // ── Push full state snapshot (fire-and-forget) ─────────────────────

  pushState(entities, contextMap, config, tick, seed, smoother, startTime, weatherSystem) {
    const payload = this._buildStatePayload(entities, contextMap, config, tick, seed, smoother, startTime, weatherSystem);
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.warn('EventSystem: failed to push state', err));
  }

  // ── Push computed metrics (fire-and-forget) ────────────────────────

  pushMetrics(entities, contextMap, tick, config, weatherSystem) {
    const aliveEntities = entities.filter(e => e.alive);
    const population = aliveEntities.length;

    // Bond count: sum all bond arrays, divide by 2 to avoid double-counting
    let totalBonds = 0;
    for (const e of aliveEntities) {
      totalBonds += e.bonds.length;
    }
    const bonds = Math.floor(totalBonds / 2);

    // Average and stddev of the 5 params across alive entities
    const paramNames = ['sociability', 'inertia', 'volatility', 'bondAffinity', 'disruptionCharge'];
    const avgParams = {};
    const paramStdDev = {};

    for (const p of paramNames) {
      if (population === 0) {
        avgParams[p] = 0;
        paramStdDev[p] = 0;
        continue;
      }
      let sum = 0;
      for (const e of aliveEntities) sum += e[p];
      const mean = sum / population;
      avgParams[p] = mean;

      let sqDiffSum = 0;
      for (const e of aliveEntities) {
        const diff = e[p] - mean;
        sqDiffSum += diff * diff;
      }
      paramStdDev[p] = Math.sqrt(sqDiffSum / population);
    }

    // Count fertile / scarred / ghost cells from contextMap grid
    let fertileCount = 0;
    let scarredCount = 0;
    let ghostCount = 0;

    for (let gy = 0; gy < 54; gy++) {
      for (let gx = 0; gx < 96; gx++) {
        // Convert grid coords to world coords (cell center)
        const worldX = (gx + 0.5) * contextMap.cellWidth;
        const worldY = (gy + 0.5) * contextMap.cellHeight;
        const effects = contextMap.getTerrainEffects(worldX, worldY, tick);
        if (effects.isFertile) fertileCount++;
        if (effects.isScarred) scarredCount++;
        if (effects.isGhostTrail) ghostCount++;
      }
    }

    const payload = {
      tick,
      timestamp: Date.now(),
      population,
      bonds,
      births: this.birthsSinceSnapshot,
      deaths: this.deathsSinceSnapshot,
      disruptionEvents: this.disruptionsSinceSnapshot,
      avgParams,
      paramStdDev,
      fertileCount,
      scarredCount,
      ghostCount,
      // Weather metrics
      seasonPhase: weatherSystem ? weatherSystem.getWarmth() : null,
      activeBlooms: weatherSystem ? weatherSystem.blooms.length : 0,
      activeStorms: weatherSystem ? weatherSystem.storms.length : 0,
      activeCurrents: weatherSystem ? weatherSystem.currents.length : 0,
    };

    // Reset counters after push
    this.birthsSinceSnapshot = 0;
    this.deathsSinceSnapshot = 0;
    this.disruptionsSinceSnapshot = 0;

    fetch('/api/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.warn('EventSystem: failed to push metrics', err));
  }

  // ── Save state (fire-and-forget) ───────────────────────────────────

  saveState(entities, contextMap, config, tick, seed, smoother, startTime, weatherSystem, manual = false) {
    const payload = this._buildStatePayload(entities, contextMap, config, tick, seed, smoother, startTime, weatherSystem);
    payload._saveType = manual ? 'manual' : 'auto';
    fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.warn('EventSystem: failed to save state', err));
  }

  // ── Load state (awaited) ───────────────────────────────────────────

  async loadState() {
    try {
      const res = await fetch('/api/load');
      const data = await res.json();
      if (data.status === 'no saved state') return null;
      return data;
    } catch (err) {
      console.warn('EventSystem: failed to load state', err);
      return null;
    }
  }

  // ── Poll for pending parameter changes (awaited) ───────────────────

  async pollPendingParams() {
    try {
      const res = await fetch('/api/pending-params');
      return await res.json();
    } catch (err) {
      console.warn('EventSystem: failed to poll pending params', err);
      return {};
    }
  }

  // ── Poll for control commands (awaited) ────────────────────────────

  async pollControl() {
    try {
      const res = await fetch('/api/control');
      return await res.json();
    } catch (err) {
      console.warn('EventSystem: failed to poll control', err);
      return { command: null };
    }
  }

  // ── Scheduling helpers ─────────────────────────────────────────────

  shouldFlushEvents(tick) {
    return tick % 60 === 0;
  }

  shouldPushState(tick) {
    return tick % 300 === 0;
  }

  shouldPushMetrics(tick) {
    return tick % 300 === 0;
  }

  shouldSave(tick) {
    return tick % 3600 === 0; // ~60 seconds at 60fps
  }

  shouldPoll(tick) {
    return tick % 120 === 0;
  }

  // ── Internal helpers ───────────────────────────────────────────────

  _buildStatePayload(entities, contextMap, config, tick, seed, smoother, startTime, weatherSystem) {
    const payload = {
      tick,
      seed,
      config,
      population: entities.filter(e => e.alive).length,
      entities: entities.map(e => e.serialize()),
      contextMap: contextMap.toSparse(),
      smoother,
      runTime: Date.now() - startTime
    };

    // Include weather state for API and persistence
    if (weatherSystem) {
      payload.weather = weatherSystem.getStateForAPI();
      payload.weatherSave = weatherSystem.serialize();
    }

    return payload;
  }
}
