// ui.js — Accordion-based control panel, mini-status header, parameter sliders, charts, toggles

export class UI {
  constructor(config, callbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.metricsHistory = []; // last 500 population readings for chart
    this.lastUpdateTick = 0;

    this.panelEl = document.getElementById('control-panel');
    this.overlayEl = document.getElementById('panel-overlay');
    this.panelInner = document.getElementById('panel-inner');
    this.gearBtn = document.getElementById('gear-btn');

    // Wire up panel open/close
    this.gearBtn.addEventListener('click', () => this.togglePanel());
    this.overlayEl.addEventListener('click', () => this.togglePanel());

    this.buildSections();
  }

  // ── Panel toggle ────────────────────────────────────────────────────

  togglePanel() {
    this.panelEl.classList.toggle('panel-open');
    this.overlayEl.classList.toggle('panel-open');
  }

  // ── Build all accordion sections ────────────────────────────────────

  buildSections() {
    this.panelInner.innerHTML = '';

    // 1. STATUS (expanded)
    this.panelInner.appendChild(this._buildStatusSection());

    // 2. CHARTS (collapsed)
    this.panelInner.appendChild(this._buildChartsSection());

    // 3. SIMULATION (collapsed)
    this.panelInner.appendChild(this._buildSimulationSection());

    // 4. BONDS (collapsed)
    this.panelInner.appendChild(this._buildBondsSection());

    // 5. DISRUPTION (collapsed)
    this.panelInner.appendChild(this._buildDisruptionSection());

    // 6. POPULATION (collapsed)
    this.panelInner.appendChild(this._buildPopulationSection());

    // 7. WEATHER (collapsed)
    this.panelInner.appendChild(this._buildWeatherSection());

    // 8. VISUAL (collapsed)
    this.panelInner.appendChild(this._buildVisualSection());

    // 9. TOGGLES (expanded)
    this.panelInner.appendChild(this._buildTogglesSection());
  }

  // ── Accordion section factory ───────────────────────────────────────

  _createSection(title, expanded, contentBuilder) {
    const section = document.createElement('div');
    section.className = 'section' + (expanded ? ' expanded' : '');

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `<span>${title}</span><span class="chevron">&#9656;</span>`;
    header.addEventListener('click', () => section.classList.toggle('expanded'));
    section.appendChild(header);

    const content = document.createElement('div');
    content.className = 'section-content';
    contentBuilder(content);
    section.appendChild(content);

    return section;
  }

  // ── 1. STATUS ───────────────────────────────────────────────────────

  _buildStatusSection() {
    return this._createSection('STATUS', true, (container) => {
      container.innerHTML = `
        <div class="status-row">
          <span class="status-label">Population</span>
          <span class="status-value" id="status-population">0</span>
        </div>
        <div class="status-row">
          <span class="status-label">Bonds</span>
          <span class="status-value" id="status-bonds">0</span>
        </div>
        <hr class="status-separator">
        <div id="param-bars"></div>
        <hr class="status-separator">
        <div class="status-row">
          <span class="status-label">Tick</span>
          <span class="status-value" id="status-tick">0</span>
        </div>
        <div class="status-row">
          <span class="status-label">Run Time</span>
          <span class="status-value" id="status-runtime">0:00:00</span>
        </div>
        <div class="status-row">
          <span class="status-label">Seed</span>
          <span class="status-value" id="status-seed">-</span>
        </div>
        <div class="status-row">
          <span class="status-label">Smoother</span>
          <span class="status-value" id="status-smoother">OFF</span>
        </div>
        <hr class="status-separator">
        <div class="status-row">
          <span class="status-label">Season</span>
          <span class="status-value" id="status-season">-</span>
        </div>
        <div class="status-row">
          <span class="status-label">Warmth</span>
          <span class="status-value" id="status-warmth">-</span>
        </div>
        <div class="status-row">
          <span class="status-label">Blooms</span>
          <span class="status-value" id="status-blooms">0</span>
        </div>
        <div class="status-row">
          <span class="status-label">Storms</span>
          <span class="status-value" id="status-storms">0</span>
        </div>
        <div class="status-row">
          <span class="status-label">Currents</span>
          <span class="status-value" id="status-currents">0</span>
        </div>
      `;

      // Parameter bar indicators
      const paramBars = container.querySelector('#param-bars');
      const params = ['Sociability', 'Inertia', 'Volatility', 'Bond Affinity', 'Disruption'];
      const paramKeys = ['sociability', 'inertia', 'volatility', 'bondAffinity', 'disruptionCharge'];

      for (let i = 0; i < params.length; i++) {
        const bar = document.createElement('div');
        bar.className = 'param-bar-container';
        bar.innerHTML = `
          <div class="param-bar-label">
            <span>${params[i]}</span>
            <span id="param-val-${paramKeys[i]}">0.50</span>
          </div>
          <div class="param-bar">
            <div class="param-bar-fill" id="param-bar-${paramKeys[i]}" style="width:50%"></div>
          </div>
        `;
        paramBars.appendChild(bar);
      }
    });
  }

