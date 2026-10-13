# Changelog

## 2.1.0 — 2026-10-13

**Simulation change: physics version 2.** New worlds are deterministic: the
same seed and settings grow the same world in every browser, on every Node
version and platform, and a reloaded save continues the exact history. A new
world grows a different history than the same seed did in 2.0.x (in Node 24,
from the first storm on; in browsers, sooner). **Saved worlds
from before 2.1 load as physics version 1 and keep running exactly as they
did** (verified bit for bit against 2.0.4), unless you upgrade them.

### Why
The Seed Exchange found seed 23 (cap 800, Smoother off) growing different
worlds on Node 22 and Node 24 from the same harness: one `Math.pow` call in the
storm-intensity curve differed by one ulp at tick 3183, and by tick 5000, 1684
of 2000 state hashes differed. JavaScript only approximates `sin`, `cos`,
`log`, `pow` and friends, so engines may legally differ in the last bit, and
Molequle amplifies that into a different world. Credits: Ori Zornitsa found
the function and wrote `molequle-trace.mjs`; Orien Code posted the falsifiable
Node 24 prediction; Framework spotted the seed-23 mismatch; Octave identified
the spec clause and proposed the Math-call log; Lucero named it: the soil has
a grain. Brief by Jinx.

### Added
- **Deterministic math (`dmath`).** The simulation core's 8 approximated call
  sites (`sin` ×5, `cos` ×2, `log` ×1, `pow` ×1 — seasons, storm and bloom
  curves, current direction, autumn pressure, the gaussian in reproduction)
  now use a port of fdlibm built only from operations JavaScript fixes to the
  bit. `sin`, `cos` and `log` match Node 24's `Math` bit for bit; `pow` is
  within 1 ulp of it, so curves keep their shape (the storm curve differs from
  the old one by at most 4.4e-16). Rendering still uses native `Math`.
- **Chaos knobs**, all off by default, each with its own random stream from
  the seed (so chaos runs are reproducible, and a knob at zero is
  byte-identical to the knob not existing):
  - `mathMode`: `deterministic` (default) or `platform` (native `Math`,
    engine-dependent on purpose).
  - `perturb`: one-shot nudges by N ulps at a given tick — an entity
    parameter, a weather value, or `random`.
  - `cosmicRate` / `cosmicMode`: rare random bit flips in entity parameters,
    per entity per 1,000 ticks; `fixed16` (16-bit, most flips tiny, a few
    dramatic) or `ieee754` (a float64 bit, clamped to [0, 1]).
  Every perturbation and flip is logged with before/after values (`perturb`
  events also carry the float64 bit patterns); cosmic flips also go to the
  weather log. Settable from the panel (new **Physics & Chaos** section), the
  REST API and `molequle_set_params`. Changing one mid-run logs a
  `config_change` event, with a warning for physics and math changes.
- **`physicsVersion`** in config, saves and run headers. Version 2: dmath and
  exact resume. Version 1: Molequle before 2.1 (native `Math`, approximate
  resume). New runs start at version 2; `reset` keeps the world's version.
- **Exact resume** for version 2 worlds: saves carry the random generators'
  state, spawn cooldowns and a full-precision context map. (Before, reloading
  re-seeded the generator approximately and rounded the context map, so a
  reloaded world drifted from the uninterrupted one.)
- **Headless harness, `tools/molequle-play.mjs`**: recipes (`seed`, `load`,
  `set`, `perturb`, `run`, `trace`, `hash`, `events`, `mathlog`, `save`,
  `header`) and `selftest` (seed 23, 500 ticks against shipped hashes: PASS,
  or the run header and first differing tick). `trace` and `mathlog` are
  modeled on Ori's `molequle-trace.mjs`. The simulation core moved out of
  `main.js` into `client/js/sim.js` so Node and the browser run the same code.
- **Tests and CI.** Golden traces (seeds 7, 11, 23, 42 at cap 800, Smoother
  off and on, 5,000 ticks, plus two chaos runs with their flip logs), dmath
  accuracy, chaos and exact-resume checks, a legacy test that compares physics
  version 1 against 2.0.4 from git, and a lint guard that fails on any
  approximated `Math` call or non-integer `**` in the simulation core. All run
  on Node 22 and 24 × Linux, Windows and macOS on every push.
- The run header now includes the chaos settings, and the harness adds its
  own and the simulation code's sha256.

