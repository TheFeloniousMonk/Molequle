"""
Molequle MCP Server

Enables Claude Desktop to observe and control the Emergent Art System
simulation via its REST API. Runs over stdio transport.
"""

import os
import json
from datetime import datetime
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

# ── Configuration ───────────────────────────────────────────────────────

API_BASE_URL = os.environ.get("MOLEQULE_API_URL", "http://localhost:3333")
CHARACTER_LIMIT = 25000

# ── API Client ──────────────────────────────────────────────────────────

client = httpx.Client(base_url=API_BASE_URL, timeout=15.0)


def api_get(endpoint: str, params: dict[str, str] | None = None) -> Any:
    """GET request to the Molequle server."""
    try:
        resp = client.get(endpoint, params=params)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        raise ConnectionError(
            f"Cannot reach Molequle server at {API_BASE_URL}. "
            "Make sure the server is running (cd server && npm start)."
        )
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"API error: {e.response.status_code} {e.response.reason_phrase}")


def api_post(endpoint: str, body: dict) -> Any:
    """POST request to the Molequle server."""
    try:
        resp = client.post(endpoint, json=body)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        raise ConnectionError(
            f"Cannot reach Molequle server at {API_BASE_URL}. "
            "Make sure the server is running (cd server && npm start)."
        )
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"API error: {e.response.status_code} {e.response.reason_phrase}")


def format_runtime(ms: int) -> str:
    """Format milliseconds as h:mm:ss."""
    secs = ms // 1000
    h = secs // 3600
    m = (secs % 3600) // 60
    s = secs % 60
    return f"{h}:{m:02d}:{s:02d}"


# ── MCP Server ──────────────────────────────────────────────────────────

mcp = FastMCP("Molequle")


# ── Tool: Get State ─────────────────────────────────────────────────────

@mcp.tool()
def molequle_get_state(detail: str = "summary") -> str:
    """Get the current simulation state snapshot.

    Returns population count, entity details, tick count, run time, config,
    smoother status, and seed. The simulation is a generative art system where
    entities with behavioral parameters (sociability, inertia, volatility,
    bond affinity, disruption charge) move, bond, disrupt, reproduce, and die
    in a space that accumulates its own history.

    Args:
        detail: Level of detail — 'summary' for overview with stats,
                'full' for complete state, 'entities' for entity list only.
    """
    state = api_get("/api/state")

    if state.get("status") == "no data yet":
        return (
            "No simulation data yet. The simulation may not be running — "
            "open http://localhost:3333 in a browser to start it."
        )

    entities = state.get("entities", [])
    alive = [e for e in entities if e.get("alive", True)]
    pop = len(alive)

    if detail == "entities":
        data = alive[:50] if len(alive) > 50 else alive
        text = json.dumps(data, indent=2)
        if len(alive) > 50:
            text += f"\n\n... truncated ({len(alive)} total entities, showing first 50)"
        return text

    if detail == "full":
        text = json.dumps(state, indent=2)
        if len(text) > CHARACTER_LIMIT:
            trimmed = {k: v for k, v in state.items() if k not in ("entities", "contextMap")}
            trimmed["entityCount"] = len(entities)
            trimmed["contextMapCells"] = len(state.get("contextMap", []))
            trimmed["note"] = (
                "Full entity and context map data truncated for size. "
                "Use detail='entities' or molequle_get_history for those."
            )
            text = json.dumps(trimmed, indent=2)
        return text

    # Summary mode
    param_keys = ["sociability", "inertia", "volatility", "bondAffinity", "disruptionCharge"]
    avgs = {}
    for key in param_keys:
        total = sum(e.get(key, 0) for e in alive)
        avgs[key] = f"{total / pop:.3f}" if pop > 0 else "N/A"

    total_bonds = sum(len(e.get("bonds", [])) for e in alive)

    lines = [
        "# Molequle State",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Tick | {state.get('tick', '?')} |",
        f"| Population | {pop} |",
        f"| Bonds | {total_bonds // 2} |",
        f"| Seed | {state.get('seed', '?')} |",
        f"| Smoother | {'ON' if state.get('smoother') else 'OFF'} |",
        f"| Run Time | {format_runtime(state['runTime']) if 'runTime' in state else '?'} |",
    ]
    # Weather info if available
    weather = state.get("weather")
    if weather:
        season = weather.get("season", {})
        lines.append(f"| Season | {season.get('name', '?')} (warmth {season.get('warmth', 0):.2f}) |")
        lines.append(f"| Blooms | {len(weather.get('blooms', []))} active |")
        lines.append(f"| Storms | {len(weather.get('storms', []))} active |")
        lines.append(f"| Currents | {len(weather.get('currents', []))} active |")
    lines += [
        "",
        "## Average Parameters",
        "| Parameter | Mean |",
        "|-----------|------|",
    ]
    for key in param_keys:
        lines.append(f"| {key} | {avgs[key]} |")

    received = state.get("receivedAt")
    if received:
        lines.append(f"\nLast updated: {datetime.fromtimestamp(received / 1000).strftime('%H:%M:%S')}")

    return "\n".join(lines)


