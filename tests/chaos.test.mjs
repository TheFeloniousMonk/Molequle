// Chaos knobs, exact resume and physics settings.
//   node tests/chaos.test.mjs

import { execFileSync } from 'child_process';
import path from 'path';
import { createWorld, loadWorld, saveWorld, trace, firstDifference, REPO_ROOT } from '../tools/harness.mjs';
import { stepUlps, hexBits, normalizePerturb, PARAM_NAMES, PARAM_LETTERS } from '../client/js/chaos.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

const BASE = { maxPopulation: 300, physicsVersion: 2, mathMode: 'deterministic' };
const TICKS = 1500;

function world(overrides, seed = 23) {
  return createWorld(seed, { ...BASE, ...overrides });
}

// ── Zero means off ─────────────────────────────────────────────────────
{
  // "Knob not existing": the keys removed from the config entirely
  const none = createWorld(23, BASE);
  delete none.config.cosmicRate; delete none.config.cosmicMode; delete none.config.perturb;
  const baseline = trace(none, TICKS);
  const variants = {
    'cosmicRate=0': { cosmicRate: 0 },
    'cosmicRate=0, cosmicMode=ieee754': { cosmicRate: 0, cosmicMode: 'ieee754' },
    'perturb=[]': { perturb: [] },
    'all knobs at zero': { cosmicRate: 0, cosmicMode: 'fixed16', perturb: [] },
  };
  for (const [name, ov] of Object.entries(variants)) {
    const at = firstDifference(trace(world(ov), TICKS), baseline);
    check(`zero is off: ${name} is hash-identical to no knob, tick by tick`, at === -1, at === -1 ? `${TICKS} ticks` : `differs at tick ${at + 1}`);
  }
}

// ── Chaos is reproducible ──────────────────────────────────────────────
for (const mode of ['fixed16', 'ieee754']) {
  const cfg = { cosmicRate: 0.5, cosmicMode: mode, perturb: [{ tick: 400, target: 'random', ulps: 1 }] };
  const a = world(cfg), b = world(cfg);
  const ta = trace(a, TICKS), tb = trace(b, TICKS);
  const flipsA = JSON.stringify(a.events.filter(e => e.type === 'cosmic_flip' || e.type === 'perturb'));
  const flipsB = JSON.stringify(b.events.filter(e => e.type === 'cosmic_flip' || e.type === 'perturb'));
  check(`chaos is reproducible (${mode}, cosmicRate=0.5 + random perturb): identical traces and flip logs`,
    firstDifference(ta, tb) === -1 && flipsA === flipsB, `${a.chaosStats.cosmicFlips} flips`);
}

// ── Flips are complete and logged accurately ──────────────────────────
for (const mode of ['fixed16', 'ieee754']) {
  let logged = 0, mismatches = 0;
  const sim = createWorld(42, { ...BASE, cosmicRate: 5, cosmicMode: mode }, { keepEvents: false });
  sim.onEvent = (type, tick, data) => {
    if (type !== 'cosmic_flip') return;
    logged++;
    const entity = sim.entities.find(e => e.id === data.entity);
    const name = PARAM_NAMES[PARAM_LETTERS.indexOf(data.param)];
    // The event fires right after the flip: the entity must hold `after` now
    if (!entity || !Object.is(entity[name], data.after) || tick !== sim.tick) mismatches++;
    if (mode === 'fixed16') {
      const q = Math.round(Math.max(0, Math.min(1, data.before)) * 65535);
      if (data.after !== (q ^ (1 << data.bit)) / 65535) mismatches++;
    }
  };
  for (let i = 0; i < 1000; i++) sim.step();
  check(`flips are complete (${mode}): logged flips = flips counted in the flip function, values match`,
    logged === sim.chaosStats.cosmicFlips && logged > 0 && mismatches === 0, `${logged} logged, ${sim.chaosStats.cosmicFlips} counted, ${mismatches} mismatches`);
}

// ── No NaN escapes ─────────────────────────────────────────────────────
{
  const sim = createWorld(7, { ...BASE, cosmicRate: 50, cosmicMode: 'ieee754' }, { keepEvents: false });
  let clamps = 0, bad = 0, firstBad = '';
  const onEvent = sim.onEvent;
  sim.onEvent = (type, tick, data) => { if (type === 'cosmic_flip' && data.clamped) clamps++; onEvent(type, tick, data); };
  for (let i = 0; i < 3000; i++) {
    sim.step();
    for (const e of sim.entities) {
      for (const p of PARAM_NAMES) {
        const v = e[p];
        if (!Number.isFinite(v) || v < 0 || v > 1) { bad++; firstBad ||= `tick ${sim.tick} ${e.id}.${p}=${v}`; }
      }
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.vx) || !Number.isFinite(e.vy)) { bad++; firstBad ||= `tick ${sim.tick} ${e.id} position`; }
    }
  }
  check('no NaN escapes: ieee754 at cosmicRate=50 for 3,000 ticks keeps every parameter finite and in [0, 1]',
    bad === 0, bad ? firstBad : `${sim.chaosStats.cosmicFlips} flips, ${clamps} clamped`);
}

