# Molequle

Molequle — an emergent art system. Bioluminescent entities that bond, form families, and leave trails.

Entities with continuous behavioral parameters move through a shared 1920x1080 canvas, form bonds, disrupt each other, reproduce, and die. The space accumulates a history of what's happened in it, and that history becomes a force that shapes future behavior. Color becomes biography — each entity's hue drifts over its lifetime based on what it's experienced.

## Quick Start

```bash
cd server
npm install
npm start
```

Open **http://localhost:3333** in your browser. The simulation starts automatically.

## Controls

### Keyboard
| Key | Action |
|-----|--------|
| Space | Pause / Resume |
| M | Toggle context map overlay |
| T | Toggle trails |
| S | Toggle The Smoother |
| R | Reset (same seed) |
| N | New run (random seed) |

### UI Panel
A mini-status bar in the header shows population, bonds, and current season at a glance. Click the gear icon to open the slide-out control panel, which contains collapsible accordion sections:
- **Status** — live population, bonds, parameter averages (S/I/V/B/D bars), tick, run time, seed, smoother state, weather conditions
- **Charts** — population over time and parameter distribution bars
- **Simulation** — speed slider, seed input, new run / reset buttons
- **Bonds** — bond radius, duration, rest distance, hardening, bonded floors
- **Disruption** — disruption threshold, radius, regen cap
- **Population** — spawn threshold, community/loneliness/crush thresholds, max population, max age
- **Weather** — season length/amplitude, current/bloom/storm parameters
- **Visual** — trail decay rate, context map half-life
- **Toggles** — The Smoother, context map, trails, pause

## REST API

The server exposes a REST API for observing and controlling the simulation remotely.

### Read Endpoints
| Endpoint | Description |
|----------|-------------|
| `GET /api/state` | Current simulation snapshot (entities, config, context map) |
| `GET /api/events?since=TICK` | Event log (bonds, deaths, spawns, disruptions) |
| `GET /api/metrics` | Time series of population, bonds, and parameter averages |
| `GET /api/history` | Accumulated context map data |
| `GET /api/config` | Current configuration values |
| `GET /api/saves` | List of saved state files |
| `GET /api/load` | Load most recent saved state |

### Write Endpoints
| Endpoint | Description |
|----------|-------------|
| `POST /api/params` | Queue parameter changes (e.g., `{"maxPopulation": 300}`) |
| `POST /api/control` | Send control commands (see below) |

### Control Commands
POST to `/api/control` with a JSON body:
```json
{"command": "pause"}
{"command": "resume"}
{"command": "reset"}
{"command": "new_run", "seed": 12345}
{"command": "smoother_on"}
{"command": "smoother_off"}
```

## How It Works

### Entities
Each entity has five behavioral parameters (all continuous 0-1):
- **Sociability** — attraction to others
- **Inertia** — resistance to movement (high = stationary + influential)
- **Volatility** — rate of parameter change (the meta-parameter)
- **Bond Affinity** — readiness to form connections
- **Disruption Charge** — how much the entity perturbs its surroundings

Parameters drift based on local conditions. There are no fixed types — behavioral profiles emerge and shift.

### Context Map
The space is divided into a grid. Each cell tracks bond formations, bond breaks, entity presence, and disruption events. This accumulated history creates terrain effects:
- **Fertile ground** — where bonds succeeded, bonding is easier
- **Scar tissue** — where bonds failed, volatility increases
- **Ghost trails** — echoes of old density attract social entities
- **Disruption zones** — volatile areas amplify chaos

### Visual Layer
- **Hue drift** — entities accumulate a color offset over their lifetime. Bond formation, bond loss, disruption exposure, and travel speed all shift an entity's hue. Two entities with identical parameters but different histories look different.
- **Size variance** — bonded entities render slightly larger. Newborns grow in over their first ~10 seconds.
- **Trails** — semi-transparent marks at each entity's position persist on a separate canvas, fading slowly. Family patrol patterns and migration routes become visible as warm underlayers.

### Weather
Seasonal cycles, migration currents, fertility blooms, and disruption storms add environmental pressure. Seasons modulate bond formation rates, movement speed, and disruption thresholds. Weather effects are tunable via the API.

### The Smoother
A toggleable rule that suppresses high-variance behavior. Disruption trends toward zero, volatility trends toward a baseline. The question: does suppressing variance produce stability or monoculture?

## Claude Desktop Extension (.mcpb)

A desktop extension lets Claude Desktop observe and control the simulation directly.

### Install

Double-click `molequle.mcpb` (in the project root) to install in Claude Desktop. It will prompt for the server URL (default: `http://localhost:3333`).

### Rebuild from Source

```bash
cd mcp
pip install --target lib mcp httpx
npx @anthropic-ai/mcpb pack . ../molequle.mcpb
```

### Available Tools

| Tool | Description |
|------|-------------|
| `molequle_get_state` | Get simulation snapshot (summary, full, or entities only) |
| `molequle_get_events` | Get event log with filtering by type and tick range |
| `molequle_get_metrics` | Get time-series data (population, params, terrain stats) |
| `molequle_get_history` | Get context map — the spatial memory of the simulation |
| `molequle_get_config` | Get current configuration values |
| `molequle_set_params` | Adjust simulation parameters remotely |
| `molequle_control` | Pause, resume, reset, toggle smoother, start new run |
| `molequle_list_saves` | List saved state files |

The Molequle server must be running for the MCP tools to work.

## State Persistence
The simulation auto-saves every ~50 seconds. On reload, it resumes from the last saved state. State files are stored in `server/data/`.

## Project Structure
```
emergent-system/
  server/
    index.js          Express server + REST API
    package.json
    data/             Saved state files
  client/
    index.html
    css/style.css
    js/
      main.js         Entry point, animation loop, orchestration
      entity.js       Entity class with parameters and behavior
      context-map.js  Accumulated history grid
      renderer.js     Canvas rendering (entities, trails, overlays)
      events.js       Event logging and server communication
      ui.js           Control panel, sliders, charts
      weather.js      Seasonal cycles, currents, blooms, storms
      prng.js         Seeded random number generator
  mcp/
    manifest.json     MCPB extension manifest
    server/main.py    Python MCP server (FastMCP)
    requirements.txt
    lib/              Bundled Python dependencies
  molequle.mcpb       Packaged desktop extension
```

## License

MIT
