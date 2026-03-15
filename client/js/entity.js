// Entity — an autonomous agent in the emergent simulation
// Entities move, form/break bonds, drift parameters, disrupt, and die
// All randomness via seeded PRNG for determinism

import { gaussianRandom, seededUUID } from './prng.js';

export class Entity {
  /**
   * @param {string} id
   * @param {number} x
   * @param {number} y
   * @param {object} params - { sociability, inertia, volatility, bondAffinity, disruptionCharge }
   * @param {function} rng - Seeded random number generator
   */
  constructor(id, x, y, params, rng) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;

    // Core parameters (all [0, 1])
    this.sociability = params.sociability;
    this.inertia = params.inertia;
    this.volatility = params.volatility;
    this.bondAffinity = params.bondAffinity;
    this.disruptionCharge = params.disruptionCharge;

    // Bonds: { targetId, strength, formedAt }
    this.bonds = [];

    this.age = 0;
    this.parameterHistory = [];
    this.alive = true;
    this.fadeProgress = 0;

    // Per-entity disruption regen rate noise (±20%), assigned at spawn
    // so entities desynchronize over time instead of crossing threshold together
    this.disruptionRegenNoise = rng ? 0.8 + rng() * 0.4 : 0.8 + Math.random() * 0.4; // [0.8, 1.2]

    // Birth parameters — homeostasis anchor (personality)
    this.birthParams = {
      sociability: params.sociability,
      inertia: params.inertia,
      volatility: params.volatility,
      bondAffinity: params.bondAffinity,
      disruptionCharge: params.disruptionCharge
    };

    // Visual individuality — accumulated hue offset from life experiences
    this.hueOffset = 0;                 // wraps [0, 360), applied to rendered color

