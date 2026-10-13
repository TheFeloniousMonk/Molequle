// chaos.js — Explicit, seeded, logged sources of chaos.
//
// With default settings a world is fully deterministic. These knobs add chaos
// back on purpose, and reproducibly:
//   perturb     — at a given tick, nudge one named value by N ulps
//   cosmicRate  — rare random bit flips in entity parameters (per entity per 1,000 ticks)
//   cosmicMode  — how a flip is applied: 'fixed16' (default) or 'ieee754'
// Each knob draws only from its own PRNG stream (derived from the world seed)
// and never touches a stream while it is off, so a knob at zero leaves the
// world byte-identical to the knob not existing. Every perturbation and flip
// is logged as an event with before/after values.

export const PARAM_LETTERS = ['S', 'I', 'V', 'B', 'D'];
export const PARAM_NAMES = ['sociability', 'inertia', 'volatility', 'bondAffinity', 'disruptionCharge'];
export const COSMIC_MODES = ['fixed16', 'ieee754'];
export const PERTURB_GLOBALS = ['season.phase', 'storm.intensity', 'bloom.intensity', 'current.strength'];
export const MAX_PERTURB_ENTRIES = 100;
export const MAX_PERTURB_ULPS = 1 << 20;

const dv = new DataView(new ArrayBuffer(8));
const SIGN = 0x8000000000000000n;

/** The float64 bit pattern of x as 16 hex digits. */
export function hexBits(x) {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
}

/**
 * Step x by n ulps along the float64 number line (nextafter, n times).
 * Done on the integer bit pattern, so it's exact on every engine.
 */
export function stepUlps(x, n) {
  dv.setFloat64(0, x);
  const bits = dv.getBigInt64(0);
  // Map to a monotonic integer line: ..., -tiny, (+-0 = 0), +tiny, ...
  let o = bits < 0n ? -(bits & ~SIGN) : bits;
  o += BigInt(n);
  dv.setBigInt64(0, o < 0n ? BigInt.asIntN(64, (-o) | SIGN) : o);
  return dv.getFloat64(0);
}

/** Resolve a parameter name or letter (V, volatility) to its property name, or null. */
export function paramName(p) {
  const i = PARAM_LETTERS.indexOf(p);
  if (i >= 0) return PARAM_NAMES[i];
  return PARAM_NAMES.includes(p) ? p : null;
}

/**
 * Validate and normalize a perturb list ([{tick, target, ulps}]).
 * Returns { value } or { error }.
 */
export function normalizePerturb(list) {
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return { error: 'perturb: not valid JSON' }; }
  }
  if (!Array.isArray(list)) return { error: 'perturb: must be a list of {tick, target, ulps}' };
  if (list.length > MAX_PERTURB_ENTRIES) return { error: `perturb: at most ${MAX_PERTURB_ENTRIES} entries` };
  const out = [];
  for (const [i, e] of list.entries()) {
    if (!e || typeof e !== 'object') return { error: `perturb[${i}]: must be an object` };
    const tick = Number(e.tick);
    if (!Number.isInteger(tick) || tick < 1) return { error: `perturb[${i}].tick: must be an integer >= 1` };
    const target = String(e.target ?? 'random');
    const dot = target.lastIndexOf('.');
    const okTarget = target === 'random' || PERTURB_GLOBALS.includes(target) ||
      (dot > 0 && paramName(target.slice(dot + 1)) !== null);
    if (!okTarget) {
      return { error: `perturb[${i}].target: use 'random', '<entity id or id prefix>.<S|I|V|B|D>', or one of ${PERTURB_GLOBALS.join(', ')}` };
    }
    const ulps = e.ulps === undefined ? 1 : Number(e.ulps);
    if (!Number.isInteger(ulps) || ulps === 0 || Math.abs(ulps) > MAX_PERTURB_ULPS) {
      return { error: `perturb[${i}].ulps: must be a nonzero integer, |ulps| <= ${MAX_PERTURB_ULPS}` };
    }
    out.push({ tick, target, ulps });
  }
  return { value: out };
}

// ── Perturbations ──────────────────────────────────────────────────────

