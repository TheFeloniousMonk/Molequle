// renderer.js — Canvas 2D renderer (visual only; never touches simulation
// state or the simulation RNG).
//
// Frame composition, back to front:
//   trail layer (low-res, persistent) -> weather underlay -> context map
//   overlay -> bonds -> entity glows -> entity bodies -> highlights ->
//   weather overlay -> bond-break flashes -> vignette
//
// Entities are drawn from pre-rendered sprite atlases (sprites.js), one pass
// per layer so each pass reads a single texture. Per-frame work uses reused
// typed arrays and cached style strings — no per-frame allocation.

import { getElement, hueToRampT } from './elements.js';
import {
  SpriteAtlas, RAMP_STEPS, BODY_LEVELS, GLOW_LEVELS,
  BOND_ALPHA_BUCKETS, MAX_BOND_ALPHA, pickLevel,
} from './sprites.js';
import { WeatherFx } from './weather-fx.js';

const BG = '#0a0a0f';
const TRAIL_DOT_RADIUS = 2;   // trail stroke half-width (world px)
const TRAIL_CLEANUP_EVERY = 3; // fades per residue-cleanup pass (lower = faint trails clear faster)
const ATLAS_CACHE_SIZE = 6;
const DEV_METRIC_INTERVAL = 300;   // frames between trail luminance samples (dev only)

// Hue anchors for the entity's biography hue, as unit vectors
const RAD = Math.PI / 180;
const COS_S = Math.cos(20 * RAD), SIN_S = Math.sin(20 * RAD);     // S: red-orange
const COS_B = Math.cos(150 * RAD), SIN_B = Math.sin(150 * RAD);   // B: green-teal
const COS_I = Math.cos(240 * RAD), SIN_I = Math.sin(240 * RAD);   // I: blue-purple
const COS_D = Math.cos(300 * RAD), SIN_D = Math.sin(300 * RAD);   // D: magenta-violet

/**
 * Entity hue in [0, 360): weighted angular blend of its parameters plus its
 * accumulated hue drift (color as biography).
 */
