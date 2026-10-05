// main.js — Entry point and orchestrator for the emergent art simulation
// Initializes all systems, runs the animation loop, handles keyboard shortcuts

import { mulberry32, seededUUID } from './prng.js';
import { Entity } from './entity.js';
import { ContextMap } from './context-map.js';
import { Renderer } from './renderer.js';
import { EventSystem } from './events.js';
import { UI } from './ui.js';
import { WeatherSystem } from './weather.js';
import { DEFAULT_CONFIG } from './params.js';
import { ELEMENT_NAMES } from './elements.js';

// Earlier defaults of trailDecayRate (1.x, 2.0.0–2.0.2), migrated on load
const PREVIOUS_TRAIL_DECAY_DEFAULTS = [0.003, 0.0015];

// ── Global simulation state ────────────────────────────────────────────

let config = { ...DEFAULT_CONFIG };
let seed = Date.now();
let rng = mulberry32(seed);
let entities = [];
let contextMap = null;
let weatherSystem = null;
let renderer = null;
let eventSystem = null;
let ui = null;
let tick = 0;
let startTime = Date.now();
let running = false;
let lastFrameTime = 0;

// Spatial hash for neighbor lookups: flat grid of reusable buckets
// (cell index = cy * cols + cx), rebuilt from scratch each tick.
const SPATIAL_CELL_SIZE = 80;
let spatialCols = 0;
let spatialRows = 0;
let spatialBuckets = [];

// Per-tick id -> entity lookup (replaces per-entity map building / Array.find)
let entityById = new Map();

// Crush-check grid: built from post-movement positions for the death phase.
// Cells are at least CRUSH_RADIUS wide, so a 3x3 block covers the radius.
const CRUSH_RADIUS = 50;
let crushCols = 0;
let crushRows = 0;
let crushCellW = 0;
let crushCellH = 0;
let crushBuckets = [];

// Spawn cooldowns per context-map cell
let spawnCooldowns = {};

// ── Spatial hashing ────────────────────────────────────────────────────

function buildSpatialHash(entities) {
  const cols = Math.ceil(config.canvasWidth / SPATIAL_CELL_SIZE);
  const rows = Math.ceil(config.canvasHeight / SPATIAL_CELL_SIZE);
  if (cols !== spatialCols || rows !== spatialRows) {
    spatialCols = cols;
    spatialRows = rows;
    spatialBuckets = Array.from({ length: cols * rows }, () => []);
  } else {
    for (let i = 0; i < spatialBuckets.length; i++) spatialBuckets[i].length = 0;
  }
  for (const e of entities) {
    if (!e.alive) continue;
    const cx = Math.floor(e.x / SPATIAL_CELL_SIZE);
    const cy = Math.floor(e.y / SPATIAL_CELL_SIZE);
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
      spatialBuckets[cy * cols + cx].push(e);
    }
  }
}

function getNearbyEntities(x, y, radius) {
  const results = [];
  const cr = Math.ceil(radius / SPATIAL_CELL_SIZE);
  const cx = Math.floor(x / SPATIAL_CELL_SIZE);
  const cy = Math.floor(y / SPATIAL_CELL_SIZE);
  const maxCX = spatialCols;
  const maxCY = spatialRows;

  for (let dx = -cr; dx <= cr; dx++) {
    // Toroidal wrapping for spatial hash
    const gx = ((cx + dx) % maxCX + maxCX) % maxCX;
    for (let dy = -cr; dy <= cr; dy++) {
      const gy = ((cy + dy) % maxCY + maxCY) % maxCY;
      const bucket = spatialBuckets[gy * maxCX + gx];
      if (bucket) {
        for (let i = 0; i < bucket.length; i++) results.push(bucket[i]);
      }
    }
  }
  return results;
}

