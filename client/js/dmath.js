// dmath.js — Deterministic math for the simulation core.
//
// JavaScript fixes + - * / and Math.sqrt to the bit, but sin, cos, log, pow
// (and the other transcendental functions) are only "implementation-
// approximated": engines may differ in the last bit, and Molequle amplifies one
// ulp into a different world. These are ports of fdlibm 5.3 (Sun
// Microsystems, the reference most engines derive from), written only with
// operations the spec fixes: + - * /, comparisons, Math.sqrt / floor / trunc /
// abs, integer and bit operations, and DataView access to the float64 bits.
// So every engine and platform returns the same bits. Accuracy is fdlibm's:
// under 1 ulp.
//
// Only what the simulation needs: sin, cos, log, pow. Arguments of sin/cos
// beyond about 8e5 use the medium-size reduction anyway (deterministic, less
// accurate); the simulation stays within [-2pi, 2pi].
//
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.

// ── float64 word access (big-endian DataView: offset 0 is the high word) ──

const dv = new DataView(new ArrayBuffer(8));

function hiWord(x) {
  dv.setFloat64(0, x);
  return dv.getInt32(0);
}

function loWord(x) {
  dv.setFloat64(0, x);
  return dv.getUint32(4);
}

function fromWords(hi, lo) {
  dv.setInt32(0, hi);
  dv.setUint32(4, lo >>> 0);
  return dv.getFloat64(0);
}

function withHi(x, hi) {
  dv.setFloat64(0, x);
  dv.setInt32(0, hi);
  return dv.getFloat64(0);
}

function withLoZero(x) {
  dv.setFloat64(0, x);
  dv.setUint32(4, 0);
  return dv.getFloat64(0);
}

// ── sin / cos ──────────────────────────────────────────────────────────

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

// sin(x + y) on [-pi/4, pi/4]; y is the tail of x; iy = 0 means y is zero
function kernelSin(x, y, iy) {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return x; // |x| < 2^-27
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

// cos(x + y) on [-pi/4, pi/4]
function kernelCos(x, y) {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return 1.0; // |x| < 2^-27
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1.0 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0); // x/4
  const hz = 0.5 * z - qx;
  const a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
}

const invpio2 = 6.36619772367581382433e-01;
const pio2_1 = 1.57079632673412561417e+00;
const pio2_1t = 6.07710050650619224932e-11;
const pio2_2 = 6.07710050630396597660e-11;
const pio2_2t = 2.02226624879595063154e-21;
const pio2_3 = 2.02226624871116645580e-21;
const pio2_3t = 8.47842766036889956997e-32;

// Reduce x to y0 + y1 in [-pi/4, pi/4]; returns the quadrant count n (x = n*pi/2 + y)
const reduced = [0, 0];
function remPio2(x) {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) { // |x| <= pi/4
    reduced[0] = x; reduced[1] = 0;
    return 0;
  }
  if (ix < 0x4002d97c) { // |x| < 3pi/4: n = +-1
    let z;
    if (hx > 0) {
      z = x - pio2_1;
      if (ix !== 0x3ff921fb) {
        reduced[0] = z - pio2_1t;
        reduced[1] = (z - reduced[0]) - pio2_1t;
      } else { // near pi/2: use 33+53 bits of pi
        z -= pio2_2;
        reduced[0] = z - pio2_2t;
        reduced[1] = (z - reduced[0]) - pio2_2t;
      }
      return 1;
    }
    z = x + pio2_1;
    if (ix !== 0x3ff921fb) {
      reduced[0] = z + pio2_1t;
      reduced[1] = (z - reduced[0]) + pio2_1t;
    } else {
      z += pio2_2;
      reduced[0] = z + pio2_2t;
      reduced[1] = (z - reduced[0]) + pio2_2t;
    }
    return -1;
  }
  // Medium-size reduction (fdlibm's, exact to |x| ~ 2^19 * pi/2), with the
  // cancellation check always taken instead of the n < 32 table shortcut —
  // identical where the shortcut applies, more accurate where it doesn't.
  let t = Math.abs(x);
  const fn = Math.trunc(t * invpio2 + 0.5);
  let r = t - fn * pio2_1;
  let w = fn * pio2_1t; // first round good to 85 bits
  const j = ix >> 20;
  let y0 = r - w;
  let i = j - ((hiWord(y0) >> 20) & 0x7ff);
  if (i > 16) { // second iteration, good to 118 bits
    t = r;
    w = fn * pio2_2;
    r = t - w;
    w = fn * pio2_2t - ((t - r) - w);
    y0 = r - w;
    i = j - ((hiWord(y0) >> 20) & 0x7ff);
    if (i > 49) { // third iteration, 151 bits
      t = r;
      w = fn * pio2_3;
      r = t - w;
      w = fn * pio2_3t - ((t - r) - w);
      y0 = r - w;
    }
  }
  const y1 = (r - y0) - w;
  // Quadrant from fn (an integer-valued double, exact below 2^53)
  const q = fn - 4 * Math.floor(fn / 4);
  if (hx < 0) {
    reduced[0] = -y0; reduced[1] = -y1;
    return -q;
  }
  reduced[0] = y0; reduced[1] = y1;
  return q;
}

