// main.js — Entry point and orchestrator for the emergent art simulation
// Initializes all systems, runs the animation loop, handles keyboard shortcuts

import { mulberry32, seededUUID } from './prng.js';
import { Entity } from './entity.js';
import { ContextMap } from './context-map.js';
import { Renderer } from './renderer.js';
import { EventSystem } from './events.js';
import { UI } from './ui.js';
import { WeatherSystem } from './weather.js';

// ── Default configuration ──────────────────────────────────────────────

const DEFAULT_CONFIG = {
  canvasWidth: 1920,
  canvasHeight: 1080,
  initialPopulation: 120,
  maxPopulation: 500,
  ticksPerFrame: 1,

  // Movement
  perceptionRadius: 150,
  maxSpeed: 4,
  socialRadius: 120,

  // Bonding
  bondRadius: 40,
  bondDuration: 60,
  bondBreakDistance: 120,

  // Disruption
  disruptionThreshold: 0.6,
  disruptionRadius: 80,
  disruptionRegenCap: 0.8,  // must be >= disruptionThreshold so D can naturally fire

  // Bond hardening
  bondHardeningAge: 200,
  bondHardeningResistance: 0.2,
  bondRestDistance: 25,
  bondedSociabilityFloor: 0.15,
  bondedVolatilityFloor: 0.2,

  // Reproduction
  spawnThreshold: 5,
  communityThreshold: 0.4,
  spawnCooldown: 200,

  // Death
  lonelinessThreshold: 400,
  crushThreshold: 12,
  maxAge: 20000,

  // Context map
  halfLifeTicks: 5000,
  gridCols: 96,
  gridRows: 54,

  // Hue drift — color becomes biography
  hueDriftRate: 0.02,            // base per-tick hue accumulation
  hueDriftBondForm: 0.5,         // hue bump on bond formation
  hueDriftBondBreak: 1.0,        // hue bump on bond break
  hueDriftDisruption: 0.3,       // per-tick hue drift in disruption zones
  hueDriftTravel: 0.1,           // per-tick hue drift at high speed

  // Size variance
  sizeGrowthDuration: 600,       // ticks for newborn to reach full size
  sizeBondScale: 0.1,            // size increase per active bond

  // Trails
  trailDecayRate: 0.003,
  trailDecayScaling: true,       // scale trail decay with avg movement speed

  // Parameter overhaul: floors, ceilings, counter-pressures
  volatilityFloor: 0.1,          // universal V floor (most important single change)
  inertiaCeiling: 0.85,          // hard I ceiling
  bondAffinityCeiling: 0.95,     // hard B ceiling
  disruptionPostFireDrop: 0.3,   // D drops by this after firing, not to 0
  bPassiveDecayRate: 0.00005,    // B passive downward drift per tick
  cabinFeverThreshold: 500,      // ticks of low S before restlessness kicks in
  cabinFeverRate: 0.0003,        // S upward drift rate during cabin fever
  homeostasisRate: 0.0001,       // drift rate back toward birth parameters
  noveltyThreshold: 1000,        // ticks absent from a cell to trigger novelty boost
  noveltyBoost: 0.03,            // V boost when entering novel region
  overcrowdingBondThreshold: 5,  // bond count where B starts decreasing
  driftNoiseScale: 0.001,        // per-tick random walk magnitude (scaled by V)

  // Weather: Seasons
  seasonLength: 12000,
  seasonAmplitude: 0.5,

  // Weather: Migration Currents
  currentCount: 2,
  currentStrength: 0.3,
  currentWidth: 200,
  currentLifetime: 5000,
  currentSpawnRate: 0.0005,

  // Weather: Fertility Blooms
  bloomSpawnRate: 0.0002,
  bloomRadiusMin: 100,
  bloomRadiusMax: 250,
  bloomLifetimeMin: 2000,
  bloomLifetimeMax: 5000,
  bloomIntensity: 1.5,
  bloomMax: 3,

  // Weather: Disruption Storms
  stormSpawnRate: 0.00008,
  stormRadiusMin: 80,
  stormRadiusMax: 200,
  stormLifetimeMin: 1000,
  stormLifetimeMax: 3000,
  stormIntensity: 1.5,
  stormMax: 2,

  // Bond topology: second-degree attraction & shared-neighbor reinforcement
  secondDegreeStrength: 0.15,    // attraction force between 2-hop neighbors (0 = off)
  sharedNeighborBonus: 0.03,     // bond strength bonus per shared neighbor per tick
  secondDegreeMaxRange: 200,     // max distance for second-degree pull

  // Display toggles
  showTrails: true,
  showContextMap: false,
  smoother: false,
  paused: false,

  // Current state (written by main loop for renderer/UI)
  currentTick: 0
};

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