### Fixed
- **The weather log lost blooms, storms and currents, and never said where
  they were.** It diffed state snapshots by `x`/`y` (currents by `x1`/`y1`),
  but the client reports `center`, `origin`, `direction` and an `id`, so
  every bloom keyed as `NaN,NaN`: a second bloom never logged a spawn, its
  end was only logged once all blooms were gone, and
  `molequle_get_weather_log` printed every event "at (0,0)". The log now takes
  spawns and ends from the client's own weather events, as it already did for
  cosmic flips: exact ticks, every bloom even between two state pushes, and
  no false spawns or ends when a save loads or a new run starts. Each entry
  carries the id; blooms and storms their center and radius, currents their
  origin and direction. Ends repeat the location and add the lifetime, peak
  intensity (or a current's width and peak strength). New `bloom_peak` and
  `storm_peak` events record the peak intensity. Season changes still come
  from state snapshots. Older log entries print without a location. Server
  and MCP only; the simulation is unchanged.

### Verified
- All 10 golden traces, the selftest, and the chaos, resume and legacy tests
  pass on Node 22 and Node 24, on Linux (x64), Windows (x64) and macOS
  (Apple Silicon).
- Chrome 152 and Node 24 grow identical worlds under physics version 2 (seed
  23, every entity field, bond and weather value at tick 3080); under version
  1 they diverge.
- A version 2 world with cosmic rays, saved by the app, reloaded in the
  browser and run past a scheduled perturbation, is identical to an
  uninterrupted Node run.
- Physics version 1 is bit-identical to 2.0.4: fresh worlds (seed 23 to tick
  3500, seed 4242) and a reloaded 2.0.4-style save.

## 2.0.4 — 2026-10-13

No simulation change; simulation results are byte-identical to 2.0.3.

### Added
- **Run header.** Every state push and save now records the physics version
  (1), math mode, seed, and the runtime and platform the world ran on.
  `molequle_get_state` prints it as one line; include it when you share a
  seed. Groundwork for deterministic physics: the Seed Exchange found that
  seed 23 grows different worlds on Node 22 and Node 24, because one
  `Math.pow` call differs by one ulp at tick 3183.

### Fixed
- **`molequle_get_trends` now returns the series, not just the latest
  entry.** Each tier keeps its "Latest" summary and adds a table, one row per
  entry: tick, population, bonds, disruptions, and mean S/I/V/B/D. It
  respects `since` and `last_n`. If the full series would exceed the response
  limit, rows are sampled evenly across the tier instead of cutting off the
  end.
- **Trend entries recorded season `''` and warmth `0`.** The client reported
  warmth as `seasonPhase` and no season name, so the trend store never got
  either. It now gets both. Entries recorded before this update can't be
  backfilled, so the trend output leaves out the season line for them instead
  of showing zeros.

## 2.0.3 — 2026-10-05

Visual only; simulation results are byte-identical to 2.0.2.

### Changed
- **Metallic is brighter, and its brightest nodes look like polished mirror.**
  Brighter ramp with a near-white chrome band at the top, stronger lit-side
  sheen, a Fresnel-style bright rim, and a gleam that grows with surface
  brightness. Mirror finish scales with each node's brightness, so dark
  gunmetal stays dark.
- **Trails persist about a third longer** — default `trailDecayRate` lowered
  again (0.0015 → 0.001125) and faint-trail cleanup slowed to match. Worlds
  saved with an earlier default pick up the new one on load; custom values
  are kept.

## 2.0.2 — 2026-10-05

**Simulation change: 2.0.2 worlds are not byte-identical to 2.0.1.** The same
seed and config will grow a (slightly) different world from here on.

### Fixed
- **Bond affinity could go briefly negative.** The failed-proximity
  discouragement in `tryFormBond()` subtracted 0.001 from both entities' bond
  affinity *after* `update()` had already clamped it, so B could dip below 0
  (about −0.01 to −0.02; lower when several neighbors discouraged an entity in
  the same tick) until the next tick re-clamped it. It's now floored at 0. The
  effect is tiny: reproduction's community check was averaging in slightly
  negative values. Found by Orien Code (House of Threads).

## 2.0.1 — 2026-10-05

Documentation only; no code changes from 2.0.0.

- Made clear that the Claude Desktop extension (`.mcpb`) is **local only**: it
  talks to the Molequle server from this project running on your machine and
  does nothing on its own. Called out in the README Quick Start (get the whole
  project first), the README extension section, and the extension's own
  description shown in Claude Desktop.

## 2.0.0 — 2026-10-05

**Visual update. 2.0 changes rendering only: simulation results are unchanged
from the previous release** (the one that included the bond-affinity
passive-term fix). The same seed and config produce a byte-identical world in
1.x and 2.0 (verified: seed 4242 to tick 5000, serialized entity state
compared byte for byte; and the running app with the new renderer matches the
simulation run with no renderer at all).

### Added
- **Elements** — `element`: `bioluminescent` (default, the original look),
  `ice`, `fire`, `metallic`. Each has its own color ramp, glow, highlight,
  shadow, and opacity; bonds, trails, and weather are tinted to match.
  Press **E** to cycle, or use the selector in the panel.
- **Faux-3D lighting** — shaded spheres with a specular highlight toward one
  global light (`lightAngle`, default 225 = upper left) and a shadow crescent
  opposite. `lighting: "flat"` for plain disks.
- **Weather you can see** — storms dim and desaturate the entities inside
  them, with a cold rim and occasional lightning; blooms are a warm upwelling
  glow; currents are drifting streaks; seasons shift a tint and vignette.
  Element flavors: frost sparkles (ice), embers (fire), static sparks
  (metallic), a dark storm cloud (bioluminescent). `showWeather` toggles all
  weather visuals.
- New parameters (all visual): `element`, `lighting`, `lightAngle`,
  `showWeather`, `trailFadeInterval`, `trailScale`, `renderScale`. They are
  saved with the run, settable via `POST /api/params` and
  `molequle_set_params`, and published at `GET /api/param-ranges`, whose
  schema now supports enum and boolean parameters.
- `?dev` in the URL samples mean trail-layer brightness every 300 frames into
  `window.__molequleDev.trailLuminance`.
- `POST /api/flush` saves trend history and the weather log immediately —
  call it before stopping a server that isn't running in a terminal.

### Changed
- **Sprite-based rendering** — entities are drawn from pre-rendered sprite
  atlases (glow, lit body, highlight; several mip levels so small entities
  stay crisp) instead of per-frame `shadowBlur`. One texture per layer pass;
  bonds, trails, and particles are batched; no per-frame allocation.
- **Resolution** — `renderScale` (default: device pixel ratio, capped at 1.5)
  sets the main canvas resolution; sharper on high-DPI displays.
- **Trails** — drawn as continuous ribbons on a lower-resolution layer
  (`trailScale`, default 0.5) composited into the main canvas.
- **Trails persist about twice as long** — default `trailDecayRate` halved
  (0.003 → 0.0015) so complex patterns can build up. Worlds saved with the old
  default pick up the new one on load; custom values are kept.
- `crushThreshold` range widened to 6–40.
- Panel: element selector, 3D lighting and weather toggles, light angle slider.

### Fixed
- **Trails never fully faded ("puke stage")** — the per-frame fade used an
  alpha so small that 8-bit rounding stalled it ~130 levels above the
  background, so residue piled up into a muddy wash. The fade now runs every
  `trailFadeInterval` frames (default 10) with the same total decay, and two
  cheap composite passes remove what 8-bit rounding leaves behind. Idle
  regions return exactly to the background color within ~10 seconds.
- Panel toggles now update their on/off state when clicked (previously only
  keyboard shortcuts refreshed them).
- Trend history and the weather log could lose up to ~20 minutes of data if
  the server was stopped without a graceful shutdown, because they only saved
  when enough new data arrived. Both now also save every 5 minutes when they
  have unsaved data.

### Notes
- Bond degree cap: no path lets an entity exceed `maxBondsPerEntity` during a
  run (audited over 40,000 ticks; bonds are only created after both
  entities pass the cap check, and stay symmetric). Lowering the cap at
  runtime doesn't remove existing bonds. Several bond lines meeting at one
  bright point are overlapping entities, not one over-bonded entity.
- Determinism holds within one JavaScript engine. Browsers can differ in the
  last bit of `Math.sin`/`Math.log`/etc., so the same seed may grow a
  different world in a different browser.

## 1.x — before versioning

- Bond affinity's passive decay and recovery balanced (B no longer climbs to
  its ceiling); `maxBondsPerEntity`, `bPassiveDecayRate`,
  `bPassiveRecoveryRate`, `overcrowdingBondThreshold` tunable.
- One parameter schema (`client/js/params.js`) shared by client, server, and
  MCP; saves named with their seed; immediate autosave on new run.
- Simulation ~8–9× faster at 500 entities with bit-identical results;
  state push/save moved off the animation frame and sliced into small steps.
- MCP extension fixed for Claude Desktop launching `python3`.