function buildCrushGrid(entities) {
  const cols = Math.max(1, Math.floor(config.canvasWidth / CRUSH_RADIUS));
  const rows = Math.max(1, Math.floor(config.canvasHeight / CRUSH_RADIUS));
  if (cols !== crushCols || rows !== crushRows) {
    crushCols = cols;
    crushRows = rows;
    crushBuckets = Array.from({ length: cols * rows }, () => []);
  } else {
    for (let i = 0; i < crushBuckets.length; i++) crushBuckets[i].length = 0;
  }
  crushCellW = config.canvasWidth / cols;
  crushCellH = config.canvasHeight / rows;
  for (const e of entities) {
    if (!e.alive) continue;
    const cx = Math.min(cols - 1, Math.floor(e.x / crushCellW));
    const cy = Math.min(rows - 1, Math.floor(e.y / crushCellH));
    if (cx >= 0 && cy >= 0) crushBuckets[cy * cols + cx].push(e);
  }
}

// Candidates within CRUSH_RADIUS of an entity (superset; exact distance is
// checked in checkDeath). Falls back to all entities on tiny canvases where
// the 3x3 block would wrap onto itself and repeat cells.
function getCrushCandidates(entity) {
  if (crushCols < 3 || crushRows < 3) return entities;
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

// ── Initialization ─────────────────────────────────────────────────────

async function init() {
  const mainCanvas = document.getElementById('main-canvas');

  contextMap = new ContextMap(config.gridCols, config.gridRows, config.canvasWidth, config.canvasHeight);
  // ?dev in the URL samples trail-layer luminance into window.__molequleDev
  renderer = new Renderer(mainCanvas, { dev: new URLSearchParams(location.search).has('dev') });
  eventSystem = new EventSystem();
  // Read module state at call time — resetSimulation() reassigns these
  eventSystem.setStateProvider(() => ({
    entities, contextMap, config, tick, seed, smoother: config.smoother, startTime, weatherSystem
  }));
  weatherSystem = new WeatherSystem(rng);

  // Try to load saved state
  const savedState = await eventSystem.loadState();

  if (savedState && savedState.entities && savedState.entities.length > 0) {
    // Restore from saved state
    seed = savedState.seed || seed;
    rng = mulberry32(seed);
    // Advance rng to approximate position (not perfect but prevents same sequence)
    for (let i = 0; i < (savedState.tick || 0) % 1000; i++) rng();

    tick = savedState.tick || 0;
    config = { ...DEFAULT_CONFIG, ...(savedState.config || {}) };
    config.smoother = savedState.smoother || false;
    // The default trail decay has been lowered (visual only). Saves store the
    // full config, so worlds saved with an earlier default would never pick up
    // the new one; custom values are left alone.
    if (PREVIOUS_TRAIL_DECAY_DEFAULTS.includes(config.trailDecayRate)) config.trailDecayRate = DEFAULT_CONFIG.trailDecayRate;

    entities = savedState.entities.map(d => Entity.deserialize(d));

    if (savedState.contextMap) {
      contextMap.fromSparse(savedState.contextMap);
    }

    // Restore weather state (weatherSave has full serialization data)
    weatherSystem = new WeatherSystem(rng);
    if (savedState.weatherSave) {
      weatherSystem.restore(savedState.weatherSave);
    }

    startTime = Date.now() - (savedState.runTime || 0);
    console.log(`Restored state: tick ${tick}, ${entities.length} entities`);
  } else {
    // Fresh start
    spawnInitialEntities();
    console.log(`Fresh start: seed ${seed}, ${entities.length} entities`);
  }

  // Initialize UI
  ui = new UI(config, {
    onConfigChange: (key, value) => {
      config[key] = value;
      if (key === 'halfLifeTicks') {
        // Recalc decay rate display if UI shows it
      }
    },
    onNewRun: (newSeed) => {
      startNewRun(newSeed || Date.now());
    },
    onReset: () => {
      resetSimulation();
    },
    onTogglePause: () => {
      config.paused = !config.paused;
    },
    onToggleSmoother: () => {
      config.smoother = !config.smoother;
    },
    onToggleTrails: () => {
      config.showTrails = !config.showTrails;
      if (!config.showTrails) renderer.clearTrails();
    },
    onToggleContextMap: () => {
      config.showContextMap = !config.showContextMap;
    }
  });

  // Keyboard controls
  document.addEventListener('keydown', handleKeyboard);

  // Start loop
  running = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(loop);
}

function spawnInitialEntities() {
  entities = [];
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
    entities.push(new Entity(id, x, y, params, rng));
  }
}

