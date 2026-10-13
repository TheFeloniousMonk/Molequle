// runheader.js — Identifies the physics and the runtime a world ran on.
// Recorded in every state push and save so that two runs of the same seed that
// disagree can be diagnosed: transcendental Math functions (sin, cos, log, pow,
// ...) may differ in the last bit between JavaScript engines and versions.

export const PHYSICS_VERSION = 1;

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

export function buildRunHeader(seed) {
  return {
    physicsVersion: PHYSICS_VERSION,
    mathMode: 'platform',
    seed,
    ...runtimeInfo(),
  };
}