# ── Tool: Get Events ────────────────────────────────────────────────────

@mcp.tool()
def molequle_get_events(
    since_tick: int = 0,
    event_type: str = "all",
    limit: int = 100,
) -> str:
    """Get the event log from the simulation.

    Events include bond formations, bond breaks, entity spawns, entity deaths,
    disruption cascades, and parameter shifts.

    Args:
        since_tick: Only return events after this tick number (default: 0 = all).
        event_type: Filter to a specific type — 'bond_formed', 'bond_broken',
                    'entity_spawned', 'entity_died', 'disruption_cascade',
                    'parameter_shift', or 'all'.
        limit: Maximum number of events to return (1–500, default: 100).
    """
    data = api_get("/api/events", params={"since": str(since_tick)})
    events = data.get("events", [])

    if event_type != "all":
        events = [e for e in events if e.get("type") == event_type]

    total = len(events)
    events = events[-limit:]

    since_str = f" (since tick {since_tick})" if since_tick > 0 else ""
    type_str = f" [type: {event_type}]" if event_type != "all" else ""
    lines = [
        "# Molequle Events",
        f"Showing {len(events)} of {total} events{since_str}{type_str}",
        "",
    ]

    for evt in events:
        d = evt.get("data", {})
        tick = evt.get("tick", "?")
        etype = evt.get("type", "?")

        if etype == "bond_formed":
            a = str(d.get("entityA", ""))[:8]
            b = str(d.get("entityB", ""))[:8]
            x, y = round(d.get("x", 0)), round(d.get("y", 0))
            detail = f"{a}..↔{b}.. at ({x}, {y})"
        elif etype == "bond_broken":
            a = str(d.get("entityA", ""))[:8]
            b = str(d.get("entityB", ""))[:8]
            detail = f"{a}..✕{b}.. age={d.get('bondAge')}"
        elif etype == "entity_spawned":
            eid = str(d.get("entityId", ""))[:8]
            x, y = round(d.get("x", 0)), round(d.get("y", 0))
            detail = f"{eid}.. cause={d.get('cause')} at ({x}, {y})"
        elif etype == "entity_died":
            eid = str(d.get("entityId", ""))[:8]
            detail = f"{eid}.. cause={d.get('cause')} age={d.get('age')}"
        elif etype == "disruption_cascade":
            did = str(d.get("disruptorId", ""))[:8]
            detail = f"by {did}.. affected={d.get('affectedCount')} bonds_weakened={d.get('bondsWeakenedCount')}"
        else:
            detail = json.dumps(d)[:100]

        lines.append(f"- **[{tick}]** `{etype}`: {detail}")

    return "\n".join(lines)


# ── Tool: Get Metrics ───────────────────────────────────────────────────

