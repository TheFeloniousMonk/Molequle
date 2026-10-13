// sim.js — The simulation core: world state and the per-tick rules.
// No DOM, canvas, network or timers: the browser app (main.js) and the
// headless harness (tools/molequle-play.mjs) both drive this module, so the
// same seed and config give the same world in either.

import { mulberry32, seededUUID, deriveStreamSeed, STREAM_IDS } from './prng.js';
import { Entity } from './entity.js';
import { ContextMap } from './context-map.js';
import { WeatherSystem } from './weather.js';
import { DEFAULT_CONFIG } from './params.js';
import { setMathMode, effectiveMathMode } from './simmath.js';
import { applyPerturbations, applyCosmicRays, normalizePerturb } from './chaos.js';

// Settings that change a world's history; changing one mid-run is logged
// as a config_change event (physics/math changes with a warning).
export const PHYSICS_KEYS = ['physicsVersion', 'mathMode', 'cosmicRate', 'cosmicMode', 'perturb'];
const HISTORY_WARNING_KEYS = ['physicsVersion', 'mathMode'];

// Spatial hash for neighbor lookups: flat grid of reusable buckets
// (cell index = cy * cols + cx), rebuilt from scratch each tick.
const SPATIAL_CELL_SIZE = 80;

// Crush-check grid: built from post-movement positions for the death phase.
// Cells are at least CRUSH_RADIUS wide, so a 3x3 block covers the radius.
const CRUSH_RADIUS = 50;

function makeStreams(seed) {
  return {
    perturb: mulberry32(deriveStreamSeed(seed, STREAM_IDS.perturb)),
    cosmic: mulberry32(deriveStreamSeed(seed, STREAM_IDS.cosmic)),
  };
}

export class Simulation {
  /**
   * @param {object} [options]
   * @param {object} [options.config] - Full config (defaults to DEFAULT_CONFIG)
   * @param {number} [options.seed]
   * @param {function} [options.onEvent] - (type, tick, data) for every sim event
   * @param {function} [options.onBondBreak] - (x1, y1, x2, y2) when a bond breaks (visual flash)
   */
  constructor({ config, seed = Date.now(), onEvent, onBondBreak } = {}) {
    this.config = config || { ...DEFAULT_CONFIG };
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.entities = [];
    this.contextMap = new ContextMap(this.config.gridCols, this.config.gridRows, this.config.canvasWidth, this.config.canvasHeight);
    this.weatherSystem = new WeatherSystem(this.rng);
    this.tick = 0;
    this.onEvent = onEvent || (() => {});
    this.onBondBreak = onBondBreak || (() => {});
    this.streams = makeStreams(seed);
    this.chaosStats = { perturbs: 0, cosmicFlips: 0 };

    // Spawn cooldowns per context-map cell
    this.spawnCooldowns = {};

    this.spatialCols = 0;
    this.spatialRows = 0;
    this.spatialBuckets = [];
    // Per-tick id -> entity lookup (replaces per-entity map building / Array.find)
    this.entityById = new Map();
    this.crushCols = 0;
    this.crushRows = 0;
    this.crushCellW = 0;
    this.crushCellH = 0;
    this.crushBuckets = [];
  }

  // ── World setup ──────────────────────────────────────────────────────

  /** Restart the world from this.seed: tick 0, fresh entities and weather. */
  reset() {
    this.rng = mulberry32(this.seed);
    this.streams = makeStreams(this.seed);
    this.chaosStats = { perturbs: 0, cosmicFlips: 0 };
    this.tick = 0;
    this.spawnCooldowns = {};
    this.contextMap = new ContextMap(this.config.gridCols, this.config.gridRows, this.config.canvasWidth, this.config.canvasHeight);
    this.weatherSystem = new WeatherSystem(this.rng);
    this.spawnInitialEntities();
  }

  /**
   * Start a fresh world with a new seed. New worlds get the current physics
   * (a version-1 world stays version 1 through reset(), but not into a new run).
   */
  newRun(seed) {
    this.seed = seed;
    if (this.config.physicsVersion !== DEFAULT_CONFIG.physicsVersion) {
      this.setParam('physicsVersion', DEFAULT_CONFIG.physicsVersion);
    }
    this.reset();
  }

