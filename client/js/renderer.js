// renderer.js — Canvas 2D renderer for deep space bioluminescence aesthetic
// Handles main entity rendering, trail persistence, context map overlay, bonds, and effects.

export class Renderer {
  constructor(mainCanvas, trailCanvas) {
    this.mainCanvas = mainCanvas;
    this.trailCanvas = trailCanvas;
    this.ctx = mainCanvas.getContext('2d');
    this.trailCtx = trailCanvas.getContext('2d');
    this.width = 1920;
    this.height = 1080;
    this.bondBreakFlashes = [];

    // Grid dimensions for context map
    this.gridCols = 96;
    this.gridRows = 54;
    this.cellW = this.width / this.gridCols;   // 20
    this.cellH = this.height / this.gridRows;  // 20

    // Initialize trail canvas to dark background
    this.clearTrails();
  }

  /**
   * Main render loop — called each frame.
   * @param {Entity[]} entities
   * @param {ContextMap} contextMap
   * @param {object} config
   * @param {WeatherSystem} [weatherSystem] - Optional weather system for visual layer
   */
  render(entities, contextMap, config, weatherSystem) {
    const ctx = this.ctx;
    const trailCtx = this.trailCtx;
    const W = this.width;
    const H = this.height;

    // Build entity lookup map for bond rendering
    const entityMap = new Map();
    for (let i = 0; i < entities.length; i++) {
      entityMap.set(entities[i].id, entities[i]);
    }

    // --- 1. Clear main canvas (fully transparent so trails show through) ---
    ctx.clearRect(0, 0, W, H);

    // --- 2. Fade trail canvas with configurable decay rate ---
    // Trail decay scales with average system movement speed when enabled:
    // active system = faster fade (readable canvas), calm system = trails persist (history)
    let decayRate = config.trailDecayRate || 0.003;
    if (config.trailDecayScaling && entities.length > 0) {
      let totalSpeed = 0;
      let aliveCount = 0;
      for (let i = 0; i < entities.length; i++) {
        if (!entities[i].alive) continue;
        const e = entities[i];
        totalSpeed += Math.sqrt(e.vx * e.vx + e.vy * e.vy);
        aliveCount++;
      }
      const avgSpeed = aliveCount > 0 ? totalSpeed / aliveCount : 0;
      decayRate = decayRate * (1 + avgSpeed * 0.5);
    }
    trailCtx.fillStyle = `rgba(10, 10, 15, ${decayRate})`;
    trailCtx.fillRect(0, 0, W, H);

    // --- 3. Draw trails ---
    if (config.showTrails) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.alive) continue;
        const color = this.entityColor(e);
        trailCtx.globalAlpha = 0.15;
        trailCtx.fillStyle = color;
        trailCtx.beginPath();
        trailCtx.arc(e.x, e.y, 2, 0, Math.PI * 2);
        trailCtx.fill();
      }
      trailCtx.globalAlpha = 1.0;
    }

    // --- 4. Draw weather layer (before entities, after trails) ---
    if (weatherSystem) {
      this._renderWeather(ctx, weatherSystem, config);
    }

    // --- 5. Draw context map overlay ---
    if (config.showContextMap && contextMap) {
      this._renderContextMap(ctx, contextMap, config);
    }

    // --- 6. Draw bonds ---
    this._renderBonds(ctx, entities, entityMap);

    // --- 7. Draw entities with glow ---
    this._renderEntities(ctx, entities, config);

    // --- 8. Draw bond break flashes ---
    this._renderBondBreakFlashes(ctx);
  }

  /**
   * Render all weather visual layers — seasons, currents, blooms, storms.
   * Drawn before entities so weather feels environmental, not UI.
   */
  _renderWeather(ctx, weatherSystem, config) {
    const W = this.width;
    const H = this.height;

    // --- Seasonal tint ---
    // Extremely subtle global color temperature shift.
    // warmth=1 (summer): faint warm tint. warmth=0 (winter): faint cool tint.
    const warmth = weatherSystem.getWarmth();
    const amplitude = config.seasonAmplitude ?? 0.5;
    if (amplitude > 0) {
      const deviation = (warmth - 0.5) * amplitude;
      // Warm: add tiny red/amber. Cool: add tiny blue.
      const r = Math.max(0, deviation * 10);   // 0-2.5 at peak summer
      const b = Math.max(0, -deviation * 10);   // 0-2.5 at peak winter
      ctx.fillStyle = `rgba(${Math.round(r * 2)}, ${Math.round(r * 0.5)}, ${Math.round(b * 2)}, 0.04)`;
      ctx.fillRect(0, 0, W, H);
    }

    // --- Migration Currents ---
    // Faint directional streaks — wind on water.
    for (const current of weatherSystem.currents) {
      if (current.effectiveStrength <= 0.01) continue;
      this._renderCurrent(ctx, current, W, H, warmth);
    }

    // --- Fertility Blooms ---
    // Soft warm radial gradient — a pool of warmth.
    for (const bloom of weatherSystem.blooms) {
      if (bloom.currentIntensity <= 0.01) continue;
      this._renderBloom(ctx, bloom, W, H);
    }

    // --- Disruption Storms ---
    // Dark pulsing shadow — approaching thunderstorm.
    for (const storm of weatherSystem.storms) {
      if (storm.currentIntensity <= 0.01) continue;
      this._renderStorm(ctx, storm, W, H);
    }
  }

  /**
   * Render a single migration current as faint directional streaks.
   */
  _renderCurrent(ctx, current, W, H, warmth) {
    const alpha = 0.03 + current.effectiveStrength * 0.03; // 0.03-0.06
    const dx = current.direction[0];
    const dy = current.direction[1];

    // Color shifts with season
    const r = Math.round(140 + warmth * 40);
    const g = Math.round(160 + warmth * 20);
    const b = Math.round(180 - warmth * 30);

    ctx.save();
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 1;

    // Draw parallel streaks along the current's width
    const perpX = -dy;
    const perpY = dx;
    const streakCount = 8;
    const halfWidth = current.width / 2;
    const streakLength = 60 + current.effectiveStrength * 40;

    for (let i = 0; i < streakCount; i++) {
      const offset = (i / (streakCount - 1) - 0.5) * 2 * halfWidth;
      const sx = current.origin[0] + perpX * offset;
      const sy = current.origin[1] + perpY * offset;

      ctx.beginPath();
      ctx.moveTo(((sx % W) + W) % W, ((sy % H) + H) % H);
      const ex = sx + dx * streakLength;
      const ey = sy + dy * streakLength;
      ctx.lineTo(((ex % W) + W) % W, ((ey % H) + H) % H);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Render a fertility bloom as a soft warm radial gradient.
   */
  _renderBloom(ctx, bloom, W, H) {
    const cx = bloom.center[0];
    const cy = bloom.center[1];
    const radius = bloom.radius;
    const intensity = bloom.currentIntensity;

    // Warm amber/gold glow, alpha tracks intensity bell curve
    const peakAlpha = 0.08 + intensity * 0.04; // 0.08-0.14 at peak

    ctx.save();
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, `rgba(220, 170, 60, ${peakAlpha})`);
    gradient.addColorStop(0.4, `rgba(200, 140, 40, ${peakAlpha * 0.6})`);
    gradient.addColorStop(0.7, `rgba(180, 120, 30, ${peakAlpha * 0.3})`);
    gradient.addColorStop(1, 'rgba(180, 120, 30, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  /**
   * Render a disruption storm as a dark pulsing shadow.
   */
  _renderStorm(ctx, storm, W, H) {
    const cx = storm.center[0];
    const cy = storm.center[1];
    const radius = storm.radius;
    const intensity = storm.currentIntensity;

    // Desaturated blue-shifted shadow, with slight flicker
    const flicker = 0.95 + Math.random() * 0.1; // subtle pulse
    const peakAlpha = (0.06 + intensity * 0.04) * flicker; // 0.06-0.12

    ctx.save();
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, `rgba(20, 15, 40, ${peakAlpha})`);
    gradient.addColorStop(0.3, `rgba(30, 20, 60, ${peakAlpha * 0.8})`);
    gradient.addColorStop(0.6, `rgba(15, 15, 45, ${peakAlpha * 0.4})`);
    gradient.addColorStop(1, 'rgba(15, 15, 45, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    // Edge flicker — faint ring at storm boundary
    if (intensity > 0.5) {
      const ringAlpha = (intensity - 0.5) * 0.04 * flicker;
      ctx.strokeStyle = `rgba(120, 80, 180, ${ringAlpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.9, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Render context map overlay showing fertile zones, scars, disruption, ghost trails.
   */
  _renderContextMap(ctx, contextMap, config) {
    const cellW = this.cellW;
    const cellH = this.cellH;
    const tick = config.currentTick || 0;

    for (let gy = 0; gy < this.gridRows; gy++) {
      for (let gx = 0; gx < this.gridCols; gx++) {
        const cell = contextMap.getCellByGrid(gx, gy);
        if (!cell) continue;

        const cx = gx * cellW + cellW / 2;
        const cy = gy * cellH + cellH / 2;
        const terrain = contextMap.getTerrainEffects(cx, cy, tick);
        const px = gx * cellW;
        const py = gy * cellH;

        // Fertile cells
        if (terrain.isFertile) {
          ctx.fillStyle = 'rgba(180, 120, 60, 0.15)';
          ctx.fillRect(px, py, cellW, cellH);
        }

        // Scarred cells
        if (terrain.isScarred) {
          const alpha = 0.08 + terrain.scarIntensity * 0.12;
          ctx.fillStyle = `rgba(60, 80, 180, ${alpha})`;
          ctx.fillRect(px, py, cellW, cellH);
        }

        // Disruption zones — flickering brightness
        if (terrain.isDisruptionZone) {
          const flicker = 0.08 + Math.random() * 0.12;
          ctx.fillStyle = `rgba(200, 50, 50, ${flicker})`;
          ctx.fillRect(px, py, cellW, cellH);
        }

        // Ghost trails
        if (terrain.isGhostTrail) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
          ctx.fillRect(px, py, cellW, cellH);
        }
      }
    }
  }

  /**
   * Render bonds between entities as thin lines with toroidal wrapping.
   */
  _renderBonds(ctx, entities, entityMap) {
    const W = this.width;
    const H = this.height;
    const halfW = W / 2;
    const halfH = H / 2;
    const drawnPairs = new Set();

    ctx.lineWidth = 1;

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e.bonds) continue;

      for (let b = 0; b < e.bonds.length; b++) {
        const bond = e.bonds[b];
        const target = entityMap.get(bond.targetId);
        if (!target) continue;

        // Only draw each bond once — use ordered id pair as key
        const lo = e.id < bond.targetId ? e.id : bond.targetId;
        const hi = e.id < bond.targetId ? bond.targetId : e.id;
        const key = lo + ':' + hi;
        if (drawnPairs.has(key)) continue;
        drawnPairs.add(key);

        const alpha = bond.strength * 0.3;
        if (alpha < 0.005) continue;
        ctx.strokeStyle = `rgba(180, 200, 220, ${alpha})`;

        // Calculate direct distance and detect wrapping
        let dx = target.x - e.x;
        let dy = target.y - e.y;

        // Toroidal wrapping: if distance exceeds half canvas, wrap around
        const wrapX = Math.abs(dx) > halfW;
        const wrapY = Math.abs(dy) > halfH;

        if (!wrapX && !wrapY) {
          // Simple direct line
          ctx.beginPath();
          ctx.moveTo(e.x, e.y);
          ctx.lineTo(target.x, target.y);
          ctx.stroke();
        } else {
          // Wrapped bond: draw two line segments, one from each side
          // Adjust dx/dy for shortest toroidal path
          if (wrapX) dx = dx > 0 ? dx - W : dx + W;
          if (wrapY) dy = dy > 0 ? dy - H : dy + H;

          // Segment from entity e going toward the wrapped direction
          const endX = e.x + dx;
          const endY = e.y + dy;

          // Draw from e toward edge
          ctx.beginPath();
          ctx.moveTo(e.x, e.y);
          ctx.lineTo(endX, endY);
          ctx.stroke();

          // Draw from target toward opposite edge
          ctx.beginPath();
          ctx.moveTo(target.x, target.y);
          ctx.lineTo(target.x - dx, target.y - dy);
          ctx.stroke();
        }
      }
    }
  }

  /**
   * Render all entities as glowing circles with additive blending.
   */
  _renderEntities(ctx, entities, config) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const color = this.entityColor(e);

      // Base radius from inertia, modified by bonds and age
      let radius = 3 + e.inertia * 8;

      // Bond count scaling: more bonds = slightly larger (relational weight)
      const sizeBondScale = config.sizeBondScale ?? 0.1;
      const bondSizeBoost = 1 + (e.bonds ? e.bonds.length : 0) * sizeBondScale;

      // Newborn growth: 80% → 100% over sizeGrowthDuration ticks
      const growthDuration = config.sizeGrowthDuration ?? 600;
      const growthFactor = e.age < growthDuration
        ? 0.8 + 0.2 * (e.age / growthDuration)
        : 1.0;

      // Combine and clamp to [0.7x, 1.4x] range
      const sizeModifier = Math.max(0.7, Math.min(1.4, bondSizeBoost * growthFactor));
      radius *= sizeModifier;

      if (!e.alive) {
        // Fading entity — opacity decreases, glow peaks at fadeProgress 0.3
        const opacity = 1 - e.fadeProgress;
        if (opacity <= 0) continue;
        ctx.globalAlpha = opacity;

        // Glow peaks at fadeProgress=0.3 then decays
        const glowPeak = e.fadeProgress < 0.3
          ? 1 + (e.fadeProgress / 0.3) * 2    // ramp up to 3x
          : 3 * (1 - (e.fadeProgress - 0.3) / 0.7); // decay from 3x to 0
        const baseBlur = 8 + e.disruptionCharge * 12;
        ctx.shadowBlur = baseBlur * Math.max(glowPeak, 0);
        ctx.shadowColor = color;
      } else {
        ctx.globalAlpha = 1.0;
        ctx.shadowBlur = 8 + e.disruptionCharge * 12;
        ctx.shadowColor = color;
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(e.x, e.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Render bond break flash effects — bright white lines fading out.
   */
  _renderBondBreakFlashes(ctx) {
    for (let i = this.bondBreakFlashes.length - 1; i >= 0; i--) {
      const flash = this.bondBreakFlashes[i];
      const alpha = 1 - flash.progress;

      if (alpha <= 0) {
        this.bondBreakFlashes.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.lineWidth = 2 * alpha;
      ctx.shadowBlur = 12 * alpha;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';

      ctx.beginPath();
      ctx.moveTo(flash.x1, flash.y1);
      ctx.lineTo(flash.x2, flash.y2);
      ctx.stroke();
      ctx.restore();

      // Advance flash progress
      flash.progress += 0.04;
    }
  }

  /**
   * Compute entity color based on personality traits.
   * Full-spectrum HSL: hue derived from dominant behavioral params.
   *   S-dominant → warm reds/oranges (0-40)
   *   B-dominant → greens/teals (120-180)
   *   I-dominant → cool blues/purples (210-270)
   *   D-dominant → magentas/violets (280-330)
   *   Mixed profiles interpolate between anchors.
   */
  entityColor(entity) {
    const S = entity.sociability;
    const I = entity.inertia;
    const B = entity.bondAffinity;
    const D = entity.disruptionCharge;
    // Weighted angular blend across four hue anchors
    const hueS = 20;   // red-orange
    const hueB = 150;  // green-teal
    const hueI = 240;  // blue-purple
    const hueD = 300;  // magenta-violet
    const total = S + I + B + D + 0.001; // avoid div-by-zero
    // Convert to cartesian for proper angular averaging
    const rad = Math.PI / 180;
    const cx = (S * Math.cos(hueS * rad) + I * Math.cos(hueI * rad) +
                B * Math.cos(hueB * rad) + D * Math.cos(hueD * rad)) / total;
    const cy = (S * Math.sin(hueS * rad) + I * Math.sin(hueI * rad) +
                B * Math.sin(hueB * rad) + D * Math.sin(hueD * rad)) / total;
    let hue = Math.atan2(cy, cx) / rad;
    if (hue < 0) hue += 360;

    // Apply accumulated hue drift — life history shifts color
    hue = (hue + (entity.hueOffset || 0)) % 360;

    const sat = 30 + entity.volatility * 60;   // 30-90%
    const light = 35 + entity.disruptionCharge * 35; // 35-70%
    return `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`;
  }

  /**
   * Full reset of the trail canvas to base dark color.
   */
  clearTrails() {
    this.trailCtx.fillStyle = '#0a0a0f';
    this.trailCtx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * Register a bond break flash effect between two points.
   * Called externally when a bond breaks.
   */
  addBondBreakFlash(x1, y1, x2, y2) {
    this.bondBreakFlashes.push({ x1, y1, x2, y2, progress: 0 });
  }
}
