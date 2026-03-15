// Seeded PRNG — mulberry32
// All simulation randomness flows through this for determinism

export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Gaussian random using Box-Muller transform (uses two uniform samples)
export function gaussianRandom(rng, mean = 0, stddev = 1) {
  const u1 = rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
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