// ── Perturbation ───────────────────────────────────────────────────────
{
  const cases = [
    [1, 1, 1 + 2 ** -52], [1, -1, 1 - 2 ** -53], [0, 1, 5e-324], [0, -1, -5e-324], [-0, 1, 5e-324],
    [5e-324, -1, 0], [0.5, 3, 0.5 + 3 * 2 ** -53], [Number.MAX_VALUE, 1, Infinity],
  ];
  const bad = cases.filter(([x, n, want]) => !Object.is(stepUlps(x, n), want));
  check('stepUlps steps the float64 bit pattern exactly', bad.length === 0, bad.map(c => c.join(' ')).join('; '));

  const T = 600;
  const baseline = trace(world({}), 900);
  const nudged = world({ perturb: [{ tick: T, target: 'random', ulps: 1 }] });
  const traced = trace(nudged, 900);
  const ev = nudged.events.find(e => e.type === 'perturb');
  const at = firstDifference(traced, baseline);
  const oneUlp = ev && ev.data.applied && stepUlps(ev.data.before, 1) === ev.data.after &&
    hexBits(ev.data.before) === ev.data.beforeHex && hexBits(ev.data.after) === ev.data.afterHex;
  check(`perturb: one ulp at tick ${T} is logged with before/after bits, and the world first differs at tick ${T}`,
    oneUlp && ev.tick === T && at === T - 1, ev ? `${ev.data.resolved}: ${ev.data.beforeHex} -> ${ev.data.afterHex}, first difference at tick ${at + 1}` : 'no perturb event');

  const g = world({ perturb: [{ tick: 50, target: 'season.phase', ulps: -2 }] });
  for (let i = 0; i < 50; i++) g.step();
  const gev = g.events.find(e => e.type === 'perturb');
  check('perturb: global target season.phase', gev && gev.data.applied && stepUlps(gev.data.before, -2) === gev.data.after);

  const bad1 = normalizePerturb([{ tick: 0, target: 'random' }]).error;
  const bad2 = normalizePerturb([{ tick: 5, target: 'nobody' }]).error;
  const good = normalizePerturb('[{"tick": 5, "target": "abc.V"}]').value;
  check('perturb: lists are validated', bad1 && bad2 && good && good[0].ulps === 1);
}

// ── Exact resume (physics version 2) ───────────────────────────────────
for (const [name, ov] of [['plain', {}], ['with cosmic rays and a perturb after the save', { cosmicRate: 1, perturb: [{ tick: 900, target: 'random', ulps: 1 }] }]]) {
  const SAVE_AT = 700;
  const a = world(ov);
  for (let i = 0; i < SAVE_AT; i++) a.step();
  const b = loadWorld(saveWorld(a));
  const ta = trace(a, 800), tb = trace(b, 800);
  const at = firstDifference(ta, tb);
  check(`exact resume (${name}): a v2 world saved at tick ${SAVE_AT} and reloaded continues bit-identically`,
    at === -1, at === -1 ? '800 ticks after the reload' : `differs ${at + 1} ticks after the reload`);
}
{
  // Legacy: a version 1 world keeps the original approximate resume
  const a = createWorld(23, { ...BASE, physicsVersion: 1 });
  for (let i = 0; i < 700; i++) a.step();
  const saved = saveWorld(a);
  delete saved.config.physicsVersion; // as written by Molequle before 2.1
  const b = loadWorld(saved);
  check('saves without physicsVersion load as version 1 (platform math, approximate resume)',
    b.config.physicsVersion === 1 && b.mathMode === 'platform' && firstDifference(trace(a, 50), trace(b, 50)) !== -1);
}

// ── Physics settings ───────────────────────────────────────────────────
{
  const sim = world({});
  for (let i = 0; i < 10; i++) sim.step();
  sim.setParam('mathMode', 'platform');
  sim.setParam('cosmicRate', 0.25);
  sim.setParam('cosmicRate', 0.25); // unchanged: not logged again
  const changes = sim.events.filter(e => e.type === 'config_change');
  check('changing physics/chaos settings mid-run is logged (math mode with a warning)',
    changes.length === 2 && changes[0].data.warning && changes[0].data.effectiveMathMode === 'platform' && !changes[1].data.warning);

  const v1 = world({ physicsVersion: 1, mathMode: 'deterministic' });
  check('physics version 1 always runs platform math', v1.mathMode === 'platform');
  v1.newRun(99);
  check('a new run starts at the current physics version', v1.config.physicsVersion === 2 && v1.mathMode === 'deterministic');
}

// ── Harness selftest ───────────────────────────────────────────────────
{
  const play = path.join(REPO_ROOT, 'tools', 'molequle-play.mjs');
  const run = (recipe) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [play, '-e', recipe], { encoding: 'utf8' }) };
    } catch (err) {
      return { code: err.status, out: String(err.stdout) };
    }
  };
  const pass = run('selftest');
  check('harness selftest passes', pass.code === 0 && pass.out.startsWith('PASS'), pass.out.split('\n')[0]);
  const fail = run('perturb tick=250 target=random ulps=1; selftest');
  check('harness selftest fails visibly on a mismatch: header plus first differing tick',
    fail.code === 1 && /first differs .* at tick 250/.test(fail.out) && fail.out.includes('# run header:'), fail.out.split('\n')[0]);
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall chaos/resume checks pass');
process.exitCode = failures ? 1 : 0;