@mcp.tool()
def molequle_get_metrics(last_n: int = 20) -> str:
    """Get time-series metrics from the simulation.

    Each snapshot (taken every 300 ticks / ~5 seconds) includes population,
    bond count, births, deaths, disruption events, average and standard
    deviation of all 5 behavioral parameters, and context map cell counts.

    Use this to understand trends — population growth/decline, parameter
    convergence/divergence, emergence of fertile/scarred regions.

    Args:
        last_n: Number of most recent snapshots to return (1–200, default: 20).
    """
    data = api_get("/api/metrics")
    snapshots = data.get("snapshots", [])[-last_n:]

    if not snapshots:
        return (
            "No metrics data yet. The simulation may not have been running "
            "long enough (metrics are pushed every 300 ticks / ~5 seconds)."
        )

    latest = snapshots[-1]
    earliest = snapshots[0]

    lines = [
        "# Molequle Metrics",
        f"{len(snapshots)} snapshots from tick {earliest.get('tick')} to {latest.get('tick')}",
        "",
        f"## Latest Snapshot (tick {latest.get('tick')})",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Population | {latest.get('population')} |",
        f"| Bonds | {latest.get('bonds')} |",
        f"| Births (period) | {latest.get('births')} |",
        f"| Deaths (period) | {latest.get('deaths')} |",
        f"| Disruptions (period) | {latest.get('disruptionEvents')} |",
        f"| Fertile cells | {latest.get('fertileCount')} |",
        f"| Scarred cells | {latest.get('scarredCount')} |",
        f"| Ghost trail cells | {latest.get('ghostCount')} |",
        "",
    ]

    avg_params = latest.get("avgParams", {})
    std_params = latest.get("paramStdDev", {})
    if avg_params:
        lines.append("## Parameter Averages (latest)")
        lines.append("| Parameter | Mean | StdDev |")
        lines.append("|-----------|------|--------|")
        for key in avg_params:
            mean = f"{avg_params[key]:.3f}"
            std = f"{std_params.get(key, 0):.3f}"
            lines.append(f"| {key} | {mean} | {std} |")
        lines.append("")

    pop_values = [s.get("population", 0) for s in snapshots]
    lines.append("## Population Trend")
    lines.append(
        f"Range: {min(pop_values)}–{max(pop_values)} | "
        f"Start: {pop_values[0]} → Current: {pop_values[-1]} "
        f"({'+' if pop_values[-1] >= pop_values[0] else ''}{pop_values[-1] - pop_values[0]})"
    )

    return "\n".join(lines)


# ── Tool: Get History (Context Map) ─────────────────────────────────────

@mcp.tool()
def molequle_get_history(top_n: int = 20) -> str:
    """Get the accumulated spatial history (context map) of the simulation.

    The context map is a grid where each cell tracks bond formations, bond
    breaks, entity presence, and disruption events. This history becomes
    physics — fertile ground makes bonding easier, scar tissue increases
    volatility, ghost trails attract social entities.

    Args:
        top_n: Number of most notable cells to return (1–100, default: 20).
    """
    data = api_get("/api/history")

    if data.get("status") == "no data yet" or not data.get("contextMap"):
        return "No context map data yet."

    cells = data["contextMap"]

    # Score and sort by total activity
    scored = sorted(
        cells,
        key=lambda c: (
            c.get("bondFormations", 0)
            + c.get("bondBreaks", 0)
            + c.get("disruptionEvents", 0)
            + c.get("totalPresence", 0) / 100
        ),
        reverse=True,
    )
    top = scored[:top_n]

    # Classify totals
    fertile = sum(
        1
        for c in cells
        if c.get("bondFormations", 0) > c.get("bondBreaks", 0) * 1.5
        and c.get("bondFormations", 0) > 5
    )
    scarred = sum(
        1 for c in cells if c.get("bondBreaks", 0) > c.get("bondFormations", 0) * 1.5
    )
    disruption = sum(1 for c in cells if c.get("disruptionEvents", 0) > 10)

    lines = [
        "# Context Map Summary",
        f"Total active cells: {len(cells)} / 5184",
        f"Fertile: {fertile} | Scarred: {scarred} | Disruption zones: {disruption}",
        "",
        f"## Top {len(top)} Most Active Cells",
        "| Grid (x,y) | World ~(x,y) | Bonds+ | Bonds- | Disruptions | Presence | Type |",
        "|------------|-------------|--------|--------|-------------|----------|------|",
    ]

    for c in top:
        gx = c.get("gx", 0)
        gy = c.get("gy", 0)
        wx, wy = round(gx * 20 + 10), round(gy * 20 + 10)
        bf = c.get("bondFormations", 0)
        bb = c.get("bondBreaks", 0)
        de = c.get("disruptionEvents", 0)
        tp = round(c.get("totalPresence", 0))

        cell_type = "—"
        if bf > bb * 1.5 and bf > 5:
            cell_type = "Fertile"
        elif bb > bf * 1.5:
            cell_type = "Scarred"
        if de > 10:
            cell_type += ("+" if cell_type != "—" else "") + "Disruption"

        lines.append(
            f"| ({gx},{gy}) | ~({wx},{wy}) | {bf:.1f} | {bb:.1f} | {de:.1f} | {tp} | {cell_type} |"
        )

    return "\n".join(lines)