/** Apply every perturb entry scheduled for sim.tick. Called at the start of a tick. */
export function applyPerturbations(sim) {
  const list = sim.config.perturb;
  if (!list || list.length === 0) return;
  for (const entry of list) {
    if (entry.tick !== sim.tick) continue;
    const ulps = entry.ulps ?? 1;
    const resolved = resolveTarget(sim, entry.target);
    if (!resolved) {
      sim.onEvent('perturb', sim.tick, { target: entry.target, ulps, applied: false, reason: 'target not found' });
      continue;
    }
    const before = resolved.get();
    const after = stepUlps(before, ulps);
    resolved.set(after);
    sim.chaosStats.perturbs++;
    sim.onEvent('perturb', sim.tick, {
      target: entry.target,
      resolved: resolved.name,
      ulps,
      applied: true,
      before, after,
      beforeHex: hexBits(before),
      afterHex: hexBits(after),
    });
  }
}

function resolveTarget(sim, target) {
  if (target === 'random') {
    const alive = sim.entities.filter(e => e.alive);
    if (alive.length === 0) return null;
    const rng = sim.streams.perturb;
    const entity = alive[Math.floor(rng() * alive.length)];
    const name = PARAM_NAMES[Math.floor(rng() * PARAM_NAMES.length)];
    return entityTarget(entity, name);
  }
  if (PERTURB_GLOBALS.includes(target)) return globalTarget(sim.weatherSystem, target);

  const dot = target.lastIndexOf('.');
  const idPart = target.slice(0, dot);
  const name = paramName(target.slice(dot + 1));
  // Exact id, else a unique id prefix (ids are deterministic per seed)
  let entity = sim.entities.find(e => e.alive && e.id === idPart);
  if (!entity) {
    const matches = sim.entities.filter(e => e.alive && e.id.startsWith(idPart));
    if (matches.length !== 1) return null;
    entity = matches[0];
  }
  return entityTarget(entity, name);
}

function entityTarget(entity, name) {
  return {
    name: `${entity.id}.${PARAM_LETTERS[PARAM_NAMES.indexOf(name)]}`,
    get: () => entity[name],
    set: (v) => { entity[name] = v; },
  };
}

function globalTarget(weather, target) {
  if (target === 'season.phase') {
    return { name: target, get: () => weather.seasonPhase, set: (v) => { weather.seasonPhase = v; } };
  }
  // The oldest active event of that kind (lists are in spawn order)
  const [list, field] = {
    'storm.intensity': [weather.storms, 'baseIntensity'],
    'bloom.intensity': [weather.blooms, 'baseIntensity'],
    'current.strength': [weather.currents, 'baseStrength'],
  }[target];
  if (list.length === 0) return null;
  const item = list[0];
  return { name: `${target}[${item.id}]`, get: () => item[field], set: (v) => { item[field] = v; } };
}

// ── Cosmic rays ────────────────────────────────────────────────────────

/**
 * For each live entity, draw against cosmicRate (flips per entity per 1,000
 * ticks); on a hit, flip one bit of one of its five parameters. Called at the
 * start of a tick.
 */
export function applyCosmicRays(sim) {
  const rate = sim.config.cosmicRate;
  if (!(rate > 0)) return;
  const p = rate / 1000;
  const mode = sim.config.cosmicMode === 'ieee754' ? 'ieee754' : 'fixed16';
  const rng = sim.streams.cosmic;
  for (const entity of sim.entities) {
    if (!entity.alive) continue;
    if (rng() >= p) continue;
    const pi = Math.floor(rng() * PARAM_NAMES.length);
    const name = PARAM_NAMES[pi];
    const before = entity[name];
    let after, bit, clamped = false;
    if (mode === 'fixed16') {
      bit = Math.floor(rng() * 16);
      const q = Math.round(Math.max(0, Math.min(1, before)) * 65535);
      after = (q ^ (1 << bit)) / 65535;
    } else {
      // One of the 52 mantissa or 11 exponent bits, never the sign
      bit = Math.floor(rng() * 63);
      dv.setFloat64(0, before);
      dv.setBigUint64(0, dv.getBigUint64(0) ^ (1n << BigInt(bit)));
      after = dv.getFloat64(0);
      if (!(after >= 0 && after <= 1)) {
        after = after > 1 ? 1 : 0; // +Infinity -> 1; NaN -> 0
        clamped = true;
      }
    }
    entity[name] = after;
    sim.chaosStats.cosmicFlips++;
    sim.onEvent('cosmic_flip', sim.tick, {
      entity: entity.id,
      param: PARAM_LETTERS[pi],
      mode,
      bit,
      before,
      after,
      clamped,
    });
  }
}
