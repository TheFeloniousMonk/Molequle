#!/usr/bin/env node
// molequle-play.mjs — Run Molequle headless from a recipe.
//
//   node tools/molequle-play.mjs recipe.txt        commands from a file
//   node tools/molequle-play.mjs -e "seed 23; run 1000; hash"
//   node tools/molequle-play.mjs selftest
//
// Commands (one per line or separated by ';', '#' starts a comment):
//   seed N                      start a fresh world with seed N, using the settings so far
//   load FILE                   continue a saved world (a browser save such as
//                               server/data/latest.json, or one written by 'save')
//   set key=value ...           change settings, e.g. set maxPopulation=800 smoother=true
//                               set mathMode=platform | set cosmicRate=0.5 cosmicMode=fixed16
//                               set physicsVersion=1 (legacy physics) | set perturb=[...]
//   perturb tick=T target=X ulps=N   schedule a one-ulp-style nudge (target: random,
//                               <entity id or prefix>.<S|I|V|B|D>, season.phase,
//                               storm.intensity, bloom.intensity, current.strength)
//   run N                       advance N ticks
//   trace N [FILE]              advance N ticks, printing (or writing) one state hash per tick
//   hash                        print the full state hash
//   state                       print tick, population, bonds and mean parameters
//   events [FILE] [type ...]    print (or write as JSON lines) the events so far, optionally by type
//   mathlog FILE                advance one tick, logging every approximated math call
//                               (sin/cos/log/pow) with arguments and result bits (platform mode only)
//   save FILE                   write the world as a save the app can load
//   header                      print the run header
//   selftest                    seed 23, 500 ticks, against the shipped golden hashes:
//                               prints PASS, or the run header and the first differing tick
//
// Every run prints its run header first. Include it when you share a seed.
//
// trace and mathlog are modeled on Ori Zornitsa's molequle-trace.mjs, which
// found the one-ulp Math.pow difference behind the Node 22 / Node 24 split
// (Seed Exchange, 2026-10-12).

import fs from 'fs';
import path from 'path';
import {
  createWorld, loadWorld, saveWorld, stateHash, trace, runHeader, formatHeader,
  readGolden, firstDifference, SELFTEST, GOLDEN_CASES,
} from './harness.mjs';
import { DEFAULT_CONFIG, PARAM_RANGES } from '../client/js/params.js';
import { setMathRecorder } from '../client/js/simmath.js';
import { hexBits, normalizePerturb } from '../client/js/chaos.js';

const out = (s) => process.stdout.write(s + '\n');

// ── Recipe parsing ─────────────────────────────────────────────────────

function parseRecipe(text) {
  return text
    .split(/\r?\n|;/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(line => {
      const [cmd, ...args] = line.split(/\s+/);
      return { cmd: cmd.toLowerCase(), args, line };
    });
}

function parseValue(key, raw) {
  const range = PARAM_RANGES[key];
  const def = DEFAULT_CONFIG[key];
  if (range && range.type === 'perturb') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (range && range.type === 'enum') return raw;
  if (typeof def === 'string') return raw;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`set ${key}: '${raw}' is not a number`);
  return n;
}

function keyValues(args) {
  const kv = {};
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq < 1) throw new Error(`expected key=value, got '${a}'`);
    kv[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return kv;
}

// ── Runner ─────────────────────────────────────────────────────────────

function summarize(sim) {
  const alive = sim.entities.filter(e => e.alive);
  const bonds = alive.reduce((n, e) => n + e.bonds.length, 0) / 2;
  const mean = (k) => alive.length ? (alive.reduce((s, e) => s + e[k], 0) / alive.length).toFixed(4) : 'n/a';
  return `tick ${sim.tick}  pop ${alive.length}  bonds ${bonds}  ` +
    `S ${mean('sociability')} I ${mean('inertia')} V ${mean('volatility')} B ${mean('bondAffinity')} D ${mean('disruptionCharge')}` +
    `  perturbs ${sim.chaosStats.perturbs} cosmic flips ${sim.chaosStats.cosmicFlips}`;
}

