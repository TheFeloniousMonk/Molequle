// weather-fx.js — Weather visuals (visual only).
//
// Weather reads as light acting on entities rather than shadow on the sky:
// storms dim and desaturate what's inside them, with a cold rim and the
// occasional lightning flash; blooms are a warm upwelling glow; currents are
// drifting streaks; seasons shift a global tint and vignette. Each element
// adds its own storm flavor (frost sparkles, embers, static sparks).
//
// Reads weather state only — never mutates it or touches the simulation RNG.
// All randomness here comes from a separate visual-only PRNG.

import { mulberry32 } from './prng.js';

const TAU = Math.PI * 2;
const MAX_STORMS = 8;
const MAX_BLOOMS = 8;
const MAX_PARTICLES = 480;
const MOTES_PER_CURRENT = 48;
const MAX_FLASHES = 4;
const BOLT_POINTS = 11;
const ALPHA_BUCKETS = 4;

// Particle kinds
const FROST = 1;
const EMBER = 2;
const SPARK = 3;
const SPAWN_RATE = { frost: 1.4, embers: 0.9, sparks: 0.7 };   // per storm per frame at full intensity
const KIND_OF = { frost: FROST, embers: EMBER, sparks: SPARK };

const FROST_STYLE = 'rgb(215, 245, 255)';
const EMBER_STYLE = 'rgb(255, 140, 45)';
const SPARK_STYLE = 'rgb(225, 235, 255)';
const MOTE_STYLE = 'rgb(175, 195, 220)';
const BOLT_STYLE = 'rgb(255, 255, 255)';
const WARM_TINT = 'rgb(255, 140, 50)';
const COOL_TINT = 'rgb(70, 120, 255)';

export class WeatherFx {
  constructor() {
    this.rand = mulberry32((Math.random() * 4294967296) >>> 0);

    // Active storms/blooms for this frame (for per-entity lookups)
    this.stormCount = 0;
    this.storms = new Float32Array(MAX_STORMS * 4);   // x, y, radius, intensity (0..1)
    this.bloomCount = 0;
    this.blooms = new Float32Array(MAX_BLOOMS * 4);
    this.W = 1920;
    this.H = 1080;

    // Particle pool (struct of arrays); life <= 0 means free
    this.pX = new Float32Array(MAX_PARTICLES);
    this.pY = new Float32Array(MAX_PARTICLES);
    this.pA = new Float32Array(MAX_PARTICLES);   // ember: vx | spark: angle
    this.pB = new Float32Array(MAX_PARTICLES);   // ember: vy | spark: length
    this.pLife = new Float32Array(MAX_PARTICLES);
    this.pMax = new Float32Array(MAX_PARTICLES);
    this.pKind = new Uint8Array(MAX_PARTICLES);
    this.pNext = 0;

    // Current motes: id -> Float32Array [s0, o0, s1, o1, ...]
    this.motes = new Map();
    this.moteSeen = new Map();
    this.frame = 0;

    // Lightning flashes
    this.fLife = new Float32Array(MAX_FLASHES);
    this.fX = new Float32Array(MAX_FLASHES);
    this.fY = new Float32Array(MAX_FLASHES);
    this.fR = new Float32Array(MAX_FLASHES);
    this.fBolt = new Float32Array(MAX_FLASHES * BOLT_POINTS * 2);
  }

  /** Cache this frame's storms and blooms (intensity normalized to 0..1). */
  prepare(weatherSystem, W, H) {
    this.W = W;
    this.H = H;
    this.frame++;
    let n = 0;
    for (const s of weatherSystem.storms) {
      if (n >= MAX_STORMS || s.currentIntensity <= 0.01) continue;
      const o = n * 4;
      this.storms[o] = s.center[0];
      this.storms[o + 1] = s.center[1];
      this.storms[o + 2] = s.radius;
      this.storms[o + 3] = Math.min(1, s.currentIntensity / (s.baseIntensity || 1.5));
      n++;
    }
    this.stormCount = n;
    n = 0;
    for (const b of weatherSystem.blooms) {
      if (n >= MAX_BLOOMS || b.currentIntensity <= 0.01) continue;
      const o = n * 4;
      this.blooms[o] = b.center[0];
      this.blooms[o + 1] = b.center[1];
      this.blooms[o + 2] = b.radius;
      this.blooms[o + 3] = Math.min(1, b.currentIntensity / (b.baseIntensity || 1.5));
      n++;
    }
    this.bloomCount = n;
  }