// Spatial hash for neighbor lookups
let spatialHash = {};
const SPATIAL_CELL_SIZE = 80;

// Spawn cooldowns per context-map cell
let spawnCooldowns = {};

// ── Spatial hashing ────────────────────────────────────────────────────

function buildSpatialHash(entities) {
  spatialHash = {};
  for (const e of entities) {
    if (!e.alive) continue;
    const cx = Math.floor(e.x / SPATIAL_CELL_SIZE);
    const cy = Math.floor(e.y / SPATIAL_CELL_SIZE);
    const key = `${cx},${cy}`;
    if (!spatialHash[key]) spatialHash[key] = [];
    spatialHash[key].push(e);
  }
}

function getNearbyEntities(x, y, radius) {
  const results = [];
  const cr = Math.ceil(radius / SPATIAL_CELL_SIZE);
  const cx = Math.floor(x / SPATIAL_CELL_SIZE);
  const cy = Math.floor(y / SPATIAL_CELL_SIZE);
  const maxCX = Math.ceil(config.canvasWidth / SPATIAL_CELL_SIZE);
  const maxCY = Math.ceil(config.canvasHeight / SPATIAL_CELL_SIZE);

  for (let dx = -cr; dx <= cr; dx++) {
    for (let dy = -cr; dy <= cr; dy++) {
      // Toroidal wrapping for spatial hash
      const gx = ((cx + dx) % maxCX + maxCX) % maxCX;
      const gy = ((cy + dy) % maxCY + maxCY) % maxCY;
      const key = `${gx},${gy}`;
      const bucket = spatialHash[key];
      if (bucket) {
        for (const e of bucket) {
          results.push(e);
        }
      }
    }
  }
  return results;
}

// ── Initialization ─────────────────────────────────────────────────────

async function init() {
  const mainCanvas = document.getElementById('main-canvas');
  const trailCanvas = document.getElementById('trail-canvas');

  contextMap = new ContextMap(config.gridCols, config.gridRows, config.canvasWidth, config.canvasHeight);
  renderer = new Renderer(mainCanvas, trailCanvas);
  eventSystem = new EventSystem();
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
      seed = newSeed || Date.now();
      resetSimulation();
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
    case 'r':
      resetSimulation();
      break;
    case 'n':
      seed = Date.now();
      resetSimulation();
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
    entity.update(nearby, contextMap, config, rng, tick, weatherEffects);

    // Apply smoother if enabled
    if (config.smoother) {
      entity.applySmoother(config);
    }
  }

  // ── Bond updates ──
  for (const entity of aliveEntities) {
    const breakEvents = entity.updateBonds(entities, contextMap, config, tick);
    for (const evt of breakEvents) {
      eventSystem.logEvent('bond_broken', tick, evt);
      // Also break bond on the other side
      const partner = entities.find(e => e.id === evt.entityB);
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
  for (let i = 0; i < aliveEntities.length; i++) {
    const entityA = aliveEntities[i];
    if (entityA.bonds.length >= 3) continue;

    // Per-entity bloom modifier
    const bloomEffects = weatherSystem.getBloomEffectsAt(entityA.x, entityA.y, config);
    config._weatherBondModifier = seasonMods.bondFormationModifier * bloomEffects.bondModifier;

    const nearby = getNearbyEntities(entityA.x, entityA.y, config.bondRadius);
    for (const entityB of nearby) {
      if (entityB.id <= entityA.id || !entityB.alive) continue;
      if (entityB.bonds.length >= 3) continue;

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
  for (const entity of aliveEntities) {
    const cause = entity.checkDeath(entities, config, tick);
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
  if (eventSystem.shouldPushState(tick)) {
    eventSystem.pushState(entities, contextMap, config, tick, seed, config.smoother, startTime, weatherSystem);
  }
  if (eventSystem.shouldPushMetrics(tick)) {
    eventSystem.pushMetrics(entities, contextMap, tick, config, weatherSystem);
  }
  if (eventSystem.shouldSave(tick)) {
    eventSystem.saveState(entities, contextMap, config, tick, seed, config.smoother, startTime, weatherSystem);
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
        seed = control.seed || Date.now();
        resetSimulation();
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