    // Internal tracking
    this.isolationTicks = 0;            // spatial isolation — used for death check
    this.relationalLoneliness = 0;      // connection quality — drives S recovery
    this.lowSociabilityTicks = 0;       // cabin fever tracker: ticks with S < 0.2
    this.recentBondBreakTick = -1000;
    this.proximityTicks = {}; // { entityId: tickCount }
    this.lastCellKey = '';              // novelty tracking: last grid cell visited
    this.cellAbsenceTicks = {};         // { cellKey: ticksSinceLastVisit }
  }

  /**
   * Main per-tick update: movement, parameter drift, isolation tracking, aging.
   * @param {Entity[]} entities - All entities in simulation
   * @param {ContextMap} contextMap
   * @param {object} config - Simulation config
   * @param {function} rng - Seeded PRNG
   * @param {number} currentTick
   */
  update(entities, contextMap, config, rng, currentTick, weatherEffects) {
    if (!this.alive) return;

    const perceptionRadius = config.perceptionRadius || 150;   // default 150
    const disruptionRadius = config.disruptionRadius || 80;    // default 80
    const socialRadius = config.socialRadius || 120;           // default 120
    const maxSpeed = config.maxSpeed || 4;                     // default 4
    const canvasWidth = config.canvasWidth || 1920;
    const canvasHeight = config.canvasHeight || 1080;

    // ── 1. Compute movement vector ──

    let forceX = 0;
    let forceY = 0;

    // Social force: attraction/repulsion based on sociability
    for (const other of entities) {
      if (other.id === this.id || !other.alive) continue;
      const dx = this._wrappedDx(other.x - this.x, canvasWidth);
      const dy = this._wrappedDy(other.y - this.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1 || dist > perceptionRadius) continue;

      const direction = (this.sociability - 0.5) * 2; // [-1, 1]
      const falloff = 1 - dist / perceptionRadius;    // linear falloff
      const magnitude = direction * falloff;
      forceX += (dx / dist) * magnitude;
      forceY += (dy / dist) * magnitude;
    }

    // Context gradient: terrain-aware nudges
    const terrain = contextMap.getTerrainEffects(this.x, this.y, currentTick);
    if (terrain.isFertile) {
      // Slight inertia-based nudge toward staying (reduce force)
      forceX *= (1 - this.inertia * 0.1);
      forceY *= (1 - this.inertia * 0.1);
    }
    if (terrain.isScarred && this.sociability > 0.5) {
      // High-S entities attracted to scarred areas (empathy/curiosity)
      forceX += (rng() - 0.5) * 0.3 * this.sociability;
      forceY += (rng() - 0.5) * 0.3 * this.sociability;
    }
    if (terrain.isGhostTrail && this.sociability > 0.5) {
      // High-S entities drawn to ghost trails
      forceX += (rng() - 0.5) * 0.2 * this.sociability;
      forceY += (rng() - 0.5) * 0.2 * this.sociability;
    }

    // Noise: random wandering — floor ensures even high-I entities drift slightly
    const noiseMag = Math.max(0.08, 0.5 * (1 - this.inertia));
    forceX += (rng() - 0.5) * 2 * noiseMag;
    forceY += (rng() - 0.5) * 2 * noiseMag;

    // Weather: migration current force
    if (weatherEffects && weatherEffects.current) {
      const currentResistance = 1 - this.inertia * 0.7; // high-I entities resist currents
      forceX += weatherEffects.current.fx * currentResistance;
      forceY += weatherEffects.current.fy * currentResistance;
    }

    // Disruption scatter: repulsive force from nearby high-D entities
    for (const other of entities) {
      if (other.id === this.id || !other.alive) continue;
      if (other.disruptionCharge <= (config.disruptionThreshold || 0.6)) continue;
      const dx = this._wrappedDx(this.x - other.x, canvasWidth);
      const dy = this._wrappedDy(this.y - other.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1 || dist > disruptionRadius) continue;

      const repulsionMag = other.disruptionCharge * 3.0;
      forceX += (dx / dist) * repulsionMag;
      forceY += (dy / dist) * repulsionMag;
    }

    // Weather: storm scatter force
    if (weatherEffects && weatherEffects.storm && weatherEffects.storm.inStorm) {
      forceX += weatherEffects.storm.scatterForce.fx;
      forceY += weatherEffects.storm.scatterForce.fy;
    }

    // Scale total force by (1 - inertia)
    forceX *= (1 - this.inertia);
    forceY *= (1 - this.inertia);

    // Bond attraction: AFTER inertia scaling so bonds bypass dampening
    // Even a high-inertia anchor feels the pull of its bonds — tether, not suggestion
    const entityMap_move = {};
    for (const e of entities) { entityMap_move[e.id] = e; }
    for (const bond of this.bonds) {
      const partner = entityMap_move[bond.targetId];
      if (!partner || !partner.alive) continue;
      const dx = this._wrappedDx(partner.x - this.x, canvasWidth);
      const dy = this._wrappedDy(partner.y - this.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      // Spring force: bonds have a rest distance. Pull when far, push when close.
      // Partners orbit each other visually instead of collapsing into one dot.
      const bondRestDistance = config.bondRestDistance ?? 25;
      const displacement = dist - bondRestDistance;
      const springMag = bond.strength * 0.5 * (displacement / bondRestDistance);
      forceX += (dx / dist) * springMag;
      forceY += (dy / dist) * springMag;
    }

    // Velocity damping
    const damping = 0.95 - this.inertia * 0.03;
    this.vx *= damping;
    this.vy *= damping;

    // Add force to velocity
    this.vx += forceX;
    this.vy += forceY;

    // Clamp speed
    // Weather: seasonal speed modifier
    const effectiveMaxSpeed = weatherEffects && weatherEffects.season
      ? maxSpeed * weatherEffects.season.speedMultiplier
      : maxSpeed;
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (speed > effectiveMaxSpeed) {
      this.vx = (this.vx / speed) * effectiveMaxSpeed;
      this.vy = (this.vy / speed) * effectiveMaxSpeed;
    }

    // Update position with toroidal wrapping
    this.x = ((this.x + this.vx) % canvasWidth + canvasWidth) % canvasWidth;
    this.y = ((this.y + this.vy) % canvasHeight + canvasHeight) % canvasHeight;

    // ── 2. Parameter drift (all scaled by volatility) ──

    const V = this.volatility;

    // Count local density
    let localDensity = 0;
    for (const other of entities) {
      if (other.id === this.id || !other.alive) continue;
      const dx = this._wrappedDx(other.x - this.x, canvasWidth);
      const dy = this._wrappedDy(other.y - this.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= perceptionRadius) localDensity++;
    }

    // ── Sociability drift ──
    // Overcrowding aversion: SCALED by degree, not binary.
    // 9 neighbors barely registers. 20 is uncomfortable. 40 is crushing.
    // The aversion grows with how far above the comfort zone you are.
    const crowdComfort = 8; // entities tolerate up to this many neighbors
    if (localDensity > crowdComfort) {
      const crowdExcess = (localDensity - crowdComfort) / 20; // normalized: 1 neighbor over = 0.05, 20 over = 1.0
      const crowdRate = this.bonds.length > 0 ? 0.0003 : 0.0006; // bonded entities tolerate crowds better
      this.sociability -= crowdRate * crowdExcess * V;
    }

    // Relational loneliness drives S recovery — not spatial isolation
    // "I'm in a crowd but nobody knows me" creates the urge to connect
    if (this.relationalLoneliness > 200) {
      const lonelinessUrgency = Math.min(1.0, (this.relationalLoneliness - 200) / 800); // ramps up 200-1000
      this.sociability += 0.0008 * lonelinessUrgency * V;
      this.inertia -= 0.0004 * lonelinessUrgency * V; // loneliness breeds restlessness
    }

    // Bonded entities drift S down gently — they have what they need
    if (this.bonds.length > 0) {
      this.sociability -= 0.0003 * V;
    }

    // Cabin fever: S suppressed too long builds pressure to re-engage
    // Different from loneliness — you can be in a crowd, bonded, and still get cabin fever
    if (this.sociability < 0.2) {
      this.lowSociabilityTicks++;
    } else {
      this.lowSociabilityTicks = 0;
    }
    const cabinFeverThreshold = config.cabinFeverThreshold ?? 500;
    const cabinFeverRate = config.cabinFeverRate ?? 0.0003;
    if (this.lowSociabilityTicks > cabinFeverThreshold) {
      this.sociability += cabinFeverRate * V;
    }

    // Inertia drift — bonding settles you, but shouldn't freeze you
    if (this.bonds.length > 0 && this.inertia < 0.75) {
      // Soft cap at 0.75 — bonded entities settle but stay mobile
      this.inertia += 0.0002 * V;
    }
    if (currentTick - this.recentBondBreakTick < 100) {
      this.inertia -= 0.001 * V;
    }
    if (terrain.isFertile) {
      this.inertia += 0.0002 * V;
    }

    // Age-based I erosion: older entities get restless. Gentle — maxes at 0.00002*V at end of life
    if (this.age > 5000) {
      const maxAge = config.maxAge || 20000;
      this.inertia -= 0.00002 * V * (this.age / maxAge);
    }

    // Low-V amplifies I drift: an entity that never changes gets uncomfortable
    // V and I become a coupled oscillator
    if (V < 0.15) {
      this.inertia -= 0.0001 * V;
    }

    // Current exposure reduces I: being moved loosens attachment to staying put
    if (weatherEffects && weatherEffects.current) {
      const currentMag = Math.sqrt(
        weatherEffects.current.fx * weatherEffects.current.fx +
        weatherEffects.current.fy * weatherEffects.current.fy
      );
      if (currentMag > 0.05) {
        this.inertia -= 0.0002 * V;
      }
    }

    // Weather: seasonal inertia drift
    if (weatherEffects && weatherEffects.season) {
      this.inertia += weatherEffects.season.inertiaDrift * V;
    }

    // ── FIX: Detect nearHighD using disruptionRadius, not perceptionRadius ──
    // Disruption is a local phenomenon — you shouldn't feel it from 150px away
    let nearHighD = false;
    for (const other of entities) {
      if (other.id === this.id || !other.alive) continue;
      if (other.disruptionCharge <= (config.disruptionThreshold || 0.6)) continue;
      const dx = this._wrappedDx(other.x - this.x, canvasWidth);
      const dy = this._wrappedDy(other.y - this.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= disruptionRadius) {
        nearHighD = true;
        break;
      }
    }

    // ── FIX: Volatility drift — V-scaled increase, prevents one-way ratchet ──
    if (nearHighD) {
      this.volatility += 0.0003 * V;
    }
    if (!terrain.isDisruptionZone) {
      this.volatility -= 0.0002 * V;
    }

    // Novelty boost: returning to a long-unvisited cell spikes V
    const cellKey = Math.floor(this.x / 20) + ',' + Math.floor(this.y / 20);
    if (cellKey !== this.lastCellKey) {
      if (this.cellAbsenceTicks[cellKey] > (config.noveltyThreshold || 1000)) {
        this.volatility += config.noveltyBoost || 0.03;
      }
      this.cellAbsenceTicks[cellKey] = 0;
      this.lastCellKey = cellKey;
    }
    // Increment absence ticks for all other cells (throttled for perf)
    // Adds 100 per check to stay in tick-scale units matching noveltyThreshold
    if (this.age % 100 === 0) {
      const noveltyThresh = config.noveltyThreshold || 1000;
      for (const key in this.cellAbsenceTicks) {
        if (key !== cellKey) {
          this.cellAbsenceTicks[key] += 100;
          // Prune entries far past threshold to prevent unbounded growth
          if (this.cellAbsenceTicks[key] > noveltyThresh * 3) {
            delete this.cellAbsenceTicks[key];
          }
        }
      }
    }

    // Bond diversity sustains V: diverse partners keep you adaptable
    if (this.bonds.length > 0) {
      let totalParamDist = 0;
      let partnerCount = 0;
      for (const bond of this.bonds) {
        const partner = entityMap_move[bond.targetId];
        if (!partner || !partner.alive) continue;
        const dS = this.sociability - partner.sociability;
        const dI = this.inertia - partner.inertia;
        const dV = this.volatility - partner.volatility;
        const dB = this.bondAffinity - partner.bondAffinity;
        const dD = this.disruptionCharge - partner.disruptionCharge;
        totalParamDist += Math.sqrt(dS * dS + dI * dI + dV * dV + dB * dB + dD * dD);
        partnerCount++;
      }
      if (partnerCount > 0) {
        const avgDistance = totalParamDist / partnerCount;
        if (avgDistance > 0.3) {
          this.volatility += 0.0001 * V;
        } else if (avgDistance < 0.15) {
          this.volatility -= 0.0001 * V;
        }
      }
    }

    // ── FIX: Bond Affinity drift — V-scaled decrease, passive recovery ──
    // The original flat -0.005 zeroed B in ~100 ticks. Now V-scaled and gentler.
    // Passive regen ensures B can never be permanently destroyed — wariness fades.

    // Passive decay — always-on downward drift so B doesn't sit at 1.0
    this.bondAffinity -= config.bPassiveDecayRate || 0.00005;

    for (const bond of this.bonds) {
      const bondAge = currentTick - bond.formedAt;
      if (bondAge > 500) {
        this.bondAffinity += 0.0002 * V;
      }
    }
    if (nearHighD) {
      this.bondAffinity -= 0.0008 * V;
    }
    // Slow passive recovery — wariness heals, given time
    this.bondAffinity += 0.0001;

    // Overcrowding penalty: too many bonds spread you thin
    if (this.bonds.length > (config.overcrowdingBondThreshold || 5)) {
      this.bondAffinity -= 0.0005 * V;
    }

    // ── Disruption Charge drift — staggered per-entity regen ──
    // Rate scales with V (volatile entities accumulate faster, stable ones slower),
    // multiplied by per-entity noise so entities desynchronize over time.
    // Bonds halve the rate (stability dampener).
    const disruptionRegenCap = config.disruptionRegenCap ?? 0.8;
    const isBonded = this.bonds.length > 0;
    const bondDamp = isBonded ? 0.5 : 1.0;
    const regenRate = 0.0001 * (0.5 + V) * this.disruptionRegenNoise * bondDamp;
    const decayRate = 0.0002 * (0.5 + V) * this.disruptionRegenNoise * bondDamp;
    if (isBonded) {
      this.disruptionCharge -= 0.0005 * V; // bonded entities calm down
    }
    // Two-way attractor: D always drifts TOWARD resting state.
    // Below cap: slow regen. Above cap: slow decay.
    // Zone exposure can spike above, but it's temporary — disruption is weather, not climate.
    if (this.disruptionCharge < disruptionRegenCap) {
      this.disruptionCharge += regenRate;
    } else if (this.disruptionCharge > disruptionRegenCap) {
      this.disruptionCharge -= decayRate; // decay faster than regen — perturbations fade
    }
    if (terrain.isDisruptionZone) {
      this.disruptionCharge += 0.0003 * V; // zones still push above cap
    }

    // Frustration-driven D: wants connection but has none
    if (this.sociability > 0.5 && this.bonds.length === 0) {
      this.disruptionCharge += 0.0002 * V;
    }

    // Overcrowding drives D: crowded but not lethal
    if (localDensity > (config.crushThreshold || 12) * 0.7) {
      this.disruptionCharge += 0.0001 * V;
    }

    // ── Bonded parameter differentiation ──
    // Bonded pairs should become visually distinct from the unbonded sea.
    // Partners push each other's sociability apart (one more social, one more
    // anchoring) and suppress each other's D (you have something to lose).
    // This creates local color variation — the "family" palette.
    for (const bond of this.bonds) {
      const partner = entityMap_move[bond.targetId];
      if (!partner || !partner.alive) continue;
      const bondAge = currentTick - bond.formedAt;
      if (bondAge > 100) {
        // Push S apart — mutual specialization. One becomes the social one,
        // the other anchors. 3x original rate for visible color divergence.
        const sDiff = this.sociability - partner.sociability;
        this.sociability += 0.0003 * Math.sign(sDiff || (rng() - 0.5)) * V;
        // Push V apart — one stabilizes, one stays reactive
        const vDiff = this.volatility - partner.volatility;
        this.volatility += 0.00015 * Math.sign(vDiff || (rng() - 0.5)) * V;
        // Push I apart — one roams, one stays. Creates visible orbit asymmetry.
        const iDiff = this.inertia - partner.inertia;
        this.inertia += 0.0002 * Math.sign(iDiff || (rng() - 0.5)) * V;
        // Push B apart — one becomes the connector, one the homebody
        const bDiff = this.bondAffinity - partner.bondAffinity;
        this.bondAffinity += 0.0001 * Math.sign(bDiff || (rng() - 0.5)) * V;
        // Bonded D suppression — stronger than the passive drift
        this.disruptionCharge -= 0.0003 * V;
      }
    }

    // Weather: storm effects on parameters
    if (weatherEffects && weatherEffects.storm && weatherEffects.storm.inStorm) {
      this.disruptionCharge += weatherEffects.storm.dBoost;
      this.volatility += weatherEffects.storm.vBoost;
      // Storm weakens bonds
      for (const bond of this.bonds) {
        bond.strength -= weatherEffects.storm.bondWeakening;
        if (bond.strength < 0) bond.strength = 0;
      }
    }

    // Weather: bloom effects on parameters
    if (weatherEffects && weatherEffects.bloom && weatherEffects.bloom.inBloom) {
      this.sociability += weatherEffects.bloom.sociabilityNudge;
    }

    // Bonded parameter floors — prevent convergence to identical zero-state
    // Bonded entities maintain minimum variation so the system keeps evolving
    if (this.bonds.length > 0) {
      // S floor: bonded entities stay mildly social — they don't close the door completely
      // This allows new entities to still be attracted to bonded groups
      const sFloor = config.bondedSociabilityFloor ?? 0.15;
      if (this.sociability < sFloor) {
        this.sociability += 0.0003; // gentle pull toward floor
      }

      // V floor: bonded entities stay somewhat reactive
      // Without this, bonded pairs fossilize — no parameter changes at all
      const vFloor = config.bondedVolatilityFloor ?? 0.2;
      if (this.volatility < vFloor) {
        this.volatility += 0.0002;
      }
    }

    // ── Seasonal parameter effects ──
    // Ties weather to parameter dynamics — behavioral seasons, not just physical ones
    if (weatherEffects && weatherEffects.season) {
      const warmth = weatherEffects.season.warmth; // 0=winter, 1=summer
      const seasonDev = (warmth - 0.5); // [-0.5, 0.5]

      // Seasonal S boost: warm seasons make everyone a little more social
      this.sociability += 0.0001 * seasonDev * V;

      // Seasonal V cycle: higher in summer, lower in winter (smaller amplitude than S)
      this.volatility += 0.00005 * seasonDev * V;

      // Seasonal D: late summer / early autumn, D regen rate increases
      // Use a shifted sine that peaks in late summer (warmth ~0.7-0.8)
      const autumnPressure = Math.max(0, Math.sin((warmth - 0.3) * Math.PI));
      this.disruptionCharge += 0.00005 * autumnPressure * V;
    }

    // ── Parameter drift noise ──
    // Tiny per-tick random walk scaled by V — thermal noise floor
    // Prevents perfect convergence even when all contextual forces balance
    const noiseScale = config.driftNoiseScale ?? 0.001;
    this.sociability += (rng() - 0.5) * noiseScale * V;
    this.inertia += (rng() - 0.5) * noiseScale * V;
    this.volatility += (rng() - 0.5) * noiseScale * V;
    this.bondAffinity += (rng() - 0.5) * noiseScale * V;
    this.disruptionCharge += (rng() - 0.5) * noiseScale * V;

    // ── Homeostasis — drift toward birth parameters ──
    // Creates personality: an entity born sociable will tend to return to sociability
    // Very slow — context can push far from nature, but nature gently pulls back
    const homeoRate = config.homeostasisRate ?? 0.0001;
    this.sociability += (this.birthParams.sociability - this.sociability) * homeoRate;
    this.inertia += (this.birthParams.inertia - this.inertia) * homeoRate;
    this.volatility += (this.birthParams.volatility - this.volatility) * homeoRate;
    this.bondAffinity += (this.birthParams.bondAffinity - this.bondAffinity) * homeoRate;
    this.disruptionCharge += (this.birthParams.disruptionCharge - this.disruptionCharge) * homeoRate;

    // ── Clamp with floors and ceilings ──
    const sFloor = config.sociabilityFloor ?? 0.05;
    const vFloorGlobal = config.volatilityFloor ?? 0.1;
    const iCeiling = config.inertiaCeiling ?? 0.85;
    const bCeiling = config.bondAffinityCeiling ?? 0.95;

    this.sociability = clamp(this.sociability, sFloor, 1);
    this.inertia = clamp(this.inertia, 0, iCeiling);
    this.volatility = clamp(this.volatility, vFloorGlobal, 1);
    this.bondAffinity = clamp(this.bondAffinity, 0, bCeiling);
    this.disruptionCharge = clamp(this.disruptionCharge, 0, 1);

    // ── 3. Track isolation (spatial) and relational loneliness ──

    // Spatial isolation: used for death check only.
    // "Is anyone physically near me?" — the ecosystem boundary.
    let hasNearby = false;
    for (const other of entities) {
      if (other.id === this.id || !other.alive) continue;
      const dx = this._wrappedDx(other.x - this.x, canvasWidth);
      const dy = this._wrappedDy(other.y - this.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= socialRadius) {
        hasNearby = true;
        break;
      }
    }
    if (!hasNearby) {
      this.isolationTicks++;
    } else {
      this.isolationTicks = 0;
    }

    // Relational loneliness: drives behavioral response to disconnection.
    // This is the NYC/Tokyo insight: a crowd of strangers isn't company.
    // Loneliness is about CONNECTION, not PROXIMITY.
    //
    // - No bonds, anyone nearby or not: lonely. Accumulates steadily.
    //   You're in a city of millions and nobody knows your name.
    // - Has bonds, partner nearby (within bondBreakDistance): not lonely.
    //   Decreases — you have what matters.
    // - Has bonds, partner far: slow accumulation. Longing, not isolation.
    // - Recent bond break: spike. Loss is the sharpest loneliness.
    if (this.bonds.length === 0) {
      // Unbonded: loneliness accumulates regardless of crowd density.
      // Faster when truly alone, but still present in crowds.
      const crowdLonelinessRate = hasNearby ? 0.3 : 1.0;
      this.relationalLoneliness += crowdLonelinessRate;
    } else {
      // Bonded: check if any partner is nearby
      let partnerNearby = false;
      const bondBreakDist = config.bondBreakDistance || 120;
      for (const bond of this.bonds) {
        const partner = entityMap_move[bond.targetId];
        if (!partner || !partner.alive) continue;
        const dx = this._wrappedDx(partner.x - this.x, canvasWidth);
        const dy = this._wrappedDy(partner.y - this.y, canvasHeight);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= bondBreakDist) {
          partnerNearby = true;
          break;
        }
      }
      if (partnerNearby) {
        // Connected and together: loneliness heals
        this.relationalLoneliness = Math.max(0, this.relationalLoneliness - 0.5);
      } else {
        // Bonded but separated: slow longing accumulation
        this.relationalLoneliness += 0.1;
      }
    }

    // Recent bond break spikes loneliness — loss hurts
    if (currentTick - this.recentBondBreakTick < 200) {
      this.relationalLoneliness += 0.5;
    }

    // Cap relational loneliness so it doesn't grow unbounded
    this.relationalLoneliness = Math.min(this.relationalLoneliness, 2000);

    // ── 4. Hue drift — color becomes biography ──
    const hueDriftRate = config.hueDriftRate ?? 0.02;
    const hueDriftDisruption = config.hueDriftDisruption ?? 0.3;
    const hueDriftTravel = config.hueDriftTravel ?? 0.1;

    // Baseline age drift
    this.hueOffset += hueDriftRate;

    // Disruption zone exposure leaves a mark
    if (terrain.isDisruptionZone) {
      this.hueOffset += hueDriftDisruption;
    }

    // Fast travelers drift faster
    const currentSpeed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (currentSpeed > maxSpeed * 0.5) {
      this.hueOffset += hueDriftTravel;
    }

    // Wrap at 360
    this.hueOffset = this.hueOffset % 360;

    // ── 5. Age ──
    this.age++;

    // ── 6. Record parameter history every 300 ticks ──
    if (this.age % 300 === 0) {
      this.parameterHistory.push({
        tick: currentTick,
        sociability: this.sociability,
        inertia: this.inertia,
        volatility: this.volatility,
        bondAffinity: this.bondAffinity,
        disruptionCharge: this.disruptionCharge
      });
    }

    // ── 7. Update presence on context map ──
    contextMap.incrementPresence(this.x, this.y);
  }

  /**
   * Update existing bonds: strengthen, weaken from disruption/distance, break if needed.
   * @param {Entity[]} entities
   * @param {ContextMap} contextMap
   * @param {object} config
   * @param {number} currentTick
   * @returns {Array} Array of break event objects
   */
  updateBonds(entities, contextMap, config, currentTick) {
    const bondBreakDistance = config.bondBreakDistance || 120;  // default 120
    const canvasWidth = config.canvasWidth || 1920;
    const canvasHeight = config.canvasHeight || 1080;
    const breakEvents = [];

    // Build entity lookup for efficiency
    const entityMap = {};
    for (const e of entities) {
      entityMap[e.id] = e;
    }

    for (let i = this.bonds.length - 1; i >= 0; i--) {
      const bond = this.bonds[i];
      const partner = entityMap[bond.targetId];

      // Strength increases passively
      bond.strength = Math.min(1.0, bond.strength + 0.001);

      // ── Bond hardening ──
      // Young bonds are fragile. Bonds that survive past hardeningAge become
      // resistant to disruption — they've earned it. The hardening factor
      // reduces disruption damage for mature bonds.
      const bondAge = currentTick - bond.formedAt;
      const hardeningAge = config.bondHardeningAge ?? 200;
      const hardeningResistance = config.bondHardeningResistance ?? 0.2;
      const hardeningFactor = bondAge > hardeningAge ? hardeningResistance : 1.0;

      // Disruption weakening: check if either member is near a high-D entity
      for (const other of entities) {
        if (other.id === this.id || other.id === bond.targetId || !other.alive) continue;
        if (other.disruptionCharge <= (config.disruptionThreshold || 0.6)) continue;

        // Check proximity to this entity
        const dx1 = this._wrappedDx(other.x - this.x, canvasWidth);
        const dy1 = this._wrappedDy(other.y - this.y, canvasHeight);
        const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

        let nearThis = dist1 <= (config.disruptionRadius || 80);
        let nearPartner = false;

        if (partner && partner.alive) {
          const dx2 = this._wrappedDx(other.x - partner.x, canvasWidth);
          const dy2 = this._wrappedDy(other.y - partner.y, canvasHeight);
          const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
          nearPartner = dist2 <= (config.disruptionRadius || 80);
        }

        if (nearThis || nearPartner) {
          bond.strength -= 0.005 * other.disruptionCharge * hardeningFactor;
        }
      }

      // Distance weakening
      if (partner && partner.alive) {
        const dx = this._wrappedDx(partner.x - this.x, canvasWidth);
        const dy = this._wrappedDy(partner.y - this.y, canvasHeight);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > bondBreakDistance) {
          bond.strength -= 0.01;
        }
      } else {
        // Partner dead or missing — weaken rapidly
        bond.strength -= 0.05;
      }

      // Break bond if strength depleted
      if (bond.strength <= 0) {
        const event = this.breakBond(bond.targetId, currentTick);
        if (event) breakEvents.push(event);
        // breakBond removes it from this.bonds, so re-check index
        i = Math.min(i, this.bonds.length); // adjust for removal
      }
    }

    return breakEvents;
  }

  /**
   * Attempt to form a bond with another entity.
   * @param {Entity} other
   * @param {ContextMap} contextMap
   * @param {object} config
   * @param {function} rng
   * @param {number} currentTick
   * @returns {object|null} Event data if bond formed, null otherwise
   */
  tryFormBond(other, contextMap, config, rng, currentTick) {
    const bondRadius = config.bondRadius || 40;           // default 40
    const bondDuration = config.bondDuration || 60;       // default 60 ticks proximity
    const canvasWidth = config.canvasWidth || 1920;
    const canvasHeight = config.canvasHeight || 1080;

    // Check distance
    const dx = this._wrappedDx(other.x - this.x, canvasWidth);
    const dy = this._wrappedDy(other.y - this.y, canvasHeight);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > bondRadius) {
      // Reset proximity tracking if out of range
      delete this.proximityTicks[other.id];
      return null;
    }

    // Check bond limits (max 3 each)
    if (this.bonds.length >= 3 || other.bonds.length >= 3) return null;

    // Check not already bonded
    if (this.bonds.some(b => b.targetId === other.id)) return null;

    // Track proximity ticks
    if (!this.proximityTicks[other.id]) {
      this.proximityTicks[other.id] = 0;
    }
    this.proximityTicks[other.id]++;

    // Need sustained proximity
    if (this.proximityTicks[other.id] < bondDuration) return null;

    // Compute bond formation probability
    const terrainHere = contextMap.getTerrainEffects(this.x, this.y, currentTick);
    const weatherBondMod = config._weatherBondModifier || 1.0; // set by main loop from season + bloom
    const probability = 0.06
      * this.bondAffinity
      * other.bondAffinity
      * terrainHere.fertilityModifier
      * terrainHere.bondFormationModifier
      * weatherBondMod;

    if (rng() < probability) {
      // Form bond on both entities
      const bondData = { targetId: other.id, strength: 0.5, formedAt: currentTick };
      const reverseBondData = { targetId: this.id, strength: 0.5, formedAt: currentTick };
      this.bonds.push(bondData);
      other.bonds.push(reverseBondData);

      // Hue drift: bond formation shifts color
      const hueDriftBondForm = config.hueDriftBondForm ?? 0.5;
      this.hueOffset = (this.hueOffset + hueDriftBondForm) % 360;
      other.hueOffset = (other.hueOffset + hueDriftBondForm) % 360;

      // Reset proximity tracking
      delete this.proximityTicks[other.id];
      delete other.proximityTicks[this.id];

      // Record in context map
      contextMap.recordBondFormation(this.x, this.y, currentTick);
      contextMap.recordBondFormation(other.x, other.y, currentTick);

      return {
        type: 'bondFormed',
        entityA: this.id,
        entityB: other.id,
        tick: currentTick,
        x: (this.x + other.x) / 2,
        y: (this.y + other.y) / 2
      };
    }

    // Failed proximity discouragement: been near long enough but bond didn't form
    if (this.proximityTicks[other.id] >= bondDuration) {
      this.bondAffinity -= 0.001;
      other.bondAffinity -= 0.001;
    }

    return null;
  }

  /**
   * Break a bond with the given target entity.
   * @param {string} targetId
   * @param {number} currentTick
   * @returns {object|null} Event data
   */
  breakBond(targetId, currentTick) {
    const bondIdx = this.bonds.findIndex(b => b.targetId === targetId);
    if (bondIdx === -1) return null;

    const bond = this.bonds[bondIdx];
    this.bonds.splice(bondIdx, 1);

    // V spike
    this.volatility = clamp(this.volatility + 0.05, 0, 1);
    // B decrease
    this.bondAffinity = clamp(this.bondAffinity - 0.02, 0, 1);
    // Hue drift: bond break is the strongest color shift
    this.hueOffset = (this.hueOffset + 1.0) % 360;
    // Track break timing
    this.recentBondBreakTick = currentTick;

    return {
      type: 'bondBroken',
      entityA: this.id,
      entityB: targetId,
      tick: currentTick,
      bondAge: currentTick - bond.formedAt,
      finalStrength: bond.strength
    };
  }

  /**
   * Apply disruption effects if this entity's D charge is high enough.
   * @param {Entity[]} entities
   * @param {ContextMap} contextMap
   * @param {object} config
   * @param {number} currentTick
   * @returns {object|null} Event data
   */
  applyDisruption(entities, contextMap, config, currentTick) {
    const disruptionThreshold = config.disruptionThreshold || 0.6; // default 0.6
    const disruptionRadius = config.disruptionRadius || 80;        // default 80
    const canvasWidth = config.canvasWidth || 1920;
    const canvasHeight = config.canvasHeight || 1080;

    if (this.disruptionCharge <= disruptionThreshold) return null;

    let affectedCount = 0;
    let bondsWeakenedCount = 0;

    for (const other of entities) {
      if (other.id === this.id || !other.alive) continue;

      const dx = this._wrappedDx(other.x - this.x, canvasWidth);
      const dy = this._wrappedDy(other.y - this.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > disruptionRadius || dist < 1) continue;

      affectedCount++;

      // Apply scatter force to the other entity
      const scatterMag = this.disruptionCharge * 2.0 / dist;
      other.vx += (dx / dist) * scatterMag;
      other.vy += (dy / dist) * scatterMag;

      // Weaken their bonds
      for (const bond of other.bonds) {
        bond.strength -= 0.003 * this.disruptionCharge;
        if (bond.strength < 0) bond.strength = 0;
        bondsWeakenedCount++;
      }
    }

    // Record disruption in context map
    contextMap.recordDisruption(this.x, this.y, currentTick);

    if (affectedCount === 0) return null;

    // Post-fire: D drops by fixed amount, not to zero
    // A disruptive entity can fire again sooner if conditions maintain its D
    this.disruptionCharge = Math.max(0, this.disruptionCharge - (config.disruptionPostFireDrop ?? 0.3));

    return {
      type: 'disruption',
      disruptorId: this.id,
      affectedCount,
      bondsWeakenedCount,
      tick: currentTick,
      x: this.x,
      y: this.y
    };
  }

  /**
   * Check if this entity should die.
   * @param {Entity[]} entities
   * @param {object} config
   * @param {number} currentTick
   * @returns {string|null} Death cause or null
   */
  checkDeath(entities, config, currentTick) {
    const lonelinessThreshold = config.lonelinessThreshold || 400; // default 400
    const crushThreshold = config.crushThreshold || 12;            // default 12
    const maxAge = config.maxAge || 20000;                         // default 20000
    const canvasWidth = config.canvasWidth || 1920;
    const canvasHeight = config.canvasHeight || 1080;

    // Loneliness death — spatial isolation only.
    // You die if you wander completely away from everyone. This is the
    // ecosystem boundary, not the relational loneliness metric.
    if (this.isolationTicks > lonelinessThreshold) return 'loneliness';

    // Overcrowding death
    let crushCount = 0;
    for (const other of entities) {
      if (other.id === this.id || !other.alive) continue;
      const dx = this._wrappedDx(other.x - this.x, canvasWidth);
      const dy = this._wrappedDy(other.y - this.y, canvasHeight);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 50) crushCount++;
    }
    if (crushCount > crushThreshold) return 'overcrowding';

    // Age death
    if (this.age > maxAge) return 'age';

    return null;
  }

  /**
   * Begin the death/fade process.
   * @param {string} cause
   * @returns {object} Event data
   */
  beginDeath(cause) {
    this.alive = false;
    return {
      type: 'death',
      entityId: this.id,
      cause,
      age: this.age,
      bondCount: this.bonds.length,
      x: this.x,
      y: this.y
    };
  }

  /**
   * Advance fade animation. Returns true when fully faded (should be removed).
   * @returns {boolean}
   */
  updateFade() {
    this.fadeProgress += 0.01;
    return this.fadeProgress >= 1.0;
  }

  /**
   * Apply smoothing: D trends toward 0, V trends toward 0.2.
   * @param {object} config
   */
  applySmoother(config) {
    // D trends toward 0 at 0.002/tick
    if (this.disruptionCharge > 0) {
      this.disruptionCharge = Math.max(0, this.disruptionCharge - 0.002);
    }
    // V trends toward 0.2 at 0.001/tick
    if (this.volatility > 0.2) {
      this.volatility -= 0.001;
    } else if (this.volatility < 0.2) {
      this.volatility += 0.001;
    }
  }

  /**
   * Spawn a new entity near a position, inheriting from nearby entities with noise.
   * New entities always arrive with at least some sociability — fresh eyes, fresh
   * willingness to connect — even if the neighborhood has gone antisocial.
   * @param {number} x
   * @param {number} y
   * @param {Entity[]} nearbyEntities
   * @param {function} rng
   * @param {number} currentTick
   * @returns {Entity}
   */
  static spawn(x, y, nearbyEntities, rng, currentTick) {
    const id = seededUUID(rng);
    let params;

    // Minimum spawn sociability — newcomers arrive willing to engage
    // regardless of what the neighborhood has become
    const spawnSFloor = 0.15;

    if (nearbyEntities.length > 0) {
      // Weighted average of nearby entities' params + Gaussian noise
      const count = nearbyEntities.length;
      let sSum = 0, iSum = 0, vSum = 0, bSum = 0, dSum = 0;
      for (const e of nearbyEntities) {
        sSum += e.sociability;
        iSum += e.inertia;
        vSum += e.volatility;
        bSum += e.bondAffinity;
        dSum += e.disruptionCharge;
      }
      params = {
        sociability: clamp(Math.max(spawnSFloor, sSum / count) + gaussianRandom(rng, 0, 0.1), 0.05, 0.95),
        inertia: clamp(iSum / count + gaussianRandom(rng, 0, 0.1), 0.05, 0.95),
        volatility: clamp(vSum / count + gaussianRandom(rng, 0, 0.1), 0.05, 0.95),
        bondAffinity: clamp(bSum / count + gaussianRandom(rng, 0, 0.1), 0.05, 0.95),
        disruptionCharge: clamp(dSum / count + gaussianRandom(rng, 0, 0.1), 0.05, 0.95)
      };
    } else {
      // No nearby entities: random params
      params = {
        sociability: clamp(rng(), 0.15, 0.95),
        inertia: clamp(rng(), 0.05, 0.95),
        volatility: clamp(rng(), 0.05, 0.95),
        bondAffinity: clamp(rng(), 0.05, 0.95),
        disruptionCharge: clamp(rng(), 0.05, 0.95)
      };
    }

    return new Entity(id, x, y, params, rng);
  }

  /**
   * Serialize entity to a plain object for API/persistence.
   * @returns {object}
   */
  serialize() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      sociability: this.sociability,
      inertia: this.inertia,
      volatility: this.volatility,
      bondAffinity: this.bondAffinity,
      disruptionCharge: this.disruptionCharge,
      bonds: this.bonds.map(b => ({ ...b })),
      age: this.age,
      parameterHistory: this.parameterHistory,
      alive: this.alive,
      fadeProgress: this.fadeProgress,
      isolationTicks: this.isolationTicks,
      relationalLoneliness: this.relationalLoneliness,
      recentBondBreakTick: this.recentBondBreakTick,
      proximityTicks: { ...this.proximityTicks },
      hueOffset: this.hueOffset,
      disruptionRegenNoise: this.disruptionRegenNoise,
      birthParams: { ...this.birthParams },
      lowSociabilityTicks: this.lowSociabilityTicks,
      lastCellKey: this.lastCellKey,
      cellAbsenceTicks: { ...this.cellAbsenceTicks }
    };
  }

  /**
   * Restore an entity from a serialized plain object.
   * @param {object} data
   * @returns {Entity}
   */
  static deserialize(data) {
    const entity = new Entity(
      data.id,
      data.x,
      data.y,
      {
        sociability: data.sociability,
        inertia: data.inertia,
        volatility: data.volatility,
        bondAffinity: data.bondAffinity,
        disruptionCharge: data.disruptionCharge
      },
      null // rng not needed for deserialization
    );
    entity.vx = data.vx || 0;
    entity.vy = data.vy || 0;
    entity.bonds = (data.bonds || []).map(b => ({ ...b }));
    entity.age = data.age || 0;
    entity.parameterHistory = data.parameterHistory || [];
    entity.alive = data.alive !== undefined ? data.alive : true;
    entity.fadeProgress = data.fadeProgress || 0;
    entity.isolationTicks = data.isolationTicks || 0;
    entity.relationalLoneliness = data.relationalLoneliness || 0;
    entity.recentBondBreakTick = data.recentBondBreakTick || -1000;
    entity.proximityTicks = data.proximityTicks ? { ...data.proximityTicks } : {};
    entity.hueOffset = data.hueOffset || 0;
    if (data.disruptionRegenNoise != null) {
      entity.disruptionRegenNoise = data.disruptionRegenNoise;
    }
    if (data.birthParams) {
      entity.birthParams = { ...data.birthParams };
    }
    entity.lowSociabilityTicks = data.lowSociabilityTicks || 0;
    entity.lastCellKey = data.lastCellKey || '';
    entity.cellAbsenceTicks = data.cellAbsenceTicks ? { ...data.cellAbsenceTicks } : {};
    return entity;
  }

  // ── Helpers ──

  /**
   * Compute wrapped delta for toroidal distance (X axis).
   */
  _wrappedDx(rawDx, width) {
    if (rawDx > width / 2) return rawDx - width;
    if (rawDx < -width / 2) return rawDx + width;
    return rawDx;
  }

  /**
   * Compute wrapped delta for toroidal distance (Y axis).
   */
  _wrappedDy(rawDy, height) {
    if (rawDy > height / 2) return rawDy - height;
    if (rawDy < -height / 2) return rawDy + height;
    return rawDy;
  }
}

/**
 * Clamp a value to [min, max].
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
