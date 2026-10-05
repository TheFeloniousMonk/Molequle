// sprites.js — Pre-rendered entity sprites (visual only).
//
// Entities are drawn with drawImage from texture atlases instead of per-frame
// shadowBlur/gradients. One atlas per layer (glow, body, highlight), each with
// a strip per color-ramp step holding the sprite at several mip levels, so
// small entities are drawn from a small sprite rather than a heavily
// downscaled large one (which would alias/shimmer).
//
// Lighting is baked in: the body is shaded toward the global light with a
// shadow crescent on the far side, and the highlight sprite is offset toward
// the light. Atlases are rebuilt only when element, lighting, or light angle
// change.

import { rampColor } from './elements.js';

export const RAMP_STEPS = 48;
export const BODY_LEVELS = [32, 16, 8, 4];   // body sprite radius (device px) per mip level
export const GLOW_LEVELS = [48, 24, 12, 6];  // glow sprite radius per mip level
export const BOND_ALPHA_BUCKETS = 24;        // bond lines are batched by quantized alpha
export const MAX_BOND_ALPHA = 0.3;           // bond alpha = strength * 0.3

const PAD = 2;
const STRIP_COLUMNS = 8;
const TAU = Math.PI * 2;

const cellSize = r => Math.ceil(2 * r + 2 * PAD);
const rgbCss = (c, a = 1) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a})`;
const mix = (c, d, f) => [c[0] + (d[0] - c[0]) * f, c[1] + (d[1] - c[1]) * f, c[2] + (d[2] - c[2]) * f];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** Mip level for a sprite drawn at `radius` device px: the smallest sprite at least that large. */
export function pickLevel(levels, radius) {
  for (let l = levels.length - 1; l > 0; l--) {
    if (levels[l] >= radius) return l;
  }
  return 0;
}

export class SpriteAtlas {
  /**
   * @param {object} element - from elements.js
   * @param {boolean} lit - faux-3D lighting (false = flat)
   * @param {number} lightAngle - degrees, clockwise from +x on screen (225 = upper left)
   */
  constructor(element, lit, lightAngle) {
    const a = lightAngle * Math.PI / 180;
    const lx = Math.cos(a);
    const ly = Math.sin(a);
    this.lit = lit;

    // Ramp colors per step. The hue circle wraps (step S == step 0); ramps don't.
    const steps = RAMP_STEPS;
    const tDenom = element.hueRamp ? steps : steps - 1;
    this.colors = [];
    for (let s = 0; s < steps; s++) this.colors.push(rampColor(element, s / tDenom));
    // Relative luminance (0..1) per step: scales mirror finish and gleam
    this.lum = new Float32Array(steps);
    for (let s = 0; s < steps; s++) {
      const [r, g, b] = this.colors[s];
      this.lum[s] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    const mirror = element.mirror || 0;

    // Body: one strip per step plus a neutral "storm gray" strip at index RAMP_STEPS
    this.body = buildAtlas(steps + 1, BODY_LEVELS, (ctx, i, l, cx, cy, r) => {
      const rgb = i < steps ? this.colors[i] : element.stormGray;
      const finish = i < steps ? mirror * this.lum[i] * this.lum[i] : 0;
      drawBody(ctx, cx, cy, r, rgb, lit, lx, ly, element.shadow * (1 - 0.35 * finish), element.bodyLift ?? 0.22, finish);
    });
    this.grayStep = steps;

    this.glow = buildAtlas(steps, GLOW_LEVELS, (ctx, i, l, cx, cy, r) => {
      drawGlow(ctx, cx, cy, r, mix(this.colors[i], WHITE, 0.08));
    });

    this.highlight = lit
      ? buildAtlas(1, BODY_LEVELS, (ctx, i, l, cx, cy, r) => drawHighlight(ctx, cx, cy, r, lx, ly, element.highlight))
      : null;

    // Cached style strings (no per-frame string building)
    this.trailStyles = this.colors.map(c => rgbCss(c));
    this.bondStyles = [];
    for (let b = 0; b < BOND_ALPHA_BUCKETS; b++) {
      const alpha = ((b + 0.5) / BOND_ALPHA_BUCKETS) * MAX_BOND_ALPHA;
      this.bondStyles.push(rgbCss(element.bond, alpha.toFixed(4)));
    }

    // Weather sprites, tinted per element
    this.bloom = radialSprite(128, element.bloomTint, [[0, 0.9], [0.35, 0.45], [0.7, 0.12], [1, 0]]);
    this.soft = radialSprite(64, WHITE, [[0, 1], [0.3, 0.55], [0.65, 0.15], [1, 0]]);
    this.shade = radialSprite(64, BLACK, [[0, 0.8], [0.5, 0.45], [0.8, 0.15], [1, 0]]);
    this.rimStyle = rgbCss(element.rimTint, 0.16);
    this.rimStyleFaint = rgbCss(element.rimTint, 0.07);
    this.rimStyleOpaque = rgbCss(element.rimTint, 1);
  }
}

// Lay out `count` strips (one per color step), each holding one cell per mip
// level, in a grid. Returns the canvas plus per-(strip, level) source rects,
// indexed strip * levels.length + level.
function buildAtlas(count, levels, drawCell) {
  const sizes = levels.map(cellSize);
  const stripW = sizes.reduce((a, b) => a + b, 0);
  const stripH = sizes[0];
  const cols = Math.min(STRIP_COLUMNS, count);
  const rows = Math.ceil(count / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * stripW;
  canvas.height = rows * stripH;
  const ctx = canvas.getContext('2d');
  const n = count * levels.length;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const ss = new Float32Array(n);
  for (let i = 0; i < count; i++) {
    let x = (i % cols) * stripW;
    const y = Math.floor(i / cols) * stripH;
    for (let l = 0; l < levels.length; l++) {
      const k = i * levels.length + l;
      sx[k] = x;
      sy[k] = y;
      ss[k] = sizes[l];
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, sizes[l], sizes[l]);
      ctx.clip();
      drawCell(ctx, i, l, x + sizes[l] / 2, y + sizes[l] / 2, levels[l]);
      ctx.restore();
      x += sizes[l];
    }
  }
  return { canvas, sx, sy, ss, levels, levelCount: levels.length };
}

// `finish` (0..1): mirror finish — a Fresnel-style bright rim, as polished
// surfaces brighten toward their edges (slightly more away from the light)
function drawBody(ctx, cx, cy, r, rgb, lit, lx, ly, shadow, lift, finish = 0) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  if (!lit) {
    ctx.fillStyle = rgbCss(rgb);
    ctx.fill();
    return;
  }
  // Sphere shading: brightest toward the light, falling off to the far rim
  const g = ctx.createRadialGradient(cx + lx * r * 0.35, cy + ly * r * 0.35, r * 0.05, cx, cy, r);
  g.addColorStop(0, rgbCss(mix(rgb, WHITE, lift)));
  g.addColorStop(0.55, rgbCss(rgb));
  g.addColorStop(1, rgbCss(mix(rgb, BLACK, shadow * 0.55)));
  ctx.fillStyle = g;
  ctx.fill();
  // Shadow crescent on the side away from the light
  ctx.clip();
  const sg = ctx.createLinearGradient(cx + lx * r * 0.1, cy + ly * r * 0.1, cx - lx * r, cy - ly * r);
  sg.addColorStop(0, 'rgba(0, 0, 0, 0)');
  sg.addColorStop(0.55, `rgba(0, 0, 0, ${shadow * 0.25})`);
  sg.addColorStop(1, `rgba(0, 0, 0, ${shadow * 0.75})`);
  ctx.fillStyle = sg;
  ctx.fillRect(cx - r - 1, cy - r - 1, 2 * r + 2, 2 * r + 2);
  if (finish > 0.01) {
    const ox = cx - lx * r * 0.08;
    const oy = cy - ly * r * 0.08;
    const rg = ctx.createRadialGradient(ox, oy, r * 0.55, ox, oy, r * 1.02);
    rg.addColorStop(0, 'rgba(255, 255, 255, 0)');
    rg.addColorStop(0.72, `rgba(255, 255, 255, ${finish * 0.3})`);
    rg.addColorStop(0.9, `rgba(255, 255, 255, ${finish * 0.85})`);
    rg.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = rg;
    ctx.fillRect(cx - r - 1, cy - r - 1, 2 * r + 2, 2 * r + 2);
  }
}

function drawHighlight(ctx, cx, cy, r, lx, ly, hl) {
  const hx = cx + lx * r * 0.38;
  const hy = cy + ly * r * 0.38;
  const hr = r * hl.size;
  const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
  g.addColorStop(0, 'rgba(255, 255, 255, 1)');
  g.addColorStop(Math.max(0.05, hl.sharpness * 0.6), 'rgba(255, 255, 255, 0.85)');
  g.addColorStop(Math.min(0.95, 0.35 + hl.sharpness * 0.5), 'rgba(255, 255, 255, 0.25)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  ctx.fillStyle = g;
  ctx.fillRect(cx - r - 1, cy - r - 1, 2 * r + 2, 2 * r + 2);
}

// Glow halo: approximates the old shadowBlur falloff around a disk
function drawGlow(ctx, cx, cy, r, rgb) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [t, a] of [[0, 1], [0.18, 0.78], [0.4, 0.36], [0.65, 0.12], [0.85, 0.03], [1, 0]]) {
    g.addColorStop(t, rgbCss(rgb, a));
  }
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
}

function radialSprite(radius, rgb, stops) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = radius * 2;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  for (const [t, a] of stops) g.addColorStop(t, rgbCss(rgb, a));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, radius * 2, radius * 2);
  return canvas;
}
