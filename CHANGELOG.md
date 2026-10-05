# Changelog

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
