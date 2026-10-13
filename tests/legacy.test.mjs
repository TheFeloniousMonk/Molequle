// Legacy holds: physics version 1 on this code reproduces Molequle 2.0.4 —
// fresh worlds and worlds reloaded from a pre-2.1 save — bit for bit, in the
// same runtime. Version 1 uses the engine's native Math, so the comparison is
// only meaningful within one runtime; it runs on every CI platform.
//
// Needs git and the v2.0.4 tag (CI checks out with fetch-depth: 0).
//   node tests/legacy.test.mjs

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createWorld, loadWorld, saveWorld, REPO_ROOT } from '../tools/harness.mjs';

const LEGACY_TAG = 'v2.0.4';

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

// Build v2.0.4's client/js in a temp dir, with main.js opened up for driving
async function loadLegacy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqlegacy-'));
  for (const f of git('ls-tree', '--name-only', `${LEGACY_TAG}:client/js`).split('\n').filter(Boolean)) {
    fs.writeFileSync(path.join(dir, f), git('show', `${LEGACY_TAG}:client/js/${f}`));
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  let main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  // The original restore code, verbatim from init()
  const start = main.indexOf('  if (savedState && savedState.entities && savedState.entities.length > 0) {');
  const end = main.indexOf('  } else {\n    // Fresh start', start);
  if (start < 0 || end < 0) throw new Error(`could not find the restore block in ${LEGACY_TAG} main.js`);
  const restoreBlock = main.slice(start, end) + '  }\n';
  main = main.replace(/^init\(\)\.catch.*$/m, '');
  main += `
export const __legacy = {
  fresh(s, overrides) {
    config = { ...DEFAULT_CONFIG, ...overrides };
    seed = s;
    eventSystem = new EventSystem();
    renderer = { addBondBreakFlash() {}, clearTrails() {} };
    resetSimulation();
  },
  restore(savedState) {
    eventSystem = new EventSystem();
    renderer = { addBondBreakFlash() {}, clearTrails() {} };
    contextMap = new ContextMap(config.gridCols, config.gridRows, config.canvasWidth, config.canvasHeight);
    weatherSystem = new WeatherSystem(rng);
    spawnCooldowns = {};
${restoreBlock}
  },
  step() { simulationTick(); },
  get world() { return { entities, contextMap, weatherSystem, tick, rng }; },
};
`;
  fs.writeFileSync(path.join(dir, 'main.js'), main);
  // The old loop talks to the server; give it a fetch that does nothing
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  globalThis.requestIdleCallback = () => {};
  const mod = await import(pathToFileURL(path.join(dir, 'main.js')).href);
  return { legacy: mod.__legacy, dir };
}

function digest({ entities, contextMap, weatherSystem, tick }) {
  const h = crypto.createHash('sha256');
  h.update(String(tick));
  h.update(JSON.stringify(entities, (k, v) => (k.startsWith('_') ? undefined : v)));
  h.update(JSON.stringify(contextMap.grid));
  h.update(JSON.stringify(weatherSystem.serialize()));
  return h.digest('hex').slice(0, 16);
}

// Step both n ticks, comparing digests every `every` ticks and the next rng() at the end
function compare(legacy, sim, n, every = 50) {
  for (let i = 1; i <= n; i++) {
    legacy.step();
    sim.step();
    if (i % every === 0 || i === n) {
      const a = digest(legacy.world), b = digest(sim);
      if (a !== b) return `differs by tick ${sim.tick}`;
    }
  }
  return legacy.world.rng() === sim.rng() ? null : 'random generator positions differ';
}

let failures = 0;
const log = console.log;
console.log = () => {}; // the old code logs resets
const { legacy, dir } = await loadLegacy();
const results = [];

for (const [seed, overrides, ticks] of [
  [23, { maxPopulation: 800 }, 3500],
  [23, { maxPopulation: 800, smoother: true }, 2000],
  [4242, {}, 2000],
]) {
  legacy.fresh(seed, overrides);
  const sim = createWorld(seed, { ...overrides, physicsVersion: 1 }, { keepEvents: false });
  const problem = compare(legacy, sim, ticks);
  results.push([`fresh world, seed ${seed} ${JSON.stringify(overrides)}, ${ticks} ticks`, problem]);
}

{
  // A world saved by 2.0.4 (no physicsVersion, no exact state), reloaded by both
  const writer = createWorld(777, { maxPopulation: 400, physicsVersion: 1 }, { keepEvents: false });
  for (let i = 0; i < 1234; i++) writer.step();
  const saved = JSON.parse(JSON.stringify(saveWorld(writer)));
  delete saved.config.physicsVersion; delete saved.config.mathMode; delete saved.config.cosmicRate;
  delete saved.config.cosmicMode; delete saved.config.perturb; delete saved.exact; delete saved.runHeader;
  legacy.restore(JSON.parse(JSON.stringify(saved)));
  const sim = loadWorld(saved, { keepEvents: false });
  const problem = compare(legacy, sim, 1500);
  results.push([`reloaded 2.0.4-style save at tick 1234, then 1500 ticks`, problem]);
}

console.log = log;
for (const [name, problem] of results) {
  if (problem) failures++;
  console.log(`${problem ? 'FAIL' : 'ok  '} physics v1 = ${LEGACY_TAG}: ${name}${problem ? ` (${problem})` : ''}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} legacy mismatch(es)` : `\nphysics version 1 reproduces ${LEGACY_TAG} (node ${process.version}, ${process.platform}/${process.arch})`);
process.exitCode = failures ? 1 : 0;
