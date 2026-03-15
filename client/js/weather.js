// weather.js — Environmental weather systems for Molequle
// Exogenous energy that prevents thermodynamic heat death.
// Weather happens TO entities, not because of them.

import { seededUUID } from './prng.js';

/**
 * WeatherSystem manages all environmental phenomena:
 * - Thermal cycles (seasons): global sine-wave affecting drift rates
 * - Migration currents: slow directional force fields
 * - Fertility blooms: temporary bonding/reproduction hotspots
 * - Disruption storms: temporary regions of elevated disruption
 */
export class WeatherSystem {
  constructor(rng) {
    this.rng = rng;
    this.seasonPhase = 0;
    this.currents = [];
    this.blooms = [];
    this.storms = [];
  }

  // ── Main update — call once per tick ────────────────────────────────

  update(config, tick, contextMap, eventLog) {
    this._updateSeason(config, tick, eventLog);
    this._updateCurrents(config, tick, eventLog);
    this._updateBlooms(config, tick, contextMap, eventLog);
    this._updateStorms(config, tick, contextMap, eventLog);
  }

  // ── Seasons ─────────────────────────────────────────────────────────

  _updateSeason(config, tick, eventLog) {
    const seasonLength = config.seasonLength || 12000;
    const prevPhase = this.seasonPhase;

    this.seasonPhase += (2 * Math.PI) / seasonLength;
    if (this.seasonPhase >= 2 * Math.PI) {
      this.seasonPhase -= 2 * Math.PI;
    }

    // Log season quarter changes
    const prevQuarter = this._seasonQuarter(prevPhase);
    const currentQuarter = this._seasonQuarter(this.seasonPhase);
    if (prevQuarter !== currentQuarter) {
      eventLog.push({
        type: 'season_change',
        tick,
        data: { season: currentQuarter, warmth: this.getWarmth() }
      });
    }
  }