// Start a fresh world with a new seed and save it right away, so a reload
// before the first periodic autosave doesn't restore the previous world.
function startNewRun(newSeed) {
  seed = newSeed;
  resetSimulation();
  eventSystem.requestSave();
}

function resetSimulation() {
  rng = mulberry32(seed);
  tick = 0;
  startTime = Date.now();
  spawnCooldowns = {};
  contextMap = new ContextMap(config.gridCols, config.gridRows, config.canvasWidth, config.canvasHeight);
  weatherSystem = new WeatherSystem(rng);
  renderer.clearTrails();
  spawnInitialEntities();
  console.log(`Reset: seed ${seed}, ${entities.length} entities`);
}

// ── Keyboard handler ───────────────────────────────────────────────────

function handleKeyboard(e) {
  if (e.target.tagName === 'INPUT') return; // Don't capture when typing in inputs

  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      config.paused = !config.paused;
      if (ui) ui.updateToggles(config);
      break;
    case 'm':
      config.showContextMap = !config.showContextMap;
      if (ui) ui.updateToggles(config);
      break;
    case 't':
      config.showTrails = !config.showTrails;
      if (!config.showTrails) renderer.clearTrails();
      if (ui) ui.updateToggles(config);
      break;
    case 's':
      config.smoother = !config.smoother;
      if (ui) ui.updateToggles(config);
      break;
    case 'e': {
      // Cycle element (visual only)
      const i = ELEMENT_NAMES.indexOf(config.element);
      config.element = ELEMENT_NAMES[(i + 1) % ELEMENT_NAMES.length];
      if (ui) ui.syncFromConfig(config);
      break;
    }
    case 'r':
      resetSimulation();
      break;
    case 'n':
      startNewRun(Date.now());
      break;
    case 'tab':
      e.preventDefault();
      if (ui) ui.togglePanel();
      break;
    case '`':
      if (ui) ui.togglePanel();
      break;
  }
}

// ── Main simulation tick ───────────────────────────────────────────────

