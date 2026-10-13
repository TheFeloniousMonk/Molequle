// simmath.js — The transcendental math the simulation core uses.
//
// Sim-core code calls sm.sin / sm.cos / sm.log / sm.pow, never Math.sin etc.
// (tests/lint-simcore.mjs enforces this). Which implementation answers depends
// on the world's physics:
//   'deterministic' — dmath.js: the same bits on every engine and platform.
//   'platform'      — native Math: the engine's own, last-bit-dependent results.
//                     Physics version 1 always uses this (worlds from before 2.1).
// Simulation.step() selects the mode at the start of every tick, so several
// worlds in one process can use different modes.

import * as dmath from './dmath.js';

export const MATH_MODES = ['deterministic', 'platform'];

const native = { sin: Math.sin, cos: Math.cos, log: Math.log, pow: Math.pow };

export const sm = { ...dmath };
let mode = 'deterministic';
let recorder = null;

/** The math mode a config actually runs with. */
export function effectiveMathMode(config) {
  if ((config.physicsVersion ?? 1) < 2) return 'platform';
  return config.mathMode === 'platform' ? 'platform' : 'deterministic';
}

export function setMathMode(next) {
  if (next === mode) return;
  mode = next;
  bind();
}

export function getMathMode() {
  return mode;
}

/**
 * Record every call (name, args, result) until stopped — the harness's
 * `mathlog` uses this to show which approximated calls one tick makes.
 * Pass null to stop.
 */
export function setMathRecorder(fn) {
  recorder = fn;
  bind();
}

function bind() {
  const impl = mode === 'platform' ? native : dmath;
  for (const name of Object.keys(native)) {
    const f = impl[name];
    sm[name] = recorder
      ? (...args) => { const r = f(...args); recorder(name, args, r); return r; }
      : f;
  }
}
