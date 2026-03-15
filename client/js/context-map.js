// Context Map — 2D grid overlay tracking spatial history of the simulation
// Each cell accumulates bond events, presence, and disruption data
// Used by entities to make terrain-aware decisions

export class ContextMap {
  /**
   * @param {number} gridCols - Number of columns (default 96)
   * @param {number} gridRows - Number of rows (default 54)
   * @param {number} canvasWidth - Canvas width in pixels (default 1920)
   * @param {number} canvasHeight - Canvas height in pixels (default 1080)
   */
  constructor(gridCols = 96, gridRows = 54, canvasWidth = 1920, canvasHeight = 1080) {
    this.gridCols = gridCols;
    this.gridRows = gridRows;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.cellWidth = canvasWidth / gridCols;   // 20px per cell
    this.cellHeight = canvasHeight / gridRows; // 20px per cell

    // Initialize grid as 2D array
    this.grid = [];
    for (let gy = 0; gy < gridRows; gy++) {
      this.grid[gy] = [];
      for (let gx = 0; gx < gridCols; gx++) {
        this.grid[gy][gx] = this._emptyCell();
      }
    }
  }

  _emptyCell() {
    return {
      bondFormations: 0,
      bondBreaks: 0,
      totalPresence: 0,
      disruptionEvents: 0,
      lastActivity: 0
    };
  }

  /**
   * Convert world coordinates to grid indices, clamped to valid range.
   */
  _toGrid(worldX, worldY) {
    const gx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(worldX / this.cellWidth)));
    const gy = Math.max(0, Math.min(this.gridRows - 1, Math.floor(worldY / this.cellHeight)));
    return { gx, gy };
  }

  /**
   * Returns the cell object for a world coordinate.
   */
  getCell(worldX, worldY) {
    const { gx, gy } = this._toGrid(worldX, worldY);
    return this.grid[gy][gx];
  }

  /**
   * Direct grid access by grid coordinates.
   */
  getCellByGrid(gx, gy) {
    if (gx < 0 || gx >= this.gridCols || gy < 0 || gy >= this.gridRows) return null;
    return this.grid[gy][gx];
  }

  /**
   * Increment totalPresence for the cell at (worldX, worldY).
   */
  incrementPresence(worldX, worldY) {
    const cell = this.getCell(worldX, worldY);
    cell.totalPresence += 1;
  }

  /**
   * Record a bond formation event at the given world position.
   */
  recordBondFormation(worldX, worldY, tick) {
    const cell = this.getCell(worldX, worldY);
    cell.bondFormations += 1;
    cell.lastActivity = tick;
  }

  /**
   * Record a bond break event at the given world position.
   */
  recordBondBreak(worldX, worldY, tick) {
    const cell = this.getCell(worldX, worldY);
    cell.bondBreaks += 1;
    cell.lastActivity = tick;
  }

  /**
   * Record a disruption event at the given world position.
   */
  recordDisruption(worldX, worldY, tick) {
    const cell = this.getCell(worldX, worldY);
    cell.disruptionEvents += 1;
    cell.lastActivity = tick;
  }

  /**
   * Compute terrain effects for the cell at (worldX, worldY).
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} currentTick - Required for ghost trail detection
   * @returns {object} Terrain effect descriptors
   */
  getTerrainEffects(worldX, worldY, currentTick = 0) {
    const cell = this.getCell(worldX, worldY);
    const { bondFormations, bondBreaks, totalPresence, disruptionEvents, lastActivity } = cell;

    const isScarred = bondBreaks > bondFormations * 1.5;
    const scarIntensity = isScarred
      ? Math.min(1.0, (bondBreaks - bondFormations * 1.5) / Math.max(1, bondBreaks))
      : 0;

    const isFertile = bondFormations > bondBreaks * 1.5 && bondFormations > 5;

    const rawFertility = 1.0 + (bondFormations - bondBreaks) / 100;
    const fertilityModifier = Math.max(0.5, Math.min(2.0, rawFertility));

    const isGhostTrail = totalPresence > 500 && (currentTick - lastActivity) > 500;

    const isDisruptionZone = disruptionEvents > 10;

    let bondFormationModifier = 1.0;
    if (isScarred) bondFormationModifier = 0.5;
    else if (isFertile) bondFormationModifier = 1.5;

    return {
      isScarred,
      scarIntensity,
      isFertile,
      fertilityModifier,
      isGhostTrail,
      isDisruptionZone,
      bondFormationModifier
    };
  }

  /**
   * Decay all cell values by multiplying by (1 - decayRate).
   * @param {number} decayRate - Default: 1/5000 (half-life of ~5000 ticks)
   */
  decay(decayRate = 1 / 5000) {
    const factor = 1 - decayRate;
    for (let gy = 0; gy < this.gridRows; gy++) {
      for (let gx = 0; gx < this.gridCols; gx++) {
        const cell = this.grid[gy][gx];
        cell.bondFormations *= factor;
        cell.bondBreaks *= factor;
        cell.totalPresence *= factor;
        // disruptionEvents is an integer count of discrete cascades — not decayed
        // lastActivity is a tick timestamp, not decayed
      }
    }
  }

  /**
   * Returns a sparse array of cells with non-trivial values (for serialization).
   * Only includes cells where at least one numeric field is above a small threshold.
   */
  toSparse() {
    const sparse = [];
    for (let gy = 0; gy < this.gridRows; gy++) {
      for (let gx = 0; gx < this.gridCols; gx++) {
        const cell = this.grid[gy][gx];
        // Only include cells with meaningful activity
        if (
          cell.bondFormations > 0 ||
          cell.bondBreaks > 0 ||
          cell.totalPresence > 5.0 ||
          cell.disruptionEvents > 0
        ) {
          const entry = { gx, gy };
          // Short keys, rounded to 2dp (floats) or kept as-is (integers)
          if (cell.bondFormations > 0) entry.bf = Math.round(cell.bondFormations * 100) / 100;
          if (cell.bondBreaks > 0) entry.bb = Math.round(cell.bondBreaks * 100) / 100;
          if (cell.totalPresence > 5.0) entry.tp = Math.round(cell.totalPresence * 100) / 100;
          if (cell.disruptionEvents > 0) entry.de = cell.disruptionEvents; // integer count
          if (cell.lastActivity > 0) entry.la = cell.lastActivity;
          sparse.push(entry);
        }
      }
    }
    return sparse;
  }

  /**
   * Restore grid state from a sparse array representation.
   * Resets all cells first, then applies sparse data.
   */
  fromSparse(sparseArray) {
    // Reset all cells
    for (let gy = 0; gy < this.gridRows; gy++) {
      for (let gx = 0; gx < this.gridCols; gx++) {
        this.grid[gy][gx] = this._emptyCell();
      }
    }
    // Apply sparse data — supports both old (long key) and new (short key) formats
    for (const entry of sparseArray) {
      const { gx, gy } = entry;
      if (gx >= 0 && gx < this.gridCols && gy >= 0 && gy < this.gridRows) {
        this.grid[gy][gx] = {
          bondFormations: entry.bf ?? entry.bondFormations ?? 0,
          bondBreaks: entry.bb ?? entry.bondBreaks ?? 0,
          totalPresence: entry.tp ?? entry.totalPresence ?? 0,
          disruptionEvents: entry.de ?? entry.disruptionEvents ?? 0,
          lastActivity: entry.la ?? entry.lastActivity ?? 0
        };
      }
    }
  }
}