# ── Tool: Get Config ────────────────────────────────────────────────────

@mcp.tool()
def molequle_get_config() -> str:
    """Get the current simulation configuration — all tunable parameters.

    Includes bond radius, disruption threshold, max population, history
    half-life, and all other adjustable values.
    """
    data = api_get("/api/config")
    if data.get("status") == "no data yet":
        return "No config data yet. The simulation may not be running."
    return json.dumps(data.get("config", data), indent=2)


# ── Tool: Set Parameters ───────────────────────────────────────────────

VALID_PARAMS = {
    "bondRadius": (20, 80),
    "bondDuration": (20, 120),
    "bondRestDistance": (10, 60),
    "bondHardeningAge": (50, 500),
    "bondHardeningResistance": (0.05, 0.5),
    "bondedSociabilityFloor": (0.0, 0.4),
    "bondedVolatilityFloor": (0.0, 0.4),
    "disruptionThreshold": (0.3, 0.9),
    "disruptionRadius": (40, 150),
    "disruptionRegenCap": (0.3, 1.0),
    "spawnThreshold": (3, 10),
    "communityThreshold": (0.2, 0.8),
    "lonelinessThreshold": (200, 800),
    "crushThreshold": (6, 20),
    "maxPopulation": (100, 800),
    "maxAge": (5000, 50000),
    "halfLifeTicks": (1000, 20000),
    "trailDecayRate": (0.001, 0.01),
    "ticksPerFrame": (1, 5),
    "seasonLength": (2000, 50000),
    "seasonAmplitude": (0.0, 1.0),
    "currentCount": (0, 5),
    "currentStrength": (0.0, 1.0),
    "currentWidth": (50, 500),
    "currentLifetime": (1000, 20000),
    "currentSpawnRate": (0.0001, 0.002),
    "bloomSpawnRate": (0.00005, 0.001),
    "bloomRadiusMin": (50, 200),
    "bloomRadiusMax": (100, 400),
    "bloomLifetimeMin": (500, 5000),
    "bloomLifetimeMax": (1000, 10000),
    "bloomIntensity": (0.5, 3.0),
    "bloomMax": (0, 5),
    "stormSpawnRate": (0.00002, 0.0005),
    "stormRadiusMin": (40, 200),
    "stormRadiusMax": (80, 400),
    "stormLifetimeMin": (300, 3000),
    "stormLifetimeMax": (500, 5000),
    "stormIntensity": (0.5, 3.0),
    "stormMax": (0, 3),
    # Hue drift
    "hueDriftRate": (0.0, 0.1),
    "hueDriftBondForm": (0.0, 5.0),
    "hueDriftBondBreak": (0.0, 5.0),
    "hueDriftDisruption": (0.0, 2.0),
    "hueDriftTravel": (0.0, 1.0),
    # Size variance
    "sizeGrowthDuration": (100, 3000),
    "sizeBondScale": (0.0, 0.5),
    # Parameter overhaul
    "cabinFeverThreshold": (100, 2000),
    "cabinFeverRate": (0.00005, 0.002),
    "homeostasisRate": (0.0, 0.001),
    "volatilityFloor": (0.0, 0.3),
    "inertiaCeiling": (0.5, 1.0),
    "bondAffinityCeiling": (0.5, 1.0),
    "disruptionPostFireDrop": (0.05, 0.8),
    "driftNoiseScale": (0.0, 0.01),
    "noveltyThreshold": (200, 5000),
    "noveltyBoost": (0.0, 0.1),
}