  /**
   * Change one config value. Physics and chaos settings are validated and the
   * change is logged as an event, since it alters history from this tick on.
   * Returns false if the value was rejected.
   */
  setParam(key, value) {
    const before = this.config[key];
    if (key === 'perturb') {
      const { value: list, error } = normalizePerturb(value);
      if (error) {
        console.warn(error);
        return false;
      }
      value = list;
    }
    this.config[key] = value;
    if (PHYSICS_KEYS.includes(key) && JSON.stringify(before) !== JSON.stringify(value)) {
      const data = { key, before, after: value };
      if (HISTORY_WARNING_KEYS.includes(key)) {
        data.warning = `${key} changed mid-run: history differs from this tick on`;
        data.effectiveMathMode = effectiveMathMode(this.config);
      }
      this.onEvent('config_change', this.tick, data);
    }
    return true;
  }

  /** The math mode this world runs with (physics version 1 is always 'platform'). */
  get mathMode() {
    return effectiveMathMode(this.config);
  }

  spawnInitialEntities() {
    const { config, rng } = this;
    this.entities = [];
    for (let i = 0; i < config.initialPopulation; i++) {
      const x = rng() * config.canvasWidth;
      const y = rng() * config.canvasHeight;
      const params = {
        sociability: 0.1 + rng() * 0.8,
        inertia: 0.1 + rng() * 0.8,
        volatility: 0.1 + rng() * 0.8,
        bondAffinity: 0.1 + rng() * 0.8,
        disruptionCharge: 0.1 + rng() * 0.8
      };
      const id = seededUUID(rng);
      this.entities.push(new Entity(id, x, y, params, rng));
    }
  }

  /**
   * Restore a saved world (the payload written by EventSystem's save).
   * Returns false if the save has no entities.
   */
  restore(savedState) {
    if (!savedState || !savedState.entities || savedState.entities.length === 0) return false;
    this.seed = savedState.seed || this.seed;
    this.tick = savedState.tick || 0;
    const savedConfig = savedState.config || {};
    this.config = { ...DEFAULT_CONFIG, ...savedConfig };
    // Saves from before physics versions existed are version 1, and stay so
    if (savedConfig.physicsVersion === undefined) this.config.physicsVersion = 1;
    this.config.smoother = savedState.smoother || false;

    // Version 2 saves carry the exact simulation state; version 1 worlds keep
    // the original approximate resume, so they continue as they always would.
    const exact = this.config.physicsVersion >= 2 ? savedState.exact : null;

    this.rng = mulberry32(this.seed);
    this.streams = makeStreams(this.seed);
    if (exact) {
      this.rng.setState(exact.rng.main);
      this.streams.perturb.setState(exact.rng.perturb);
      this.streams.cosmic.setState(exact.rng.cosmic);
    } else {
      // Advance rng to approximate position (not perfect but prevents same sequence)
      for (let i = 0; i < (savedState.tick || 0) % 1000; i++) this.rng();
    }
    this.chaosStats = { perturbs: 0, cosmicFlips: 0, ...(exact && exact.chaosStats) };

    this.entities = savedState.entities.map(d => Entity.deserialize(d));

    this.contextMap = new ContextMap(this.config.gridCols, this.config.gridRows, this.config.canvasWidth, this.config.canvasHeight);
    if (exact) {
      this.contextMap.fromSparse(exact.contextMap);
    } else if (savedState.contextMap) {
      this.contextMap.fromSparse(savedState.contextMap);
    }

    // Restore weather state (weatherSave has full serialization data)
    this.weatherSystem = new WeatherSystem(this.rng);
    if (savedState.weatherSave) {
      this.weatherSystem.restore(savedState.weatherSave);
    }
    this.spawnCooldowns = exact ? { ...exact.spawnCooldowns } : {};
    return true;
  }

  /**
   * Simulation state a save needs, beyond entities and weather, for a version 2
   * world to resume exactly: generator states, spawn cooldowns, and the
   * full-precision context map (the API's sparse map is rounded and thinned).
   * Must be taken at the same tick as the entities.
   */
  exactState() {
    return {
      rng: {
        main: this.rng.getState(),
        perturb: this.streams.perturb.getState(),
        cosmic: this.streams.cosmic.getState(),
      },
      spawnCooldowns: { ...this.spawnCooldowns },
      contextMap: this.contextMap.toSparse({ exact: true }),
      chaosStats: { ...this.chaosStats },
    };
  }

