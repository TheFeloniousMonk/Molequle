// EventSystem — bridge between browser simulation and Node/Express server
// Handles event logging, batching, metrics, state snapshots, save/load, and polling

export class EventSystem {
  constructor() {
    this.eventBuffer = [];
    this.birthsSinceSnapshot = 0;
    this.deathsSinceSnapshot = 0;
    this.disruptionsSinceSnapshot = 0;

    // Deferred state work: the simulation only marks pushes/saves as due;
    // serialization runs later in an idle callback, never inside the rAF frame.
    this.stateProvider = null;      // () => current sim state, set by main.js
    this.statePushDue = false;
    this.statePushInFlight = false;
    this.saveDue = false;
    this.idleScheduled = false;

    // parameterHistory grows for an entity's whole lifetime, so state pushes
    // send only entries the server hasn't acknowledged yet. Entity -> count.
    this.historyAcked = new WeakMap();
  }

  setStateProvider(fn) {
    this.stateProvider = fn;
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

  // ── Deferred state push / save ─────────────────────────────────────
  // Called from the simulation tick: cheap, only flags work and schedules it.

  requestStatePush() {
    if (this.statePushInFlight) return; // previous push still pending: skip this one
    this.statePushDue = true;
    this._scheduleIdle();
  }

  requestSave() {
    this.saveDue = true;
    this._scheduleIdle();
  }

  _scheduleIdle() {
    if (this.idleScheduled) return;
    this.idleScheduled = true;
    const run = () => {
      this.idleScheduled = false;
      this._runDeferred();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 1000 });
    } else {
      setTimeout(run, 0);
    }
  }

  // One job per idle callback, so a push and a save that come due on the
  // same tick don't combine into a single long task.
  _runDeferred() {
    if (!this.stateProvider) return;
    if (this.statePushDue) {
      this.statePushDue = false;
      this._pushState(this.stateProvider());
    } else if (this.saveDue) {
      this.saveDue = false;
      this._saveState(this.stateProvider());
    }
    if (this.statePushDue || this.saveDue) this._scheduleIdle();
  }

  // ── Push state snapshot (fire-and-forget, parameterHistory as delta) ──

  _pushState(state) {
    if (this.statePushInFlight) return;
    const t0 = performance.now();

    const acked = this.historyAcked;
    const sent = [];
    const entities = state.entities.map(e => {
      const from = acked.get(e) || 0;
      sent.push([e, e.parameterHistory.length]);
      const data = e.serialize(from);
      data.parameterHistoryFrom = from; // server merges; stripped before it serves the state
      return data;
    });
    const body = JSON.stringify(this._buildStatePayload(state, entities));
    performance.measure('molequle:pushState', { start: t0 });

    this.statePushInFlight = true;
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(res => {
        if (res.resendFullHistory) {
          // Server lost its copy (e.g. restarted): send full histories next time
          this.historyAcked = new WeakMap();
        } else {
          for (const [e, count] of sent) acked.set(e, count);
        }
      })
      .catch(err => console.warn('EventSystem: failed to push state', err))
      .finally(() => { this.statePushInFlight = false; });
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

  _saveState(state, manual = false) {
    const t0 = performance.now();
    const payload = this._buildStatePayload(state, state.entities.map(e => e.serialize()));
    payload._saveType = manual ? 'manual' : 'auto';
    const body = JSON.stringify(payload);
    performance.measure('molequle:saveState', { start: t0 });
    fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
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

  // serializedEntities hold live references (see Entity.serialize) — the
  // returned payload must be stringified in the same synchronous task.
  _buildStatePayload(state, serializedEntities) {
    const { entities, contextMap, config, tick, seed, smoother, startTime, weatherSystem } = state;
    const payload = {
      tick,
      seed,
      config,
      population: entities.filter(e => e.alive).length,
      entities: serializedEntities,
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