  /** Storm influence at a point, 0..1 */
  stormAt(x, y) {
    return influence(this.storms, this.stormCount, x, y, this.W, this.H);
  }

  /** Bloom influence at a point, 0..1 */
  bloomAt(x, y) {
    return influence(this.blooms, this.bloomCount, x, y, this.W, this.H);
  }

  /** Drawn before entities: season tint, bloom glow, storm cloud, current streaks. */
  drawUnderlay(ctx, atlas, element, weatherSystem, config) {
    const W = this.W;
    const H = this.H;

    // Season: faint additive warm/cool tint
    const amplitude = config.seasonAmplitude ?? 0.5;
    const deviation = (weatherSystem.getWarmth() - 0.5) * amplitude;   // [-0.5, 0.5] * amplitude
    if (Math.abs(deviation) > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.abs(deviation) * 0.12;
      ctx.fillStyle = deviation > 0 ? WARM_TINT : COOL_TINT;
      ctx.fillRect(0, 0, W, H);
    }

    // Blooms: soft warm upwelling, element-tinted
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.bloomCount; i++) {
      const o = i * 4;
      const r = this.blooms[o + 2] * 1.25;
      ctx.globalAlpha = 0.22 * this.blooms[o + 3];
      ctx.drawImage(atlas.bloom, this.blooms[o] - r, this.blooms[o + 1] - r, r * 2, r * 2);
    }