  // ── Spatial hashing ──────────────────────────────────────────────────

  buildSpatialHash(entities) {
    const cols = Math.ceil(this.config.canvasWidth / SPATIAL_CELL_SIZE);
    const rows = Math.ceil(this.config.canvasHeight / SPATIAL_CELL_SIZE);
    if (cols !== this.spatialCols || rows !== this.spatialRows) {
      this.spatialCols = cols;
      this.spatialRows = rows;
      this.spatialBuckets = Array.from({ length: cols * rows }, () => []);
    } else {
      for (let i = 0; i < this.spatialBuckets.length; i++) this.spatialBuckets[i].length = 0;
    }
    for (const e of entities) {
      if (!e.alive) continue;
      const cx = Math.floor(e.x / SPATIAL_CELL_SIZE);
      const cy = Math.floor(e.y / SPATIAL_CELL_SIZE);
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
        this.spatialBuckets[cy * cols + cx].push(e);
      }
    }
  }

  getNearbyEntities(x, y, radius) {
    const results = [];
    const cr = Math.ceil(radius / SPATIAL_CELL_SIZE);
    const cx = Math.floor(x / SPATIAL_CELL_SIZE);
    const cy = Math.floor(y / SPATIAL_CELL_SIZE);
    const maxCX = this.spatialCols;
    const maxCY = this.spatialRows;
    const buckets = this.spatialBuckets;

    for (let dx = -cr; dx <= cr; dx++) {
      // Toroidal wrapping for spatial hash
      const gx = ((cx + dx) % maxCX + maxCX) % maxCX;
      for (let dy = -cr; dy <= cr; dy++) {
        const gy = ((cy + dy) % maxCY + maxCY) % maxCY;
        const bucket = buckets[gy * maxCX + gx];
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) results.push(bucket[i]);
        }
      }
    }
    return results;
  }

  buildCrushGrid(entities) {
    const config = this.config;
    const cols = Math.max(1, Math.floor(config.canvasWidth / CRUSH_RADIUS));
    const rows = Math.max(1, Math.floor(config.canvasHeight / CRUSH_RADIUS));
    if (cols !== this.crushCols || rows !== this.crushRows) {
      this.crushCols = cols;
      this.crushRows = rows;
      this.crushBuckets = Array.from({ length: cols * rows }, () => []);
    } else {
      for (let i = 0; i < this.crushBuckets.length; i++) this.crushBuckets[i].length = 0;
    }
    this.crushCellW = config.canvasWidth / cols;
    this.crushCellH = config.canvasHeight / rows;
    for (const e of entities) {
      if (!e.alive) continue;
      const cx = Math.min(cols - 1, Math.floor(e.x / this.crushCellW));
      const cy = Math.min(rows - 1, Math.floor(e.y / this.crushCellH));
      if (cx >= 0 && cy >= 0) this.crushBuckets[cy * cols + cx].push(e);
    }
  }

  // Candidates within CRUSH_RADIUS of an entity (superset; exact distance is
  // checked in checkDeath). Falls back to all entities on tiny canvases where
  // the 3x3 block would wrap onto itself and repeat cells.
  getCrushCandidates(entity) {
    const { crushCols, crushRows, crushCellW, crushCellH, crushBuckets } = this;
    if (crushCols < 3 || crushRows < 3) return this.entities;
    const results = [];
    const cx = Math.min(crushCols - 1, Math.floor(entity.x / crushCellW));
    const cy = Math.min(crushRows - 1, Math.floor(entity.y / crushCellH));
    for (let dx = -1; dx <= 1; dx++) {
      const gx = (cx + dx + crushCols) % crushCols;
      for (let dy = -1; dy <= 1; dy++) {
        const gy = (cy + dy + crushRows) % crushRows;
        const bucket = crushBuckets[gy * crushCols + gx];
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) results.push(bucket[i]);
        }
      }
    }
    return results;
  }

  // ── Main simulation tick ─────────────────────────────────────────────

  step() {
    const config = this.config;
    const rng = this.rng;
    const contextMap = this.contextMap;
    const weatherSystem = this.weatherSystem;
    const entityById = this.entityById;
    const logEvent = this.onEvent;

    const tick = ++this.tick;
    config.currentTick = tick;
    setMathMode(effectiveMathMode(config));

    // ── Chaos knobs (no-ops, consuming no randomness, while off) ──
    applyPerturbations(this);
    applyCosmicRays(this);

    this.buildSpatialHash(this.entities);
    entityById.clear();
    for (const e of this.entities) entityById.set(e.id, e);

    const aliveEntities = this.entities.filter(e => e.alive);
    const decayRate = 1 / (config.halfLifeTicks || 5000);

    // ── Update weather systems ──
    const weatherEvents = [];
    weatherSystem.update(config, tick, contextMap, weatherEvents);
    for (const evt of weatherEvents) {
      logEvent(evt.type, tick, evt.data);
    }

    // Get seasonal modifiers (applied globally to bond formation, spawn, disruption threshold)
    const seasonMods = weatherSystem.getSeasonalModifiers(config);

    // ── Update each entity ──
    for (const entity of aliveEntities) {
      // Compute per-entity weather effects
      const weatherEffects = weatherSystem.getEffectsAt(entity.x, entity.y, config);

      // Pass nearby entities instead of all for performance
      const nearby = this.getNearbyEntities(entity.x, entity.y, config.perceptionRadius);
      entity.update(nearby, contextMap, config, rng, tick, weatherEffects, entityById);

      // Apply smoother if enabled
      if (config.smoother) {
        entity.applySmoother(config);
      }
    }

    // ── Bond updates ──
    // Disruptors in entity order. D, alive and positions don't change during
    // this phase, so one list serves every bond instead of scanning all entities.
    const bondDisruptionThreshold = config.disruptionThreshold || 0.6;
    const disruptors = this.entities.filter(e => e.alive && e.disruptionCharge > bondDisruptionThreshold);
    for (const entity of aliveEntities) {
      const breakEvents = entity.updateBonds(this.entities, contextMap, config, tick, entityById, disruptors);
      for (const evt of breakEvents) {
        logEvent('bond_broken', tick, evt);
        // Also break bond on the other side
        const partner = entityById.get(evt.entityB);
        if (partner) {
          const partnerEvt = partner.breakBond(entity.id, tick);
          if (partnerEvt) {
            this.onBondBreak(entity.x, entity.y, partner.x, partner.y);
            contextMap.recordBondBreak(entity.x, entity.y, tick);
          }
        }
      }
    }

    // ── Bond formation attempts ──
    // Seasonal + bloom modifiers affect bond formation probability via config overlay
    config._weatherBondModifier = seasonMods.bondFormationModifier;
    const maxBonds = config.maxBondsPerEntity ?? 3;
    for (let i = 0; i < aliveEntities.length; i++) {
      const entityA = aliveEntities[i];
      if (entityA.bonds.length >= maxBonds) continue;

      // Per-entity bloom modifier
      const bloomEffects = weatherSystem.getBloomEffectsAt(entityA.x, entityA.y, config);
      config._weatherBondModifier = seasonMods.bondFormationModifier * bloomEffects.bondModifier;

      const nearby = this.getNearbyEntities(entityA.x, entityA.y, config.bondRadius);
      for (const entityB of nearby) {
        if (entityB.id <= entityA.id || !entityB.alive) continue;
        if (entityB.bonds.length >= maxBonds) continue;

        const bondEvent = entityA.tryFormBond(entityB, contextMap, config, rng, tick);
        if (bondEvent) {
          logEvent('bond_formed', tick, bondEvent);
        }
      }
    }
    delete config._weatherBondModifier;

    // ── Disruption ──
    // Seasonal modifier lowers disruption threshold in summer
    const effectiveDisruptionThreshold = (config.disruptionThreshold || 0.6) + seasonMods.disruptionThresholdOffset;
    for (const entity of aliveEntities) {
      if (entity.disruptionCharge > effectiveDisruptionThreshold) {
        const nearby = this.getNearbyEntities(entity.x, entity.y, config.disruptionRadius);
        const disruptionEvent = entity.applyDisruption(nearby, contextMap, config, tick);
        if (disruptionEvent) {
          logEvent('disruption_cascade', tick, disruptionEvent);
        }
      }
    }

    // ── Death checks ──
    this.buildCrushGrid(this.entities);
    for (const entity of aliveEntities) {
      const cause = entity.checkDeath(this.getCrushCandidates(entity), config, tick);
      if (cause) {
        const deathEvent = entity.beginDeath(cause);
        logEvent('entity_died', tick, deathEvent);
      }
    }

    // ── Fade dead entities ──
    const entities = this.entities;
    for (let i = entities.length - 1; i >= 0; i--) {
      if (!entities[i].alive) {
        const shouldRemove = entities[i].updateFade();
        if (shouldRemove) {
          entities.splice(i, 1);
        }
      }
    }

    // ── Reproduction ──
    this.trySpawnEntities();

    // ── Minimum population safeguard ──
    const currentAlive = entities.filter(e => e.alive).length;
    if (currentAlive < 10) {
      for (let i = 0; i < 5; i++) {
        const x = rng() * config.canvasWidth;
        const y = rng() * config.canvasHeight;
        const newEntity = Entity.spawn(x, y, [], rng, tick);
        entities.push(newEntity);
        logEvent('entity_spawned', tick, {
          entityId: newEntity.id,
          x, y,
          cause: 'minimum_population',
          parameters: {
            sociability: newEntity.sociability,
            inertia: newEntity.inertia,
            volatility: newEntity.volatility,
            bondAffinity: newEntity.bondAffinity,
            disruptionCharge: newEntity.disruptionCharge
          }
        });
      }
    }

    // ── Context map decay ──
    if (tick % 10 === 0) {
      contextMap.decay(decayRate * 10); // batch decay every 10 ticks
    }
  }

  // ── Reproduction logic ───────────────────────────────────────────────

  trySpawnEntities() {
    const { config, rng, weatherSystem, entities, spawnCooldowns, tick } = this;
    if (entities.filter(e => e.alive).length >= config.maxPopulation) return;

    const aliveEntities = entities.filter(e => e.alive);

    // Check each alive entity as potential spawn center
    // Use spatial hash to find clusters
    const checked = new Set();

    for (const entity of aliveEntities) {
      const cellKey = `${Math.floor(entity.x / 100)},${Math.floor(entity.y / 100)}`;
      if (checked.has(cellKey)) continue;
      checked.add(cellKey);

      // Check spawn cooldown for this cell
      if (spawnCooldowns[cellKey] && tick - spawnCooldowns[cellKey] < config.spawnCooldown) continue;

      // Count nearby entities within 100px
      const nearby = this.getNearbyEntities(entity.x, entity.y, 100);
      const nearbyAlive = nearby.filter(e => e.alive && e.id !== entity.id);
      if (nearbyAlive.length < config.spawnThreshold) continue;

      // Check average bond affinity
      let avgB = 0;
      for (const e of nearbyAlive) avgB += e.bondAffinity;
      avgB /= nearbyAlive.length;

      // Weather modifiers lower the community threshold (easier reproduction)
      const seasonMod = weatherSystem ? weatherSystem.getSeasonalModifiers(config) : { spawnModifier: 1.0 };
      const bloomEffects = weatherSystem ? weatherSystem.getBloomEffectsAt(entity.x, entity.y, config) : { spawnModifier: 1.0 };
      const effectiveCommunityThresh = config.communityThreshold / (seasonMod.spawnModifier * bloomEffects.spawnModifier);
      if (avgB < effectiveCommunityThresh) continue;

      // Spawn new entity at cluster center
      let cx = 0, cy = 0;
      for (const e of nearbyAlive) { cx += e.x; cy += e.y; }
      cx /= nearbyAlive.length;
      cy /= nearbyAlive.length;
      cx += (rng() - 0.5) * 30;
      cy += (rng() - 0.5) * 30;
      cx = ((cx % config.canvasWidth) + config.canvasWidth) % config.canvasWidth;
      cy = ((cy % config.canvasHeight) + config.canvasHeight) % config.canvasHeight;

      const newEntity = Entity.spawn(cx, cy, nearbyAlive, rng, tick);
      entities.push(newEntity);
      spawnCooldowns[cellKey] = tick;

      this.onEvent('entity_spawned', tick, {
        entityId: newEntity.id,
        x: cx,
        y: cy,
        cause: 'reproduction',
        nearbyCount: nearbyAlive.length,
        parameters: {
          sociability: newEntity.sociability,
          inertia: newEntity.inertia,
          volatility: newEntity.volatility,
          bondAffinity: newEntity.bondAffinity,
          disruptionCharge: newEntity.disruptionCharge
        }
      });

      // Only spawn one per tick to prevent explosions
      break;
    }
  }
}
