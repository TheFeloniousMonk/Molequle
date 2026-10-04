// EventSystem — bridge between browser simulation and Node/Express server
// Handles event logging, batching, metrics, state snapshots, save/load, and polling

// Deferred serialization: bulky per-entity values (hundreds of keys each) are
// replaced by markers in the snapshot JSON, stringified a few at a time in
// later idle slices, and assembled into the request body as a Blob. (A
// multi-MB string body makes fetch() block while it encodes; a Blob doesn't,
// and building it from small Blobs spreads the encoding across slices.)
const DEFERRED_MARKER = '__molequle_deferred_';
const DEFERRED_PER_STEP = 4;   // deferred values stringified between time checks
const DEFERRED_PER_BLOB = 32;  // values per intermediate Blob (each Blob has fixed overhead)
const SLICE_MS = 4;            // work budget per slice when not given an idle deadline

export class EventSystem {
  constructor() {
    this.eventBuffer = [];
    this.birthsSinceSnapshot = 0;
    this.deathsSinceSnapshot = 0;
    this.disruptionsSinceSnapshot = 0;

    // Deferred state work: the simulation only marks pushes/saves as due;
    // serialization runs later in idle callbacks, never inside the rAF frame.
    this.stateProvider = null;      // () => current sim state, set by main.js
    this.statePushDue = false;
    this.statePushInFlight = false; // from snapshot until the POST settles
    this.saveDue = false;
    this.idleScheduled = false;
    this.activeJob = null;          // generator: one small step per next()
    this.activeJobName = '';

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
    // Previous push still being built or sent: skip this one
    if (this.statePushInFlight || this.statePushDue) return;
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
    const run = (deadline) => {
      this.idleScheduled = false;
      this._runDeferred(deadline);
    };
    if (typeof requestIdleCallback === 'function') {
      // Mid-job, don't wait as long for idle time on a busy page
      requestIdleCallback(run, { timeout: this.activeJob ? 100 : 1000 });
    } else {
      setTimeout(run, 0);
    }
  }

  // Runs job steps while this slice has time (always at least one step).
  // A job finishing ends the slice, so a push and a save that come due on
  // the same tick never share one.
  _runDeferred(deadline) {
    if (!this.stateProvider) return;
    if (!this.activeJob) {
      if (this.statePushDue) {
        this.statePushDue = false;
        this.activeJob = this._pushStateJob(this.stateProvider());
        this.activeJobName = 'molequle:pushState';
      } else if (this.saveDue) {
        this.saveDue = false;
        this.activeJob = this._saveStateJob(this.stateProvider());
        this.activeJobName = 'molequle:saveState';
      }
    }
    if (this.activeJob) {
      const start = performance.now();
      const useDeadline = deadline && !deadline.didTimeout;
      for (;;) {
        let done;
        try {
          done = this.activeJob.next().done;
        } catch (err) {
          // Drop the job rather than wedge every future push/save
          console.warn(`EventSystem: ${this.activeJobName} failed`, err);
          if (this.activeJobName === 'molequle:pushState') this.statePushInFlight = false;
          done = true;
        }
        if (done) {
          this.activeJob = null;
          break;
        }
        if (useDeadline ? deadline.timeRemaining() < 1 : performance.now() - start > SLICE_MS) break;
      }
      performance.measure(this.activeJobName, { start });
    }
    if (this.activeJob || this.statePushDue || this.saveDue) this._scheduleIdle();
  }

  // Swap a bulky value for a marker; it's stringified later by _deferredBody
  _defer(deferred, value) {
    deferred.push(value);
    return DEFERRED_MARKER + (deferred.length - 1) + '__';
  }

  // Stringify deferred values a few per step and assemble the JSON body as a
  // Blob: snapshot text up to each marker, then that marker's value. Markers
  // appear in the snapshot in the order they were deferred.
  *_deferredBody(json, deferred) {
    const blobs = [];
    let group = [];
    let pos = 0;
    for (let i = 0; i < deferred.length; i++) {
      const marker = '"' + DEFERRED_MARKER + i + '__"';
      const at = json.indexOf(marker, pos);
      if (at < 0) throw new Error(`EventSystem: deferred marker ${i} missing`);
      group.push(json.slice(pos, at), JSON.stringify(deferred[i]) ?? 'null');
      pos = at + marker.length;
      if (i % DEFERRED_PER_BLOB === DEFERRED_PER_BLOB - 1) {
        blobs.push(new Blob(group));
        group = [];
      }
      if (i % DEFERRED_PER_STEP === DEFERRED_PER_STEP - 1) yield;
    }
    group.push(json.slice(pos));
    blobs.push(new Blob(group));
    return new Blob(blobs, { type: 'application/json' });
  }

  // ── Push state snapshot (fire-and-forget, parameterHistory as delta) ──

  *_pushStateJob(state) {
    this.statePushInFlight = true;

    // Step 1 — atomic snapshot of everything at this tick. The bulky values
    // are stringified in later steps: parameterHistory (full on the first
    // push) is copied so it's frozen at this tick; cellAbsenceTicks (hundreds
    // of keys per entity) is slow bookkeeping in units of 100 ticks, so a few
    // frames of skew between entities is immaterial.
    const acked = this.historyAcked;
    const sent = [];
    const deferred = [];
    const entities = state.entities.map(e => {
      const from = acked.get(e) || 0;
      const historyLength = e.parameterHistory.length;
      sent.push([e, historyLength]);
      const data = e.serialize(from);
      data.parameterHistoryFrom = from; // server merges; stripped before it serves the state
      data.parameterHistory = this._defer(deferred, e.parameterHistory.slice(from, historyLength));
      data.cellAbsenceTicks = this._defer(deferred, data.cellAbsenceTicks);
      return data;
    });
    const snapshot = JSON.stringify(this._buildStatePayload(state, entities));
    yield;

    const body = yield* this._deferredBody(snapshot, deferred);

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

  *_saveStateJob(state, manual = false) {
    // Step 1 — atomic snapshot; the bulky per-entity values are stringified
    // in later steps. parameterHistory is copied (cheap: shared entry objects)
    // so the saved history can't run ahead of the saved tick.
    const deferred = [];
    const entities = state.entities.map(e => {
      const data = e.serialize();
      data.parameterHistory = this._defer(deferred, data.parameterHistory.slice());
      data.cellAbsenceTicks = this._defer(deferred, data.cellAbsenceTicks);
      return data;
    });
    const payload = this._buildStatePayload(state, entities);
    payload._saveType = manual ? 'manual' : 'auto';
    const snapshot = JSON.stringify(payload);
    yield;

    const body = yield* this._deferredBody(snapshot, deferred);
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
