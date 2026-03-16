/**
 * Vienna Accident Heatmap – app.js
 *
 * Loads accident data from data/accidents.json, renders an interactive Leaflet
 * heat map, and handles filtering, color schemes, and PNG export.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const VIENNA_CENTER = [48.2082, 16.3738];
const VIENNA_ZOOM   = 12;

// Tile layer URLs (dark / light)
const TILE_LAYERS = {
  dark:  {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  },
  none: null,
};

const COLOR_SCHEMES = {
  fire:    { 0.0: '#000000', 0.3: '#ff0000', 0.65: '#ff7700', 0.85: '#ffff00', 1.0: '#ffffff' },
  classic: { 0.4: '#0000ff', 0.6: '#00ff00', 0.8: '#ffff00', 1.0: '#ff0000' },
  plasma:  { 0.0: '#0d0887', 0.25: '#7e03a8', 0.5: '#cc4778', 0.75: '#f89540', 1.0: '#f0f921' },
  viridis: { 0.0: '#440154', 0.25: '#31688e', 0.5: '#35b779', 0.75: '#b5de2b', 1.0: '#fde725' },
  cool:    { 0.0: '#00ffff', 0.5: '#0066ff', 1.0: '#9900ff' },
};

// Aspect ratios: [widthRatio, heightRatio]  (null = free)
const ASPECT_RATIOS = {
  '1:1':  [1, 1],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '4:5':  [4, 5],
  'free': null,
};

// Flags bitmask (must match fetch-data.mjs)
const FLAG_CYCLIST    = 1;
const FLAG_PEDESTRIAN = 2;
const FLAG_MOTORCYCLE = 4;
const FLAG_FATAL      = 8;
const FLAG_SERIOUS    = 16;
const FLAG_MINOR      = 32;

// ── State ─────────────────────────────────────────────────────────────────

let map          = null;
let tileLayer    = null;
let heatLayer    = null;
let allPoints    = [];   // raw: [[lat, lng, year, flags], …]
let metadata     = null;

const state = {
  yearFrom:     2009,
  yearTo:       2024,
  cyclists:     false,
  pedestrians:  false,
  motorcycles:  false,
  severity:     'all',   // 'all' | 'fatal' | 'serious' | 'minor'
  scheme:       'fire',
  radius:       15,
  blur:         20,
  opacity:      0.8,
  tileStyle:    'dark',
  selectionActive: false,
  selectionRatio:  '1:1',
};

// ── Map initialisation ─────────────────────────────────────────────────────

function initMap() {
  map = L.map('map', {
    center: VIENNA_CENTER,
    zoom: VIENNA_ZOOM,
    zoomControl: true,
    attributionControl: true,
  });

  setTileLayer('dark');
}

function setTileLayer(style) {
  if (tileLayer) {
    map.removeLayer(tileLayer);
    tileLayer = null;
  }
  const cfg = TILE_LAYERS[style];
  if (cfg) {
    tileLayer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: cfg.maxZoom,
      subdomains: 'abcd',
    }).addTo(map);
  }
}

// ── Data loading ──────────────────────────────────────────────────────────

async function loadData() {
  showLoading(true);
  try {
    const resp = await fetch('data/accidents.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();

     allPoints = data.points ?? [];
     metadata  = data.meta  ?? {};

     populateYearSelects(metadata.years ?? []);
      updateSeverityControls();
     updateHeaderMeta();
     updateHeatmap();
     showLoading(false);
  } catch (err) {
    showLoading(false);
    showError(`Failed to load accident data: ${err.message}`);
    console.error(err);
  }
}

// ── Filters ───────────────────────────────────────────────────────────────

function getFilteredPoints() {
  const { yearFrom, yearTo, cyclists, pedestrians, motorcycles, severity } = state;
  const anyInvolvement = cyclists || pedestrians || motorcycles;

  return allPoints.filter(([, , year, flags]) => {
    if (year < yearFrom || year > yearTo) return false;

    if (anyInvolvement) {
      let match = false;
      if (cyclists    && (flags & FLAG_CYCLIST))    match = true;
      if (pedestrians && (flags & FLAG_PEDESTRIAN)) match = true;
      if (motorcycles && (flags & FLAG_MOTORCYCLE)) match = true;
      if (!match) return false;
    }

    if (severity === 'fatal'   && !(flags & FLAG_FATAL))   return false;
    if (severity === 'serious' && !(flags & FLAG_SERIOUS))  return false;
    if (severity === 'minor'   && !(flags & FLAG_MINOR))    return false;

    return true;
  });
}

// ── Heat map ──────────────────────────────────────────────────────────────

function updateHeatmap() {
  const points = getFilteredPoints();
  const heatPoints = points.map(([lat, lng]) => [lat, lng, 1]);

  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }

  heatLayer = L.heatLayer(heatPoints, {
    radius:  state.radius,
    blur:    state.blur,
    maxZoom: 17,
    max:     1.0,
    gradient: COLOR_SCHEMES[state.scheme],
  }).addTo(map);

  // Adjust canvas opacity via the layer's container
  if (heatLayer._canvas) {
    heatLayer._canvas.style.opacity = state.opacity;
  }

  updateStats(points.length);
}

// ── UI helpers ────────────────────────────────────────────────────────────

function showLoading(visible) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !visible);
}

function showError(msg) {
  const el = document.getElementById('error-overlay');
  document.getElementById('error-message').textContent = msg;
  el.classList.remove('hidden');
}

function populateYearSelects(years) {
  const from = document.getElementById('year-from');
  const to   = document.getElementById('year-to');

  if (years.length === 0) {
    // Build a default range
    years = Array.from({ length: 16 }, (_, i) => 2009 + i);
  }

  from.innerHTML = '';
  to.innerHTML   = '';

  years.forEach(y => {
    from.insertAdjacentHTML('beforeend', `<option value="${y}">${y}</option>`);
    to.insertAdjacentHTML('beforeend',   `<option value="${y}">${y}</option>`);
  });

  // Default: select earliest and latest
  from.value = years[0];
  to.value   = years[years.length - 1];

  state.yearFrom = years[0];
  state.yearTo   = years[years.length - 1];
}

function updateHeaderMeta() {
  const el = document.getElementById('header-meta');
  if (!metadata) return;
  const updated = metadata.lastUpdated
    ? new Date(metadata.lastUpdated).toLocaleDateString('en-AT', { year: 'numeric', month: 'short', day: 'numeric' })
    : '–';
  const severityNote = metadata.severityAvailable === false ? ' · Severity: n/a in source' : '';
  el.textContent = `Vienna: ${(metadata.viennaCount ?? 0).toLocaleString()} accidents · Updated ${updated}${severityNote}`;
}

function updateSeverityControls() {
  const hasFatal = allPoints.some(([, , , flags]) => (flags & FLAG_FATAL) !== 0);
  const hasSerious = allPoints.some(([, , , flags]) => (flags & FLAG_SERIOUS) !== 0);

  const fatalInput = document.querySelector('input[name="severity"][value="fatal"]');
  const seriousInput = document.querySelector('input[name="severity"][value="serious"]');

  if (fatalInput) fatalInput.disabled = !hasFatal;
  if (seriousInput) seriousInput.disabled = !hasSerious;

  if ((state.severity === 'fatal' && !hasFatal) || (state.severity === 'serious' && !hasSerious)) {
    state.severity = 'all';
    const allInput = document.querySelector('input[name="severity"][value="all"]');
    if (allInput) allInput.checked = true;
  }
}

function updateStats(showing) {
  document.getElementById('stat-showing').textContent = showing.toLocaleString();
  document.getElementById('stat-total').textContent   = (metadata?.viennaCount ?? allPoints.length).toLocaleString();
}

// ── Selection box ─────────────────────────────────────────────────────────

const sel = {
  box:       null,
  label:     null,
  active:    false,
  dragging:  false,
  resizing:  false,
  handle:    null,   // 'nw'|'ne'|'sw'|'se'
  startX:    0,
  startY:    0,
  startRect: null,
  ratio:     ASPECT_RATIOS['1:1'],
};

function initSelection() {
  sel.box   = document.getElementById('selection-box');
  sel.label = document.getElementById('selection-label');

  // Initial position: centred on map
  resetSelectionBox();

  // Drag to move
  sel.box.addEventListener('mousedown', onSelBoxMouseDown);

  // Resize handles
  sel.box.querySelectorAll('.selection-handle').forEach(h => {
    h.addEventListener('mousedown', e => {
      e.stopPropagation();
      sel.resizing = true;
      sel.handle   = [...h.classList].find(c => ['nw','ne','sw','se'].includes(c));
      sel.startX   = e.clientX;
      sel.startY   = e.clientY;
      sel.startRect = sel.box.getBoundingClientRect();
      document.addEventListener('mousemove', onSelResize);
      document.addEventListener('mouseup',   onSelMouseUp);
    });
  });
}

function resetSelectionBox() {
  const wrapper = document.querySelector('.map-wrapper');
  const ww = wrapper.offsetWidth;
  const wh = wrapper.offsetHeight;

  const ratio = sel.ratio;
  let bw, bh;
  if (!ratio) {
    bw = Math.min(ww * 0.6, 400);
    bh = Math.min(wh * 0.6, 400);
  } else {
    bw = Math.min(ww * 0.6, 400);
    bh = Math.round(bw * ratio[1] / ratio[0]);
    if (bh > wh * 0.8) {
      bh = Math.round(wh * 0.8);
      bw = Math.round(bh * ratio[0] / ratio[1]);
    }
  }

  const left = (ww - bw) / 2;
  const top  = (wh - bh) / 2;

  Object.assign(sel.box.style, {
    left:   `${left}px`,
    top:    `${top}px`,
    width:  `${bw}px`,
    height: `${bh}px`,
  });

  updateSelLabel();
}

function updateSelLabel() {
  const w = parseInt(sel.box.style.width);
  const h = parseInt(sel.box.style.height);
  sel.label.textContent = `${w} × ${h}px · drag to move`;
}

function onSelBoxMouseDown(e) {
  if (e.target.classList.contains('selection-handle')) return;
  sel.dragging = true;
  sel.startX   = e.clientX;
  sel.startY   = e.clientY;
  sel.startRect = sel.box.getBoundingClientRect();
  document.addEventListener('mousemove', onSelDrag);
  document.addEventListener('mouseup',   onSelMouseUp);
  e.preventDefault();
}

function onSelDrag(e) {
  if (!sel.dragging) return;
  // Convert mouse client coordinates to wrapper-relative offsets, then clamp so the
  // selection box cannot be dragged outside the map wrapper bounds.
  const wrapper = document.querySelector('.map-wrapper').getBoundingClientRect();
  const dx = e.clientX - sel.startX;
  const dy = e.clientY - sel.startY;

  const newLeft = Math.max(0, Math.min(
    sel.startRect.left - wrapper.left + dx,
    wrapper.width - sel.startRect.width
  ));
  const newTop = Math.max(0, Math.min(
    sel.startRect.top - wrapper.top + dy,
    wrapper.height - sel.startRect.height
  ));

  sel.box.style.left = `${newLeft}px`;
  sel.box.style.top  = `${newTop}px`;
  updateSelLabel();
  e.preventDefault();
}

function onSelResize(e) {
  if (!sel.resizing) return;

  const wrapper = document.querySelector('.map-wrapper').getBoundingClientRect();
  const dx = e.clientX - sel.startX;
  const dy = e.clientY - sel.startY;

  const r0 = sel.startRect;
  let left   = r0.left  - wrapper.left;
  let top    = r0.top   - wrapper.top;
  let right  = r0.right - wrapper.left;
  let bottom = r0.bottom- wrapper.top;

  if (sel.handle.includes('e')) right  = Math.max(left + 40, r0.right  - wrapper.left + dx);
  if (sel.handle.includes('s')) bottom = Math.max(top  + 40, r0.bottom - wrapper.top  + dy);
  if (sel.handle.includes('w')) left   = Math.min(right- 40, r0.left   - wrapper.left + dx);
  if (sel.handle.includes('n')) top    = Math.min(bottom-40, r0.top    - wrapper.top  + dy);

  // Constrain to aspect ratio if set
  let newW = right - left;
  let newH = bottom - top;
  if (sel.ratio) {
    const [rw, rh] = sel.ratio;
    // Adjust height to match width's ratio
    newH = Math.round(newW * rh / rw);
    if (sel.handle.includes('s') || sel.handle.includes('n')) {
      newW = Math.round(newH * rw / rh);
    }
    if (sel.handle.includes('n')) top    = bottom - newH;
    if (sel.handle.includes('w')) left   = right  - newW;
  }

  // Clamp to map wrapper
  newW = Math.min(newW, wrapper.width);
  newH = Math.min(newH, wrapper.height);
  left = Math.max(0, left);
  top  = Math.max(0, top);

  sel.box.style.left   = `${left}px`;
  sel.box.style.top    = `${top}px`;
  sel.box.style.width  = `${newW}px`;
  sel.box.style.height = `${newH}px`;
  updateSelLabel();
  e.preventDefault();
}

function onSelMouseUp() {
  sel.dragging = false;
  sel.resizing = false;
  document.removeEventListener('mousemove', onSelDrag);
  document.removeEventListener('mousemove', onSelResize);
  document.removeEventListener('mouseup',   onSelMouseUp);
}

function toggleSelection(active) {
  sel.active = active;
  sel.box.classList.toggle('hidden', !active);
  document.getElementById('btn-toggle-selection').classList.toggle('active', active);
  document.getElementById('btn-export').disabled = !active;

  if (active) resetSelectionBox();
  // Prevent map dragging when selection box is shown
  if (active) {
    map.dragging.disable();
  } else {
    map.dragging.enable();
  }
}

// ── Export ────────────────────────────────────────────────────────────────

async function exportPng() {
  const exportWidth = parseInt(document.getElementById('export-width').value, 10) || 1200;

  // Dimensions of the selection box in screen pixels
  const selW = parseInt(sel.box.style.width,  10);
  const selH = parseInt(sel.box.style.height, 10);
  const selL = parseInt(sel.box.style.left,   10);
  const selT = parseInt(sel.box.style.top,    10);

  const btn = document.getElementById('btn-export');
  btn.disabled = true;
  btn.textContent = 'Exporting…';

  try {
    // Temporarily hide the selection overlay
    sel.box.style.display = 'none';

    const mapWrapper = document.querySelector('.map-wrapper');
    const canvas = await html2canvas(mapWrapper, {
      allowTaint:   true,
      useCORS:      true,
      logging:      false,
      backgroundColor: '#0f1117',
    });

    // Crop to selection rectangle
    const cropped = document.createElement('canvas');
    const scale   = exportWidth / selW;
    cropped.width  = exportWidth;
    cropped.height = Math.round(selH * scale);

    const ctx = cropped.getContext('2d');
    ctx.drawImage(
      canvas,
      selL, selT, selW, selH,    // source rect
      0, 0, cropped.width, cropped.height  // dest rect
    );

    // Add small attribution watermark
    ctx.font = `${Math.max(10, Math.round(11 * scale))}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'right';
    ctx.fillText('Statistik Austria OGD · wirmachen.wien', cropped.width - 8, cropped.height - 8);

    // Download
    const link = document.createElement('a');
    link.download = `vienna-accident-heatmap-${Date.now()}.png`;
    link.href = cropped.toDataURL('image/png');
    link.click();
  } finally {
    sel.box.style.display = '';
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M8 2v8M5 7l3 3 3-3M2 11v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"/>
    </svg> Export PNG`;
  }
}

// ── Event listeners ───────────────────────────────────────────────────────

function bindControls() {
  // Year selects
  document.getElementById('year-from').addEventListener('change', e => {
    state.yearFrom = +e.target.value;
    clampYears();
    updateHeatmap();
  });
  document.getElementById('year-to').addEventListener('change', e => {
    state.yearTo = +e.target.value;
    clampYears();
    updateHeatmap();
  });

  // Involvement checkboxes
  document.getElementById('filter-all').addEventListener('change', e => {
    if (e.target.checked) {
      state.cyclists = state.pedestrians = state.motorcycles = false;
      document.getElementById('filter-cyclist').checked    = false;
      document.getElementById('filter-pedestrian').checked = false;
      document.getElementById('filter-motorcycle').checked = false;
    }
    updateHeatmap();
  });
  document.getElementById('filter-cyclist').addEventListener('change', e => {
    state.cyclists = e.target.checked;
    syncAllCheckbox();
    updateHeatmap();
  });
  document.getElementById('filter-pedestrian').addEventListener('change', e => {
    state.pedestrians = e.target.checked;
    syncAllCheckbox();
    updateHeatmap();
  });
  document.getElementById('filter-motorcycle').addEventListener('change', e => {
    state.motorcycles = e.target.checked;
    syncAllCheckbox();
    updateHeatmap();
  });

  // Severity radios
  document.querySelectorAll('input[name="severity"]').forEach(r => {
    r.addEventListener('change', e => {
      state.severity = e.target.value;
      updateHeatmap();
    });
  });

  // Color schemes
  document.getElementById('color-schemes').addEventListener('click', e => {
    const btn = e.target.closest('.scheme-btn');
    if (!btn) return;
    document.querySelectorAll('.scheme-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.scheme = btn.dataset.scheme;
    updateHeatmap();
  });

  // Sliders
  document.getElementById('radius-slider').addEventListener('input', e => {
    state.radius = +e.target.value;
    document.getElementById('radius-value').textContent = e.target.value;
    updateHeatmap();
  });
  document.getElementById('blur-slider').addEventListener('input', e => {
    state.blur = +e.target.value;
    document.getElementById('blur-value').textContent = e.target.value;
    updateHeatmap();
  });
  document.getElementById('opacity-slider').addEventListener('input', e => {
    state.opacity = +e.target.value / 100;
    document.getElementById('opacity-value').textContent = e.target.value;
    if (heatLayer?._canvas) {
      heatLayer._canvas.style.opacity = state.opacity;
    }
  });

  // Tile style
  document.querySelectorAll('input[name="tile-style"]').forEach(r => {
    r.addEventListener('change', e => {
      state.tileStyle = e.target.value;
      setTileLayer(e.target.value);
    });
  });

  // Export controls
  document.getElementById('btn-toggle-selection').addEventListener('click', () => {
    toggleSelection(!sel.active);
  });

  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sel.ratio = ASPECT_RATIOS[btn.dataset.ratio];
      if (sel.active) resetSelectionBox();
    });
  });

  document.getElementById('btn-retry').addEventListener('click', () => window.location.reload());
  document.getElementById('btn-export').addEventListener('click', exportPng);
}

function clampYears() {
  if (state.yearFrom > state.yearTo) {
    document.getElementById('year-to').value = state.yearFrom;
    state.yearTo = state.yearFrom;
  }
}

function syncAllCheckbox() {
  const anyActive = state.cyclists || state.pedestrians || state.motorcycles;
  document.getElementById('filter-all').checked = !anyActive;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  bindControls();
  initSelection();
  await loadData();
});
