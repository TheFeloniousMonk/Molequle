// runheader.js — Identifies the physics and the runtime a world ran on.
// Recorded in every state push and save so that two runs of the same seed that
// disagree can be diagnosed: under physics version 1 (or mathMode 'platform'),
// transcendental Math functions may differ in the last bit between JavaScript
// engines and versions. Platform fields are recorded in every mode: if two
// deterministic runs ever disagree, that's a bug, and this is the first clue.

import { effectiveMathMode } from './simmath.js';

export const PHYSICS_VERSION = 2;

export function runtimeInfo() {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return { runtime: `node ${process.version}`, platform: process.platform, arch: process.arch };
  }
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  return {
    runtime: nav.userAgent || 'unknown',
    platform: (nav.userAgentData && nav.userAgentData.platform) || nav.platform || 'unknown',
    arch: '',
  };
}

export function buildRunHeader(seed, config = {}) {
  return {
    physicsVersion: config.physicsVersion ?? 1,
    mathMode: effectiveMathMode(config),
    cosmicRate: config.cosmicRate ?? 0,
    cosmicMode: config.cosmicMode ?? 'fixed16',
    perturb: config.perturb ?? [],
    seed,
    ...runtimeInfo(),
  };
}
