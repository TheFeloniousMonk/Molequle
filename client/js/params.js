// params.js — Simulation defaults and the ranges of remotely tunable parameters.
// Single source of truth: the client builds its config from DEFAULT_CONFIG, and
// the server validates /api/params against PARAM_RANGES and publishes it at
// GET /api/param-ranges (which the MCP server reads). Add a tunable parameter
// here, in both objects, and every layer picks it up.

// ── Default configuration ──────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  canvasWidth: 1920,
  canvasHeight: 1080,
  initialPopulation: 120,
  maxPopulation: 500,
  ticksPerFrame: 1,

  // Movement
  perceptionRadius: 150,
  maxSpeed: 4,
  socialRadius: 120,

  // Bonding
  bondRadius: 40,
  bondDuration: 60,
  bondBreakDistance: 120,

  // Disruption
  disruptionThreshold: 0.6,
  disruptionRadius: 80,
  disruptionRegenCap: 0.8,  // must be >= disruptionThreshold so D can naturally fire

  // Bond hardening
  bondHardeningAge: 200,
  bondHardeningResistance: 0.2,
  bondRestDistance: 25,
  bondedSociabilityFloor: 0.15,
  bondedVolatilityFloor: 0.2,

  // Reproduction
  spawnThreshold: 5,
  communityThreshold: 0.4,
  spawnCooldown: 200,

  // Death
  lonelinessThreshold: 400,
  crushThreshold: 12,
  maxAge: 20000,

  // Context map
  halfLifeTicks: 5000,
  gridCols: 96,
  gridRows: 54,

  // Hue drift — color becomes biography
  hueDriftRate: 0.02,            // base per-tick hue accumulation
  hueDriftBondForm: 0.5,         // hue bump on bond formation
  hueDriftBondBreak: 1.0,        // hue bump on bond break
  hueDriftDisruption: 0.3,       // per-tick hue drift in disruption zones
  hueDriftTravel: 0.1,           // per-tick hue drift at high speed

  // Size variance
  sizeGrowthDuration: 600,       // ticks for newborn to reach full size
  sizeBondScale: 0.1,            // size increase per active bond

  // Trails
  trailDecayRate: 0.001125,       // per-frame trail fade (lowered from 0.003 in 2.0, then 0.0015, so patterns can build up)
  trailDecayScaling: true,       // scale trail decay with avg movement speed
  trailFadeInterval: 10,         // frames between trail fades (same total decay, steps big enough to survive 8-bit rounding)
  trailScale: 0.5,               // trail layer resolution relative to the main canvas

  // Look (visual only — no effect on the simulation)
  element: 'bioluminescent',     // material: bioluminescent | ice | fire | metallic
  lighting: 'faux3d',            // faux3d (shaded spheres + highlights) | flat
  lightAngle: 225,               // global light direction, degrees clockwise from +x (225 = upper left)
  showWeather: true,             // draw weather visuals (storm/bloom/current/season effects)
  renderScale: 0,                // main canvas resolution multiplier; 0 = auto (min(devicePixelRatio, 1.5))

  // Parameter overhaul: floors, ceilings, counter-pressures
  volatilityFloor: 0.1,          // universal V floor (most important single change)
  inertiaCeiling: 0.85,          // hard I ceiling
  bondAffinityCeiling: 0.95,     // hard B ceiling
  disruptionPostFireDrop: 0.3,   // D drops by this after firing, not to 0
  bPassiveDecayRate: 0.0001,     // B passive downward drift per tick (so B doesn't sit at the ceiling)
  bPassiveRecoveryRate: 0.0001,  // B passive upward recovery per tick (wariness heals); nets to zero with decay
  cabinFeverThreshold: 500,      // ticks of low S before restlessness kicks in
  cabinFeverRate: 0.0003,        // S upward drift rate during cabin fever
  homeostasisRate: 0.0001,       // drift rate back toward birth parameters
  noveltyThreshold: 1000,        // ticks absent from a cell to trigger novelty boost
  noveltyBoost: 0.03,            // V boost when entering novel region
  overcrowdingBondThreshold: 5,  // bond count where B starts decreasing
  maxBondsPerEntity: 3,          // bond degree cap: entities at this many bonds don't form more
  driftNoiseScale: 0.001,        // per-tick random walk magnitude (scaled by V)

  // Weather: Seasons
  seasonLength: 12000,
  seasonAmplitude: 0.5,

  // Weather: Migration Currents
  currentCount: 2,
  currentStrength: 0.3,
  currentWidth: 200,
  currentLifetime: 5000,
  currentSpawnRate: 0.0005,

  // Weather: Fertility Blooms
  bloomSpawnRate: 0.0002,
  bloomRadiusMin: 100,
  bloomRadiusMax: 250,
  bloomLifetimeMin: 2000,
  bloomLifetimeMax: 5000,
  bloomIntensity: 1.5,
  bloomMax: 3,

  // Weather: Disruption Storms
  stormSpawnRate: 0.00008,
  stormRadiusMin: 80,
  stormRadiusMax: 200,
  stormLifetimeMin: 1000,
  stormLifetimeMax: 3000,
  stormIntensity: 1.5,
  stormMax: 2,

  // Bond topology: second-degree attraction & shared-neighbor reinforcement
  secondDegreeStrength: 0.4,     // attraction force between 2-hop neighbors (0 = off)
  sharedNeighborBonus: 0.12,     // bond strength bonus per shared neighbor per tick
  secondDegreeMaxRange: 200,     // max distance for second-degree pull
  introductionFactor: 0.3,      // per-shared-neighbor reduction in bond formation time

  // Display toggles
  showTrails: true,
  showContextMap: false,
  smoother: false,
  paused: false,

  // Current state (written by main loop for renderer/UI)
  currentTick: 0
};

