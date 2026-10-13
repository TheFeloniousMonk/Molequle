// main.js — Entry point for the browser app
// Drives the simulation core (sim.js) from the animation loop, renders it,
// and handles the UI, keyboard shortcuts and server communication.

import { Simulation } from './sim.js';
import { Renderer } from './renderer.js';
import { EventSystem } from './events.js';
import { UI } from './ui.js';
import { DEFAULT_CONFIG } from './params.js';
import { ELEMENT_NAMES } from './elements.js';

// Earlier defaults of trailDecayRate (1.x, 2.0.0–2.0.2), migrated on load
const PREVIOUS_TRAIL_DECAY_DEFAULTS = [0.003, 0.0015];

// ── App state ──────────────────────────────────────────────────────────

let sim = null;
let renderer = null;
let eventSystem = null;
let ui = null;
let startTime = Date.now();
let running = false;
let lastFrameTime = 0;

// ── Initialization ─────────────────────────────────────────────────────

async function init() {
  const mainCanvas = document.getElementById('main-canvas');

  // ?dev in the URL samples trail-layer luminance into window.__molequleDev
  renderer = new Renderer(mainCanvas, { dev: new URLSearchParams(location.search).has('dev') });
  eventSystem = new EventSystem();
  sim = new Simulation({
    onEvent: (type, tick, data) => eventSystem.logEvent(type, tick, data),
    onBondBreak: (x1, y1, x2, y2) => renderer.addBondBreakFlash(x1, y1, x2, y2),
  });
  // Read sim state at call time — reset/new run/restore replace its parts
  eventSystem.setStateProvider(() => ({
    entities: sim.entities, contextMap: sim.contextMap, config: sim.config, tick: sim.tick,
    seed: sim.seed, smoother: sim.config.smoother, startTime, weatherSystem: sim.weatherSystem,
    exactState: () => sim.exactState()
  }));

  // Try to load saved state
  const savedState = await eventSystem.loadState();

  if (sim.restore(savedState)) {
    // The default trail decay has been lowered (visual only). Saves store the
    // full config, so worlds saved with an earlier default would never pick up
    // the new one; custom values are left alone.
    if (PREVIOUS_TRAIL_DECAY_DEFAULTS.includes(sim.config.trailDecayRate)) sim.config.trailDecayRate = DEFAULT_CONFIG.trailDecayRate;
    startTime = Date.now() - (savedState.runTime || 0);
    console.log(`Restored state: tick ${sim.tick}, ${sim.entities.length} entities`);
  } else {
    // Fresh start
    sim.reset();
    console.log(`Fresh start: seed ${sim.seed}, ${sim.entities.length} entities`);
  }

  // Initialize UI
  ui = new UI(sim.config, {
    onConfigChange: (key, value) => {
      sim.setParam(key, value);
    },
    onNewRun: (newSeed) => {
      startNewRun(newSeed || Date.now());
    },
    onReset: () => {
      resetSimulation();
    },
    onTogglePause: () => {
      sim.config.paused = !sim.config.paused;
    },
    onToggleSmoother: () => {
      sim.config.smoother = !sim.config.smoother;
    },
    onToggleTrails: () => {
      sim.config.showTrails = !sim.config.showTrails;
      if (!sim.config.showTrails) renderer.clearTrails();
    },
    onToggleContextMap: () => {
      sim.config.showContextMap = !sim.config.showContextMap;
    }
  });

  // Keyboard controls
  document.addEventListener('keydown', handleKeyboard);

  // Start loop
  running = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(loop);
}

// Start a fresh world with a new seed (at the current physics version) and
// save it right away, so a reload before the first periodic autosave doesn't
// restore the previous world.
function startNewRun(newSeed) {
  startTime = Date.now();
  renderer.clearTrails();
  sim.newRun(newSeed);
  if (ui) ui.syncFromConfig(sim.config);
  console.log(`New run: seed ${sim.seed}, ${sim.entities.length} entities`);
  eventSystem.requestSave();
}

// Restart the current world from its seed (same physics)
function resetSimulation() {
  startTime = Date.now();
  renderer.clearTrails();
  sim.reset();
  console.log(`Reset: seed ${sim.seed}, ${sim.entities.length} entities`);
}

// ── Keyboard handler ───────────────────────────────────────────────────

function handleKeyboard(e) {
  if (e.target.tagName === 'INPUT') return; // Don't capture when typing in inputs
  const config = sim.config;

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

// ── Simulation tick + server communication ─────────────────────────────

function simulationTick() {
  sim.step();
  const tick = sim.tick;

  if (eventSystem.shouldFlushEvents(tick)) {
    eventSystem.flushEvents();
  }
  // State push and save are only flagged here; serialization runs in an
  // idle callback outside the animation frame (see EventSystem._runDeferred)
  if (eventSystem.shouldPushState(tick)) {
    eventSystem.requestStatePush();
  }
  if (eventSystem.shouldPushMetrics(tick)) {
    eventSystem.pushMetrics(sim.entities, sim.contextMap, tick, sim.config, sim.weatherSystem);
  }
  if (eventSystem.shouldSave(tick)) {
    eventSystem.requestSave();
  }
  if (eventSystem.shouldPoll(tick)) {
    pollServer();
  }
}

// ── Server polling ─────────────────────────────────────────────────────

async function pollServer() {
  // Poll for parameter changes from API
  const params = await eventSystem.pollPendingParams();
  if (params && Object.keys(params).length > 0) {
    for (const [key, value] of Object.entries(params)) {
      if (key in sim.config) {
        sim.setParam(key, value);
      }
    }
    if (ui) ui.syncFromConfig(sim.config);
  }

  // Poll for control commands
  const control = await eventSystem.pollControl();
  if (control && control.command) {
    switch (control.command) {
      case 'pause':
        sim.config.paused = true;
        break;
      case 'resume':
        sim.config.paused = false;
        break;
      case 'reset':
        resetSimulation();
        break;
      case 'new_run':
        startNewRun(control.seed || Date.now());
        break;
      case 'smoother_on':
        sim.config.smoother = true;
        break;
      case 'smoother_off':
        sim.config.smoother = false;
        break;
    }
    if (ui) ui.updateToggles(sim.config);
  }
}

// ── Animation loop ─────────────────────────────────────────────────────

function loop(timestamp) {
  if (!running) return;

  if (!sim.config.paused) {
    for (let i = 0; i < (sim.config.ticksPerFrame || 1); i++) {
      simulationTick();
    }
  }

  // Render every frame regardless of pause
  renderer.render(sim.entities, sim.contextMap, sim.config, sim.weatherSystem);

  // Update UI
  if (ui) {
    ui.update(sim.entities, sim.contextMap, sim.config, sim.tick, sim.seed, startTime, sim.weatherSystem);
  }

  requestAnimationFrame(loop);
}

// ── Start ──────────────────────────────────────────────────────────────

init().catch(err => console.error('Failed to initialize:', err));
