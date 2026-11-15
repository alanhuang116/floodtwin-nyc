// Interface: transport and clock (top), scenario builder (left), results in tiers
// (right: a headline that stays in view, then tabs), timeline, view modes, legend,
// camera tools, canvas interaction (select, probe, draw barriers) and keyboard.
import { lineChart, scatterChart, curveChart } from './charts.js';
import { PRESETS, presetById, clockLabel, shortClock } from './scenarios.js';
import { Timeline } from './timeline.js';
import { RAMPS, HAZARD, cssGradient } from './ramps.js';
import { BOROUGHS } from './grid.js';
import { ENTRY_M } from './sim.js';

const $ = (s) => document.querySelector(s);

export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') e.style.cssText = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export const fmtInt = v => Math.round(v).toLocaleString('en-US');
export const fmtMoney = v => {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
};
const fmtM = v => `${v.toFixed(2)} m`;
const fmtPct = v => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

const ICON = {
  chev: '<svg viewBox="0 0 16 16" class="chev"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  surge: '<svg viewBox="0 0 20 20"><path d="M2 12c2-2 4-2 6 0s4 2 6 0 3-1.6 4-1M2 16c2-2 4-2 6 0s4 2 6 0 3-1.6 4-1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 3v6M7.5 6.5L10 9l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rain: '<svg viewBox="0 0 20 20"><path d="M5.5 11a3.5 3.5 0 0 1 .4-7 4.5 4.5 0 0 1 8.4 1.2A3 3 0 0 1 14 11Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 14l-1 2.5M10.5 14l-1 2.5M14 14l-1 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  both: '<svg viewBox="0 0 20 20"><path d="M2 15c2-2 4-2 6 0s4 2 6 0 3-1.6 4-1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6 9a3 3 0 0 1 .3-6 3.8 3.8 0 0 1 7.2 1A2.6 2.6 0 0 1 13 9Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M5 3.2v9.6c0 .4.4.6.7.4l7.4-4.8a.5.5 0 0 0 0-.8L5.7 2.8c-.3-.2-.7 0-.7.4Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><rect x="4" y="3" width="2.6" height="10" rx=".6" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx=".6" fill="currentColor"/></svg>',
};

const MODES = [
  { id: 0, name: 'Photo' }, { id: 1, name: 'Depth' }, { id: 2, name: 'Speed' }, { id: 3, name: 'Hazard' },
  { id: 4, name: 'Peak Depth' }, { id: 5, name: 'Arrival' }, { id: 6, name: 'Damage' },
];
const SPEEDS = [{ v: 300, name: '300×' }, { v: 900, name: '900×' }, { v: 2700, name: '2700×' }, { v: Infinity, name: 'Max' }];
const BORO_SHORT = ['', 'Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island'];
const GROUPS = [
  { name: 'Coastal Storms', icon: 'surge', ids: ['sandy', 'sandy-2050s', 'sandy-2100s', 'noreaster'] },
  { name: 'Extreme Rainfall', icon: 'rain', ids: ['dep-moderate', 'dep-extreme', 'ida'] },
  { name: 'Compound', icon: 'both', ids: ['compound'] },
];

function slider({ label, min, max, step, value, fmt, hint, onInput, onChange }) {
  const out = h('span', { class: 'field-value', text: fmt(value) });
  const inp = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const paint = () => inp.style.setProperty('--p', `${((inp.value - min) / (max - min)) * 100}%`);
  paint();
  inp.addEventListener('input', () => { out.textContent = fmt(+inp.value); paint(); onInput?.(+inp.value); });
  inp.addEventListener('change', () => onChange?.(+inp.value));
  return h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: label }), out), inp,
    hint ? h('div', { class: 'field-hint', text: hint }) : null);
}

function seg(options, value, onChange, cls = 'seg full') {
  const wrap = h('div', { class: cls, role: 'group' });
  const btns = options.map(o => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value), title: o.title || null, text: o.name });
    b.addEventListener('click', () => { btns.forEach(x => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); onChange(o.value); });
    wrap.appendChild(b);
    return b;
  });
  wrap.set = (v) => btns.forEach((b, k) => b.setAttribute('aria-pressed', String(options[k].value === v)));
  return wrap;
}

function toggle(label, checked, onChange, note) {
  const inp = h('input', { type: 'checkbox' });
  inp.checked = checked;
  inp.addEventListener('change', () => onChange(inp.checked));
  return h('label', { class: 'switch-row' }, h('span', { class: 'switch-text' }, h('span', { text: label }), note ? h('small', { text: note }) : null),
    h('span', { class: 'switch' }, inp, h('span')));
}

export class UI {
  constructor(app) {
    this.app = app;
    this.tab = 'overview';
    this.open = { adjust: false, defences: false, model: false, display: false };
    this._bindTop();
    this._buildModes();
    this._buildCamTools();
    this._buildRight();
    this.renderLeft();
    this.timeline = new Timeline($('#timeline'), app.sim, t => app.seek(t));
    this.timeline.setScenario(app.sim.scenario);
    this._bindCanvas();
    this._bindKeys();
    this.updateLegend();
    this.onGrid(app.sim.grid);
    this._lastFrameUI = 0;
  }

  // ------------------------------------------------------------ top bar
  _bindTop() {
    const app = this.app;
    this.playBtn = $('#btn-play');
    this.playBtn.addEventListener('click', () => app.togglePlay());
    $('#btn-restart').addEventListener('click', () => app.restart());
    $('#btn-share').addEventListener('click', () => app.share());
    $('#btn-shot').addEventListener('click', () => app.screenshot());
    const sp = $('#speed');
    this.speedSeg = seg(SPEEDS.map(s => ({ value: s.v, name: s.name, title: isFinite(s.v) ? `${s.v} seconds of storm per second` : 'As fast as this GPU allows' })),
      app.state.speed, v => app.setSpeed(v), 'seg');
    sp.replaceWith(this.speedSeg);
    this.speedSeg.id = 'speed';
    this.speedSeg.classList.add('speed-seg');
    for (const id of ['left', 'right']) {
      $(`#toggle-${id}`).addEventListener('click', () => {
        const p = $(`#panel-${id}`), o = !p.classList.contains('open');
        document.querySelectorAll('.panel').forEach(x => x.classList.remove('open'));
        p.classList.toggle('open', o);
      });
    }
  }