// Remotely tunable parameters (POST /api/params, molequle_set_params).
// Numeric (default type): clamped to [min, max]; integer params are rounded.
// type 'enum': value must be one of `values`. type 'boolean': true or false.
// Every key must also exist in DEFAULT_CONFIG — the client ignores keys it
// doesn't have.
export const PARAM_RANGES = {
  ticksPerFrame: { min: 1, max: 5 },
  bondRadius: { min: 20, max: 80 },
  bondDuration: { min: 20, max: 120 },
  disruptionThreshold: { min: 0.3, max: 0.9 },
  disruptionRadius: { min: 40, max: 150 },
  disruptionRegenCap: { min: 0.3, max: 1.0 },
  bondHardeningAge: { min: 50, max: 500 },
  bondHardeningResistance: { min: 0.05, max: 0.5 },
  bondRestDistance: { min: 10, max: 60 },
  bondedSociabilityFloor: { min: 0.0, max: 0.4 },
  bondedVolatilityFloor: { min: 0.0, max: 0.4 },
  spawnThreshold: { min: 3, max: 10 },
  communityThreshold: { min: 0.2, max: 0.8 },
  lonelinessThreshold: { min: 200, max: 800 },
  crushThreshold: { min: 6, max: 40 },
  maxPopulation: { min: 100, max: 800 },
  maxAge: { min: 5000, max: 50000 },
  halfLifeTicks: { min: 1000, max: 20000 },
  trailDecayRate: { min: 0.0005, max: 0.01 },
  seasonLength: { min: 2000, max: 50000 },
  seasonAmplitude: { min: 0.0, max: 1.0 },
  currentCount: { min: 0, max: 5 },
  currentStrength: { min: 0.0, max: 1.0 },
  currentWidth: { min: 50, max: 500 },
  currentLifetime: { min: 1000, max: 20000 },
  currentSpawnRate: { min: 0.0001, max: 0.002 },
  bloomSpawnRate: { min: 0.00005, max: 0.001 },
  bloomRadiusMin: { min: 50, max: 200 },
  bloomRadiusMax: { min: 100, max: 400 },
  bloomLifetimeMin: { min: 500, max: 5000 },
  bloomLifetimeMax: { min: 1000, max: 10000 },
  bloomIntensity: { min: 0.5, max: 3.0 },
  bloomMax: { min: 0, max: 5 },
  stormSpawnRate: { min: 0.00002, max: 0.0005 },
  stormRadiusMin: { min: 40, max: 200 },
  stormRadiusMax: { min: 80, max: 400 },
  stormLifetimeMin: { min: 300, max: 3000 },
  stormLifetimeMax: { min: 500, max: 5000 },
  stormIntensity: { min: 0.5, max: 3.0 },
  stormMax: { min: 0, max: 3 },
  // Hue drift
  hueDriftRate: { min: 0.0, max: 0.1 },
  hueDriftBondForm: { min: 0.0, max: 5.0 },
  hueDriftBondBreak: { min: 0.0, max: 5.0 },
  hueDriftDisruption: { min: 0.0, max: 2.0 },
  hueDriftTravel: { min: 0.0, max: 1.0 },
  // Size variance
  sizeGrowthDuration: { min: 100, max: 3000 },
  sizeBondScale: { min: 0.0, max: 0.5 },
  // Parameter overhaul
  cabinFeverThreshold: { min: 100, max: 2000 },
  cabinFeverRate: { min: 0.00005, max: 0.002 },
  homeostasisRate: { min: 0.0, max: 0.001 },
  volatilityFloor: { min: 0.0, max: 0.3 },
  inertiaCeiling: { min: 0.5, max: 1.0 },
  bondAffinityCeiling: { min: 0.5, max: 1.0 },
  disruptionPostFireDrop: { min: 0.05, max: 0.8 },
  driftNoiseScale: { min: 0.0, max: 0.01 },
  noveltyThreshold: { min: 200, max: 5000 },
  noveltyBoost: { min: 0.0, max: 0.1 },
  // Bond topology
  secondDegreeStrength: { min: 0.0, max: 1.0 },
  sharedNeighborBonus: { min: 0.0, max: 0.5 },
  secondDegreeMaxRange: { min: 50, max: 400 },
  introductionFactor: { min: 0.0, max: 0.8 },
  // Bond affinity & degree
  bPassiveDecayRate: { min: 0.0, max: 0.001 },
  bPassiveRecoveryRate: { min: 0.0, max: 0.001 },
  maxBondsPerEntity: { min: 1, max: 6, integer: true },
  overcrowdingBondThreshold: { min: 1, max: 10, integer: true },
  // Look (visual only)
  element: { type: 'enum', values: ['bioluminescent', 'ice', 'fire', 'metallic'] },
  lighting: { type: 'enum', values: ['faux3d', 'flat'] },
  lightAngle: { min: 0, max: 360 },
  showWeather: { type: 'boolean' },
  trailFadeInterval: { min: 1, max: 60, integer: true },
  trailScale: { min: 0.25, max: 1 },
  renderScale: { min: 0, max: 2 },
};