  // ── 2. CHARTS ───────────────────────────────────────────────────────

  _buildChartsSection() {
    return this._createSection('CHARTS', false, (container) => {
      container.innerHTML = `
        <div class="mini-chart">
          <h3>Population Over Time</h3>
          <canvas id="chart-population" width="400" height="100"></canvas>
        </div>
        <div class="mini-chart">
          <h3>Parameter Distribution</h3>
          <canvas id="chart-params" width="400" height="120"></canvas>
        </div>
      `;

      // Defer canvas reference until DOM is ready
      requestAnimationFrame(() => {
        this.popChartCanvas = document.getElementById('chart-population');
        this.paramChartCanvas = document.getElementById('chart-params');
      });
    });
  }

  // ── 3. SIMULATION ──────────────────────────────────────────────────

  _buildSimulationSection() {
    return this._createSection('SIMULATION', false, (container) => {
      container.appendChild(this._sliderRow('Speed', 'ticksPerFrame', 1, 5, 1, 1));

      const seedDiv = document.createElement('div');
      seedDiv.className = 'seed-input';
      seedDiv.innerHTML = `
        <label style="font-size:11px;color:#8a8a9a;">Seed</label>
        <input type="text" id="seed-input" value="">
        <button class="btn" id="btn-new-run">New Run</button>
        <button class="btn" id="btn-reset">Reset</button>
      `;
      container.appendChild(seedDiv);

      // Defer event binding until DOM is ready
      requestAnimationFrame(() => {
        document.getElementById('btn-new-run').addEventListener('click', () => {
          const val = document.getElementById('seed-input').value;
          this.callbacks.onNewRun(val ? parseInt(val) || Date.now() : null);
        });
        document.getElementById('btn-reset').addEventListener('click', () => {
          this.callbacks.onReset();
        });
      });
    });
  }

  // ── 4. BONDS ───────────────────────────────────────────────────────

  _buildBondsSection() {
    return this._createSection('BONDS', false, (container) => {
      container.appendChild(this._sliderRow('Bond Radius', 'bondRadius', 20, 80, 1, 40));
      container.appendChild(this._sliderRow('Bond Duration', 'bondDuration', 20, 120, 1, 60));
      container.appendChild(this._sliderRow('Bond Rest Distance', 'bondRestDistance', 10, 60, 1, 25));
      container.appendChild(this._sliderRow('Bond Hardening Age', 'bondHardeningAge', 50, 500, 10, 200));
      container.appendChild(this._sliderRow('Bond Hardening Resist', 'bondHardeningResistance', 0.05, 0.5, 0.01, 0.2));
      container.appendChild(this._sliderRow('Bonded S Floor', 'bondedSociabilityFloor', 0.0, 0.4, 0.01, 0.15));
      container.appendChild(this._sliderRow('Bonded V Floor', 'bondedVolatilityFloor', 0.0, 0.4, 0.01, 0.2));
    });
  }

  // ── 5. DISRUPTION ──────────────────────────────────────────────────

  _buildDisruptionSection() {
    return this._createSection('DISRUPTION', false, (container) => {
      container.appendChild(this._sliderRow('Disruption Thresh', 'disruptionThreshold', 0.3, 0.9, 0.01, 0.6));
      container.appendChild(this._sliderRow('Disruption Radius', 'disruptionRadius', 40, 150, 1, 80));
      container.appendChild(this._sliderRow('Disruption Regen Cap', 'disruptionRegenCap', 0.3, 1.0, 0.01, 0.8));
    });
  }

  // ── 6. POPULATION ─────────────────────────────────────────────────

