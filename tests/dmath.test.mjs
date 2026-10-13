// dmath accuracy: compare dmath's sin/cos/log/pow with this engine's Math over
// millions of inputs, in ulps. Engines may legally differ from each other in
// the last bit, so up to 1 ulp is expected; more means a porting bug.
// Also checks the special values JavaScript defines exactly.
// usage: node tests/dmath.test.mjs [samples per case]

import * as dm from '../client/js/dmath.js';
import { mulberry32 } from '../client/js/prng.js';

const N = Number(process.argv[2] || 200000);
const rand = mulberry32(20261012);
const dv = new DataView(new ArrayBuffer(8));

function ordered(x) {
  dv.setFloat64(0, x);
  const b = dv.getBigInt64(0);
  return b < 0n ? -(b & 0x7fffffffffffffffn) : b;
}

function ulps(a, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity;
  if (a === b) return 0;
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}

// Random double with uniformly random exponent in [emin, emax] and random mantissa
function randExp(emin, emax, signed) {
  const e = emin + Math.floor(rand() * (emax - emin + 1));
  dv.setUint32(0, (((e + 1023) & 0x7ff) << 20) | Math.floor(rand() * 0x100000));
  dv.setUint32(4, Math.floor(rand() * 0x100000000));
  const v = dv.getFloat64(0);
  return signed && rand() < 0.5 ? -v : v;
}

