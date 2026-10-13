// harness.mjs — Headless Molequle for Node: build worlds, step them, hash them.
// Shared by the CLI (molequle-play.mjs) and the tests. Runs the same simulation
// core as the browser (client/js/sim.js); no server or browser needed.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Simulation } from '../client/js/sim.js';
import { DEFAULT_CONFIG } from '../client/js/params.js';
import { buildRunHeader } from '../client/js/runheader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');
export const CLIENT_DIR = path.join(REPO_ROOT, 'client', 'js');

// sha256 of a text file with line endings normalized, so a Windows checkout
// (CRLF) and a Linux checkout (LF) of the same commit hash the same.
export function textSha256(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Identifies the harness and the simulation code it ran
export function codeInfo() {
  const simFiles = ['sim.js', 'entity.js', 'weather.js', 'context-map.js', 'prng.js', 'params.js',
    'dmath.js', 'simmath.js', 'chaos.js'];
  const h = crypto.createHash('sha256');
  for (const f of simFiles) h.update(textSha256(path.join(CLIENT_DIR, f)));
  return {
    harnessSha256: textSha256(path.join(here, 'molequle-play.mjs')),
    simCodeSha256: h.digest('hex'),
  };
}

export function runHeader(sim) {
  const code = codeInfo();
  return {
    ...buildRunHeader(sim.seed, sim.config),
    harnessSha256: code.harnessSha256.slice(0, 16),
    simCodeSha256: code.simCodeSha256.slice(0, 16),
  };
}

export function formatHeader(h) {
  return Object.entries(h)
    .map(([k, v]) => `${k}=${Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v}`)
    .join(', ');
}

/**
 * A fresh world: DEFAULT_CONFIG plus overrides, at tick 0.
 * Events go to `events` (as JSON snapshots, so later mutation can't alter them).
 */
export function createWorld(seed, overrides = {}, { keepEvents = true } = {}) {
  const events = [];
  const sim = new Simulation({
    config: { ...DEFAULT_CONFIG, ...overrides },
    seed,
    onEvent: keepEvents ? (type, tick, data) => events.push(JSON.parse(JSON.stringify({ type, tick, data }))) : undefined,
  });
  sim.reset();
  sim.events = events;
  return sim;
}

/** Serialize a world the way the browser saves it (restorable by the app and by loadWorld). */
export function saveWorld(sim) {
  return {
    runHeader: buildRunHeader(sim.seed, sim.config),
    tick: sim.tick,
    seed: sim.seed,
    config: sim.config,
    population: sim.entities.filter(e => e.alive).length,
    entities: sim.entities.map(e => e.serialize()),
    contextMap: sim.contextMap.toSparse(),
    smoother: sim.config.smoother,
    runTime: 0,
    weatherSave: sim.weatherSystem.serialize(),
    exact: sim.exactState(),
  };
}

export function loadWorld(saved, { keepEvents = true } = {}) {
  const events = [];
  const sim = new Simulation({
    onEvent: keepEvents ? (type, tick, data) => events.push(JSON.parse(JSON.stringify({ type, tick, data }))) : undefined,
  });
  // A JSON round trip gives the restored world its own copies of everything
  if (!sim.restore(JSON.parse(JSON.stringify(saved)))) throw new Error('save has no entities');
  sim.events = events;
  return sim;
}

/**
 * Hash of the complete simulation state: every entity (all serialized fields),
 * the full-precision context map, weather, generator states, spawn cooldowns
 * and the tick. Two worlds with equal hashes evolve identically from here on.
 * Thorough but slow (~40 ms at 800 entities); traces use tickHash.
 */
export function stateHash(sim) {
  const h = crypto.createHash('sha256');
  h.update(String(sim.tick));
  for (const e of sim.entities) h.update(JSON.stringify(e.serialize()));
  h.update(JSON.stringify(sim.weatherSystem.serialize()));
  h.update(JSON.stringify(sim.exactState()));
  return h.digest('hex').slice(0, 16);
}

// Reusable buffer for tickHash's numbers
let numBuf = new Float64Array(1 << 16);
let numLen = 0;
function num(v) {
  if (numLen === numBuf.length) {
    const bigger = new Float64Array(numBuf.length * 2);
    bigger.set(numBuf);
    numBuf = bigger;
  }
  numBuf[numLen++] = v;
}

/**
 * Fast per-tick hash (~1 ms) of the state that evolves every tick: each
 * entity's position, velocity, parameters, bonds, counters and proximity
 * tracking, plus the full context map, weather, generator states and spawn
 * cooldowns — as raw float64 bits. It leaves out only the bookkeeping that is
 * derived from those (parameterHistory, cellAbsenceTicks), which stateHash
 * covers; trace() checks that every 100 ticks.
 */
export function tickHash(sim) {
  numLen = 0;
  let text = '';
  num(sim.tick);
  for (const e of sim.entities) {
    text += e.id + '|' + e.lastCellKey + '|';
    num(e.x); num(e.y); num(e.vx); num(e.vy);
    num(e.sociability); num(e.inertia); num(e.volatility); num(e.bondAffinity); num(e.disruptionCharge);
    num(e.age); num(e.alive ? 1 : 0); num(e.fadeProgress); num(e.isolationTicks); num(e.relationalLoneliness);
    num(e.recentBondBreakTick); num(e.hueOffset); num(e.lowSociabilityTicks); num(e.disruptionRegenNoise);
    num(e.bonds.length);
    for (const b of e.bonds) { text += b.targetId; num(b.strength); num(b.formedAt); }
    for (const id in e.proximityTicks) { text += id; num(e.proximityTicks[id]); }
    num(e.parameterHistory.length);
  }
  const grid = sim.contextMap.grid;
  for (const row of grid) {
    for (const c of row) { num(c.bondFormations); num(c.bondBreaks); num(c.totalPresence); num(c.disruptionEvents); num(c.lastActivity); }
  }
  num(sim.rng.getState()); num(sim.streams.perturb.getState()); num(sim.streams.cosmic.getState());
  text += JSON.stringify(sim.weatherSystem.serialize()) + JSON.stringify(sim.spawnCooldowns);
  const h = crypto.createHash('sha256');
  h.update(new Uint8Array(numBuf.buffer, 0, numLen * 8));
  h.update(text);
  return h.digest('hex').slice(0, 16);
}

/**
 * Step n ticks, returning one hash per tick: tickHash every tick, combined
 * with the full stateHash on every 100th tick. A tick's hash depends only on
 * the world, so a shorter trace is a prefix of a longer one.
 */
export function trace(sim, n, onTick) {
  const hashes = [];
  for (let i = 1; i <= n; i++) {
    sim.step();
    let h = tickHash(sim);
    if (sim.tick % 100 === 0) h = crypto.createHash('sha256').update(h + stateHash(sim)).digest('hex').slice(0, 16);
    hashes.push(h);
    if (onTick) onTick(sim, h);
  }
  return hashes;
}

/** First index where two hash lists differ, or -1. */
export function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ── Golden traces ──────────────────────────────────────────────────────

export const GOLDEN_DIR = path.join(REPO_ROOT, 'tests', 'golden');
export const GOLDEN_TICKS = 5000;
export const GOLDEN_CASES = [
  ...[7, 11, 23, 42].flatMap(seed => [false, true].map(smoother => ({
    name: `seed${seed}-cap800-smoother${smoother ? 'On' : 'Off'}`,
    seed,
    config: { maxPopulation: 800, smoother, physicsVersion: 2, mathMode: 'deterministic' },
  }))),
  // Chaos runs must reproduce across runtimes too, flip log included
  {
    name: 'seed23-cap800-cosmic0.5-fixed16',
    seed: 23,
    chaos: true,
    config: { maxPopulation: 800, physicsVersion: 2, mathMode: 'deterministic', cosmicRate: 0.5, cosmicMode: 'fixed16' },
  },
  {
    name: 'seed23-cap800-cosmic0.5-ieee754-perturb',
    seed: 23,
    chaos: true,
    config: {
      maxPopulation: 800, physicsVersion: 2, mathMode: 'deterministic', cosmicRate: 0.5, cosmicMode: 'ieee754',
      perturb: [{ tick: 1000, target: 'random', ulps: 1 }, { tick: 3000, target: 'storm.intensity', ulps: -1 }],
    },
  },
];

/** sha256 of a world's chaos events (cosmic flips and perturbations), in order. */
export function chaosEventsHash(sim) {
  const chaos = sim.events.filter(e => e.type === 'cosmic_flip' || e.type === 'perturb');
  return { count: chaos.length, sha256: crypto.createHash('sha256').update(JSON.stringify(chaos)).digest('hex').slice(0, 16) };
}

// The selftest: the first 500 ticks of the seed 23 golden (Smoother off)
export const SELFTEST = { golden: 'seed23-cap800-smootherOff', ticks: 500 };

export function readGolden(name) {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8'));
}