@mcp.tool()
def molequle_set_params(params: str) -> str:
    """Adjust simulation parameters remotely.

    Changes are queued and applied on the client's next poll cycle (~2 seconds).

    Available parameters and their ranges:
      bondRadius: 20–80 (default 40)
      bondDuration: 20–120 (default 60)
      bondRestDistance: 10–60 (default 25) — spring rest distance between bonded entities
      bondHardeningAge: 50–500 (default 200) — ticks before bond resists disruption
      bondHardeningResistance: 0.05–0.5 (default 0.2) — damage multiplier for mature bonds
      bondedSociabilityFloor: 0.0–0.4 (default 0.15) — minimum S for bonded entities
      bondedVolatilityFloor: 0.0–0.4 (default 0.2) — minimum V for bonded entities
      disruptionThreshold: 0.3–0.9 (default 0.6)
      disruptionRadius: 40–150 (default 80)
      disruptionRegenCap: 0.3–1.0 (default 0.8) — max D from passive regen
      spawnThreshold: 3–10 (default 5)
      communityThreshold: 0.2–0.8 (default 0.4)
      lonelinessThreshold: 200–800 (default 400)
      crushThreshold: 6–20 (default 12)
      maxPopulation: 100–800 (default 500)
      maxAge: 5000–50000 (default 20000)
      halfLifeTicks: 1000–20000 (default 5000)
      trailDecayRate: 0.001–0.01 (default 0.003) — trail opacity decay per tick
      seasonLength: 2000-50000 (default 12000) -- ticks per full seasonal cycle
      seasonAmplitude: 0.0-1.0 (default 0.5) -- strength of seasonal effects
      currentCount: 0-5 (default 2) -- max simultaneous migration currents
      currentStrength: 0.0-1.0 (default 0.3) -- base push force of currents
      currentWidth: 50-500 (default 200) -- pixel width of currents
      currentLifetime: 1000-20000 (default 5000) -- average current duration
      currentSpawnRate: 0.0001-0.002 (default 0.0005) -- spawn probability per tick
      bloomSpawnRate: 0.00005-0.001 (default 0.0002) -- bloom spawn probability per tick
      bloomRadiusMin: 50-200 (default 100)
      bloomRadiusMax: 100-400 (default 250)
      bloomLifetimeMin: 500-5000 (default 2000)
      bloomLifetimeMax: 1000-10000 (default 5000)
      bloomIntensity: 0.5-3.0 (default 1.5) -- multiplier for bloom effects
      bloomMax: 0-5 (default 3) -- max simultaneous blooms
      stormSpawnRate: 0.00002-0.0005 (default 0.00008) -- storm spawn probability per tick
      stormRadiusMin: 40-200 (default 80)
      stormRadiusMax: 80-400 (default 200)
      stormLifetimeMin: 300-3000 (default 1000)
      stormLifetimeMax: 500-5000 (default 3000)
      stormIntensity: 0.5-3.0 (default 1.5) -- multiplier for storm effects
      stormMax: 0-3 (default 2) -- max simultaneous storms
      ticksPerFrame: 1–5 (default 1)
      cabinFeverThreshold: 100-2000 (default 500) -- ticks of low S before restlessness kicks in
      cabinFeverRate: 0.00005-0.002 (default 0.0003) -- S upward drift rate during cabin fever
      homeostasisRate: 0.0-0.001 (default 0.0001) -- drift rate back toward birth parameters (personality)
      volatilityFloor: 0.0-0.3 (default 0.1) -- universal V minimum (prevents system death)
      inertiaCeiling: 0.5-1.0 (default 0.85) -- hard I maximum (prevents frozen entities)
      bondAffinityCeiling: 0.5-1.0 (default 0.95) -- hard B maximum
      disruptionPostFireDrop: 0.05-0.8 (default 0.3) -- D drop after disruption fires (not to zero)
      driftNoiseScale: 0.0-0.01 (default 0.001) -- per-tick random walk magnitude (thermal noise)
      noveltyThreshold: 200-5000 (default 1000) -- ticks absent from cell to trigger V novelty boost
      noveltyBoost: 0.0-0.1 (default 0.03) -- one-time V spike when entering novel region
      hueDriftRate: 0.0-0.1 (default 0.02) -- base per-tick hue accumulation
      hueDriftBondForm: 0.0-5.0 (default 0.5) -- hue bump on bond formation
      hueDriftBondBreak: 0.0-5.0 (default 1.0) -- hue bump on bond break
      hueDriftDisruption: 0.0-2.0 (default 0.3) -- per-tick hue drift in disruption zones
      hueDriftTravel: 0.0-1.0 (default 0.1) -- per-tick hue drift at high speed
      sizeGrowthDuration: 100-3000 (default 600) -- ticks for newborn to reach full size
      sizeBondScale: 0.0-0.5 (default 0.1) -- size increase per active bond

    Args:
        params: JSON string of parameter names to values,
                e.g. '{"maxPopulation": 300, "disruptionThreshold": 0.5}'
    """
    try:
        param_dict = json.loads(params)
    except json.JSONDecodeError as e:
        return f"Error: Invalid JSON — {e}"

    invalid = [k for k in param_dict if k not in VALID_PARAMS]
    if invalid:
        return (
            f"Error: Unknown parameter(s): {', '.join(invalid)}.\n"
            f"Valid parameters: {', '.join(VALID_PARAMS.keys())}"
        )

    result = api_post("/api/params", param_dict)
    return (
        f"Parameters queued: {json.dumps(param_dict)}\n"
        f"{result.get('message', 'Will be applied on next client poll (~2s).')}"
    )


