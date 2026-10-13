// Golden traces: seeds 7, 11, 23, 42 at cap 800, Smoother off and on, physics
// version 2 deterministic math. Per-tick state hashes for 5,000 ticks must
// match tests/golden/*.json exactly — on every Node version and platform.
// (Seed 23 with the Smoother off split Node 22 from Node 24 at tick 3183 under
// the old platform math.)
//
//   node tests/golden.test.mjs            check (cases run in parallel)
//   node tests/golden.test.mjs --update   regenerate the golden files
//   node tests/golden.test.mjs seed23-cap800-smootherOff   one case

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';
import {
  createWorld, trace, runHeader, readGolden, firstDifference, chaosEventsHash,
  GOLDEN_CASES, GOLDEN_DIR, GOLDEN_TICKS,
} from '../tools/harness.mjs';

if (!isMainThread) {
  const spec = GOLDEN_CASES.find(c => c.name === workerData.name);
  const sim = createWorld(spec.seed, spec.config, { keepEvents: !!spec.chaos });
  const header = runHeader(sim);
  const t0 = Date.now();
  const hashes = trace(sim, workerData.ticks);
  const chaosEvents = spec.chaos ? chaosEventsHash(sim) : undefined;
  parentPort.postMessage({ header, hashes, chaosEvents, seconds: (Date.now() - t0) / 1000 });
} else {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const names = args.filter(a => !a.startsWith('--'));
  const cases = names.length ? GOLDEN_CASES.filter(c => names.includes(c.name)) : GOLDEN_CASES;
  const parallel = Math.max(1, Math.min(cases.length, os.availableParallelism ? os.availableParallelism() : os.cpus().length));

  const runCase = (spec) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { name: spec.name, ticks: GOLDEN_TICKS } });
    w.once('message', resolve);
    w.once('error', reject);
  });

  let failures = 0;
  const queue = [...cases];
  const results = [];
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (queue.length) {
      const spec = queue.shift();
      const r = await runCase(spec);
      results.push(spec.name);
      if (update) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        const golden = { name: spec.name, seed: spec.seed, config: spec.config, ticks: GOLDEN_TICKS, header: r.header, chaosEvents: r.chaosEvents, hashes: r.hashes };
        fs.writeFileSync(path.join(GOLDEN_DIR, `${spec.name}.json`), JSON.stringify(golden, null, 0) + '\n');
        console.log(`wrote ${spec.name} (${r.seconds.toFixed(0)}s)`);
        continue;
      }
      const golden = readGolden(spec.name);
      const at = firstDifference(r.hashes, golden.hashes);
      const eventsOk = JSON.stringify(r.chaosEvents) === JSON.stringify(golden.chaosEvents);
      if (at === -1 && !eventsOk) {
        failures++;
        console.log(`FAIL ${spec.name}: traces match but the chaos event log differs (expected ${JSON.stringify(golden.chaosEvents)}, got ${JSON.stringify(r.chaosEvents)})`);
      } else if (at === -1) {
        const extra = r.chaosEvents ? `, ${r.chaosEvents.count} chaos events match` : '';
        console.log(`ok   ${spec.name}: ${GOLDEN_TICKS} ticks match${extra} (${r.seconds.toFixed(0)}s)`);
      } else {
        failures++;
        console.log(`FAIL ${spec.name}: first differs at tick ${at + 1} (expected ${golden.hashes[at]}, got ${r.hashes[at]})`);
        console.log(`     this run: ${JSON.stringify(r.header)}`);
        console.log(`     golden:   ${JSON.stringify(golden.header)}`);
      }
    }
  }));
  if (!update) console.log(failures ? `\n${failures} golden trace(s) differ` : `\nall ${results.length} golden traces match`);
  process.exitCode = failures ? 1 : 0;
}