let failures = 0;
function report(name, fn, ref, gen, maxAllowed = 1) {
  let worst = 0, worstIn = null, exact = 0;
  for (let i = 0; i < N; i++) {
    const args = gen();
    const u = ulps(fn(...args), ref(...args));
    if (u === 0) exact++;
    if (u > worst) { worst = u; worstIn = args; }
  }
  const ok = worst <= maxAllowed;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} max ${String(worst).padStart(3)} ulp, ${(100 * exact / N).toFixed(3)}% identical` +
    (worst ? `  worst at ${worstIn.map(v => v.toPrecision(17)).join(', ')}` : ''));
}

const u = (a, b) => () => [a + rand() * (b - a)];

console.log(`dmath vs ${typeof process !== 'undefined' ? `node ${process.version}` : 'this engine'} Math, ${N} samples per case\n`);

// sin / cos: the simulation's ranges, then everything up to the medium-reduction limit
report('sin [0, 2pi]', dm.sin, Math.sin, u(0, 2 * Math.PI));
report('sin [-pi/4, pi/4]', dm.sin, Math.sin, u(-Math.PI / 4, Math.PI / 4));
report('sin tiny |x| < 2^-20', dm.sin, Math.sin, () => [randExp(-60, -20, true)]);
report('sin |x| to 2^19 pi/2', dm.sin, Math.sin, () => [randExp(-1, 19, true)]);
report('sin near k*pi/2 (k < 200)', dm.sin, Math.sin, () => {
  const k = 1 + Math.floor(rand() * 200);
  return [k * (Math.PI / 2) * (1 + (rand() - 0.5) * 1e-12)];
});
report('cos [0, 2pi]', dm.cos, Math.cos, u(0, 2 * Math.PI));
report('cos [-pi/4, pi/4]', dm.cos, Math.cos, u(-Math.PI / 4, Math.PI / 4));
report('cos |x| to 2^19 pi/2', dm.cos, Math.cos, () => [randExp(-1, 19, true)]);
report('cos near k*pi/2 (k < 200)', dm.cos, Math.cos, () => {
  const k = 1 + Math.floor(rand() * 200);
  return [k * (Math.PI / 2) * (1 + (rand() - 0.5) * 1e-12)];
});

// log: (0, 1] as in the gaussian, all exponents, near 1, subnormals
report('log (0, 1]', dm.log, Math.log, () => [rand() || 1e-10]);
report('log all exponents', dm.log, Math.log, () => [randExp(-1022, 1023, false)]);
report('log near 1', dm.log, Math.log, () => [1 + (rand() - 0.5) * 2e-6]);
report('log subnormal', dm.log, Math.log, () => [randExp(-1074, -1023, false)]);

// pow: the storm curve, then general cases
report('pow(x in (0,1], 0.7)', dm.pow, Math.pow, () => [rand() || 1e-10, 0.7]);
report('pow(x > 0, y in [-10, 10])', dm.pow, Math.pow, () => [randExp(-30, 30, false), (rand() - 0.5) * 20]);
report('pow(x > 0, any y, finite result)', dm.pow, Math.pow, () => {
  const x = randExp(-100, 100, false);
  return [x, (rand() - 0.5) * 1000 / Math.max(1, Math.abs(Math.round(Math.log2(x))))];
});
report('pow(x < 0, integer y)', dm.pow, Math.pow, () => [-randExp(-5, 5, false), Math.round((rand() - 0.5) * 60)]);
report('pow(near 1, huge y)', dm.pow, Math.pow, () => [1 + (rand() - 0.5) * 1e-7, (rand() - 0.5) * 2e10]);
report('pow subnormal result', dm.pow, Math.pow, () => [rand() * 0.5 + 0.25, 1030 + rand() * 40]);
report('pow overflow edge', dm.pow, Math.pow, () => [2 - rand() * 1e-3, 1023 + rand() * 2]);

// Special values that JavaScript defines exactly
const specials = [
  ['sin(0)', dm.sin(0), 0], ['sin(-0)', dm.sin(-0), -0], ['sin(Inf)', dm.sin(Infinity), NaN], ['sin(NaN)', dm.sin(NaN), NaN],
  ['cos(0)', dm.cos(0), 1], ['cos(-Inf)', dm.cos(-Infinity), NaN],
  ['log(1)', dm.log(1), 0], ['log(0)', dm.log(0), -Infinity], ['log(-0)', dm.log(-0), -Infinity],
  ['log(-1)', dm.log(-1), NaN], ['log(Inf)', dm.log(Infinity), Infinity], ['log(NaN)', dm.log(NaN), NaN],
  ['pow(x, 0)', dm.pow(NaN, 0), 1], ['pow(1, NaN)', dm.pow(1, NaN), NaN], ['pow(1, Inf)', dm.pow(1, Infinity), NaN],
  ['pow(-1, Inf)', dm.pow(-1, Infinity), NaN], ['pow(0.5, Inf)', dm.pow(0.5, Infinity), 0],
  ['pow(2, -Inf)', dm.pow(2, -Infinity), 0], ['pow(0, -1)', dm.pow(0, -1), Infinity],
  ['pow(-0, -1)', dm.pow(-0, -1), -Infinity], ['pow(-0, -2)', dm.pow(-0, -2), Infinity],
  ['pow(-0, 3)', dm.pow(-0, 3), -0], ['pow(-8, 1/3)', dm.pow(-8, 1 / 3), NaN],
  ['pow(-2, 3)', dm.pow(-2, 3), -8], ['pow(-Inf, 3)', dm.pow(-Infinity, 3), -Infinity],
  ['pow(-Inf, -3)', dm.pow(-Infinity, -3), -0], ['pow(Inf, -0.5)', dm.pow(Infinity, -0.5), 0],
  ['pow(4, 0.5)', dm.pow(4, 0.5), 2], ['pow(2, 1024)', dm.pow(2, 1024), Infinity], ['pow(2, -1074)', dm.pow(2, -1074), 5e-324],
  ['pow(2, -1075)', dm.pow(2, -1075), 0],
];
let specialFails = 0;
for (const [name, got, want] of specials) {
  if (!Object.is(got, want)) { specialFails++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
}
console.log(`${specialFails ? 'FAIL' : 'ok  '} special values (${specials.length})`);
if (specialFails) failures++;

console.log(failures ? `\n${failures} failing case(s)` : '\nall dmath cases within 1 ulp of Math');
process.exitCode = failures ? 1 : 0;