  _buildPopulationSection() {
    return this._createSection('POPULATION', false, (container) => {
      container.appendChild(this._sliderRow('Spawn Threshold', 'spawnThreshold', 3, 10, 1, 5));
      container.appendChild(this._sliderRow('Community Thresh', 'communityThreshold', 0.2, 0.8, 0.01, 0.4));
      container.appendChild(this._sliderRow('Loneliness Thresh', 'lonelinessThreshold', 200, 800, 10, 400));
      container.appendChild(this._sliderRow('Crush Threshold', 'crushThreshold', 6, 20, 1, 12));
      container.appendChild(this._sliderRow('Max Population', 'maxPopulation', 100, 800, 10, 500));
      container.appendChild(this._sliderRow('Max Age', 'maxAge', 5000, 50000, 500, 20000));
    });
  }

  // ── 7. WEATHER ─────────────────────────────────────────────────────

  _buildWeatherSection() {
    return this._createSection('WEATHER', false, (container) => {
      // Seasons
      container.appendChild(this._subHeading('Seasons'));
      container.appendChild(this._sliderRow('Season Length', 'seasonLength', 2000, 50000, 500, 12000));
      container.appendChild(this._sliderRow('Season Amplitude', 'seasonAmplitude', 0.0, 1.0, 0.05, 0.5));

      // Currents
      container.appendChild(this._subHeading('Currents'));
      container.appendChild(this._sliderRow('Max Currents', 'currentCount', 0, 5, 1, 2));
      container.appendChild(this._sliderRow('Current Strength', 'currentStrength', 0.0, 1.0, 0.05, 0.3));
      container.appendChild(this._sliderRow('Current Width', 'currentWidth', 50, 500, 10, 200));
      container.appendChild(this._sliderRow('Current Lifetime', 'currentLifetime', 1000, 20000, 500, 5000));
      container.appendChild(this._sliderRow('Current Spawn Rate', 'currentSpawnRate', 0.0001, 0.002, 0.0001, 0.0005));

      // Blooms
      container.appendChild(this._subHeading('Blooms'));
      container.appendChild(this._sliderRow('Bloom Spawn Rate', 'bloomSpawnRate', 0.00005, 0.001, 0.00005, 0.0002));
      container.appendChild(this._sliderRow('Bloom Radius Min', 'bloomRadiusMin', 50, 200, 10, 100));
      container.appendChild(this._sliderRow('Bloom Radius Max', 'bloomRadiusMax', 100, 400, 10, 250));
      container.appendChild(this._sliderRow('Bloom Lifetime Min', 'bloomLifetimeMin', 500, 5000, 100, 2000));
      container.appendChild(this._sliderRow('Bloom Lifetime Max', 'bloomLifetimeMax', 1000, 10000, 100, 5000));
      container.appendChild(this._sliderRow('Bloom Intensity', 'bloomIntensity', 0.5, 3.0, 0.1, 1.5));
      container.appendChild(this._sliderRow('Max Blooms', 'bloomMax', 0, 5, 1, 3));

      // Storms
      container.appendChild(this._subHeading('Storms'));
      container.appendChild(this._sliderRow('Storm Spawn Rate', 'stormSpawnRate', 0.00002, 0.0005, 0.00002, 0.00008));
      container.appendChild(this._sliderRow('Storm Radius Min', 'stormRadiusMin', 40, 200, 10, 80));
      container.appendChild(this._sliderRow('Storm Radius Max', 'stormRadiusMax', 80, 400, 10, 200));
      container.appendChild(this._sliderRow('Storm Lifetime Min', 'stormLifetimeMin', 300, 3000, 100, 1000));
      container.appendChild(this._sliderRow('Storm Lifetime Max', 'stormLifetimeMax', 500, 5000, 100, 3000));
      container.appendChild(this._sliderRow('Storm Intensity', 'stormIntensity', 0.5, 3.0, 0.1, 1.5));
      container.appendChild(this._sliderRow('Max Storms', 'stormMax', 0, 3, 1, 2));
    });
  }

  // ── 8. VISUAL ──────────────────────────────────────────────────────

  _buildVisualSection() {
    return this._createSection('VISUAL', false, (container) => {
      container.appendChild(this._sliderRow('Trail Decay Rate', 'trailDecayRate', 0.001, 0.01, 0.001, 0.003));
      container.appendChild(this._sliderRow('Context Map Half Life', 'halfLifeTicks', 1000, 20000, 100, 5000));
    });
  }

  // ── 9. TOGGLES ─────────────────────────────────────────────────────