export function sin(x) {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0);
  if (ix >= 0x7ff00000) return NaN; // Inf or NaN
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelSin(reduced[0], reduced[1], 1);
    case 1: return kernelCos(reduced[0], reduced[1]);
    case 2: return -kernelSin(reduced[0], reduced[1], 1);
    default: return -kernelCos(reduced[0], reduced[1]);
  }
}

export function cos(x) {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelCos(reduced[0], reduced[1]);
    case 1: return -kernelSin(reduced[0], reduced[1], 1);
    case 2: return -kernelCos(reduced[0], reduced[1]);
    default: return kernelSin(reduced[0], reduced[1], 1);
  }
}

// ── log ────────────────────────────────────────────────────────────────

const ln2_hi = 6.93147180369123816490e-01;
const ln2_lo = 1.90821492927058770002e-10;
const two54 = 1.80143985094819840000e+16;
const Lg1 = 6.666666666666735130e-01;
const Lg2 = 3.999999999940941908e-01;
const Lg3 = 2.857142874366239149e-01;
const Lg4 = 2.222219843214978396e-01;
const Lg5 = 1.818357216161805012e-01;
const Lg6 = 1.531383769920937332e-01;
const Lg7 = 1.479819860511658591e-01;

export function log(x) {
  let hx = hiWord(x);
  const lx = loWord(x);
  let k = 0;
  if (hx < 0x00100000) { // x < 2^-1022 (including negatives)
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity; // log(+-0)
    if (hx < 0) return NaN; // log(negative)
    k -= 54;
    x *= two54; // subnormal: scale up
    hx = hiWord(x);
  }
  if (hx >= 0x7ff00000) return x + x; // Inf or NaN
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i ^ 0x3ff00000)); // normalize x or x/2
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) { // |f| < 2^-20
    if (f === 0) {
      if (k === 0) return 0;
      const dk = k;
      return dk * ln2_hi + dk * ln2_lo;
    }
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    const dk = k;
    return dk * ln2_hi - ((R - dk * ln2_lo) - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
}

// ── pow ────────────────────────────────────────────────────────────────

const bp = [1.0, 1.5];
const dp_h = [0.0, 5.84962487220764160156e-01];
const dp_l = [0.0, 1.35003920212974897128e-08];
const two53 = 9007199254740992.0;
const huge = 1.0e300;
const tiny = 1.0e-300;
const L1 = 5.99999999999994648725e-01;
const L2 = 4.28571428578550184252e-01;
const L3 = 3.33333329818377432918e-01;
const L4 = 2.72728123808534006489e-01;
const L5 = 2.30660745775561754067e-01;
const L6 = 2.06975017800338417784e-01;
const P1 = 1.66666666666666019037e-01;
const P2 = -2.77777777770155933842e-03;
const P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06;
const P5 = 4.13813679705723846039e-08;
const lg2 = 6.93147180559945286227e-01;
const lg2_h = 6.93147182464599609375e-01;
const lg2_l = -1.90465429995776804525e-09;
const ovt = 8.0085662595372944372e-17;
const cp = 9.61796693925975554329e-01;
const cp_h = 9.61796700954437255859e-01;
const cp_l = -7.02846165095275826516e-09;
const ivln2 = 1.44269504088896338700e+00;
const ivln2_h = 1.44269502162933349609e+00;
const ivln2_l = 1.92596299112661746887e-08;

// 2^n for an integer n in [-1022, 1023], built from its bits
function pow2(n) {
  return fromWords((n + 0x3ff) << 20, 0);
}

// z * 2^n for an integer n: exact, except one rounding when the result is subnormal
function scalbn(z, n) {
  if (n > 1023) {
    z *= pow2(1023);
    n -= 1023;
    if (n > 1023) {
      z *= pow2(1023);
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    // Scale in two steps; the first is exact (z is near 1)
    if (n < -2022) n = -2022;
    z *= pow2(n + 1000);
    n = -1000;
  }
  return z * pow2(n);
}

export function pow(x, y) {
  const hx = hiWord(x);
  const lx = loWord(x);
  const hy = hiWord(y);
  const ly = loWord(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;

  // y == 0: x**0 = 1
  if ((iy | ly) === 0) return 1.0;

  // NaN in either argument
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) ||
      iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) {
    return x + y;
  }

  // When x < 0: yisint = 0 (y not an integer), 1 (odd integer), 2 (even integer)
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) yisint = 2;
    else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        const j = ly >>> (52 - k);
        if (((j << (52 - k)) >>> 0) === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        const j = iy >> (20 - k);
        if ((j << (20 - k)) === iy) yisint = 2 - (j & 1);
      }
    }
  }

  // Special values of y
  if (ly === 0) {
    if (iy === 0x7ff00000) { // y is +-Inf
      if (((ix - 0x3ff00000) | lx) === 0) return NaN; // (+-1)**+-Inf
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0; // |x| > 1
      return hy < 0 ? -y : 0.0; // |x| < 1
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1.0 / x : x; // y is +-1
    if (hy === 0x40000000) return x * x; // y is 2
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x); // y is 0.5, x >= +0
  }

  let ax = Math.abs(x);
  // Special values of x: +-0, +-Inf, +-1
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    let z = ax;
    if (hy < 0) z = 1.0 / z;
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0) z = NaN; // (-1)**non-integer
      else if (yisint === 1) z = -z;
    }
    return z;
  }

  let n = (hx >> 31) + 1;
  // (x < 0)**(non-integer) is NaN
  if ((n | yisint) === 0) return NaN;

  let s = 1.0; // sign of the result
  if ((n | (yisint - 1)) === 0) s = -1.0; // (negative)**(odd integer)

  let t1, t2;
  if (iy > 0x41e00000) { // |y| > 2^31
    if (iy > 0x43f00000) { // |y| > 2^64: must over/underflow
      if (ix <= 0x3fefffff) return hy < 0 ? huge * huge : tiny * tiny;
      if (ix >= 0x3ff00000) return hy > 0 ? huge * huge : tiny * tiny;
    }
    // Over/underflow if x is not close to one
    if (ix < 0x3fefffff) return hy < 0 ? s * huge * huge : s * tiny * tiny;
    if (ix > 0x3ff00000) return hy > 0 ? s * huge * huge : s * tiny * tiny;
    // |1 - x| <= 2^-20: log(x) by x - x^2/2 + x^3/3 - x^4/4
    const t = ax - 1.0;
    const w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
    const u = ivln2_h * t;
    const v = t * ivln2_l - w * ivln2;
    t1 = withLoZero(u + v);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    if (ix < 0x00100000) { // subnormal x
      ax *= two53;
      n -= 53;
      ix = hiWord(ax);
    }
    n += (ix >> 20) - 0x3ff;
    const j = ix & 0x000fffff;
    // Interval
    let k;
    ix = j | 0x3ff00000; // normalize ix
    if (j <= 0x3988e) k = 0; // |x| < sqrt(3/2)
    else if (j < 0xbb67a) k = 1; // |x| < sqrt(3)
    else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = withHi(ax, ix);

    // ss = s_h + s_l = (x - 1)/(x + 1) or (x - 1.5)/(x + 1.5)
    let u = ax - bp[k];
    let v = 1.0 / (ax + bp[k]);
    const ss = u * v;
    const s_h = withLoZero(ss);
    // t_h = ax + bp[k], high part
    let t_h = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let t_l = ax - (t_h - bp[k]);
    const s_l = v * ((u - s_h * t_h) - s_h * t_l);
    // log(ax)
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += s_l * (s_h + ss);
    s2 = s_h * s_h;
    t_h = withLoZero(3.0 + s2 + r);
    t_l = r - ((t_h - 3.0) - s2);
    // u + v = ss * (1 + ...)
    u = s_h * t_h;
    v = s_l * t_h + t_l * ss;
    // 2/(3 log2) * (ss + ...)
    const p_h = withLoZero(u + v);
    const p_l = v - (p_h - u);
    const z_h = cp_h * p_h;
    const z_l = cp_l * p_h + p_l * cp + dp_l[k];
    // log2(ax) = (ss + ...) * 2/(3 log2) = n + dp_h + z_h + z_l
    const t = n;
    t1 = withLoZero(((z_h + z_l) + dp_h[k]) + t);
    t2 = z_l - (((t1 - t) - dp_h[k]) - z_h);
  }

  // Split y into y1 + y2 and compute (y1 + y2) * (t1 + t2)
  const y1 = withLoZero(y);
  const p_l = (y - y1) * t1 + y * t2;
  let p_h = y1 * t1;
  let z = p_l + p_h;
  let j = hiWord(z);
  let i = loWord(z);
  if (j >= 0x40900000) { // z >= 1024
    if (((j - 0x40900000) | i) !== 0) return s * huge * huge; // overflow
    if (p_l + ovt > z - p_h) return s * huge * huge;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) { // z <= -1075
    if (((j - 0xc090cc00) | i) !== 0) return s * tiny * tiny; // underflow
    if (p_l <= z - p_h) return s * tiny * tiny;
  }

  // 2^(p_h + p_l)
  i = j & 0x7fffffff;
  let k = (i >> 20) - 0x3ff;
  n = 0;
  if (i > 0x3fe00000) { // |z| > 0.5: n = [z + 0.5]
    n = j + (0x00100000 >> (k + 1));
    k = ((n & 0x7fffffff) >> 20) - 0x3ff; // new k for n
    const t = fromWords(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    p_h -= t;
  }
  let t = withLoZero(p_l + p_h);
  const u = t * lg2_h;
  const v = (p_l - (t - p_h)) * lg2 + t * lg2_l;
  z = u + v;
  const w = v - (z - u);
  t = z * z;
  t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const r = (z * t1) / (t1 - 2.0) - (w + z * w);
  z = 1.0 - (r - z);
  j = hiWord(z);
  j += n << 20;
  if ((j >> 20) <= 0) z = scalbn(z, n); // subnormal output
  else z = withHi(z, j);
  return s * z;
}