# ── Tool: Control ──────────────────────────────────────────────────────

@mcp.tool()
def molequle_control(command: str, seed: int | None = None) -> str:
    """Send control commands to the simulation.

    Commands are queued and applied on next client poll (~2 seconds).

    Args:
        command: One of 'pause', 'resume', 'reset', 'new_run',
                 'smoother_on', 'smoother_off'.
        seed: Optional seed for the 'new_run' command.
    """
    valid_commands = ["pause", "resume", "reset", "new_run", "smoother_on", "smoother_off"]
    if command not in valid_commands:
        return f"Error: Unknown command '{command}'. Valid: {', '.join(valid_commands)}"

    body: dict[str, Any] = {"command": command}
    if command == "new_run" and seed is not None:
        body["seed"] = seed

    api_post("/api/control", body)
    seed_str = f" Seed: {seed}" if seed is not None else ""
    return f"Command '{command}' queued.{seed_str} Will be applied on next client poll (~2s)."


# ── Tool: Get Trends ──────────────────────────────────────────────────

@mcp.tool()
def molequle_get_trends(
    tier: str = "all",
    since: int | None = None,
    last_n: int | None = None,
) -> str:
    """Get long-term trend data from the RRD-style trend store.

    The trend store preserves key simulation metrics at decreasing resolution
    over time — recent data at high resolution, older data compressed. Unlike
    the metrics buffer (which only holds ~2000 recent snapshots), the trend
    store is never pruned and survives server restarts.

    Tier 1 ("Recent"): every 300 ticks, up to 2,400 entries (~2 hours)
    Tier 2 ("Hours"): every 6,000 ticks, up to 1,728 entries (~48 hours)
    Tier 3 ("History"): every 72,000 ticks, unlimited (~20 min resolution)

    Each entry contains: population, bonds, births, deaths, disruptions,
    mean/std of all 5 behavioral parameters (S/I/V/B/D), context map cell
    counts, season info, active weather counts, bond density, avg entity age.

    Args:
        tier: Which tier(s) to return — '1', '2', '3', or 'all' (default: 'all').
        since: Only return entries after this tick number (optional).
        last_n: Maximum entries per tier (optional).
    """
    params = {}
    if tier != "all":
        params["tier"] = tier
    if since is not None:
        params["since"] = str(since)
    if last_n is not None:
        params["last_n"] = str(last_n)

    data = api_get("/api/trends", params=params)

    lines = ["# Molequle Trends", ""]

    for tier_key in ["tier1", "tier2", "tier3"]:
        entries = data.get(tier_key)
        if entries is None:
            continue
        tier_num = tier_key[-1]
        tier_names = {"1": "Recent (300-tick)", "2": "Hours (6k-tick)", "3": "History (72k-tick)"}
        lines.append(f"## Tier {tier_num} — {tier_names[tier_num]}")
        lines.append(f"Entries: {len(entries)}")

        if entries:
            first = entries[0]
            last = entries[-1]
            lines.append(f"Range: tick {first.get('tick', '?')} → {last.get('tick', '?')}")
            lines.append("")

            # Show latest entry summary
            e = last
            lines.append(f"**Latest** (tick {e.get('tick')}):")
            lines.append(f"  Pop: {e.get('population', 0)} | Bonds: {e.get('bonds', 0)} | "
                         f"Births: {e.get('births', 0)} | Deaths: {e.get('deaths', 0)} | "
                         f"Disruptions: {e.get('disruptions', 0)}")
            lines.append(f"  S={e.get('mean_S', 0):.3f} I={e.get('mean_I', 0):.3f} "
                         f"V={e.get('mean_V', 0):.3f} B={e.get('mean_B', 0):.3f} "
                         f"D={e.get('mean_D', 0):.3f}")
            lines.append(f"  Season: {e.get('season', '?')} (warmth {e.get('warmth', 0):.2f})")
            lines.append(f"  Blooms: {e.get('active_blooms', 0)} | "
                         f"Storms: {e.get('active_storms', 0)} | "
                         f"Currents: {e.get('active_currents', 0)}")

            # Population trend across this tier
            pops = [x.get("population", 0) for x in entries]
            lines.append(f"  Pop range: {min(pops)}–{max(pops)}")
        lines.append("")

    text = "\n".join(lines)
    if len(text) > CHARACTER_LIMIT:
        text = text[:CHARACTER_LIMIT] + "\n\n... truncated"
    return text


