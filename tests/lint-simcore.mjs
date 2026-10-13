// Lint guard: simulation-core code must not call approximated math directly.
//
// JavaScript fixes + - * / and Math.sqrt to the bit, but exp, log, pow, sin,
// cos, tan, ... may differ in the last bit between engines, which grows into a
// different world. Sim-core code must use sm.* (simmath.js), which runs dmath
// in deterministic mode. This fails on any Math.<approximated>() call or `**`
// with a non-integer exponent in a sim-core file.
//
// Sim-core files are everything sim.js imports, transitively (so a new module
// is covered automatically). simmath.js is exempt: it is the one place allowed
// to reference native Math for platform mode. Rendering code is out of scope.
//
//   node tests/lint-simcore.mjs              lint client/js
//   node tests/lint-simcore.mjs --selftest   prove the rule catches a planted call

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '..', 'client', 'js');
const ENTRY = 'sim.js';
const EXEMPT = new Set(['simmath.js']);
const APPROX = ['exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos',
  'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'hypot', 'cbrt'];

// Blank out comments and string contents (keeping line structure) so neither is linted
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += q; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

function imports(src) {
  const list = [];
  const re = /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"](\.\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) list.push(m[1].replace(/^\.\//, ''));
  return list;
}

export function simCoreFiles(dir) {
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const dep of imports(fs.readFileSync(path.join(dir, f), 'utf8'))) visit(dep);
  };
  visit(ENTRY);
  return [...seen].sort();
}

export function lint(dir) {
  const problems = [];
  const callRe = new RegExp(`\\bMath\\s*\\.\\s*(${APPROX.join('|')})\\b`, 'g');
  // `**` with an exponent that isn't a plain integer literal
  const powRe = /\*\*\s*(?!\(?\s*-?\d+\s*\)?(?![.\w]))/g;
  for (const f of simCoreFiles(dir)) {
    if (EXEMPT.has(f)) continue;
    const code = stripCommentsAndStrings(fs.readFileSync(path.join(dir, f), 'utf8'));
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(callRe)) problems.push(`${f}:${i + 1}: Math.${m[1]} is approximated; use sm.${m[1]} (simmath.js)`);
      for (const m of line.matchAll(powRe)) problems.push(`${f}:${i + 1}: '**' with a non-integer exponent is Math.pow; use sm.pow`);
    });
  }
  return problems;
}

function report(dir) {
  const files = simCoreFiles(dir).filter(f => !EXEMPT.has(f));
  const problems = lint(dir);
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(problems.length ? `\n${problems.length} problem(s) in sim-core files` : `ok   no approximated math in ${files.length} sim-core files: ${files.join(', ')}`);
  return problems.length === 0;
}

if (process.argv.includes('--selftest')) {
  // Plant violations in a copy and make sure each is caught
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqlint-'));
  for (const f of fs.readdirSync(CLIENT)) if (f.endsWith('.js')) fs.copyFileSync(path.join(CLIENT, f), path.join(tmp, f));
  const plants = [
    ['weather.js', 'const planted = Math.pow(2, 0.5);'],
    ['entity.js', 'const planted = Math.sin(1);'],
    ['context-map.js', 'const planted = 2 ** 0.5;'],
  ];
  let ok = lint(tmp).length === 0;
  if (!ok) console.log('FAIL copy is not clean before planting');
  for (const [f, line] of plants) {
    const file = path.join(tmp, f);
    const orig = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, orig + '\n' + line + '\n');
    const caught = lint(tmp).length > 0;
    console.log(`${caught ? 'ok  ' : 'FAIL'} planted \`${line}\` in ${f} ${caught ? 'is caught' : 'was NOT caught'}`);
    ok = ok && caught;
    fs.writeFileSync(file, orig);
  }
  // Allowed forms must not be flagged
  fs.writeFileSync(path.join(tmp, 'context-map.js'), fs.readFileSync(path.join(CLIENT, 'context-map.js'), 'utf8') +
    '\nconst fine = [2 ** 3, x ** 2, Math.sqrt(2), Math.floor(1.5)]; // Math.pow in a comment\nconst s = "Math.sin";\n');
  const falsePositives = lint(tmp);
  console.log(`${falsePositives.length ? 'FAIL' : 'ok  '} integer powers, sqrt, comments and strings are allowed`);
  ok = ok && falsePositives.length === 0;
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = ok ? 0 : 1;
} else {
  process.exitCode = report(CLIENT) ? 0 : 1;
}
