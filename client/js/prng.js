// Seeded PRNG — mulberry32
// All simulation randomness flows through this for determinism

import { sm } from './simmath.js';

// Returns rng(): a uniform double in [0, 1). The generator's whole state is
// one 32-bit integer, readable with rng.getState() and restorable with
// rng.setState(), so a saved world can resume the exact sequence.
export function mulberry32(seed) {
  let s = seed | 0;
  const rng = function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  rng.getState = () => s;
  rng.setState = (state) => { s = state | 0; };
  return rng;
}

// Independent PRNG streams derived from the world seed. The simulation's own
// stream ('main') is mulberry32(seed) itself, so existing seeds keep their
// meaning; the chaos knobs each draw from their own stream, which they only
// advance while enabled.
export const STREAM_IDS = { perturb: 1, cosmic: 2 };

export function deriveStreamSeed(seed, streamId) {
  // Mix all 53 bits of the seed with the stream id (murmur3 fmix32 rounds:
  // integer-only, identical on every engine)
  const lo = seed >>> 0;
  const hi = Math.floor(seed / 4294967296) >>> 0;
  let h = Math.imul(lo ^ Math.imul(streamId, 0x9E3779B9), 0x85EBCA6B);
  h ^= h >>> 13;
  h = Math.imul(h ^ hi, 0xC2B2AE35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85EBCA6B);
  h ^= h >>> 13;
  h = Math.imul(h, 0xC2B2AE35);
  h ^= h >>> 16;
  return h | 0;
}

// Gaussian random using Box-Muller transform (uses two uniform samples)
export function gaussianRandom(rng, mean = 0, stddev = 1) {
  const u1 = rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * sm.log(u1 || 1e-10)) * sm.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

// UUID generator using seeded PRNG
export function seededUUID(rng) {
  const hex = '0123456789abcdef';
  let uuid = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += '-';
    } else if (i === 14) {
      uuid += '4';
    } else if (i === 19) {
      uuid += hex[(rng() * 4 | 0) + 8];
    } else {
      uuid += hex[rng() * 16 | 0];
    }
  }
  return uuid;
}