export function entityHue(entity) {
  const S = entity.sociability;
  const I = entity.inertia;
  const B = entity.bondAffinity;
  const D = entity.disruptionCharge;
  const total = S + I + B + D + 0.001;
  const cx = (S * COS_S + I * COS_I + B * COS_B + D * COS_D) / total;
  const cy = (S * SIN_S + I * SIN_I + B * SIN_B + D * SIN_D) / total;
  let hue = Math.atan2(cy, cx) / RAD;
  if (hue < 0) hue += 360;
  return (hue + (entity.hueOffset || 0)) % 360;
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas - main (visible) canvas
   * @param {object} [options]
   * @param {boolean} [options.dev] - sample trail-layer luminance (window.__molequleDev)
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = 1920;
    this.height = 1080;
    this.dev = !!options.dev;

    this.renderScale = 0;
    this.trailResolution = 0;
    this.trailCanvas = document.createElement('canvas');
    this.trailCtx = this.trailCanvas.getContext('2d', { alpha: false });
    this.trailKeep = 1;        // product of (1 - decay) since the last fade
    this.trailFrames = 0;      // frames since the last fade
    this.trailFadeCount = 0;   // fades applied (residue cleanup runs every TRAIL_CLEANUP_EVERY)
    this.frame = 0;

    this.atlases = new Map();
    this.weatherFx = new WeatherFx();
    this.vignette = makeVignette();
    this.bondBreakFlashes = [];
    this.indexById = new Map();

    // Per-entity frame data (grown as needed)
    this.capacity = 0;
    this._grow(512);

    // Bond segments batched by alpha bucket: [x1, y1, x2, y2, ...]
    this.bondCounts = new Int32Array(BOND_ALPHA_BUCKETS);
    this.bondSegs = Array.from({ length: BOND_ALPHA_BUCKETS }, () => new Float32Array(256));

    // Trail segments batched by ramp step: [x0, y0, x1, y1, ...]
    this.dotCounts = new Int32Array(RAMP_STEPS);
    this.dotPos = Array.from({ length: RAMP_STEPS }, () => new Float32Array(128));
    // Each entity's last trail point: [x, y, frame] (allocated once per entity)
    this.trailPrev = new WeakMap();

    if (this.dev) {
      this.probe = document.createElement('canvas');
      this.probe.width = 96;
      this.probe.height = 54;
      this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
      window.__molequleDev = { trailLuminance: [] };
    }
  }

  // ── Frame ────────────────────────────────────────────────────────────

  render(entities, contextMap, config, weatherSystem) {
    this.frame++;
    this._ensureSize(config);
    const W = this.width;
    const H = this.height;
    const element = getElement(config.element);
    const lit = config.lighting !== 'flat';
    const atlas = this._atlasFor(config.element, element, lit, config.lightAngle ?? 225);
    const showWeather = config.showWeather !== false && !!weatherSystem;
    if (showWeather) this.weatherFx.prepare(weatherSystem, W, H);

    this._prepareEntities(entities, config, element, atlas, lit, showWeather);
    if (config.showTrails) this._updateTrails(entities, config, element, atlas);

    const ctx = this.ctx;
    const rs = this.renderScale;
    ctx.setTransform(rs, 0, 0, rs, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 1. Background: the trail layer (opaque, background-colored) scaled up
    if (config.showTrails) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.trailCanvas, 0, 0, W, H);
    } else {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
    }

    // 2. Weather underlay
    if (showWeather) this.weatherFx.drawUnderlay(ctx, atlas, element, weatherSystem, config);

    // 3. Context map overlay
    if (config.showContextMap && contextMap) this._renderContextMap(ctx, contextMap, config);

    // 4-7. Bonds, then entities in layer passes
    this._renderBonds(ctx, entities, atlas);
    this._renderEntities(ctx, entities.length, element, atlas, lit);

    // 8. Weather overlay
    if (showWeather) this.weatherFx.drawOverlay(ctx, atlas, element);

    // 9. Bond break flashes
    this._renderBondBreakFlashes(ctx);

    // 10. Vignette, slightly deeper in winter
    let vignetteAlpha = 0.4;
    if (showWeather) {
      const deviation = (weatherSystem.getWarmth() - 0.5) * (config.seasonAmplitude ?? 0.5);
      vignetteAlpha += Math.max(0, -deviation) * 0.6;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(1, vignetteAlpha);
    ctx.drawImage(this.vignette, 0, 0, W, H);
    ctx.globalAlpha = 1;

    if (this.dev && this.frame % DEV_METRIC_INTERVAL === 0) this._sampleTrailLuminance();
  }

  // ── Per-entity values for this frame ────────────────────────────────

  _prepareEntities(entities, config, element, atlas, lit, showWeather) {
    const n = entities.length;
    if (n > this.capacity) this._grow(n);
    const rs = this.renderScale;
    const fx = this.weatherFx;
    const additive = element.bodyBlend === 'lighter';
    const sizeBondScale = config.sizeBondScale ?? 0.1;
    const growthDuration = config.sizeGrowthDuration ?? 600;
    const hueCircle = !!element.hueRamp;

    this.indexById.clear();
    for (let i = 0; i < n; i++) {
      const e = entities[i];
      this.indexById.set(e.id, i);

      // Color: biography hue -> ramp step
      const t = hueToRampT(element, entityHue(e));
      this.eStep[i] = hueCircle ? Math.round(t * RAMP_STEPS) % RAMP_STEPS : Math.round(t * (RAMP_STEPS - 1));

      // Size: inertia, bond count, newborn growth (unchanged semantics)
      const bondSizeBoost = 1 + (e.bonds ? e.bonds.length : 0) * sizeBondScale;
      const growthFactor = e.age < growthDuration ? 0.8 + 0.2 * (e.age / growthDuration) : 1.0;
      const r = (3 + e.inertia * 8) * Math.max(0.7, Math.min(1.4, bondSizeBoost * growthFactor));
      this.eX[i] = e.x;
      this.eY[i] = e.y;
      this.eR[i] = r;

      // Fading entities: opacity falls, glow peaks at fadeProgress 0.3
      let opacity = 1;
      let glowPeak = 1;
      if (!e.alive) {
        opacity = 1 - e.fadeProgress;
        glowPeak = e.fadeProgress < 0.3
          ? 1 + (e.fadeProgress / 0.3) * 2
          : 3 * (1 - (e.fadeProgress - 0.3) / 0.7);
        if (glowPeak < 0) glowPeak = 0;
      }
      if (opacity <= 0) {
        this.eBodyA[i] = 0;
        this.eGlowA[i] = 0;
        this.eHlA[i] = 0;
        this.eGrayA[i] = 0;
        continue;
      }

      // Volatility -> glow size/opacity; disruption -> glow intensity, highlight brightness
      const V = e.volatility;
      const D = e.disruptionCharge;
      let glowA = element.glowStrength * (0.3 + 0.45 * D + 0.25 * V) * opacity;
      let bodyA = element.bodyAlpha * opacity * (additive ? 0.8 + 0.2 * D : 1);
      // Highlight brightness follows disruption charge, down to the element's floor
      const hl = element.highlight;
      let hlA = lit ? hl.intensity * Math.max(hl.floor || 0, 0.55 + 0.45 * D) * opacity : 0;   // may exceed 1 (double pass)
      if (hl.lumBoost) hlA *= 1 + hl.lumBoost * (atlas.lum[this.eStep[i]] - 0.5);   // brighter surface, brighter gleam
      let grayA = 0;

      if (showWeather) {
        const storm = fx.stormCount ? fx.stormAt(e.x, e.y) : 0;
        if (storm > 0) {
          // Dim and desaturate: less colored light, a neutral overlay
          if (additive) bodyA *= 1 - 0.55 * storm;
          glowA *= 1 - 0.7 * storm;
          hlA *= 1 - 0.6 * storm;
          grayA = (additive ? 0.3 : 0.55) * storm * opacity;
        }
        const bloom = fx.bloomCount ? fx.bloomAt(e.x, e.y) : 0;
        if (bloom > 0) {
          bodyA = Math.min(1, bodyA * (1 + 0.3 * bloom));
          glowA *= 1 + 0.6 * bloom;
          hlA *= 1 + 0.3 * bloom;
        }
      }

      const glowR = r * 1.1 + (5 + 9 * V + 5 * D) * glowPeak;
      this.eGlowR[i] = glowR;
      this.eGlowA[i] = glowA > 1 ? 1 : glowA;
      this.eBodyA[i] = bodyA;
      this.eHlA[i] = hlA > 2 ? 2 : hlA;
      this.eGrayA[i] = grayA;
      this.eBodyLvl[i] = pickLevel(BODY_LEVELS, r * rs);
      this.eGlowLvl[i] = pickLevel(GLOW_LEVELS, glowR * rs);
    }
  }

  // ── Trails ───────────────────────────────────────────────────────────

  _updateTrails(entities, config, element, atlas) {
    const tctx = this.trailCtx;
    const trs = this.trailResolution;
    tctx.setTransform(trs, 0, 0, trs, 0, 0);

    // Decay accumulates every frame; the fade is applied every N frames as
    // one larger step with the same total (see _fadeTrails)
    let decay = config.trailDecayRate || 0.003;
    if (config.trailDecayScaling && entities.length > 0) {
      let totalSpeed = 0;
      let aliveCount = 0;
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;
        totalSpeed += Math.sqrt(e.vx * e.vx + e.vy * e.vy);
        aliveCount++;
      }
      const avgSpeed = aliveCount > 0 ? totalSpeed / aliveCount : 0;
      decay *= 1 + avgSpeed * 0.5;
    }
    this.trailKeep *= 1 - Math.min(decay, 1);
    this.trailFrames++;
    const interval = Math.max(1, Math.round(config.trailFadeInterval ?? 10));
    if (this.trailFrames >= interval) {
      this._fadeTrails(1 - this.trailKeep);
      this.trailKeep = 1;
      this.trailFrames = 0;
    }

    // Each entity extends its trail with a segment from where it was last
    // frame (a continuous stroke rather than a row of beads). Batched by ramp
    // step: one path + stroke per color.
    const W = this.width;
    const H = this.height;
    const counts = this.dotCounts;
    counts.fill(0);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e.alive) continue;
      const x = this.eX[i];
      const y = this.eY[i];
      let prev = this.trailPrev.get(e);
      if (!prev) {
        prev = new Float32Array(3);
        prev[2] = -1;
        this.trailPrev.set(e, prev);
      }
      let x0 = x + 0.01;   // no usable previous point: a dot (near-zero segment)
      let y0 = y;
      // Previous point only if drawn last frame and not across a wrap-around jump
      if (prev[2] === this.frame - 1 && Math.abs(x - prev[0]) < W / 4 && Math.abs(y - prev[1]) < H / 4) {
        x0 = prev[0];
        y0 = prev[1];
      }
      prev[0] = x;
      prev[1] = y;
      prev[2] = this.frame;

      const s = this.eStep[i];
      let buf = this.dotPos[s];
      const c = counts[s];
      if (c * 4 + 4 > buf.length) {
        const grown = new Float32Array(buf.length * 2);
        grown.set(buf);
        this.dotPos[s] = buf = grown;
      }
      buf[c * 4] = x0;
      buf[c * 4 + 1] = y0;
      buf[c * 4 + 2] = x;
      buf[c * 4 + 3] = y;
      counts[s] = c + 1;
    }
    tctx.globalCompositeOperation = 'source-over';
    tctx.globalAlpha = element.trailAlpha;
    tctx.lineWidth = TRAIL_DOT_RADIUS * 2;
    tctx.lineCap = 'butt';   // consecutive segments meet exactly (round caps double-blend at joints)
    for (let s = 0; s < RAMP_STEPS; s++) {
      const c = counts[s];
      if (c === 0) continue;
      const buf = this.dotPos[s];
      tctx.strokeStyle = atlas.trailStyles[s];
      tctx.beginPath();
      for (let k = 0; k < c; k++) {
        tctx.moveTo(buf[k * 4], buf[k * 4 + 1]);
        tctx.lineTo(buf[k * 4 + 2], buf[k * 4 + 3]);
      }
      tctx.stroke();
    }
    tctx.globalAlpha = 1;
  }

  /**
   * Fade the trail layer toward the background by `alpha`.
   *
   * The canvas stores 8-bit color, so a fade's per-pixel step rounds to zero
   * once a pixel is within ~0.5/alpha levels of the background; trails then
   * never fully fade and residue builds up into a muddy wash. Fading every N
   * frames with a larger alpha shrinks that band; two cheap passes then
   * remove what's left:
   *   - color-burn with rgb(254,254,254) maps v -> 255 - (255 - v) * 255/254,
   *     lowering dark channels by ~1 level per fade and bright ones by ~0
   *   - lighten with the background color floors every channel back at the
   *     background, so nothing is pushed below it
   * Net: residue walks down to the background (exactly) a level per cleanup,
   * while bright trails fade at the configured rate. Cleanup runs every
   * TRAIL_CLEANUP_EVERY fades so faint trails linger long enough for
   * patterns to build up.
   */
  _fadeTrails(alpha) {
    const tctx = this.trailCtx;
    const W = this.width;
    const H = this.height;
    tctx.globalAlpha = Math.max(alpha, 2 / 255);
    tctx.globalCompositeOperation = 'source-over';
    tctx.fillStyle = BG;
    tctx.fillRect(0, 0, W, H);
    tctx.globalAlpha = 1;
    if (++this.trailFadeCount % TRAIL_CLEANUP_EVERY !== 0) return;
    tctx.globalCompositeOperation = 'color-burn';
    tctx.fillStyle = 'rgb(254, 254, 254)';
    tctx.fillRect(0, 0, W, H);
    tctx.globalCompositeOperation = 'lighten';
    tctx.fillStyle = BG;
    tctx.fillRect(0, 0, W, H);
    tctx.globalCompositeOperation = 'source-over';
  }

  clearTrails() {
    const tctx = this.trailCtx;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalAlpha = 1;
    tctx.globalCompositeOperation = 'source-over';
    tctx.fillStyle = BG;
    tctx.fillRect(0, 0, this.trailCanvas.width, this.trailCanvas.height);
    this.trailKeep = 1;
    this.trailFrames = 0;
  }

  // ── Bonds ────────────────────────────────────────────────────────────

  // Lines batched by quantized alpha: one path + stroke per bucket
  _renderBonds(ctx, entities, atlas) {
    const W = this.width;
    const H = this.height;
    const halfW = W / 2;
    const halfH = H / 2;
    const counts = this.bondCounts;
    counts.fill(0);

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e.bonds) continue;
      for (let b = 0; b < e.bonds.length; b++) {
        const bond = e.bonds[b];
        const j = this.indexById.get(bond.targetId);
        if (j === undefined) continue;
        const target = entities[j];

        // Draw each pair once: the first time it's seen, either earlier in
        // this entity's list or from the partner's side if the partner came
        // first and holds the reverse bond
        if (alreadyListed(e.bonds, b, bond.targetId)) continue;
        if (j < i && hasBondTo(target, e.id)) continue;

        const alpha = bond.strength * MAX_BOND_ALPHA;
        if (alpha < 0.005) continue;
        const bucket = Math.min(BOND_ALPHA_BUCKETS - 1, Math.floor((alpha / MAX_BOND_ALPHA) * BOND_ALPHA_BUCKETS));

        let dx = target.x - e.x;
        let dy = target.y - e.y;
        const wrapX = Math.abs(dx) > halfW;
        const wrapY = Math.abs(dy) > halfH;
        if (!wrapX && !wrapY) {
          this._pushSeg(bucket, e.x, e.y, target.x, target.y);
        } else {
          // Wrapped bond: a segment from each end toward the opposite edge
          if (wrapX) dx = dx > 0 ? dx - W : dx + W;
          if (wrapY) dy = dy > 0 ? dy - H : dy + H;
          this._pushSeg(bucket, e.x, e.y, e.x + dx, e.y + dy);
          this._pushSeg(bucket, target.x, target.y, target.x - dx, target.y - dy);
        }
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    for (let b = 0; b < BOND_ALPHA_BUCKETS; b++) {
      const c = counts[b];
      if (c === 0) continue;
      const segs = this.bondSegs[b];
      ctx.strokeStyle = atlas.bondStyles[b];
      ctx.beginPath();
      for (let k = 0; k < c; k++) {
        const o = k * 4;
        ctx.moveTo(segs[o], segs[o + 1]);
        ctx.lineTo(segs[o + 2], segs[o + 3]);
      }
      ctx.stroke();
    }
  }

  _pushSeg(bucket, x1, y1, x2, y2) {
    let segs = this.bondSegs[bucket];
    const c = this.bondCounts[bucket];
    if (c * 4 + 4 > segs.length) {
      const grown = new Float32Array(segs.length * 2);
      grown.set(segs);
      this.bondSegs[bucket] = segs = grown;
    }
    const o = c * 4;
    segs[o] = x1;
    segs[o + 1] = y1;
    segs[o + 2] = x2;
    segs[o + 3] = y2;
    this.bondCounts[bucket] = c + 1;
  }

  // ── Entities ─────────────────────────────────────────────────────────

  _renderEntities(ctx, n, element, atlas, lit) {
    const eX = this.eX, eY = this.eY;

    // Glows
    const glow = atlas.glow;
    ctx.globalCompositeOperation = element.glowBlend;
    for (let i = 0; i < n; i++) {
      const a = this.eGlowA[i];
      if (a < 0.004) continue;
      const lvl = this.eGlowLvl[i];
      const k = this.eStep[i] * glow.levelCount + lvl;
      const size = glow.ss[k] * this.eGlowR[i] / GLOW_LEVELS[lvl];
      ctx.globalAlpha = a;
      ctx.drawImage(glow.canvas, glow.sx[k], glow.sy[k], glow.ss[k], glow.ss[k],
        eX[i] - size / 2, eY[i] - size / 2, size, size);
    }

    // Bodies (plus the neutral storm overlay, from the same atlas)
    const body = atlas.body;
    const grayBase = atlas.grayStep * body.levelCount;
    ctx.globalCompositeOperation = element.bodyBlend;
    for (let i = 0; i < n; i++) {
      const a = this.eBodyA[i];
      if (a <= 0) continue;
      const lvl = this.eBodyLvl[i];
      const k = this.eStep[i] * body.levelCount + lvl;
      const size = body.ss[k] * this.eR[i] / BODY_LEVELS[lvl];
      const x = eX[i] - size / 2;
      const y = eY[i] - size / 2;
      ctx.globalAlpha = a > 1 ? 1 : a;
      ctx.drawImage(body.canvas, body.sx[k], body.sy[k], body.ss[k], body.ss[k], x, y, size, size);
      const g = this.eGrayA[i];
      if (g > 0.004) {
        const kg = grayBase + lvl;
        ctx.globalAlpha = g;
        ctx.drawImage(body.canvas, body.sx[kg], body.sy[kg], body.ss[kg], body.ss[kg], x, y, size, size);
      }
    }

    // Specular highlights
    if (lit && atlas.highlight) {
      const hl = atlas.highlight;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const a = this.eHlA[i];
        if (a < 0.004) continue;
        const lvl = this.eBodyLvl[i];
        const size = hl.ss[lvl] * this.eR[i] / BODY_LEVELS[lvl];
        const x = eX[i] - size / 2;
        const y = eY[i] - size / 2;
        ctx.globalAlpha = a > 1 ? 1 : a;
        ctx.drawImage(hl.canvas, hl.sx[lvl], hl.sy[lvl], hl.ss[lvl], hl.ss[lvl], x, y, size, size);
        if (a > 1.004) {
          // Intensity above 1: a second additive pass blows the gleam out toward white
          ctx.globalAlpha = a - 1;
          ctx.drawImage(hl.canvas, hl.sx[lvl], hl.sy[lvl], hl.ss[lvl], hl.ss[lvl], x, y, size, size);
        }
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Context map overlay ──────────────────────────────────────────────

  _renderContextMap(ctx, contextMap, config) {
    const cellW = contextMap.cellWidth;
    const cellH = contextMap.cellHeight;
    const tick = config.currentTick || 0;

    // Layers drawn in a fixed order (fertile, scarred, disruption, ghost);
    // cells don't overlap, so layer-by-layer equals cell-by-cell.
    const fertile = new Path2D();
    const ghost = new Path2D();
    const scarred = [];
    const disrupted = [];
    for (let gy = 0; gy < contextMap.gridRows; gy++) {
      for (let gx = 0; gx < contextMap.gridCols; gx++) {
        const terrain = contextMap.getTerrainEffects(gx * cellW + cellW / 2, gy * cellH + cellH / 2, tick);
        const px = gx * cellW;
        const py = gy * cellH;
        if (terrain.isFertile) fertile.rect(px, py, cellW, cellH);
        if (terrain.isScarred) scarred.push(px, py, 0.08 + terrain.scarIntensity * 0.12);
        if (terrain.isDisruptionZone) disrupted.push(px, py);
        if (terrain.isGhostTrail) ghost.rect(px, py, cellW, cellH);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(180, 120, 60, 0.15)';
    ctx.fill(fertile);
    ctx.fillStyle = 'rgb(60, 80, 180)';
    for (let i = 0; i < scarred.length; i += 3) {
      ctx.globalAlpha = scarred[i + 2];
      ctx.fillRect(scarred[i], scarred[i + 1], cellW, cellH);
    }
    ctx.fillStyle = 'rgb(200, 50, 50)';
    for (let i = 0; i < disrupted.length; i += 2) {
      ctx.globalAlpha = 0.08 + Math.random() * 0.12;   // flicker (visual only)
      ctx.fillRect(disrupted[i], disrupted[i + 1], cellW, cellH);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fill(ghost);
  }

  // ── Bond break flashes ───────────────────────────────────────────────

  _renderBondBreakFlashes(ctx) {
    if (this.bondBreakFlashes.length === 0) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ffffff';
    for (let i = this.bondBreakFlashes.length - 1; i >= 0; i--) {
      const flash = this.bondBreakFlashes[i];
      const alpha = 1 - flash.progress;
      if (alpha <= 0) {
        this.bondBreakFlashes.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(flash.x1, flash.y1);
      ctx.lineTo(flash.x2, flash.y2);
      // Wide faint stroke as the glow, thin bright core
      ctx.globalAlpha = 0.25 * alpha;
      ctx.lineWidth = 7 * alpha;
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2 * alpha;
      ctx.stroke();
      flash.progress += 0.04;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Register a bond break flash between two points. */
  addBondBreakFlash(x1, y1, x2, y2) {
    this.bondBreakFlashes.push({ x1, y1, x2, y2, progress: 0 });
  }

  // ── Setup helpers ────────────────────────────────────────────────────

  // Main canvas at renderScale (0 = auto: min(devicePixelRatio, 1.5)); trail
  // layer at renderScale * trailScale. Resizing the trail layer clears it.
  _ensureSize(config) {
    const auto = Math.min(window.devicePixelRatio || 1, 1.5);
    const rs = config.renderScale > 0 ? config.renderScale : auto;
    const trs = rs * Math.min(1, Math.max(0.1, config.trailScale ?? 0.5));
    if (rs !== this.renderScale) {
      this.renderScale = rs;
      this.canvas.width = Math.round(this.width * rs);
      this.canvas.height = Math.round(this.height * rs);
    }
    if (trs !== this.trailResolution) {
      this.trailResolution = trs;
      this.trailCanvas.width = Math.max(1, Math.round(this.width * trs));
      this.trailCanvas.height = Math.max(1, Math.round(this.height * trs));
      this.clearTrails();
    }
  }

  _atlasFor(name, element, lit, lightAngle) {
    const key = `${name}|${lit ? 1 : 0}|${lightAngle}`;
    if (key === this.atlasKey) return this.atlas;
    let atlas = this.atlases.get(key);
    if (!atlas) {
      atlas = new SpriteAtlas(element, lit, lightAngle);
      this.atlases.set(key, atlas);
      if (this.atlases.size > ATLAS_CACHE_SIZE) this.atlases.delete(this.atlases.keys().next().value);
    }
    this.atlasKey = key;
    this.atlas = atlas;
    return atlas;
  }

  _grow(n) {
    const cap = Math.max(n, this.capacity * 2);
    this.capacity = cap;
    this.eX = new Float32Array(cap);
    this.eY = new Float32Array(cap);
    this.eR = new Float32Array(cap);
    this.eGlowR = new Float32Array(cap);
    this.eGlowA = new Float32Array(cap);
    this.eBodyA = new Float32Array(cap);
    this.eHlA = new Float32Array(cap);
    this.eGrayA = new Float32Array(cap);
    this.eStep = new Uint8Array(cap);
    this.eBodyLvl = new Uint8Array(cap);
    this.eGlowLvl = new Uint8Array(cap);
  }

  // Dev only: mean trail-layer brightness above the background (0-255 scale).
  // Should plateau during a run rather than climb.
  _sampleTrailLuminance() {
    const p = this.probeCtx;
    p.drawImage(this.trailCanvas, 0, 0, this.probe.width, this.probe.height);
    const data = p.getImageData(0, 0, this.probe.width, this.probe.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] - 10) * 0.2126 + (data[i + 1] - 10) * 0.7152 + (data[i + 2] - 15) * 0.0722;
    }
    const sample = { frame: this.frame, time: Math.round(performance.now()), meanAboveBg: +(sum / (data.length / 4)).toFixed(3) };
    window.__molequleDev.trailLuminance.push(sample);
    console.debug('[molequle dev] trail luminance', sample);
  }
}

// True if bonds[0..before) already contains a bond to targetId
function alreadyListed(bonds, before, targetId) {
  for (let k = 0; k < before; k++) {
    if (bonds[k].targetId === targetId) return true;
  }
  return false;
}

function hasBondTo(entity, targetId) {
  const bonds = entity.bonds;
  if (!bonds) return false;
  for (let k = 0; k < bonds.length; k++) {
    if (bonds[k].targetId === targetId) return true;
  }
  return false;
}

// Darkened edges; drawn scaled to the canvas each frame
function makeVignette() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(160, 90, 40, 160, 90, 190);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(0.55, 'rgba(0, 0, 0, 0.12)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 320, 180);
  return canvas;
}