function simulationTick() {
  tick++;
  config.currentTick = tick;

  buildSpatialHash(entities);
  entityById.clear();
  for (const e of entities) entityById.set(e.id, e);

  const aliveEntities = entities.filter(e => e.alive);
  const decayRate = 1 / (config.halfLifeTicks || 5000);

  // ── Update weather systems ──
  const weatherEvents = [];
  weatherSystem.update(config, tick, contextMap, weatherEvents);
  for (const evt of weatherEvents) {
    eventSystem.logEvent(evt.type, tick, evt.data);
  }

  // Get seasonal modifiers (applied globally to bond formation, spawn, disruption threshold)
  const seasonMods = weatherSystem.getSeasonalModifiers(config);

  // ── Update each entity ──
  for (const entity of aliveEntities) {
    // Compute per-entity weather effects
    const weatherEffects = weatherSystem.getEffectsAt(entity.x, entity.y, config);

    // Pass nearby entities instead of all for performance
    const nearby = getNearbyEntities(entity.x, entity.y, config.perceptionRadius);
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
  const disruptors = entities.filter(e => e.alive && e.disruptionCharge > bondDisruptionThreshold);
  for (const entity of aliveEntities) {
    const breakEvents = entity.updateBonds(entities, contextMap, config, tick, entityById, disruptors);
    for (const evt of breakEvents) {
      eventSystem.logEvent('bond_broken', tick, evt);
      // Also break bond on the other side
      const partner = entityById.get(evt.entityB);
      if (partner) {
        const partnerEvt = partner.breakBond(entity.id, tick);
        if (partnerEvt) {
          // Add bond break flash
          renderer.addBondBreakFlash(entity.x, entity.y, partner.x, partner.y);
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

    const nearby = getNearbyEntities(entityA.x, entityA.y, config.bondRadius);
    for (const entityB of nearby) {
      if (entityB.id <= entityA.id || !entityB.alive) continue;
      if (entityB.bonds.length >= maxBonds) continue;

      const bondEvent = entityA.tryFormBond(entityB, contextMap, config, rng, tick);
      if (bondEvent) {
        eventSystem.logEvent('bond_formed', tick, bondEvent);
      }
    }
  }
  delete config._weatherBondModifier;

  // ── Disruption ──
  // Seasonal modifier lowers disruption threshold in summer
  const effectiveDisruptionThreshold = (config.disruptionThreshold || 0.6) + seasonMods.disruptionThresholdOffset;
  for (const entity of aliveEntities) {
    if (entity.disruptionCharge > effectiveDisruptionThreshold) {
      const nearby = getNearbyEntities(entity.x, entity.y, config.disruptionRadius);
      const disruptionEvent = entity.applyDisruption(nearby, contextMap, config, tick);
      if (disruptionEvent) {
        eventSystem.logEvent('disruption_cascade', tick, disruptionEvent);
      }
    }
  }

  // ── Death checks ──
  buildCrushGrid(entities);
  for (const entity of aliveEntities) {
    const cause = entity.checkDeath(getCrushCandidates(entity), config, tick);
    if (cause) {
      const deathEvent = entity.beginDeath(cause);
      eventSystem.logEvent('entity_died', tick, deathEvent);
    }
  }

  // ── Fade dead entities ──
  for (let i = entities.length - 1; i >= 0; i--) {
    if (!entities[i].alive) {
      const shouldRemove = entities[i].updateFade();
      if (shouldRemove) {
        entities.splice(i, 1);
      }
    }
  }

  // ── Reproduction ──
  trySpawnEntities();

  // ── Minimum population safeguard ──
  const currentAlive = entities.filter(e => e.alive).length;
  if (currentAlive < 10) {
    for (let i = 0; i < 5; i++) {
      const x = rng() * config.canvasWidth;
      const y = rng() * config.canvasHeight;
      const newEntity = Entity.spawn(x, y, [], rng, tick);
      entities.push(newEntity);
      eventSystem.logEvent('entity_spawned', tick, {
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

  // ── Server communication ──
  if (eventSystem.shouldFlushEvents(tick)) {
    eventSystem.flushEvents();
  }
  // State push and save are only flagged here; serialization runs in an
  // idle callback outside the animation frame (see EventSystem._runDeferred)
  if (eventSystem.shouldPushState(tick)) {
    eventSystem.requestStatePush();
  }
  if (eventSystem.shouldPushMetrics(tick)) {
    eventSystem.pushMetrics(entities, contextMap, tick, config, weatherSystem);
  }
  if (eventSystem.shouldSave(tick)) {
    eventSystem.requestSave();
  }
  if (eventSystem.shouldPoll(tick)) {
    pollServer();
  }
}

// ── Reproduction logic ─────────────────────────────────────────────────

function trySpawnEntities() {
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
    const nearby = getNearbyEntities(entity.x, entity.y, 100);
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

    eventSystem.logEvent('entity_spawned', tick, {
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

// ── Server polling ─────────────────────────────────────────────────────

async function pollServer() {
  // Poll for parameter changes from API
  const params = await eventSystem.pollPendingParams();
  if (params && Object.keys(params).length > 0) {
    for (const [key, value] of Object.entries(params)) {
      if (key in config) {
        config[key] = value;
      }
    }
    if (ui) ui.syncFromConfig(config);
  }

  // Poll for control commands
  const control = await eventSystem.pollControl();
  if (control && control.command) {
    switch (control.command) {
      case 'pause':
        config.paused = true;
        break;
      case 'resume':
        config.paused = false;
        break;
      case 'reset':
        resetSimulation();
        break;
      case 'new_run':
        startNewRun(control.seed || Date.now());
        break;
      case 'smoother_on':
        config.smoother = true;
        break;
      case 'smoother_off':
        config.smoother = false;
        break;
    }
    if (ui) ui.updateToggles(config);
  }
}

// ── Animation loop ─────────────────────────────────────────────────────

function loop(timestamp) {
  if (!running) return;

  if (!config.paused) {
    for (let i = 0; i < (config.ticksPerFrame || 1); i++) {
      simulationTick();
    }
  }

  // Render every frame regardless of pause
  renderer.render(entities, contextMap, config, weatherSystem);

  // Update UI
  if (ui) {
    ui.update(entities, contextMap, config, tick, seed, startTime, weatherSystem);
  }

  requestAnimationFrame(loop);
}

// ── Start ──────────────────────────────────────────────────────────────

init().catch(err => console.error('Failed to initialize:', err));