function run(commands) {
  let sim = null;
  const pending = {}; // settings given before a world exists
  let headerShown = false;

  const need = (cmd) => {
    if (!sim) throw new Error(`'${cmd}': no world yet (use 'seed N' or 'load FILE' first)`);
    if (!headerShown) { out(`# run header: ${formatHeader(runHeader(sim))}`); headerShown = true; }
    return sim;
  };

  for (const { cmd, args, line } of commands) {
    switch (cmd) {
      case 'seed': {
        const seed = Number(args[0]);
        if (!Number.isFinite(seed)) throw new Error(`seed: '${args[0]}' is not a number`);
        const { perturb, ...rest } = pending;
        sim = createWorld(seed, rest);
        if (perturb) sim.setParam('perturb', perturb);
        headerShown = false;
        break;
      }
      case 'load': {
        sim = loadWorld(JSON.parse(fs.readFileSync(args[0], 'utf8')));
        for (const [k, v] of Object.entries(pending)) sim.setParam(k, v);
        headerShown = false;
        out(`# loaded ${args[0]} at tick ${sim.tick}`);
        break;
      }
      case 'set': {
        for (const [k, raw] of Object.entries(keyValues(args))) {
          if (!(k in DEFAULT_CONFIG)) throw new Error(`set: unknown setting '${k}'`);
          const value = parseValue(k, raw);
          if (sim) {
            if (!sim.setParam(k, value)) throw new Error(`set ${k}: invalid value`);
          } else {
            if (k === 'perturb') {
              const { value: list, error } = normalizePerturb(value);
              if (error) throw new Error(error);
              pending.perturb = list;
            } else {
              pending[k] = value;
            }
          }
        }
        break;
      }
      case 'perturb': {
        const kv = keyValues(args);
        const entry = { tick: Number(kv.tick), target: kv.target ?? 'random', ulps: kv.ulps === undefined ? 1 : Number(kv.ulps) };
        const list = [...(sim ? sim.config.perturb : pending.perturb || []), entry];
        const { value, error } = normalizePerturb(list);
        if (error) throw new Error(error);
        if (sim) sim.setParam('perturb', value);
        else pending.perturb = value;
        break;
      }
      case 'run': {
        const s = need(cmd);
        const n = Number(args[0]);
        for (let i = 0; i < n; i++) s.step();
        out(summarize(s));
        break;
      }
      case 'trace': {
        const s = need(cmd);
        const n = Number(args[0]);
        const lines = [];
        trace(s, n, (w, h) => lines.push(`${w.tick} ${h}`));
        if (args[1]) {
          fs.writeFileSync(args[1], lines.join('\n') + '\n');
          out(`# trace: ${n} ticks written to ${args[1]}`);
        } else {
          for (const l of lines) out(l);
        }
        break;
      }
      case 'hash':
        out(`tick ${need(cmd).tick} hash ${stateHash(sim)}`);
        break;
      case 'state':
        out(summarize(need(cmd)));
        break;
      case 'header':
        out(formatHeader(runHeader(need(cmd))));
        break;
      case 'events': {
        const s = need(cmd);
        const file = args[0] && !/^[a-z_]+$/.test(args[0]) ? args[0] : null;
        const types = args.slice(file ? 1 : 0);
        const list = s.events.filter(e => types.length === 0 || types.includes(e.type));
        const text = list.map(e => JSON.stringify(e)).join('\n');
        if (file) {
          fs.writeFileSync(file, text + (text ? '\n' : ''));
          out(`# events: ${list.length} written to ${file}`);
        } else if (text) {
          out(text);
        }
        break;
      }
      case 'mathlog': {
        const s = need(cmd);
        if (s.mathMode !== 'platform') {
          throw new Error('mathlog: platform mode only (set mathMode=platform, or physicsVersion=1); deterministic math is the same everywhere');
        }
        const calls = [];
        setMathRecorder((name, a, r) => calls.push({ fn: name, args: a, argBits: a.map(hexBits), result: r, resultBits: hexBits(r) }));
        try {
          s.step();
        } finally {
          setMathRecorder(null);
        }
        fs.writeFileSync(args[0], calls.map(c => JSON.stringify({ tick: s.tick, ...c })).join('\n') + '\n');
        out(`# mathlog: tick ${s.tick}, ${calls.length} approximated calls written to ${args[0]}`);
        break;
      }
      case 'save': {
        fs.writeFileSync(args[0], JSON.stringify(saveWorld(need(cmd))));
        out(`# saved tick ${sim.tick} to ${args[0]}`);
        break;
      }
      case 'selftest':
        process.exitCode = selftest(pending) ? 0 : 1;
        break;
      default:
        throw new Error(`unknown command: ${line}`);
    }
  }
}

// ── Selftest ───────────────────────────────────────────────────────────

function selftest(overrides = {}) {
  const golden = readGolden(SELFTEST.golden);
  const spec = GOLDEN_CASES.find(c => c.name === SELFTEST.golden);
  const sim = createWorld(spec.seed, { ...spec.config, ...overrides }, { keepEvents: false });
  const header = runHeader(sim);
  const hashes = trace(sim, SELFTEST.ticks);
  const at = firstDifference(hashes, golden.hashes.slice(0, SELFTEST.ticks));
  if (at === -1) {
    out(`PASS selftest: seed ${spec.seed}, ${SELFTEST.ticks} ticks match the shipped golden (${SELFTEST.golden})`);
    out(`# run header: ${formatHeader(header)}`);
    return true;
  }
  out(`FAIL selftest: seed ${spec.seed} first differs from the shipped golden at tick ${at + 1}`);
  out(`# run header: ${formatHeader(header)}`);
  out(`# golden header: ${formatHeader(golden.header)}`);
  out(`# expected ${golden.hashes[at]}, got ${hashes[at]}`);
  return false;
}

// ── Main ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
try {
  let text;
  if (argv[0] === '-e') text = argv.slice(1).join(' ');
  else if (argv[0] === 'selftest') text = 'selftest';
  else if (argv[0] && argv[0] !== '-') text = fs.readFileSync(argv[0], 'utf8');
  else if (!process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
  else {
    out('usage: node tools/molequle-play.mjs <recipe file> | -e "<commands>" | selftest');
    out(`See the comment at the top of ${path.relative(process.cwd(), new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))} for commands.`);
    process.exit(2);
  }
  run(parseRecipe(text));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 2;
}