  _buildTogglesSection() {
    return this._createSection('TOGGLES', true, (container) => {
      container.appendChild(this._toggleRow('The Smoother', 'smoother', this.config.smoother, () => this.callbacks.onToggleSmoother()));
      container.appendChild(this._toggleRow('Context Map (M)', 'showContextMap', this.config.showContextMap, () => this.callbacks.onToggleContextMap()));
      container.appendChild(this._toggleRow('Trails (T)', 'showTrails', this.config.showTrails, () => this.callbacks.onToggleTrails()));
      container.appendChild(this._toggleRow('Pause (Space)', 'paused', this.config.paused, () => this.callbacks.onTogglePause()));
    });
  }

  // ── Sub-heading for weather groups ─────────────────────────────────

  _subHeading(text) {
    const div = document.createElement('div');
    div.className = 'sub-heading';
    div.textContent = text;
    return div;
  }

  // ── Slider row ─────────────────────────────────────────────────────

  _sliderRow(label, key, min, max, step, defaultVal) {
    const row = document.createElement('div');
    row.className = 'slider-row';

    const currentVal = this.config[key] !== undefined ? this.config[key] : defaultVal;

    row.innerHTML = `
      <label>${label}</label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${currentVal}" data-key="${key}">
      <span class="slider-value">${this._formatValue(currentVal, step)}</span>
    `;

    const slider = row.querySelector('input[type="range"]');
    const valueDisplay = row.querySelector('.slider-value');
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      valueDisplay.textContent = this._formatValue(val, step);
      this.callbacks.onConfigChange(key, val);
    });

    return row;
  }

  _formatValue(val, step) {
    if (step >= 1) return Math.round(val).toString();
    if (step >= 0.1) return val.toFixed(1);
    if (step >= 0.01) return val.toFixed(2);
    if (step >= 0.001) return val.toFixed(3);
    if (step >= 0.0001) return val.toFixed(4);
    return val.toFixed(5);
  }

  // ── Toggle row ─────────────────────────────────────────────────────

  _toggleRow(label, key, initialState, callback) {
    const row = document.createElement('div');
    row.className = 'toggle-row';

    const lbl = document.createElement('label');
    lbl.textContent = label;
    row.appendChild(lbl);

    const toggle = document.createElement('div');
    toggle.className = 'toggle-switch' + (initialState ? ' active' : '');
    toggle.dataset.key = key;
    toggle.addEventListener('click', () => {
      callback();
    });
    row.appendChild(toggle);

    return row;
  }

  // ── Update (called each frame from main loop) ─────────────────────

  update(entities, contextMap, config, tick, seed, startTime, weatherSystem) {
    // Throttle UI updates to every 10 ticks
    if (tick - this.lastUpdateTick < 10 && tick !== 0) return;
    this.lastUpdateTick = tick;

    const alive = entities.filter(e => e.alive);
    const pop = alive.length;

    // Track population history
    this.metricsHistory.push(pop);
    if (this.metricsHistory.length > 500) this.metricsHistory.shift();

    // Bond count
    let bondCount = 0;
    for (const e of alive) bondCount += e.bonds.length;
    bondCount = Math.floor(bondCount / 2);

    // Avg params
    const paramKeys = ['sociability', 'inertia', 'volatility', 'bondAffinity', 'disruptionCharge'];
    const avgs = {};
    for (const key of paramKeys) {
      let sum = 0;
      for (const e of alive) sum += e[key];
      avgs[key] = pop > 0 ? sum / pop : 0;
    }

    // Status updates
    document.getElementById('status-population').textContent = pop;
    document.getElementById('status-bonds').textContent = bondCount;
    document.getElementById('status-tick').textContent = tick;
    document.getElementById('status-seed').textContent = seed;
    document.getElementById('status-smoother').textContent = config.smoother ? 'ON' : 'OFF';
    document.getElementById('status-smoother').style.color = config.smoother ? '#4fd1c5' : '';

    // Mini-status header updates
    document.getElementById('mini-population').textContent = pop;
    document.getElementById('mini-bonds').textContent = bondCount;

    // Weather status
    if (weatherSystem) {
      const seasonName = weatherSystem.getSeasonName().replace('_', ' ');
      const warmth = weatherSystem.getWarmth();
      document.getElementById('status-season').textContent = seasonName;
      document.getElementById('status-warmth').textContent = warmth.toFixed(2);
      // Color warmth indicator: warm = amber, cool = blue
      const warmthColor = warmth > 0.5
        ? `rgb(${Math.round(180 + warmth * 60)}, ${Math.round(140 + warmth * 40)}, ${Math.round(60)})`
        : `rgb(${Math.round(80)}, ${Math.round(120 + warmth * 60)}, ${Math.round(160 + (1 - warmth) * 60)})`;
      document.getElementById('status-warmth').style.color = warmthColor;
      document.getElementById('status-blooms').textContent = weatherSystem.blooms.length;
      document.getElementById('status-storms').textContent = weatherSystem.storms.length;
      document.getElementById('status-storms').style.color = weatherSystem.storms.length > 0 ? '#c84a6a' : '';
      document.getElementById('status-currents').textContent = weatherSystem.currents.length;

      // Mini-status season
      document.getElementById('mini-season').textContent = seasonName;
    }

    // Runtime
    const elapsed = Date.now() - startTime;
    const secs = Math.floor(elapsed / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    document.getElementById('status-runtime').textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    // Parameter bars
    for (const key of paramKeys) {
      const bar = document.getElementById(`param-bar-${key}`);
      const val = document.getElementById(`param-val-${key}`);
      if (bar && val) {
        bar.style.width = `${avgs[key] * 100}%`;
        val.textContent = avgs[key].toFixed(2);
      }
    }

    // Draw charts
    this._drawPopulationChart();
    this._drawParamChart(avgs);
  }

  _drawPopulationChart() {
    const canvas = this.popChartCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = 'rgba(10, 10, 15, 0.9)';
    ctx.fillRect(0, 0, w, h);

    if (this.metricsHistory.length < 2) return;

    const data = this.metricsHistory;
    const maxVal = Math.max(...data, 10);
    const minVal = Math.min(...data, 0);
    const range = maxVal - minVal || 1;

    ctx.strokeStyle = '#4a9ead';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((data[i] - minVal) / range) * (h - 10) - 5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current value label
    ctx.fillStyle = '#c8c8d8';
    ctx.font = '10px IBM Plex Mono';
    ctx.fillText(`${data[data.length - 1]}`, w - 30, 12);
  }

  _drawParamChart(avgs) {
    const canvas = this.paramChartCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = 'rgba(10, 10, 15, 0.9)';
    ctx.fillRect(0, 0, w, h);

    const params = [
      { key: 'sociability', label: 'S', color: '#e8a04c' },
      { key: 'inertia', label: 'I', color: '#4a9ead' },
      { key: 'volatility', label: 'V', color: '#c84a6a' },
      { key: 'bondAffinity', label: 'B', color: '#6acc6a' },
      { key: 'disruptionCharge', label: 'D', color: '#8a6acc' }
    ];

    const barH = 16;
    const gap = 6;
    const labelW = 20;
    const barStartX = labelW + 4;
    const barMaxW = w - barStartX - 40;

    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const y = 6 + i * (barH + gap);
      const val = avgs[p.key] || 0;

      // Label
      ctx.fillStyle = '#8a8a9a';
      ctx.font = '10px IBM Plex Mono';
      ctx.fillText(p.label, 4, y + 12);

      // Background bar
      ctx.fillStyle = 'rgba(74, 158, 173, 0.1)';
      ctx.fillRect(barStartX, y, barMaxW, barH);

      // Fill bar
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(barStartX, y, barMaxW * val, barH);
      ctx.globalAlpha = 1.0;

      // Value
      ctx.fillStyle = '#c8c8d8';
      ctx.fillText(val.toFixed(2), barStartX + barMaxW + 4, y + 12);
    }
  }

  // ── Sync UI state from config (e.g., after API param change) ───────

  syncFromConfig(config) {
    this.config = config;
    // Update all sliders
    const sliders = document.querySelectorAll('input[type="range"][data-key]');
    for (const slider of sliders) {
      const key = slider.dataset.key;
      if (config[key] !== undefined) {
        slider.value = config[key];
        const valueDisplay = slider.parentElement.querySelector('.slider-value');
        if (valueDisplay) {
          valueDisplay.textContent = this._formatValue(config[key], parseFloat(slider.step));
        }
      }
    }
    this.updateToggles(config);
  }

  updateToggles(config) {
    const toggles = document.querySelectorAll('.toggle-switch[data-key]');
    for (const toggle of toggles) {
      const key = toggle.dataset.key;
      if (config[key]) {
        toggle.classList.add('active');
      } else {
        toggle.classList.remove('active');
      }
    }
  }
}