# ── Tool: Get Weather Log ─────────────────────────────────────────────

@mcp.tool()
def molequle_get_weather_log(
    since: int | None = None,
    type: str | None = None,
    last_n: int = 50,
) -> str:
    """Get the weather event log — lifecycle of blooms, storms, currents, and seasons.

    Records when weather events spawn, end, and when seasons change. Use this
    to correlate weather events with trend data: "Did bond count spike when
    a bloom appeared at tick 1,200,000?"

    Event types: bloom_spawn, bloom_end, storm_spawn, storm_end,
    current_spawn, current_end, season_change.

    Args:
        since: Only return events after this tick number (optional).
        type: Filter by event type, e.g. 'storm_spawn' (optional).
        last_n: Maximum events to return (default: 50).
    """
    params = {"last_n": str(last_n)}
    if since is not None:
        params["since"] = str(since)
    if type is not None:
        params["type"] = type

    data = api_get("/api/weather-log", params=params)
    events = data.get("events", [])
    total = data.get("total", len(events))

    type_str = f" [type: {type}]" if type else ""
    since_str = f" (since tick {since})" if since else ""

    lines = [
        "# Weather Event Log",
        f"Showing {len(events)} of {total} events{since_str}{type_str}",
        "",
    ]

    for evt in events:
        tick = evt.get("tick", "?")
        etype = evt.get("event_type", "?")
        details = evt.get("details", {})

        if "season" in etype:
            detail = f"{details.get('from', '?')} → {details.get('to', '?')} (warmth {details.get('warmth', 0):.2f})"
        elif "current" in etype:
            detail = (f"({details.get('x1', 0):.0f},{details.get('y1', 0):.0f})→"
                      f"({details.get('x2', 0):.0f},{details.get('y2', 0):.0f}) "
                      f"str={details.get('strength', 0):.2f}")
        else:
            detail = (f"at ({details.get('x', 0):.0f},{details.get('y', 0):.0f}) "
                      f"r={details.get('radius', 0):.0f} int={details.get('intensity', 0):.1f}")

        lines.append(f"- **[{tick}]** `{etype}`: {detail}")

    return "\n".join(lines)


# ── Tool: List Saves ───────────────────────────────────────────────────

@mcp.tool()
def molequle_list_saves() -> str:
    """List all saved state files.

    The simulation auto-saves every ~50 seconds. Returns filenames sorted
    by most recent first.
    """
    data = api_get("/api/saves")
    saves = data.get("saves", [])

    if not saves:
        return "No saved states found."

    lines = [f"# Saved States ({len(saves)})", ""]
    for i, f in enumerate(saves, 1):
        # Extract timestamp from filename like state-1710000000000.json
        ts = ""
        if f.startswith("state-") and f.endswith(".json"):
            try:
                ms = int(f[6:-5])
                ts = datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                ts = "?"
        lines.append(f"{i}. `{f}` — {ts}")

    return "\n".join(lines)


# ── Entry Point ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