    // Bioluminescent storms: a visible dark cloud
    if (element.stormFx === 'cloud') {
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < this.stormCount; i++) {
        const o = i * 4;
        const r = this.storms[o + 2] * 1.1;
        ctx.globalAlpha = 0.5 * this.storms[o + 3];
        ctx.drawImage(atlas.shade, this.storms[o] - r, this.storms[o + 1] - r, r * 2, r * 2);
      }
    }

    // Currents: drifting streaks along each current's band
    this._drawCurrents(ctx, weatherSystem);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Drawn after entities: storm rims, lightning, element particles. */
  drawOverlay(ctx, atlas, element) {
    const rand = this.rand;
    ctx.globalCompositeOperation = 'lighter';

    // Storm rims, and new lightning / particles
    const kind = KIND_OF[element.stormFx] || 0;
    for (let i = 0; i < this.stormCount; i++) {
      const o = i * 4;
      const x = this.storms[o];
      const y = this.storms[o + 1];
      const r = this.storms[o + 2];
      const k = this.storms[o + 3];
      ctx.globalAlpha = k;
      ctx.lineWidth = 7;
      ctx.strokeStyle = atlas.rimStyleFaint;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = atlas.rimStyle;
      ctx.stroke();

      if (rand() < 0.006 * k) this._strike(x, y, r);
      if (kind) {
        let n = SPAWN_RATE[element.stormFx] * k;
        while (n > 0) {
          if (rand() < n) this._spawn(kind, x, y, r);
          n -= 1;
        }
      }
    }

    this._drawFlashes(ctx, atlas, element);
    this._updateAndDrawParticles(ctx);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawCurrents(ctx, weatherSystem) {
    const W = this.W;
    const H = this.H;
    const span = Math.hypot(W, H);
    const rand = this.rand;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = MOTE_STYLE;
    ctx.lineWidth = 1;
    for (const c of weatherSystem.currents) {
      let motes = this.motes.get(c.id);
      if (!motes) {
        motes = new Float32Array(MOTES_PER_CURRENT * 2);
        for (let m = 0; m < MOTES_PER_CURRENT; m++) {
          motes[m * 2] = (rand() - 0.5) * span;
          motes[m * 2 + 1] = bandOffset(rand);
        }
        this.motes.set(c.id, motes);
      }
      this.moteSeen.set(c.id, this.frame);
      const strength = c.effectiveStrength;
      if (strength <= 0.01) continue;
      const dx = c.direction[0];
      const dy = c.direction[1];
      const speed = 0.6 + strength * 2.5;
      const len = 6 + strength * 20;
      ctx.globalAlpha = Math.min(0.25, 0.03 + strength * 0.25);
      ctx.beginPath();
      for (let m = 0; m < MOTES_PER_CURRENT; m++) {
        let s = motes[m * 2] + speed;
        if (s > span / 2) {
          s -= span;
          motes[m * 2 + 1] = bandOffset(rand);
        }
        motes[m * 2] = s;
        const off = motes[m * 2 + 1] * c.width;
        let x = c.origin[0] + dx * s - dy * off;
        let y = c.origin[1] + dy * s + dx * off;
        x = ((x % W) + W) % W;
        y = ((y % H) + H) % H;
        ctx.moveTo(x, y);
        ctx.lineTo(x - dx * len, y - dy * len);
      }
      ctx.stroke();
    }
    // Forget motes of currents that have ended
    if (this.motes.size > weatherSystem.currents.length) {
      for (const [id, seen] of this.moteSeen) {
        if (seen !== this.frame) {
          this.motes.delete(id);
          this.moteSeen.delete(id);
        }
      }
    }
  }

  _strike(x, y, r) {
    const rand = this.rand;
    let slot = -1;
    for (let i = 0; i < MAX_FLASHES; i++) {
      if (this.fLife[i] <= 0) { slot = i; break; }
    }
    if (slot < 0) return;
    // Bolt from a point on the storm's edge to a point near its center
    const a0 = rand() * TAU;
    const sx = x + Math.cos(a0) * r * 0.85;
    const sy = y + Math.sin(a0) * r * 0.85;
    const a1 = rand() * TAU;
    const d1 = rand() * r * 0.35;
    const ex = x + Math.cos(a1) * d1;
    const ey = y + Math.sin(a1) * d1;
    const nx = -(ey - sy);
    const ny = ex - sx;
    const nl = Math.hypot(nx, ny) || 1;
    const base = slot * BOLT_POINTS * 2;
    for (let p = 0; p < BOLT_POINTS; p++) {
      const t = p / (BOLT_POINTS - 1);
      const jitter = p === 0 || p === BOLT_POINTS - 1 ? 0 : (rand() - 0.5) * r * 0.18;
      this.fBolt[base + p * 2] = sx + (ex - sx) * t + (nx / nl) * jitter;
      this.fBolt[base + p * 2 + 1] = sy + (ey - sy) * t + (ny / nl) * jitter;
    }
    this.fX[slot] = ex;
    this.fY[slot] = ey;
    this.fR[slot] = r;
    this.fLife[slot] = 7;
  }

  _drawFlashes(ctx, atlas, element) {
    for (let i = 0; i < MAX_FLASHES; i++) {
      const life = this.fLife[i];
      if (life <= 0) continue;
      const a = life / 7;
      // Brief brightening of the storm interior
      const fr = this.fR[i] * 0.9;
      ctx.globalAlpha = 0.22 * a;
      ctx.drawImage(atlas.soft, this.fX[i] - fr, this.fY[i] - fr, fr * 2, fr * 2);
      // The bolt: wide tinted glow, thin white core
      const base = i * BOLT_POINTS * 2;
      ctx.beginPath();
      ctx.moveTo(this.fBolt[base], this.fBolt[base + 1]);
      for (let p = 1; p < BOLT_POINTS; p++) ctx.lineTo(this.fBolt[base + p * 2], this.fBolt[base + p * 2 + 1]);
      ctx.globalAlpha = 0.45 * a;
      ctx.lineWidth = 4;
      ctx.strokeStyle = atlas.rimStyleOpaque;
      ctx.stroke();
      ctx.globalAlpha = 0.9 * a;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = BOLT_STYLE;
      ctx.stroke();
      this.fLife[i] = life - 1;
    }
  }

  _spawn(kind, x, y, r) {
    const rand = this.rand;
    // Find a free slot, starting after the last one used
    let i = this.pNext;
    for (let tries = 0; tries < MAX_PARTICLES; tries++) {
      if (this.pLife[i] <= 0) break;
      i = (i + 1) % MAX_PARTICLES;
    }
    if (this.pLife[i] > 0) return;
    this.pNext = (i + 1) % MAX_PARTICLES;
    const a = rand() * TAU;
    const d = Math.sqrt(rand()) * r;
    this.pX[i] = x + Math.cos(a) * d;
    this.pY[i] = y + Math.sin(a) * d;
    this.pKind[i] = kind;
    let life;
    if (kind === FROST) {
      life = 40 + rand() * 40;
    } else if (kind === EMBER) {
      life = 70 + rand() * 70;
      this.pA[i] = (rand() - 0.5) * 0.4;     // vx
      this.pB[i] = -(0.3 + rand() * 0.6);    // vy: rises
    } else {
      life = 3 + rand() * 4;
      this.pA[i] = rand() * TAU;             // angle
      this.pB[i] = 3 + rand() * 6;           // length
    }
    this.pLife[i] = life;
    this.pMax[i] = life;
  }

  _updateAndDrawParticles(ctx) {
    // Advance
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      if (this.pKind[i] === EMBER) {
        this.pX[i] += this.pA[i] + Math.sin((this.frame + i) * 0.07) * 0.15;
        this.pY[i] += this.pB[i];
      }
      this.pLife[i] -= 1;
    }
    // Draw, batched by kind and quantized alpha
    for (let kind = FROST; kind <= SPARK; kind++) {
      for (let b = 0; b < ALPHA_BUCKETS; b++) {
        let any = false;
        for (let i = 0; i < MAX_PARTICLES; i++) {
          if (this.pLife[i] <= 0 || this.pKind[i] !== kind) continue;
          const t = this.pLife[i] / this.pMax[i];                // 1 -> 0 over life
          const a = kind === FROST ? Math.sin(Math.PI * t) : t;  // frost twinkles in and out
          if (Math.min(ALPHA_BUCKETS - 1, Math.floor(a * ALPHA_BUCKETS)) !== b) continue;
          if (!any) {
            ctx.beginPath();
            any = true;
          }
          const x = this.pX[i];
          const y = this.pY[i];
          if (kind === FROST) {
            ctx.moveTo(x - 2.5, y); ctx.lineTo(x + 2.5, y);
            ctx.moveTo(x, y - 2.5); ctx.lineTo(x, y + 2.5);
          } else if (kind === EMBER) {
            ctx.moveTo(x + 1.3, y);
            ctx.arc(x, y, 1.3, 0, TAU);
          } else {
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(this.pA[i]) * this.pB[i], y + Math.sin(this.pA[i]) * this.pB[i]);
          }
        }
        if (!any) continue;
        ctx.globalAlpha = (b + 0.5) / ALPHA_BUCKETS;
        if (kind === EMBER) {
          ctx.fillStyle = EMBER_STYLE;
          ctx.fill();
        } else {
          ctx.lineWidth = kind === FROST ? 1 : 1.2;
          ctx.strokeStyle = kind === FROST ? FROST_STYLE : SPARK_STYLE;
          ctx.stroke();
        }
      }
    }
  }
}

function influence(arr, count, x, y, W, H) {
  let f = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    let dx = x - arr[o];
    let dy = y - arr[o + 1];
    if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
    if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
    const r = arr[o + 2];
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) f += (1 - Math.sqrt(d2) / r) * arr[o + 3];
  }
  return f > 1 ? 1 : f;
}

// Offset across a current's band (fraction of its width), biased toward the center line
function bandOffset(rand) {
  const u = rand() * 2 - 1;
  return u * Math.abs(u) * 0.9;
}