  _setPlayIcon() {
    const s = this.app.sim, running = s.status === 'running' || (s.status === 'seeking' && s.resumeAfterSeek);
    if (this._running === running) return;
    this._running = running;
    this.playBtn.innerHTML = running ? ICON.pause : ICON.play;
    this.playBtn.title = running ? 'Pause (Space)' : 'Run (Space)';
    this.playBtn.setAttribute('aria-label', running ? 'Pause' : 'Run');
  }

  // ------------------------------------------------------------ view modes and legend
  _buildModes() {
    const host = $('#modes');
    this.modesEl = seg(MODES.map(m => ({ value: m.id, name: m.name })), this.app.state.display.mode, v => this.app.setMode(v), 'seg');
    host.replaceWith(this.modesEl);
    this.modesEl.id = 'modes';
  }

  syncModes() { this.modesEl.set(this.app.state.display.mode); }

  updateLegend() {
    const L = $('#legend'), m = this.app.state.display.mode, lay = this.app.state.display.layers;
    const parts = [];
    const bar = (title, ramp, scale, note) => [h('div', { class: 'legend-title', text: title }), h('div', { class: 'legend-bar', style: `background:${cssGradient(ramp.stops)}` }),
      h('div', { class: 'legend-scale' }, ...scale.map(s => h('span', { text: s }))), note ? h('div', { class: 'legend-note', text: note }) : null];
    if (m === 1) parts.push(...bar('Water Depth', RAMPS.depth, ['0', '1 m', '2 m', '3 m+']));
    if (m === 2) parts.push(...bar('Flow Speed', RAMPS.speed, ['0', '1 m/s', '2 m/s', '3 m/s+']));
    if (m === 3) {
      parts.push(h('div', { class: 'legend-title', text: 'Flood Hazard Rating' }));
      parts.push(h('div', { class: 'legend-classes' }, ...HAZARD.map(c => h('div', { class: 'legend-class' }, h('i', { style: `background:${c.color}` }), h('span', { text: c.label }), h('span', { text: c.note })))));
      parts.push(h('div', { class: 'legend-note', text: 'Depth × (speed + 0.5) + debris factor, DEFRA FD2320' }));
    }
    if (m === 4) parts.push(...bar('Peak Water Depth So Far', RAMPS.depth, ['0', '1 m', '2 m', '3 m+']));
    if (m === 5) parts.push(...bar('Arrival of 10 cm of Water', RAMPS.arrival, ['Early', '', '', 'Late']));
    if (m === 6) parts.push(...bar('Building Damage Ratio', RAMPS.damage, ['0', '15%', '30%', '60%+'], 'Grey: no water. Light blue: wet below the first floor.'));
    if (lay.fema) parts.push(h('div', { class: 'legend-chip' }, h('i', { style: 'border-color:#e2b44f' }), h('span', { text: 'FEMA 1% annual chance flood zone' })));
    if (lay.sandy) parts.push(h('div', { class: 'legend-chip' }, h('i', { style: 'border-color:#f2f5f7' }), h('span', { text: 'Mapped Sandy inundation, 2012' })));
    L.replaceChildren(...parts.filter(Boolean));
    L.hidden = !parts.length;
  }

  // ------------------------------------------------------------ camera tools
  _buildCamTools() {
    const app = this.app, menu = $('#views-menu');
    menu.replaceChildren(h('div', { class: 'menu-title', text: 'Places' }), ...app.views.map((v, k) => h('button', { type: 'button', text: v.name, onclick: () => { app.viewer.flyTo(v, k === 0 ? 2.8 : 2.4); menu.hidden = true; } })));
    $('#btn-views').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
    $('#btn-north').addEventListener('click', () => { const v = app.viewer.currentView(); app.viewer.flyTo({ ...v, azim: 0 }, 1.0); });
    this.compass = $('#compass');
  }