  _seasonQuarter(phase) {
    const normalized = ((phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const fraction = normalized / (2 * Math.PI);
    if (fraction < 0.25) return 'spring';
    if (fraction < 0.5) return 'summer';
    if (fraction < 0.75) return 'autumn';
    return 'winter';
  }

  getSeasonName() {
    const fraction = ((this.seasonPhase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
    if (fraction < 0.125) return 'early_spring';
    if (fraction < 0.25) return 'late_spring';
    if (fraction < 0.375) return 'early_summer';
    if (fraction < 0.5) return 'late_summer';
    if (fraction < 0.625) return 'early_autumn';
    if (fraction < 0.75) return 'late_autumn';
    if (fraction < 0.875) return 'early_winter';
    return 'late_winter';
  }

  /** Warmth: 0 = deep winter, 1 = peak summer */
  getWarmth() {
    return 0.5 + 0.5 * Math.sin(this.seasonPhase);
  }

  /**
   * Get seasonal modifiers applied to the simulation.
   * amplitude controls how strong the effects are (0 = none, 1 = extreme).
   */
  getSeasonalModifiers(config) {
    const amplitude = config.seasonAmplitude ?? 0.5;
    const warmth = this.getWarmth();
    const deviation = (warmth - 0.5) * amplitude; // [-0.5*amp, +0.5*amp]

    return {
      warmth,
      speedMultiplier: 1.0 + deviation,                        // faster in summer
      bondFormationModifier: 1.0 + 0.8 * deviation,            // bonds easier in summer
      disruptionThresholdOffset: -0.05 * deviation,             // lower threshold in summer
      spawnModifier: 1.0 + 0.6 * deviation,                    // easier reproduction in summer
      inertiaDrift: -0.0001 * deviation,                        // summer: I nudged down, winter: I nudged up
    };
  }

  // ── Migration Currents ──────────────────────────────────────────────

  _updateCurrents(config, tick, eventLog) {
    const maxCurrents = config.currentCount ?? 2;
    const spawnRate = config.currentSpawnRate ?? 0.0005;
    const W = config.canvasWidth || 1920;
    const H = config.canvasHeight || 1080;

    // Update existing currents
    for (let i = this.currents.length - 1; i >= 0; i--) {
      const c = this.currents[i];
      c.ticksRemaining--;
      c.age++;

      // Drift origin slowly
      c.origin[0] = ((c.origin[0] + c.direction[0] * 0.5) % W + W) % W;
      c.origin[1] = ((c.origin[1] + c.direction[1] * 0.5) % H + H) % H;

      // Fade in/out: ramp up first 500 ticks, ramp down last 500 ticks
      const fadeIn = Math.min(1, c.age / 500);
      const fadeOut = Math.min(1, c.ticksRemaining / 500);
      c.effectiveStrength = c.baseStrength * fadeIn * fadeOut;

      if (c.ticksRemaining <= 0) {
        eventLog.push({
          type: 'current_fade',
          tick,
          data: { currentId: c.id, lifetime: c.age }
        });
        this.currents.splice(i, 1);
      }
    }

    // Spawn new currents
    if (this.currents.length < maxCurrents && this.rng() < spawnRate) {
      this._spawnCurrent(config, tick, eventLog);
    }

    // Ensure at least 1 current exists after tick 500
    if (this.currents.length === 0 && tick > 500) {
      this._spawnCurrent(config, tick, eventLog);
    }
  }

  _spawnCurrent(config, tick, eventLog) {
    const W = config.canvasWidth || 1920;
    const H = config.canvasHeight || 1080;
    const lifetime = config.currentLifetime ?? 5000;
    const rng = this.rng;

    // Spawn from a random edge
    const edge = Math.floor(rng() * 4);
    let ox, oy;
    if (edge === 0) { ox = 0; oy = rng() * H; }           // left
    else if (edge === 1) { ox = W; oy = rng() * H; }       // right
    else if (edge === 2) { ox = rng() * W; oy = 0; }       // top
    else { ox = rng() * W; oy = H; }                        // bottom

    // Direction: roughly inward with some randomness
    const angle = rng() * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    const current = {
      id: seededUUID(rng),
      origin: [ox, oy],
      direction: [dx, dy],
      width: config.currentWidth ?? 200,
      baseStrength: config.currentStrength ?? 0.3,
      effectiveStrength: 0,
      ticksRemaining: lifetime + Math.floor((rng() - 0.5) * lifetime * 0.6),
      age: 0,
    };

    this.currents.push(current);
    eventLog.push({
      type: 'current_spawn',
      tick,
      data: { currentId: current.id, origin: current.origin, direction: current.direction }
    });
  }

  /**
   * Get the combined current force at a point.
   * Returns { fx, fy } — additive force vector.
   */
  getCurrentForceAt(x, y, config) {
    let fx = 0, fy = 0;
    const W = config.canvasWidth || 1920;
    const H = config.canvasHeight || 1080;

    for (const c of this.currents) {
      if (c.effectiveStrength <= 0) continue;

      // Distance from the current's line (origin + t*direction)
      // Use perpendicular distance to the infinite line through origin in direction
      const relX = x - c.origin[0];
      const relY = y - c.origin[1];

      // Wrap for toroidal distance
      const wrX = relX > W / 2 ? relX - W : relX < -W / 2 ? relX + W : relX;
      const wrY = relY > H / 2 ? relY - H : relY < -H / 2 ? relY + H : relY;

      // Perpendicular distance to the current's line
      const perpDist = Math.abs(wrX * (-c.direction[1]) + wrY * c.direction[0]);

      if (perpDist < c.width) {
        // Strength falls off linearly with distance from center line
        const falloff = 1 - perpDist / c.width;
        const strength = c.effectiveStrength * falloff;
        fx += c.direction[0] * strength;
        fy += c.direction[1] * strength;
      }
    }

    return { fx, fy };
  }

  // ── Fertility Blooms ────────────────────────────────────────────────

  _updateBlooms(config, tick, contextMap, eventLog) {
    const maxBlooms = config.bloomMax ?? 3;
    const spawnRate = config.bloomSpawnRate ?? 0.0002;

    for (let i = this.blooms.length - 1; i >= 0; i--) {
      const b = this.blooms[i];
      b.ticksRemaining--;
      b.age++;

      // Bell curve intensity over lifetime
      const progress = b.age / b.totalLifetime;
      b.currentIntensity = b.baseIntensity * Math.sin(progress * Math.PI);

      // Track phase for API
      if (progress < 0.3) b.phase = 'building';
      else if (progress < 0.7) b.phase = 'peak';
      else b.phase = 'fading';

      // Log peak
      if (progress >= 0.5 && !b.peakLogged) {
        b.peakLogged = true;
        eventLog.push({
          type: 'bloom_peak',
          tick,
          data: { bloomId: b.id, center: b.center, radius: b.radius, intensity: b.currentIntensity }
        });
      }

      // Enrich context map while active
      if (b.currentIntensity > 0.1 && tick % 20 === 0) {
        contextMap.recordBondFormation(b.center[0], b.center[1], tick);
      }

      if (b.ticksRemaining <= 0) {
        eventLog.push({
          type: 'bloom_fade',
          tick,
          data: { bloomId: b.id, lifetime: b.age }
        });
        this.blooms.splice(i, 1);
      }
    }

    // Spawn new blooms
    if (this.blooms.length < maxBlooms && this.rng() < spawnRate) {
      this._spawnBloom(config, tick, eventLog);
    }
  }

  _spawnBloom(config, tick, eventLog) {
    const W = config.canvasWidth || 1920;
    const H = config.canvasHeight || 1080;
    const rng = this.rng;

    const radiusMin = config.bloomRadiusMin ?? 100;
    const radiusMax = config.bloomRadiusMax ?? 250;
    const lifetimeMin = config.bloomLifetimeMin ?? 2000;
    const lifetimeMax = config.bloomLifetimeMax ?? 5000;

    const totalLifetime = lifetimeMin + Math.floor(rng() * (lifetimeMax - lifetimeMin));

    const bloom = {
      id: seededUUID(rng),
      center: [rng() * W, rng() * H],
      radius: radiusMin + rng() * (radiusMax - radiusMin),
      baseIntensity: config.bloomIntensity ?? 1.5,
      currentIntensity: 0,
      totalLifetime,
      ticksRemaining: totalLifetime,
      age: 0,
      phase: 'building',
      peakLogged: false,
    };

    this.blooms.push(bloom);
    eventLog.push({
      type: 'bloom_spawn',
      tick,
      data: { bloomId: bloom.id, center: bloom.center, radius: bloom.radius }
    });
  }

  /**
   * Get bloom effects at a point.
   * Returns { bondModifier, spawnModifier, sociabilityNudge, inBloom }
   */
  getBloomEffectsAt(x, y, config) {
    let bondModifier = 1.0;
    let spawnModifier = 1.0;
    let sociabilityNudge = 0;
    let inBloom = false;
    let totalIntensity = 0;

    const W = config.canvasWidth || 1920;
    const H = config.canvasHeight || 1080;

    for (const b of this.blooms) {
      if (b.currentIntensity <= 0) continue;

      const dx = x - b.center[0];
      const dy = y - b.center[1];
      const wrX = dx > W / 2 ? dx - W : dx < -W / 2 ? dx + W : dx;
      const wrY = dy > H / 2 ? dy - H : dy < -H / 2 ? dy + H : dy;
      const dist = Math.sqrt(wrX * wrX + wrY * wrY);

      if (dist < b.radius) {
        const falloff = 1 - dist / b.radius;
        const localIntensity = b.currentIntensity * falloff;
        totalIntensity += localIntensity;
        inBloom = true;
      }
    }

    if (inBloom) {
      bondModifier = 1.0 + totalIntensity * 0.5;      // up to ~1.75x at peak center
      spawnModifier = 1.0 + totalIntensity * 0.3;      // easier reproduction
      sociabilityNudge = 0.0002 * totalIntensity;       // gentle S pull upward
    }

    return { bondModifier, spawnModifier, sociabilityNudge, inBloom, intensity: totalIntensity };
  }

  // ── Disruption Storms ───────────────────────────────────────────────

  _updateStorms(config, tick, contextMap, eventLog) {
    const maxStorms = config.stormMax ?? 2;
    const spawnRate = config.stormSpawnRate ?? 0.00008;

    for (let i = this.storms.length - 1; i >= 0; i--) {
      const s = this.storms[i];
      s.ticksRemaining--;
      s.age++;

      // Bell curve intensity, but sharper rise than blooms
      const progress = s.age / s.totalLifetime;
      // Storms build faster and linger — sin(x^0.7 * pi) peaks earlier
      s.currentIntensity = s.baseIntensity * Math.sin(Math.pow(progress, 0.7) * Math.PI);

      if (progress < 0.25) s.phase = 'building';
      else if (progress < 0.65) s.phase = 'peak';
      else s.phase = 'fading';

      // Log peak
      if (progress >= 0.4 && !s.peakLogged) {
        s.peakLogged = true;
        eventLog.push({
          type: 'storm_peak',
          tick,
          data: { stormId: s.id, center: s.center, radius: s.radius, intensity: s.currentIntensity }
        });
      }

      // Record a single disruption event when storm reaches peak
      if (s.phase === 'peak' && !s.disruptionRecorded) {
        s.disruptionRecorded = true;
        contextMap.recordDisruption(s.center[0], s.center[1], tick);
      }

      if (s.ticksRemaining <= 0) {
        eventLog.push({
          type: 'storm_fade',
          tick,
          data: { stormId: s.id, lifetime: s.age }
        });
        this.storms.splice(i, 1);
      }
    }

    // Spawn new storms (much rarer than blooms)
    if (this.storms.length < maxStorms && this.rng() < spawnRate) {
      this._spawnStorm(config, tick, eventLog);
    }
  }

  _spawnStorm(config, tick, eventLog) {
    const W = config.canvasWidth || 1920;
    const H = config.canvasHeight || 1080;
    const rng = this.rng;

    const radiusMin = config.stormRadiusMin ?? 80;
    const radiusMax = config.stormRadiusMax ?? 200;
    const lifetimeMin = config.stormLifetimeMin ?? 1000;
    const lifetimeMax = config.stormLifetimeMax ?? 3000;

    const totalLifetime = lifetimeMin + Math.floor(rng() * (lifetimeMax - lifetimeMin));

    const storm = {
      id: seededUUID(rng),
      center: [rng() * W, rng() * H],
      radius: radiusMin + rng() * (radiusMax - radiusMin),
      baseIntensity: config.stormIntensity ?? 1.5,
      currentIntensity: 0,
      totalLifetime,
      ticksRemaining: totalLifetime,
      age: 0,
      phase: 'building',
      peakLogged: false,
    };

    this.storms.push(storm);
    eventLog.push({
      type: 'storm_spawn',
      tick,
      data: { stormId: storm.id, center: storm.center, radius: storm.radius }
    });
  }

  /**
   * Get storm effects at a point.
   * Returns { dBoost, vBoost, bondWeakening, scatterForce: {fx,fy}, inStorm }
   */
  getStormEffectsAt(x, y, config) {
    let dBoost = 0;
    let vBoost = 0;
    let bondWeakening = 0;
    let scatterFx = 0, scatterFy = 0;
    let inStorm = false;

    const W = config.canvasWidth || 1920;
    const H = config.canvasHeight || 1080;

    for (const s of this.storms) {
      if (s.currentIntensity <= 0) continue;

      const dx = x - s.center[0];
      const dy = y - s.center[1];
      const wrX = dx > W / 2 ? dx - W : dx < -W / 2 ? dx + W : dx;
      const wrY = dy > H / 2 ? dy - H : dy < -H / 2 ? dy + H : dy;
      const dist = Math.sqrt(wrX * wrX + wrY * wrY);

      if (dist < s.radius) {
        const falloff = 1 - dist / s.radius;
        const localIntensity = s.currentIntensity * falloff;
        inStorm = true;

        dBoost += 0.002 * localIntensity;          // push D up
        vBoost += 0.001 * localIntensity;           // chaos is contagious
        bondWeakening += 0.002 * localIntensity;    // bonds tested

        // Scatter: push outward from storm center
        if (dist > 1) {
          const scatterMag = 0.5 * localIntensity;
          scatterFx += (wrX / dist) * scatterMag;
          scatterFy += (wrY / dist) * scatterMag;
        }
      }
    }

    return { dBoost, vBoost, bondWeakening, scatterForce: { fx: scatterFx, fy: scatterFy }, inStorm };
  }

  // ── Combined effects query ──────────────────────────────────────────

  /**
   * Get all weather effects at a point in one call.
   * Used by entity.update() to apply weather.
   */
  getEffectsAt(x, y, config) {
    return {
      season: this.getSeasonalModifiers(config),
      current: this.getCurrentForceAt(x, y, config),
      bloom: this.getBloomEffectsAt(x, y, config),
      storm: this.getStormEffectsAt(x, y, config),
    };
  }

  // ── Serialization ───────────────────────────────────────────────────

  serialize() {
    return {
      seasonPhase: this.seasonPhase,
      currents: this.currents.map(c => ({ ...c, origin: [...c.origin], direction: [...c.direction] })),
      blooms: this.blooms.map(b => ({ ...b, center: [...b.center] })),
      storms: this.storms.map(s => ({ ...s, center: [...s.center] })),
    };
  }

  restore(data) {
    if (!data) return;
    this.seasonPhase = data.seasonPhase || 0;
    this.currents = (data.currents || []).map(c => ({ ...c, origin: [...c.origin], direction: [...c.direction] }));
    this.blooms = (data.blooms || []).map(b => ({ ...b, center: [...b.center] }));
    this.storms = (data.storms || []).map(s => ({ ...s, center: [...s.center] }));
  }

  // ── API state snapshot ──────────────────────────────────────────────

  getStateForAPI() {
    return {
      season: {
        phase: this.seasonPhase / (2 * Math.PI), // normalize to 0-1
        warmth: this.getWarmth(),
        name: this.getSeasonName(),
      },
      currents: this.currents.map(c => ({
        id: c.id,
        origin: c.origin,
        direction: c.direction,
        width: c.width,
        strength: c.effectiveStrength,
        ticksRemaining: c.ticksRemaining,
      })),
      blooms: this.blooms.map(b => ({
        id: b.id,
        center: b.center,
        radius: b.radius,
        intensity: b.currentIntensity,
        ticksRemaining: b.ticksRemaining,
        phase: b.phase,
      })),
      storms: this.storms.map(s => ({
        id: s.id,
        center: s.center,
        radius: s.radius,
        intensity: s.currentIntensity,
        ticksRemaining: s.ticksRemaining,
        phase: s.phase,
      })),
    };
  }
}