  // ------------------------------------------------------------ left panel
  renderLeft() {
    const app = this.app, st = app.state, body = $('#left-body');
    const scroll = body.scrollTop;
    body.replaceChildren();
    // ---- events
    const evSec = h('section', { class: 'section first' }, h('div', { class: 'section-label', text: 'Event' }));
    for (const g of GROUPS) {
      const list = h('div', { class: 'presets' });
      for (const id of g.ids) {
        const p = presetById(id), on = st.preset === id;
        const card = h('button', { type: 'button', class: `preset${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => { if (st.preset !== id) app.applyPreset(id, true); } },
          h('span', { class: 'preset-icon', html: ICON[g.icon] }),
          h('span', { class: 'preset-main' }, h('span', { class: 'preset-name', text: p.name }), on ? h('span', { class: 'preset-note', text: p.note }) : h('span', { class: 'preset-tag', text: p.tag })));
        list.appendChild(card);
      }
      evSec.append(h('div', { class: 'group-label', text: g.name }), list);
    }
    if (st.preset === 'custom') evSec.append(h('div', { class: 'callout', text: 'Custom event: settings below differ from every preset.' }));
    body.appendChild(evSec);
    body.appendChild(this._section('adjust', 'Adjust the Event', this._adjustBody()));
    body.appendChild(this._section('defences', 'Defences', this._defenceBody(), this._defenceBadge()));
    body.appendChild(this._section('model', 'Model', this._modelBody(), h('span', { class: 'badge', text: `${st.model.dx} m` })));
    body.appendChild(this._section('display', 'Display', this._displayBody()));
    body.scrollTop = scroll;
    this.renderApply();
  }

  _section(key, title, content, badge) {
    const sec = h('section', { class: `section${this.open[key] ? '' : ' closed'}` });
    const head = h('button', { type: 'button', class: 'section-head', 'aria-expanded': String(!!this.open[key]) },
      h('span', { class: 'section-title', text: title }), h('span', { class: 'section-side' }, badge || null, h('span', { html: ICON.chev })));
    head.addEventListener('click', () => { this.open[key] = !this.open[key]; sec.classList.toggle('closed', !this.open[key]); head.setAttribute('aria-expanded', String(this.open[key])); });
    sec.append(head, h('div', { class: 'section-body' }, content));
    return sec;
  }

  _changed() { this.app.markCustom(); this.app.markDirty(); }

  _adjustBody() {
    const app = this.app, ev = app.state.ev, out = [];
    const set = (k) => (v) => { ev[k] = v; this._changed(); };
    if (ev.mode === 'replay') {
      out.push(h('div', { class: 'section-note', text: 'The observed Sandy water levels at all four gauges, raised by a chosen amount of sea level rise.' }));
    }
    if (ev.mode === 'surge') {
      out.push(slider({ label: 'Peak at The Battery', min: 1.5, max: 4.5, step: 0.05, value: ev.peak, fmt: v => `${v.toFixed(2)} m`, onChange: set('peak'),
        hint: 'Sandy peaked at 3.44 m NAVD88; the 1% annual chance stillwater is about 3.4 m.' }));
      out.push(slider({ label: 'Surge Duration', min: 12, max: 48, step: 1, value: ev.duration, fmt: v => `${v} h`, onChange: set('duration') }));
      out.push(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: 'Peak Arrives On' })),
        seg([{ value: 'high', name: 'High Tide' }, { value: 'mid', name: 'Mid Tide' }, { value: 'low', name: 'Low Tide' }], ev.timing || 'high', set('timing'))));
    }
    out.push(slider({ label: 'Sea Level Rise', min: 0, max: 1.5, step: 0.05, value: ev.slr || 0, fmt: v => (v ? `+${v.toFixed(2)} m` : 'None'), onChange: set('slr'),
      hint: 'NPCC 2019 middle range: 0.2 to 0.5 m by the 2050s, 0.6 to 1.3 m by the 2100s.' }));
    if (ev.mode !== 'replay') {
      out.push(slider({ label: 'Rainfall', min: 0, max: 120, step: 1, value: ev.rain || 0, fmt: v => (v ? `${v} mm/h` : 'None'), onChange: (v) => { ev.rain = v; ev.hyeto = null; this._changed(); this.renderLeft(); } }));
      if (ev.rain > 0) {
        out.push(slider({ label: 'Rain Duration', min: 1, max: 6, step: 0.5, value: ev.rainDur || 1, fmt: v => `${v} h`, onChange: (v) => { ev.rainDur = v; ev.hyeto = null; this._changed(); this.renderLeft(); } }));
        const tot = ev.hyeto ? ev.hyeto.reduce((a, b) => a + b, 0) : ev.rain * (ev.rainDur || 1);
        const rp = app.returnPeriod(tot, ev.rainDur || 1);
        const txt = !rp ? '' : rp.under ? 'More frequent than once a year at Central Park.' : rp.over ? `Rarer than 1 in ${rp.rp} years at Central Park (NOAA Atlas 14).` : `About 1 in ${rp.rp} years at Central Park (NOAA Atlas 14).`;
        out.push(h('div', { class: 'section-note', text: `${Math.round(tot)} mm in total. ${txt}` }));
      }
    }
    return out;
  }

  _defenceBadge() {
    const d = this.app.state.defences, n = d.waterfront.boros.length + d.barriers.length;
    return n ? h('span', { class: 'badge accent', text: `${n} on` }) : null;
  }

  _defenceBody() {
    const app = this.app, d = app.state.defences, out = [];
    out.push(h('div', { class: 'section-note', text: 'Raise every waterfront cell of a borough to a crest height, or draw barriers on the map.' }));
    const chips = h('div', { class: 'chips' });
    for (let b = 1; b <= 5; b++) {
      const on = d.waterfront.boros.includes(b);
      chips.appendChild(h('button', { type: 'button', class: `chip-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), text: BORO_SHORT[b], onclick: () => {
        const s = new Set(d.waterfront.boros); if (s.has(b)) s.delete(b); else s.add(b);
        d.waterfront.boros = [...s].sort(); this._changed(); this.renderLeft();
      } }));
    }
    out.push(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: 'Waterfront Walls' })), chips));
    out.push(slider({ label: 'Crest Height', min: 2.5, max: 6, step: 0.1, value: d.waterfront.crest, fmt: v => `${v.toFixed(1)} m NAVD88`, onChange: v => { d.waterfront.crest = v; this._changed(); },
      hint: 'Lower Manhattan bulkheads are about 2 m; Sandy reached 3.44 m.' }));
    const drawing = app.tool === 'draw';
    out.push(h('button', { type: 'button', class: `btn block${drawing ? ' accent' : ''}`, text: drawing ? 'Click on the Map to Add Points' : 'Draw a Barrier', onclick: () => app.setTool(drawing ? 'select' : 'draw') }));
    if (d.barriers.length) {
      out.push(h('div', { class: 'list' }, ...d.barriers.map((b, k) => {
        let len = 0; for (let i = 1; i < b.points.length; i++) len += Math.hypot(b.points[i][0] - b.points[i - 1][0], b.points[i][1] - b.points[i - 1][1]);
        return h('div', { class: 'list-item row' }, h('span', { text: `Barrier ${k + 1}` }), h('span', { class: 'muted', text: `${(len / 1000).toFixed(2)} km · ${b.crest.toFixed(1)} m` }),
          h('button', { type: 'button', class: 'link-btn', text: 'Remove', onclick: () => { d.barriers.splice(k, 1); app.refreshDefences(); this._changed(); this.renderLeft(); } }));
      })));
    }
    return out;
  }

  _modelBody() {
    const app = this.app, m = app.state.model, out = [];
    out.push(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: 'Grid' }), h('span', { class: 'field-value', text: `${fmtInt((48960 / m.dx) * (50880 / m.dx))} cells` })),
      seg([{ value: 80, name: '80 m Fast' }, { value: 40, name: '40 m Standard' }, { value: 20, name: '20 m Fine' }], m.dx, v => { m.dx = v; app.markDirty(); this.renderLeft(); }),
      h('div', { class: 'field-hint', text: m.dx <= 20 ? 'Fine resolves single streets; best with a dedicated graphics card.' : m.dx >= 80 ? 'Fast suits laptops and integrated graphics.' : 'Standard balances detail and speed.' })));
    out.push(toggle('Buildings Block Flow', m.porosity, v => { m.porosity = v; app.markDirty(); }, 'Sub-grid porosity from footprints'));
    out.push(slider({ label: 'Sewer Capacity', min: 0, max: 80, step: 2, value: m.drainage, fmt: v => `${v} mm/h`, onChange: v => { m.drainage = v; this._changed(); },
      hint: 'NYC sewers are designed for about 1.75 inches (44 mm) an hour.' }));
    out.push(slider({ label: 'Street Roughness', min: 0.015, max: 0.06, step: 0.001, value: m.nPaved, fmt: v => `n ${v.toFixed(3)}`, onChange: v => { m.nPaved = v; app.markDirty(); } }));
    return out;
  }

  _displayBody() {
    const app = this.app, d = app.state.display, L = d.layers, out = [];
    out.push(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: 'Light' })),
      seg([{ value: 'event', name: 'Event Clock' }, { value: 'day', name: 'Day' }, { value: 'dusk', name: 'Dusk' }, { value: 'night', name: 'Night' }], d.lighting, v => app.setLighting(v))));
    out.push(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: 'Sky' })),
      seg([{ value: 'auto', name: 'Auto' }, { value: 'clear', name: 'Clear' }, { value: 'overcast', name: 'Overcast' }, { value: 'storm', name: 'Storm' }], d.weather, v => app.setWeather(v))));
    const lay = [['buildings', '3D Buildings'], ['trees', 'Street Trees'], ['labels', 'Place Names'], ['tracers', 'Flow Tracers'], ['hwm', 'High-Water Marks'],
      ['subway', 'Subway Stations'], ['fema', 'FEMA Flood Zones'], ['sandy', 'Sandy Extent, 2012']];
    out.push(h('div', { class: 'layers' }, ...lay.map(([k, n]) => toggle(n, L[k], v => app.setLayer(k, v)))));
    out.push(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: 'Graphics' }), h('span', { class: 'field-value muted', text: app.tier === 'high' ? 'Dedicated GPU' : app.tier === 'balanced' ? 'Capable GPU' : 'Integrated GPU' })),
      seg([{ value: 'high', name: 'High' }, { value: 'balanced', name: 'Balanced' }, { value: 'performance', name: 'Light' }], d.quality, v => app.setQuality(v)),
      h('div', { class: 'field-hint', text: 'Resolution adapts on its own when frames slow down.' })));
    return out;
  }

  renderApply() {
    const bar = $('#apply-bar');
    if (!bar) return;
    bar.hidden = !this.app.dirty;
    if (this.app.dirty) {
      bar.replaceChildren(h('span', { class: 'apply-text', text: 'Settings changed' }),
        h('button', { type: 'button', class: 'btn small', text: 'Discard', onclick: () => { const a = this.app; a.applyPreset(a.state.preset === 'custom' ? 'sandy' : a.state.preset, false); } }),
        h('button', { type: 'button', class: 'btn small primary', text: 'Apply and Run', onclick: () => this.app.applyChanges(true) }));
    }
  }

  setToolBanner(tool, n = 0) {
    const b = $('#draw-banner');
    if (tool !== 'draw') { b.hidden = true; $('#view').classList.remove('drawing'); return; }
    $('#view').classList.add('drawing');
    b.hidden = false;
    b.replaceChildren(h('span', { text: n < 2 ? `Click on the map to place barrier points (${n} so far)` : `${n} points. Double-click or press Enter to finish.` }),
      h('button', { type: 'button', class: 'btn small', text: 'Cancel', onclick: () => this.app.setTool('select') }),
      n >= 2 ? h('button', { type: 'button', class: 'btn small primary', text: 'Finish', onclick: () => this.app.finishDraft() }) : null);
  }

  // ------------------------------------------------------------ right panel
  _buildRight() {
    const tabs = [['overview', 'Overview'], ['places', 'Places'], ['assets', 'Transit'], ['validation', 'Validation'], ['inspect', 'Inspect']];
    const host = $('#tabs');
    this.tabBtns = {};
    for (const [k, n] of tabs) {
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(k === this.tab), text: n, onclick: () => this.showTab(k) });
      this.tabBtns[k] = b; host.appendChild(b);
    }
  }

  showTab(k) {
    this.tab = k;
    for (const [key, b] of Object.entries(this.tabBtns)) b.setAttribute('aria-selected', String(key === k));
    this.renderRight(true);
    const p = $('#panel-right');
    if (innerWidth <= 1100) { document.querySelectorAll('.panel').forEach(x => x.classList.remove('open')); p.classList.add('open'); }
  }

  renderRight(force) {
    const body = $('#right-body');
    const fn = { overview: this._overview, places: this._places, assets: this._assets, validation: this._validation, inspect: this._inspect }[this.tab];
    const scroll = body.scrollTop;
    this._chart = null; this._ov = null;
    body.replaceChildren(fn.call(this));
    body.scrollTop = force ? 0 : scroll;
  }

  _headline() {
    const app = this.app, sim = app.sim, R = sim.results, sc = sim.scenario;
    const p = presetById(app.state.preset);
    const name = app.state.preset === 'custom' ? 'Custom Event' : p.name;
    const el = $('#headline');
    const status = { idle: 'Ready', running: 'Running', paused: 'Paused', seeking: 'Computing', done: 'Complete', error: 'Stopped' }[sim.status] || sim.status;
    const frac = sim.t / sc.duration;
    el.replaceChildren(
      h('div', { class: 'hl-top' }, h('span', { class: 'hl-name', text: name }), h('span', { class: `hl-status s-${sim.status}`, text: status })),
      h('div', { class: 'hl-progress' }, h('i', { style: `width:${(frac * 100).toFixed(1)}%` })),
      h('div', { class: 'hl-figures' },
        h('div', { class: 'hl-fig' }, h('span', { class: 'hl-label', text: 'Building Loss' }), h('span', { class: 'hl-value', text: R ? fmtMoney(R.loss) : '$0' })),
        h('div', { class: 'hl-fig' }, h('span', { class: 'hl-label', text: 'Buildings Flooded' }), h('span', { class: 'hl-value', text: R ? fmtInt(R.wet) : '0' })),
        h('div', { class: 'hl-fig' }, h('span', { class: 'hl-label', text: 'Flooded Land' }), h('span', { class: 'hl-value', text: `${(sim.solver.wetCity / 1e6).toFixed(1)} km²` }))));
  }

  _overview() {
    const app = this.app, sim = app.sim, sc = sim.scenario;
    const wrap = h('div', { class: 'tabpanel' });
    const ov = this._ov = {};
    ov.big = h('div', { class: 'kpi-big', text: '$0' });
    ov.sub = h('div', { class: 'kpi-sub', text: '' });
    wrap.append(h('div', { class: 'kpi-hero' }, h('div', { class: 'kpi-label', text: 'Estimated Damage to Buildings and Contents' }), ov.big, ov.sub));
    const kpi = (label, sub) => { const v = h('span', { class: 'kpi-value', text: '0' }); return [v, h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), v, h('span', { class: 'kpi-sub', text: sub }))]; };
    const [vWet, kWet] = kpi('Buildings Flooded', `Water at least ${Math.round(ENTRY_M * 100)} cm deep`);
    const [vFF, kFF] = kpi('Above First Floor', 'Water inside the living space');
    const [vRes, kRes] = kpi('Residents Affected', 'In homes flooded above the first floor');
    const [vSub, kSub] = kpi('Subway Stations', 'Underground, water at the entrances');
    Object.assign(ov, { vWet, vFF, vRes, vSub });
    wrap.append(h('div', { class: 'kpis' }, kWet, kFF, kRes, kSub));
    ov.peak = h('span', { class: 'block-sub', text: '' });
    const ch = h('div');
    wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Flooded City Land' }), ov.peak), ch));
    ov.rankWrap = h('div', { class: 'block' });
    wrap.append(ov.rankWrap);
    requestAnimationFrame(() => {
      this._chart = lineChart(ch, { height: 118, title: 'Flooded city land over time', series: [{ key: 'area', name: 'Flooded land', color: 'var(--series-1)', area: true }],
        xFmt: t => shortClock(sc, t), yFmt: (v, tip) => (tip ? `${v.toFixed(1)} km²` : `${v}`),
        xTicks: (a, b) => { const out = []; const st = b > 10 * 3600 ? 3 * 3600 : 3600; for (let t = 0; t <= b; t += st) out.push(t); return out; } });
      this._updateChart();
    });
    this._updateOverview();
    return wrap;
  }

  _updateOverview() {
    const ov = this._ov, app = this.app, sim = app.sim, R = sim.results;
    if (!ov) return;
    ov.big.textContent = R ? fmtMoney(R.loss) : '$0';
    ov.sub.textContent = R && R.loss > 0 ? `${fmtMoney(R.low)} to ${fmtMoney(R.high)} if every building sits at its 10th or 90th percentile damage` : 'No building has taken water yet';
    ov.vWet.textContent = R ? fmtInt(R.wet) : '0';
    ov.vFF.textContent = R ? fmtInt(R.aboveFF) : '0';
    ov.vRes.textContent = R ? fmtInt(R.residents) : '0';
    ov.vSub.textContent = R ? fmtInt(R.subwayFlooded) : '0';
    ov.peak.textContent = `Peak so far ${sim.maxArea.toFixed(1)} km²`;
    const top = R && R.loss > 0 ? [...R.nta.keys()].filter(k => R.nta[k] > 0).sort((a, b) => R.nta[b] - R.nta[a]).slice(0, 6) : [];
    const key = top.map(k => `${k}:${Math.round(R.nta[k] / 1e6)}`).join('|');
    if (key === ov.rankKey) return;
    ov.rankKey = key;
    if (top.length) {
      const max = R.nta[top[0]] || 1;
      ov.rankWrap.replaceChildren(h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Hardest-Hit Neighborhoods' }),
        h('button', { type: 'button', class: 'link-btn', text: 'All', onclick: () => this.showTab('places') })),
        h('div', { class: 'rank' }, ...top.map(k => this._rankRow(sim.ntas[k].name, BORO_SHORT[sim.ntas[k].boro], R.nta[k] / max, fmtMoney(R.nta[k]), () => app.flyToPoint(sim.ntas[k].x, sim.ntas[k].y, 2600)))));
    } else {
      ov.rankWrap.replaceChildren(h('div', { class: 'hint', html: '<strong>Press Run</strong> to start the storm. Drag the timeline to move through it; click any building for its damage, or open ground for a water gauge.' }));
    }
  }

  _kpi(label, value, sub) {
    return h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), h('span', { class: 'kpi-value', text: value }), h('span', { class: 'kpi-sub', text: sub }));
  }

  _rankRow(name, sub, frac, value, onclick) {
    return h('button', { type: 'button', class: 'rank-row', onclick },
      h('span', { class: 'rank-name' }, h('span', { text: name }), h('small', { text: sub })),
      h('span', { class: 'rank-bar' }, h('i', { style: `width:${Math.max(2, frac * 100).toFixed(1)}%` })),
      h('span', { class: 'rank-value', text: value }));
  }

  _updateChart() {
    if (!this._chart) return;
    const sim = this.app.sim;
    this._chart.update({ area: sim.series.map(p => [p.t, p.area]) }, 0, sim.scenario.duration, sim.t);
  }

  _places() {
    const app = this.app, sim = app.sim, R = sim.results;
    const wrap = h('div', { class: 'tabpanel' });
    if (!R) { wrap.append(h('div', { class: 'hint', text: 'Run the event to see results by borough and neighborhood.' })); return wrap; }
    const rows = [1, 2, 3, 4, 5].map(b => ({ b, ...R.boro[b], exposed: sim.exposedBoro[b] }));
    const bmax = Math.max(...rows.map(r => r.loss), 1);
    wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Boroughs' }), h('span', { class: 'block-sub', text: 'Loss and share of building value' })),
      h('div', { class: 'rank' }, ...rows.slice().sort((a, b) => b.loss - a.loss).map(r => {
        const lb = app.data.events.labels.boroughs.find(x => x.name === BOROUGHS[r.b]) || {};
        return this._rankRow(BOROUGHS[r.b], `${fmtInt(r.wet)} flooded · ${fmtPct(r.loss / Math.max(1, r.exposed))} of value`, r.loss / bmax, fmtMoney(r.loss), () => app.flyToPoint(lb.x, lb.y, 14000));
      })),
      h('table', { class: 'data-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Borough' }), h('th', { text: 'Flooded' }), h('th', { text: 'Above FF' }), h('th', { text: 'Residents' }))),
        h('tbody', {}, ...rows.map(r => h('tr', {}, h('td', { text: BORO_SHORT[r.b] }), h('td', { text: fmtInt(r.wet) }), h('td', { text: fmtInt(r.aboveFF) }), h('td', { text: fmtInt(r.residents) })))))));
    const ks = [...R.nta.keys()].filter(k => R.nta[k] > 0).sort((a, b) => R.nta[b] - R.nta[a]).slice(0, 40);
    if (ks.length) {
      const max = R.nta[ks[0]] || 1;
      wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Neighborhoods' }), h('span', { class: 'block-sub', text: `Top ${ks.length} by loss` })),
        h('div', { class: 'rank' }, ...ks.map(k => this._rankRow(sim.ntas[k].name, `${BORO_SHORT[sim.ntas[k].boro]} · ${fmtInt(R.ntaWet[k])} flooded`, R.nta[k] / max, fmtMoney(R.nta[k]), () => app.flyToPoint(sim.ntas[k].x, sim.ntas[k].y, 2600))))));
    }
    wrap.append(h('div', { class: 'block-sub', text: 'Residents: night-time population of the National Structure Inventory in homes flooded above the first floor. Neighborhoods are the 2020 Neighborhood Tabulation Areas.' }));
    return wrap;
  }

  _assets() {
    const app = this.app, sim = app.sim, R = sim.results;
    const wrap = h('div', { class: 'tabpanel' });
    if (!R) { wrap.append(h('div', { class: 'hint', text: 'Run the event to see subway stations and hospitals reached by water.' })); return wrap; }
    const wet = sim.subway.map((s, k) => ({ s, d: R.subway[k].max })).filter(x => x.d > 0.15).sort((a, b) => b.d - a.d);
    const under = wet.filter(x => x.s.structure !== 'Elevated' && x.s.structure !== 'Viaduct');
    wrap.append(h('div', { class: 'kpis' }, this._kpi('Stations Reached', fmtInt(under.length), `Of ${sim.subway.filter(s => s.structure !== 'Elevated' && s.structure !== 'Viaduct').length} below street or at grade`),
      this._kpi('Hospitals Reached', fmtInt(R.hospitalsFlooded), `Of ${sim.hospitals.length} in the five boroughs`)));
    if (under.length) {
      wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Subway Stations With Water at Street Level' })),
        h('div', { class: 'list' }, ...under.slice(0, 40).map(x => h('button', { type: 'button', class: 'list-item row clickable', onclick: () => app.flyToPoint(x.s.x, x.s.y, 900) },
          h('span', { class: 'routes' }, ...x.s.routes.split(' ').filter(Boolean).slice(0, 5).map(r => h('i', { class: `route r-${r.replace(/[^A-Z0-9]/gi, '')}`, text: r }))),
          h('span', { class: 'grow', text: x.s.name }), h('span', { class: 'muted', text: fmtM(x.d) }))))));
    }
    const hosp = sim.hospitals.map((s, k) => ({ s, d: R.hospitals[k].max })).filter(x => x.d > 0.15).sort((a, b) => b.d - a.d);
    if (hosp.length) {
      wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Hospitals With Water on Site' })),
        h('div', { class: 'list' }, ...hosp.map(x => h('button', { type: 'button', class: 'list-item row clickable', onclick: () => app.flyToPoint(x.s.x, x.s.y, 900) },
          h('span', { class: 'grow', text: x.s.name }), h('span', { class: 'muted', text: fmtM(x.d) }))))));
    }
    wrap.append(h('div', { class: 'block-sub', text: 'Depth is the peak water depth in the model cell at the station or hospital. Tunnels and basements flood through entrances, vents and grates that the model does not represent one by one.' }));
    return wrap;
  }

  _validation() {
    const app = this.app, sim = app.sim, R = sim.results, V = app.validation;
    const wrap = h('div', { class: 'tabpanel' });
    const replay = app.state.ev.mode === 'replay' && !(app.state.ev.slr > 0);
    if (replay && R && R.hwmStats) {
      const s = R.hwmStats;
      wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'High-Water Marks, This Run' }), h('span', { class: 'block-sub', text: `At ${shortClock(sim.scenario, sim.t)}` })),
        h('div', { class: 'kpis three' }, this._kpi('Mean Error', `${s.bias >= 0 ? '+' : ''}${s.bias.toFixed(2)} m`, 'Model minus observed'), this._kpi('Typical Miss', `${s.mae.toFixed(2)} m`, 'Mean absolute error'),
          this._kpi('Marks Reached', `${s.n} of ${s.n + s.dry}`, `${s.dry} still dry in the model`))));
      const pts = sim.hwm.map((hm, k) => (R.hwm[k] != null ? { x: hm.elev_m, y: R.hwm[k], cat: hm.boro ? 'nyc' : 'nj', label: `HWM ${hm.id}, ${hm.county}` } : null)).filter(Boolean);
      const sc = h('div');
      wrap.append(h('div', { class: 'block' }, sc, h('div', { class: 'legend-row' }, h('span', { class: 'key' }, h('i', { class: 'dot', style: 'background:var(--series-1)' }), 'New York City'), h('span', { class: 'key' }, h('i', { class: 'dot', style: 'background:var(--series-3)' }), 'New Jersey'))));
      requestAnimationFrame(() => scatterChart(sc, { points: pts, cats: [{ key: 'nyc', color: 'var(--series-1)' }, { key: 'nj', color: 'var(--series-3)' }], domain: [1.5, 5], fmt: (v, u) => (u ? `${v.toFixed(2)} m` : v.toFixed(1)), xLabel: 'Observed, m NAVD88', yLabel: 'Simulated, m', height: 240 }));
      if (sim.extent) {
        const e = sim.extent;
        wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Flood Extent Against the Mapped Sandy Zone' })),
          h('div', { class: 'kpis three' }, this._kpi('Critical Success', e.csi.toFixed(2), 'Overlap over union'), this._kpi('Hit Rate', fmtPct(e.hitRate), 'Of mapped flooding'), this._kpi('False Alarms', fmtPct(e.far), 'Of modelled flooding')),
          h('div', { class: 'block-sub', text: `Mapped ${e.obsKm2.toFixed(1)} km², modelled ${e.simKm2.toFixed(1)} km² of city land (cells deeper than 10 cm).` })));
      } else wrap.append(h('div', { class: 'block-sub', text: 'Extent agreement is computed when the replay finishes.' }));
    } else {
      wrap.append(h('div', { class: 'callout', text: 'Live validation runs during the Hurricane Sandy replay without sea level rise, against 158 USGS high-water marks and the mapped 2012 inundation zone.' }));
    }
    if (V?.runs?.length) {
      wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Reference Runs, Full Sandy Replay' })),
        h('table', { class: 'data-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Grid' }), h('th', { text: 'Marks' }), h('th', { text: 'Bias' }), h('th', { text: 'MAE' }), h('th', { text: 'RMSE' }), h('th', { text: 'CSI' }))),
          h('tbody', {}, ...V.runs.map(r => h('tr', {}, h('td', { text: `${r.dx} m` }), h('td', { text: `${r.hwm.n}` }), h('td', { text: `${r.hwm.bias >= 0 ? '+' : ''}${r.hwm.bias.toFixed(2)}` }),
            h('td', { text: r.hwm.mae.toFixed(2) }), h('td', { text: r.hwm.rmse.toFixed(2) }), h('td', { text: r.extent.csi.toFixed(2) }))))),
        h('div', { class: 'block-sub', text: 'Metres; marks are USGS Sandy high-water marks inside the model domain. See the methodology for how these were produced.' })));
    }
    return wrap;
  }

  _inspect() {
    const app = this.app, sim = app.sim, sel = app.selected;
    const wrap = h('div', { class: 'tabpanel' });
    if (sel) {
      const inf = app.city.infoAt(sel.texel);
      const cls = app.data.city.class_names[inf.cls] || 'Building';
      if (sel.id >= sim.n) {
        wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-title big', text: cls }), h('div', { class: 'block-sub', text: 'Outside New York City, drawn from OpenStreetMap for context; not priced.' }),
          h('dl', { class: 'facts' }, h('dt', { text: 'Height' }), h('dd', { text: `${inf.h.toFixed(0)} m` }), h('dt', { text: 'Ground' }), h('dd', { text: `${inf.ground.toFixed(1)} m NAVD88` }))));
      } else {
        const b = sim.buildingInfo(sel.id);
        const facts = [['Height', `${inf.h.toFixed(0)} m, ${b.storeys} ${b.storeys === 1 ? 'storey' : 'storeys'}`], ['Ground', `${b.ground.toFixed(2)} m NAVD88 (model cell)`]];
        if (b.arch) facts.push(['Damage Curve', b.archLabel], ['First Floor', `${b.ffh.toFixed(1)} m above ground`], ['Value', `${fmtMoney(b.vs)} structure, ${fmtMoney(b.vc)} contents`], ['Residents', b.pop ? fmtInt(b.pop) : 'None recorded']);
        wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-title big', text: cls }), h('div', { class: 'block-sub', text: `${b.nta || ''}, ${b.boro}` }),
          h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
          h('button', { type: 'button', class: 'link-btn', text: 'Fly to this building', onclick: () => app.flyToBuilding(sel) })));
        const wet = b.depthMax > ENTRY_M;
        wrap.append(h('div', { class: 'kpis' }, this._kpi('Peak Water', b.depthMax > 0.005 ? fmtM(b.depthMax) : 'Dry', 'At the building, above ground'),
          this._kpi('Now', b.depthNow > 0.005 ? fmtM(b.depthNow) : 'Dry', shortClock(sim.scenario, sim.t))));
        if (b.arch) {
          const d = b.damage;
          wrap.append(h('div', { class: 'kpi-hero small' }, h('div', { class: 'kpi-label', text: 'Expected Loss' }), h('div', { class: 'kpi-big', text: wet ? fmtMoney(b.loss) : '$0' }),
            h('div', { class: 'kpi-sub', text: wet ? `Damage ratio ${fmtPct(d.mean)} once water is inside (10th to 90th percentile ${fmtPct(d.p10)} to ${fmtPct(d.p90)})${b.entry < 1 ? `, weighted by a ${fmtPct(b.entry)} chance of entry below the first floor` : ''}${b.share < 1 ? ', on the lowest two storeys' : ''}` : 'Water has not reached 15 cm here' })));
          const cc = h('div');
          wrap.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'FloodVuln Damage Curve' }), h('span', { class: 'block-sub', text: 'New York calibration' })), cc));
          requestAnimationFrame(() => curveChart(cc, { ...b.curve, at: wet ? d : null }));
        } else wrap.append(h('div', { class: 'block-sub', text: 'No National Structure Inventory record is joined to this footprint, so it is not priced.' }));
      }
    }
    const pv = sim.probeValue, pt = sim.probe;
    if (pt) {
      const blk = h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Water Gauge' }),
        h('button', { type: 'button', class: 'link-btn', text: 'Remove', onclick: () => app.setProbe(null) })));
      if (pv) {
        blk.append(h('div', { class: 'kpis three' }, this._kpi('Depth', pv.h > 0.005 ? fmtM(pv.h) : 'Dry', `Ground ${pv.z.toFixed(2)} m`), this._kpi('Speed', `${pv.speed.toFixed(2)} m/s`, 'Depth-averaged'),
          this._kpi('Peak', fmtM(pv.maxDepth), pv.arrival > 0 ? `Wet from ${shortClock(sim.scenario, pv.arrival)}` : 'Not yet wet')));
        const pc = h('div'); blk.append(pc);
        requestAnimationFrame(() => {
          const c = lineChart(pc, { height: 110, title: 'Depth at the gauge', series: [{ key: 'h', name: 'Depth', color: 'var(--series-1)', area: true }], xFmt: t => shortClock(sim.scenario, t),
            yFmt: (v, tip) => (tip ? `${v.toFixed(2)} m` : `${v}`), xTicks: (a, bb) => { const o = []; for (let t = 0; t <= bb; t += 3 * 3600) o.push(t); return o; } });
          c.update({ h: sim.probeSeries.map(p => [p[0], p[1]]) }, 0, sim.scenario.duration, sim.t);
        });
      }
      wrap.append(blk);
    }
    if (!sel && !pt) wrap.append(h('div', { class: 'hint', html: '<strong>Click a building</strong> for its value, peak water and damage, or <strong>click open ground</strong> to drop a water gauge there.' }));
    return wrap;
  }

  // ------------------------------------------------------------ events from the app
  onGrid(g) {
    if (!g) return;
    $('#grid-badge').textContent = `${g.dx} m grid · ${(g.N / 1e6).toFixed(g.N > 1e6 ? 1 : 2)}M cells`;
  }

  onResults() { this._dirtyRight = true; }
  onExtent() { if (this.tab === 'validation') this.renderRight(); }
  onProbe() { if (this.tab === 'inspect') this._dirtyRight = true; }
  onStatus() { this._setPlayIcon(); this._dirtyRight = true; }
  onSelect(showTab) { if (showTab && this.app.selected) this.showTab('inspect'); else if (this.tab === 'inspect') this.renderRight(true); }
  onProbeSet(pt) { if (pt) this.showTab('inspect'); else if (this.tab === 'inspect') this.renderRight(true); }
  onReset() {
    this.timeline?.setScenario(this.app.sim.scenario);
    this.renderRight(true);
    this._setPlayIcon();
  }

  /** Called every frame. */
  frame(now) {
    const app = this.app, sim = app.sim, sc = sim.scenario;
    this._setPlayIcon();
    this.timeline.update();
    const clock = clockLabel(sc, sim.t);
    if (clock !== this._clock) {
      this._clock = clock;
      $('#clock').firstChild.textContent = clock;
    }
    const g = sc.gauges(sim.t);
    const sub = `The Battery ${g[0].toFixed(2)} m${sc.rain(sim.t) > 0 ? ` · Rain ${Math.round(sc.rain(sim.t))} mm/h` : ''}`;
    if (sub !== this._clockSub) { this._clockSub = sub; $('#clock-sub').textContent = sub; }
    const v = app.viewer.currentView();
    this.compass.style.transform = `rotate(${-v.azim}deg)`;
    if (now - this._lastFrameUI > 0.5) {
      this._lastFrameUI = now;
      this._headline();
      if (this._dirtyRight) {
        if (this.tab === 'overview') { this._dirtyRight = false; this._updateOverview(); }
        else if (now - (this._lastRight || 0) > 1.5) { this._dirtyRight = false; this._lastRight = now; this.renderRight(); }
      }
      this._updateChart();
      const rate = sim.simRate;
      $('#perf').textContent = sim.status === 'running' || sim.status === 'seeking' ? `${rate > 10 ? fmtInt(rate) : rate.toFixed(1)}× real time` : '';
      const r = app.city.readiness();
      const ld = $('#city-loading');
      ld.hidden = r > 0.98;
      if (!ld.hidden) ld.querySelector('span').textContent = `Loading buildings ${Math.round(r * 100)}%`;
    }
  }

  // ------------------------------------------------------------ canvas interaction
  _bindCanvas() {
    const app = this.app, cv = $('#view'), hover = $('#hovercard');
    let down = null;
    cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button }; app.viewer.cancelFly(); });
    cv.addEventListener('pointerup', e => {
      if (!down || down.b !== 0) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 600;
      down = null;
      if (moved) return;
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (app.tool === 'draw') { const g = app.viewer.groundAt(x, y); if (g) app.addDraftPoint(g.x, g.y); return; }
      const pick = e.shiftKey ? null : app.viewer.pickBuilding(x, y);
      if (pick && pick.id >= 0) { app.selectBuilding(pick); return; }
      const g = app.viewer.groundAt(x, y);
      if (g) { app.selectBuilding(null, false); app.setProbe({ x: g.x, y: g.y }); }
    });
    cv.addEventListener('dblclick', () => { if (app.tool === 'draw') app.finishDraft(); });
    let hoverT = null;
    cv.addEventListener('pointermove', e => {
      hover.hidden = true;
      clearTimeout(hoverT);
      if (e.buttons || app.tool === 'draw') return;
      hoverT = setTimeout(() => this._hover(e), 160);
    });
    cv.addEventListener('pointerleave', () => { clearTimeout(hoverT); hover.hidden = true; });
  }

  _hover(e) {
    const app = this.app, cv = $('#view'), hc = $('#hovercard');
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const pick = app.viewer.pickBuilding(x, y);
    if (!pick || pick.id < 0) { hc.hidden = true; return; }
    const inf = app.city.infoAt(pick.texel), sim = app.sim;
    const rows = [];
    let title = app.data.city.class_names[inf.cls] || 'Building';
    if (pick.id < sim.n) {
      const E = app.data.exposure, k = pick.id;
      const nta = sim.ntas[E.nta[k]]?.name;
      title = `${title}${nta ? `, ${nta}` : ''}`;
      const d = sim.bDepthMax[k];
      rows.push(['Peak water', d > 0.005 ? fmtM(d) : 'Dry']);
      if (sim.bLoss[k] > 0) rows.push(['Loss', fmtMoney(sim.bLoss[k])]);
      else if (E.vs[k] > 0) rows.push(['Value', fmtMoney(E.vs[k] + E.vc[k])]);
    }
    rows.push(['Height', `${inf.h.toFixed(0)} m`]);
    hc.replaceChildren(h('div', { class: 'hovercard-title', text: title }), ...rows.map(([k, v]) => h('div', { class: 'hovercard-row' }, h('span', { text: k }), h('b', { text: v }))));
    hc.hidden = false;
    hc.style.left = `${Math.min(e.clientX + 14, innerWidth - hc.offsetWidth - 8)}px`;
    hc.style.top = `${Math.min(e.clientY + 14, innerHeight - hc.offsetHeight - 8)}px`;
  }

  _bindKeys() {
    const app = this.app;
    addEventListener('keydown', e => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.code === 'Space') { app.togglePlay(); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') app.restart();
      else if (e.key >= '1' && e.key <= '7') app.setMode(+e.key - 1);
      else if (e.key === 'Escape') { if (app.tool === 'draw') app.setTool('select'); else if (app.selected) app.selectBuilding(null); else if (app.sim.probe) app.setProbe(null); this.closeWelcome(); }
      else if (e.key === 'Enter' && app.tool === 'draw') app.finishDraft();
    });
  }

  // ------------------------------------------------------------ welcome
  welcome() {
    const w = $('#welcome');
    w.hidden = false;
    const app = this.app;
    $('#welcome-sandy').addEventListener('click', () => { this.closeWelcome(); app.viewer.flyTo(app.views[1], 3.2); app.sim.play(); });
    $('#welcome-explore').addEventListener('click', () => { this.closeWelcome(); });
    $('#welcome-grid').textContent = `${(app.sim.grid.N / 1e6).toFixed(1)} million`;
    $('#welcome-gpu').textContent = app.tier === 'performance' ? 'Running in light mode for this device; switch to High under Display for more detail.' : 'Drag to orbit, right-drag to pan, scroll to zoom. Click a building for its damage.';
  }

  closeWelcome() { const w = $('#welcome'); if (w && !w.hidden) w.hidden = true; }
}
