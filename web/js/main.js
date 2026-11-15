// FloodTwin NYC: bootstrap, application state and actions, and the frame loop.
import * as THREE from 'three';
import { loadAll, makeGeo } from './data.js';
import { Viewer } from './render.js';
import { Terrain } from './scene/terrain.js';
import { City } from './scene/city.js';
import { Water } from './scene/water.js';
import { Tracers } from './scene/tracers.js';
import { Markers } from './scene/markers.js';
import { Bridges } from './scene/bridges.js';
import { Simulation } from './sim.js';
import { presetById } from './scenarios.js';
import { Labels } from './labels.js';
import { UI } from './ui.js';

const $ = (s) => document.querySelector(s);

// target: [east, north, height] in local metres; polar from vertical; azim 0 = looking north
export const VIEWS = [
  { name: 'New York Harbor', target: [21000, 24500, 5], dist: 4600, polar: 70, azim: 20 },
  { name: 'Lower Manhattan', target: [21800, 26300, 5], dist: 3000, polar: 60, azim: 28 },
  { name: 'Five Boroughs', target: [27500, 24500, 0], dist: 50000, polar: 48, azim: 18 },
  { name: 'Battery Park City', target: [21194, 26470, 3], dist: 1300, polar: 62, azim: 70 },
  { name: 'Red Hook and Gowanus', target: [22500, 22760, 2], dist: 3200, polar: 58, azim: 40 },
  { name: 'Long Island City', target: [26558, 30084, 3], dist: 2800, polar: 58, azim: -40 },
  { name: 'Coney Island', target: [24069, 11570, 2], dist: 3600, polar: 58, azim: 12 },
  { name: 'Howard Beach and Broad Channel', target: [36656, 18300, 1], dist: 6200, polar: 56, azim: 10 },
  { name: 'The Rockaways', target: [38441, 13027, 2], dist: 6500, polar: 58, azim: -15 },
  { name: 'Midland Beach, Staten Island', target: [14931, 11193, 2], dist: 3600, polar: 58, azim: 45 },
  { name: 'LaGuardia Airport', target: [33179, 33941, 2], dist: 3800, polar: 56, azim: 20 },
  { name: 'Hoboken and Jersey City', target: [19890, 28500, 2], dist: 4200, polar: 58, azim: 70 },
  { name: 'Street Level, South Street', target: [22381, 26061, 3], dist: 140, polar: 84, azim: 300 },
];

/** Unmodelled land and sea around the domain: a dark plane that thins into the horizon haze. */
function makeApron(W, H, shared) {
  const R = 160000, pos = [], idx = [];
  const inner = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]];
  const outer = [[-R, -R], [R, -R], [R, R], [-R, R]];
  for (const [x, z] of [...inner, ...outer]) pos.push(x, -0.6, z);
  for (let k = 0; k < 4; k++) { const a = k, b = (k + 1) % 4, c = 4 + k, d = 4 + (k + 1) % 4; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: { uApron: shared.uApron, uFogColor: shared.uFogColor, uFogDensity: shared.uFogDensity },
    vertexShader: 'varying vec3 vW; varying float vD; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: `uniform vec3 uApron, uFogColor;
uniform float uFogDensity;
varying vec3 vW;
varying float vD;
void main() {
  float t = smoothstep(32000.0, 150000.0, length(vW.xz));
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vD * vD);
  gl_FragColor = vec4(mix(mix(uApron, uFogColor, t), uFogColor, f), 1.0);
}`,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.renderOrder = -5; mesh.name = 'apron';
  return mesh;
}

function gpuInfo() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return 'FloodTwin NYC needs WebGL 2, which this browser or device does not provide.';
  if (!gl.getExtension('EXT_color_buffer_float')) return 'This GPU cannot render to floating-point textures (EXT_color_buffer_float), which the flood solver needs.';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { name };
}

/** A first guess at what the device can do; the frame-time governor refines it while running. */
function tierOf(name) {
  const n = (name || '').toLowerCase();
  // phones and tablets: a mobile user agent, or a touch screen with no mouse or trackpad
  const small = /android|iphone|ipad|mobile/i.test(navigator.userAgent) || (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
  if (/swiftshader|llvmpipe|software|basic render/.test(n) || small) return 'performance';
  if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|rx \d{3,4}|arc\(tm\) a|arc a\d|apple m\d (pro|max|ultra)/.test(n)) return 'high';
  if (/apple m\d|apple gpu/.test(n)) return 'balanced';
  if (/intel|uhd|iris|mali|adreno|powervr|radeon\(tm\) graphics|vega/.test(n)) return 'performance';
  return 'balanced';
}

const GRID_FOR = { high: 40, balanced: 40, performance: 80 };
const SNAPS_FOR = { high: 320e6, balanced: 200e6, performance: 100e6 };

class App {
  constructor() {
    this.views = VIEWS;
    this.tool = 'select';
    this.selected = null;
    this.draft = [];
    this.dirty = false;
    this.rainWet = 0;
  }

  async start() {
    const gpu = gpuInfo();
    if (typeof gpu === 'string') return this.fail(gpu);
    this.gpu = gpu;
    this.tier = tierOf(gpu.name);
    const t0 = performance.now();
    const data = await loadAll('data', (f, label) => {
      $('#loader-bar').style.width = `${Math.round(f * 90)}%`;
      $('#loader-pct').textContent = `${Math.round(f * 90)}%`;
      $('#loader-text').textContent = label;
    });
    this.validation = await fetch('data/validation.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
    const bridgeData = await fetch('data/bridges.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
    this.data = data;
    this.geo = makeGeo(data.meta);
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.W = W; this.H = H;
    $('#loader-text').textContent = 'Building the city';
    await new Promise(r => setTimeout(r, 30));

    const img = new THREE.Texture(data.imagery);
    img.colorSpace = THREE.SRGBColorSpace; img.anisotropy = 8; img.generateMipmaps = true;
    img.minFilter = THREE.LinearMipmapLinearFilter; img.needsUpdate = true;
    const shared = this.shared = {
      imageryTex: img,
      uVis: { value: null }, uState: { value: null }, uStats: { value: null }, uBed: { value: null },
      uSimTime: { value: 0 }, uMode: { value: 0 }, uShowFema: { value: 0 }, uShowSandy: { value: 0 },
      uDomain: { value: new THREE.Vector2(W, H) }, uDryTime: { value: 5400 }, uRainWet: { value: 0 }, uTEnd: { value: 1 },
      uNight: { value: 0 }, uDay: { value: 1 }, uTime: { value: 0 }, uRainVis: { value: 0 }, uWind: { value: 0.1 },
      uFogColor: { value: new THREE.Color(0x8a949c) }, uFogDensity: { value: 0.00002 }, uSelected: { value: -1 }, uFlood: { value: 0 },
      uApron: { value: new THREE.Color(0x2a3035) },
    };

    const viewer = this.viewer = new Viewer($('#view'), shared);
    const quality = this._initialQuality();
    viewer.setQuality(quality);
    const terrain = this.terrain = new Terrain(data, shared, this.geo);
    const water = this.water = new Water(data, shared);
    const city = this.city = new City({ data, shared, terrain, renderer: viewer.renderer, base: new URL('data/', location.href).href, quality });
    const markers = this.markers = new Markers(data, terrain);
    const tracers = this.tracers = new Tracers(viewer.renderer, shared);
    const sc = viewer.scene;
    sc.add(terrain.group, city.group, makeApron(W, H, shared));
    if (bridgeData) { this.bridges = new Bridges(bridgeData, W, H); sc.add(this.bridges.group); }
    for (const o of [water.group, tracers.mesh]) { o.traverse(x => x.layers.set(1)); sc.add(o); }
    markers.group.traverse(x => x.layers.set(3)); sc.add(markers.group);
    viewer.sun.shadow.camera.layers.enableAll();
    viewer.setWater(water);
    viewer.initPicking(city, W, H, (x, y) => terrain.heightAt(x, y));

    const sim = this.sim = new Simulation(viewer.renderer, data);
    sim.snapBudget = SNAPS_FOR[quality] || 200e6;
    sim.on('grid', g => {
      water.setRiver(g);
      tracers.setRiver(water.riverTex);
      shared.uVis.value = sim.solver.vis.texture;
      shared.uState.value = sim.solver.a.texture;
      shared.uBed.value = sim.solver.bedTex;
      shared.uFlood.value = 1;
      markers.setDefences(this.state.defences.barriers, g, this.state.defences.waterfront);
      this.ui?.onGrid(g);
    });
    sim.on('results', R => {
      city.setDamage(sim.bDr, sim.bFlags);
      markers.setHwmSim(R.hwm);
      markers.setStations(R.subway);
      this.labels.setHwmValues(R.hwm);
      this.labels.setStations(R.subway);
      this.ui?.onResults(R);
    });
    sim.on('reset', () => {
      city.setDamage(sim.bDr, sim.bFlags);
      markers.setHwmSim(null); markers.setStations(null);
      this.labels?.setHwmValues(null); this.labels?.setStations(null);
      tracers.reset();
      this.ui?.onReset();
      this.rainWet = 0;
    });
    sim.on('extent', () => this.ui?.onExtent());
    sim.on('probe', v => { markers.setProbeWater(v.wse); this.ui?.onProbe(); });
    sim.on('status', () => this.ui?.onStatus());
    sim.on('error', msg => this.toast(msg, 6000));

    this.state = this._initialState(quality);
    this.labels = new Labels($('#labels'), viewer, data, terrain);

    $('#loader-text').textContent = 'Building the model grid';
    await new Promise(r => setTimeout(r, 30));
    this._configure();
    this.ui = new UI(this);
    this.applyDisplay();
    viewer.setView(this.state.view || VIEWS[0]);
    this._lightKey = '';
    this._updateLighting(true);

    // first frames compile shaders; keep the loader up until they are done
    $('#loader-text').textContent = 'Compiling shaders';
    await new Promise(r => setTimeout(r, 20));
    this.last = performance.now() / 1000;
    this._frame(this.last);
    viewer.renderer.compile(viewer.scene, viewer.camera);
    this._frame(this.last + 0.016);
    $('#loader-bar').style.width = '100%';
    $('#loader-pct').textContent = '100%';
    $('#loader').classList.add('done');
    setTimeout(() => $('#loader').remove(), 700);
    console.info(`FloodTwin NYC ready in ${Math.round(performance.now() - t0)} ms on ${gpu.name || 'unknown GPU'} (${this.tier})`);

    const qa = new URLSearchParams(location.search);
    if (qa.has('qa')) this._qa(qa);
    else if (this.fromLink) { this.toast('Scenario loaded from the link'); if (this.fromLink.run) sim.play(); }
    else this.ui.welcome();
    requestAnimationFrame(t => this._loop(t));
  }

  fail(msg) {
    const l = $('#loader');
    l.querySelector('.loader-bar')?.remove();
    l.querySelector('.loader-status')?.remove();
    const e = document.createElement('div'); e.className = 'loader-error'; e.textContent = msg;
    l.querySelector('.loader-inner').appendChild(e);
  }

  _initialQuality() {
    const q = new URLSearchParams(location.search).get('quality');
    let saved = null;
    try { saved = localStorage.getItem('floodtwin-nyc-quality'); } catch { /* storage unavailable */ }
    return q || saved || this.tier;
  }

  _initialState(quality) {
    const p = presetById('sandy');
    const st = {
      preset: 'sandy',
      ev: { ...p.p },
      model: { dx: GRID_FOR[this.tier] || 40, drainage: p.p.drainage, infiltration: p.p.infiltration, nPaved: 0.030, nGreen: 0.045,
        porosity: true, theta: 0.8, frMax: 1.0, alpha: 0.7 },
      defences: { waterfront: { boros: [], crest: 4.0 }, barriers: [] },
      display: { mode: 0, lighting: 'day', weather: 'auto', quality,
        layers: { buildings: true, trees: true, labels: true, hwm: true, subway: true, tracers: true, fema: false, sandy: false } },
      speed: 900,
    };
    const m = location.hash.match(/s=([A-Za-z0-9_-]+)/);
    if (m) {
      try {
        const json = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
        for (const k of ['preset', 'ev', 'model', 'defences', 'speed', 'view']) if (json[k] != null) st[k] = json[k];
        if (json.display) Object.assign(st.display, json.display, { layers: { ...st.display.layers, ...(json.display.layers || {}) } });
        this.fromLink = { run: !!json.run };
      } catch (e) { console.warn('Could not read the link', e); }
    }
    return st;
  }

  _configure() {
    const st = this.state;
    const model = { ...st.model, barriers: st.defences.barriers, waterfront: st.defences.waterfront };
    this.sim.speed = st.speed;
    this.sim.configure(model, { ...st.ev, drainage: st.model.drainage, infiltration: st.model.infiltration });
    this.shared.uTEnd.value = this.sim.scenario.duration;
    this.dirty = false;
  }

  /** Apply pending settings (rebuilds the grid if needed) and restart. */
  applyChanges(run) {
    const busy = $('#busy');
    $('#busy-text').textContent = this.state.model.dx <= 20 ? 'Building the 20 m model grid (6.2 million cells)' : 'Building the model grid';
    busy.hidden = false;
    setTimeout(() => {
      try { this._configure(); } catch (e) { console.error(e); this.toast(`Could not build the model: ${e.message}`, 6000); }
      busy.hidden = true;
      this.ui.renderLeft();
      this.ui.updateLegend();
      this._lightKey = '';
      if (run) this.sim.play();
    }, 40);
  }

  applyPreset(id, run = true) {
    const p = presetById(id), st = this.state;
    st.preset = id;
    st.ev = { ...p.p };
    st.model.drainage = p.p.drainage; st.model.infiltration = p.p.infiltration;
    this.applyChanges(run);
  }

  markDirty() { this.dirty = true; this.ui?.renderApply(); }
  markCustom() { this.state.preset = 'custom'; }

  togglePlay() {
    const s = this.sim;
    if (s.status === 'running' || (s.status === 'seeking' && s.resumeAfterSeek)) s.pause(); else s.play();
    this.ui.closeWelcome();
  }

  restart() { this.sim.reset(); this.sim.play(); }
  seek(t) { this.sim.seek(t); }
  setSpeed(v) { this.state.speed = v; this.sim.speed = v; }

  setMode(m) {
    this.state.display.mode = m;
    this.shared.uMode.value = m;
    this.ui.syncModes();
    this.ui.updateLegend();
  }

  setLighting(l) { this.state.display.lighting = l; this._lightKey = ''; }
  setWeather(w) { this.state.display.weather = w; this._lightKey = ''; }

  setLayer(k, on) {
    this.state.display.layers[k] = on;
    this.applyDisplay();
    this.ui.updateLegend();
  }

  setQuality(q) {
    this.state.display.quality = q;
    this.viewer.setQuality(q);
    this.city.setQuality(q);
    try { localStorage.setItem('floodtwin-nyc-quality', q); } catch { /* storage unavailable */ }
  }

  applyDisplay() {
    const L = this.state.display.layers, sh = this.shared;
    sh.uShowFema.value = L.fema ? 1 : 0;
    sh.uShowSandy.value = L.sandy ? 1 : 0;
    sh.uMode.value = this.state.display.mode;
    this.markers.show.hwm = L.hwm; this.markers.show.subway = L.subway;
    this.labels.show.hwm = L.hwm; this.labels.show.subway = L.subway; this.labels.show.places = L.labels;
    this.city.group.visible = L.buildings;
    this.city.showTrees = L.trees;
    for (const ch of this.city.chunks) if (ch.treeMesh) ch.treeMesh.visible = L.trees;
    this.tracers.mesh.visible = L.tracers;
  }

  _hour() {
    const l = this.state.display.lighting, sc = this.sim.scenario;
    if (l === 'day') return 14.4;
    if (l === 'dusk') return 17.6;
    if (l === 'night') return 21.5;
    if (sc.clock === 'absolute') { const d = new Date(sc.start + this.sim.t * 1000 - 4 * 3600 * 1000); return d.getUTCHours() + d.getUTCMinutes() / 60; }
    return (10 + this.sim.t / 3600) % 24;
  }

  _weather() {
    const w = this.state.display.weather;
    if (w !== 'auto') return w;
    const sc = this.sim.scenario;
    if (sc.rain(this.sim.t) > 0) return 'rain';
    // the storm sky builds with the surge and clears behind it
    const st = sc.stage(this.sim.t);
    return st > 2.3 ? 'storm' : st > 1.9 ? 'overcast' : 'partly';
  }

  _updateLighting(force) {
    const hour = this._hour(), weather = this._weather();
    const key = `${Math.round(hour * 6)}|${weather}`;
    if (!force && key === this._lightKey) return;
    this._lightKey = key;
    this.viewer.setLighting(hour, weather);
    const wind = { clear: 0.03, partly: 0.05, overcast: 0.07, rain: 0.14, storm: 0.26 }[weather];
    const ev = this.state.ev;
    const surge = ev.mode === 'replay' ? 1 : ev.mode === 'surge' ? Math.min(1, Math.max(0.35, (ev.peak - 1.5) / 1.6)) : 0;
    this.water.uniforms.uStorm.value = Math.max(surge * 0.9, { clear: 0.12, partly: 0.18, overcast: 0.25, rain: 0.4, storm: 0.9 }[weather]);
    this.shared.uWind.value = Math.max(wind, surge * 0.2);
  }

  // ---------- selection, probe, tools ----------
  /** Select a building from a pick: { id, texel } (id < NYC count has exposure). */
  selectBuilding(pick, showTab = true) {
    this.selected = pick;
    this.shared.uSelected.value = pick ? pick.texel : -1;
    this.ui.onSelect(showTab);
  }

  flyToBuilding(pick) {
    const info = this.city.infoAt(pick.texel);
    const k = pick.id;
    const E = this.data.exposure;
    const x = k < E.n ? E.x[k] : null, y = k < E.n ? E.y[k] : null;
    if (x == null) return;
    const v = this.viewer.currentView();
    this.viewer.flyTo({ target: [x, y, info.ground + Math.min(info.h, 80) * 0.4], dist: Math.max(260, Math.min(info.h * 5, 1400)), polar: 58, azim: v.azim });
  }

  flyToPoint(x, y, dist = 1800) {
    const v = this.viewer.currentView();
    this.viewer.flyTo({ target: [x, y, this.terrain.heightAt(x, y)], dist, polar: 58, azim: v.azim });
  }

  setProbe(pt) {
    this.sim.setProbe(pt);
    this.markers.setProbe(pt);
    this.ui.onProbeSet(pt);
  }

  setTool(t) {
    if (this.tool === 'draw' && t !== 'draw') { this.draft = []; this.markers.setDraft([]); }
    this.tool = t;
    this.ui.setToolBanner(t, this.draft.length);
    this.ui.renderLeft();
  }

  addDraftPoint(x, y) {
    this.draft.push([x, y]);
    this.markers.setDraft(this.draft, this.state.defences.waterfront.crest);
    this.ui.setToolBanner('draw', this.draft.length);
  }

  finishDraft() {
    if (this.draft.length >= 2) {
      this.state.defences.barriers.push({ points: this.draft.slice(), crest: this.state.defences.waterfront.crest });
      this.markDirty();
      this.toast('Barrier added. Apply to include it in the model.');
    }
    this.draft = [];
    this.markers.setDraft([]);
    this.refreshDefences();
    this.setTool('select');
  }

  refreshDefences() { this.markers.setDefences(this.state.defences.barriers, this.sim.grid, this.state.defences.waterfront); }

  /** Return period of a rainfall depth over a duration, from NOAA Atlas 14 (Central Park). */
  returnPeriod(totalMm, hours) {
    const a = this.data.events.atlas14;
    if (!a) return null;
    const hrs = a.durations.map(d => d.endsWith('-min') ? parseInt(d) / 60 : d.endsWith('-hr') ? parseInt(d) : parseInt(d) * 24);
    let k = hrs.findIndex(x => x >= hours);
    if (k < 0) k = hrs.length - 1;
    const k0 = Math.max(0, k - 1), w = k === k0 ? 0 : (Math.log(hours) - Math.log(hrs[k0])) / (Math.log(hrs[k]) - Math.log(hrs[k0]));
    const cw = Math.min(1, Math.max(0, w));
    const depth = a.return_periods_yr.map((_, r) => a.depth[k0][r] * (1 - cw) + a.depth[k][r] * cw);
    const R = a.return_periods_yr;
    if (totalMm < depth[0]) return { under: true };
    if (totalMm > depth.at(-1)) return { over: true, rp: R.at(-1) };
    for (let r = 1; r < R.length; r++) {
      if (totalMm <= depth[r]) {
        const f = (Math.log(totalMm) - Math.log(depth[r - 1])) / (Math.log(depth[r]) - Math.log(depth[r - 1]));
        const rp = Math.exp(Math.log(R[r - 1]) + f * (Math.log(R[r]) - Math.log(R[r - 1])));
        return { rp: rp < 10 ? Math.round(rp) : rp < 100 ? Math.round(rp / 5) * 5 : Math.round(rp / 10) * 10 };
      }
    }
    return null;
  }

  share() {
    const st = this.state;
    const payload = { preset: st.preset, ev: st.ev, model: st.model, defences: st.defences, speed: isFinite(st.speed) ? st.speed : 3600,
      display: { mode: st.display.mode, lighting: st.display.lighting, weather: st.display.weather, layers: st.display.layers }, view: this.viewer.currentView(), run: true };
    const enc = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}#s=${enc}`;
    history.replaceState(null, '', url);
    navigator.clipboard?.writeText(url).then(() => this.toast('Link copied. It opens this scenario, settings and view.'), () => this.toast('The link is in the address bar.'));
  }

  screenshot() {
    const url = this.viewer.capture(performance.now() / 1000);
    const a = document.createElement('a'); a.href = url; a.download = `floodtwin-nyc_${this.state.preset}_${Math.round(this.sim.t / 60)}min.png`; a.click();
  }

  toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.hidden = true; }, ms);
  }

  /** Screenshot and test hook: ?qa&preset=sandy&t=19800&mode=1&view=1&light=night&tab=boroughs&dx=80 */
  _qa(q) {
    const st = this.state;
    if (q.has('preset')) { const p = presetById(q.get('preset')); st.preset = p.id; st.ev = { ...p.p }; st.model.drainage = p.p.drainage; st.model.infiltration = p.p.infiltration; }
    if (q.has('dx')) st.model.dx = +q.get('dx');
    if (q.has('por')) st.model.porosity = q.get('por') !== '0';
    if (q.has('wall')) st.defences.waterfront = { boros: [1, 2, 3, 4, 5], crest: +q.get('wall') };
    this._configure();
    this.ui.renderLeft();
    if (q.has('light')) this.setLighting(q.get('light'));
    if (q.has('weather')) this.setWeather(q.get('weather'));
    if (q.has('mode')) this.setMode(+q.get('mode'));
    if (q.has('fema')) this.setLayer('fema', true);
    if (q.has('sandy')) this.setLayer('sandy', true);
    if (q.has('view')) this.viewer.setView(VIEWS[+q.get('view')] || VIEWS[0]);
    if (q.has('cam')) { const [x, y, z, d, p, a] = q.get('cam').split(',').map(Number); this.viewer.setView({ target: [x, y, z], dist: d, polar: p, azim: a }); }
    const t = +(q.get('t') || 0);
    const t0 = performance.now();
    const n = t > 0 ? this.sim.runSync(t) : 0;
    console.info(`qa: ${n} steps to t=${t} in ${Math.round(performance.now() - t0)} ms`);
    if (q.has('probe')) { const [x, y] = q.get('probe').split(',').map(Number); this.setProbe({ x, y }); }
    if (q.has('tab')) this.ui.showTab(q.get('tab'));
    if (q.has('clean')) document.body.classList.add('clean');
    if (q.has('nolabels')) document.getElementById('labels').style.display = 'none';
    if (q.has('welcome')) this.ui.welcome();
    if (q.has('mode')) this.setMode(+q.get('mode'));
    if (q.has('run')) this.sim.play();
    this._lightKey = '';
    // wait for the building chunks around the camera before reporting
    const need = +(q.get('frames') || 30), maxWait = +(q.get('wait') || 25000);
    let frames = 0;
    const tStart = performance.now();
    const report = () => {
      frames++;
      const ready = this.city.readiness() > 0.97 && this.city.stats.pending === 0;
      if ((frames < need || !ready) && performance.now() - tStart < maxWait) { requestAnimationFrame(report); return; }
      if (q.has('pick') && !this._qaPicked) {
        this._qaPicked = true;
        const [px, py] = q.get('pick').split(',').map(Number);
        const pk = this.viewer.pickBuilding(px, py);
        if (pk) { this.selectBuilding(pk); this.ui.renderRight(true); }
        requestAnimationFrame(report); return;
      }
      const R = this.sim.results, s = this.sim.solver;
      window.__qaReport?.({ ok: true, t: this.sim.t, status: this.sim.status, steps: n, ms: Math.round(performance.now() - t0), frames,
        wetKm2: +(s.wetCity / 1e6).toFixed(2), loss: R ? Math.round(R.loss) : null, wet: R?.wet, aboveFF: R?.aboveFF, hwmStats: R?.hwmStats,
        subwayFlooded: R?.subwayFlooded, city: { ...this.city.stats, readiness: +this.city.readiness().toFixed(2) },
        info: { calls: this.viewer.renderer.info.render.calls, triangles: this.viewer.renderer.info.render.triangles },
        programs: this.viewer.renderer.info.programs?.length, scale: this.viewer.scale, tier: this.tier, gpu: this.gpu.name });
    };
    requestAnimationFrame(report);
  }

  // ---------- frame loop ----------
  _loop(tms) {
    const t = tms / 1000;
    this._frame(t);
    requestAnimationFrame(x => this._loop(x));
  }

  _frame(t) {
    const dt = Math.min(0.25, Math.max(0, t - (this.last ?? t)));
    this.last = t;
    const sim = this.sim, sh = this.shared, sc = sim.scenario, v = this.viewer;
    const t0 = sim.t;
    sim.update(dt, t);
    const adv = sim.t - t0;
    sh.uTime.value = t;
    sh.uSimTime.value = sim.t;
    sh.uStats.value = sim.solver.statsA.texture;
    sh.uState.value = sim.solver.a.texture;
    const rain = sc.rain(sim.t);
    sh.uRainVis.value = Math.min(1, rain / 45);
    v.rain = Math.min(1, rain / 40);
    const target = rain > 0 ? Math.min(1, rain / 15) : 0;
    this.rainWet = target > this.rainWet ? Math.min(target, this.rainWet + adv / 300 + dt * 0.5) : Math.max(target, this.rainWet - Math.max(0, adv) / 3600);
    sh.uRainWet.value = this.rainWet;
    const gauges = sc.gauges(sim.t);
    v.waterLevel = Math.max(-1.5, Math.min(6, gauges[0]));
    this.water.setRiverCurrent((sc.stage(sim.t + 120) - sc.stage(sim.t - 120)) / 240);
    const cam = v.camera, tgt = v.controls.target;
    if (this.state.display.layers.tracers) {
      const d = cam.position.distanceTo(tgt), size = THREE.MathUtils.clamp(d * 1.6, 1500, 14000);
      const cx = tgt.x + this.W / 2, cy = this.H / 2 - tgt.z;
      this.tracers.update(dt, [cx - size / 2, cy - size / 2, size, size]);
      this.tracers.uniforms.uScale.value = THREE.MathUtils.clamp(d / 250, 6, 40);
    }
    if (this.state.display.lighting === 'event' || this.state.display.weather === 'auto') this._updateLighting();
    this.terrain.update(cam, tgt);
    this.water.update(cam);
    this.city.update(cam, t);
    this.markers.update(cam, gauges);
    this.bridges?.update(sh.uNight.value, cam);
    v.render(t);
    this.labels.setGaugeLevels(gauges);
    this.labels.update(this.markers);
    this.ui?.frame(t);
    if (dt > 0) v.govern(dt, t);
  }
}

// QA runs collect errors into <pre id="out"> so a headless DOM dump can read them
if (new URLSearchParams(location.search).has('qa')) {
  const out = document.createElement('pre'); out.id = 'out'; out.hidden = true; document.body.appendChild(out);
  const errors = [];
  let stage = 'start', done = false;
  const show = () => { if (!done) out.textContent = JSON.stringify({ running: true, stage, errors, loader: document.querySelector('#loader-text')?.textContent, city: window.floodtwin?.city?.stats }); };
  show();
  window.__qaErrors = errors;
  window.__qaStage = (s) => { stage = s; show(); };
  setInterval(show, 500);
  const ce = console.error.bind(console), cw = console.warn.bind(console);
  console.error = (...a) => { errors.push(a.map(x => String(x?.stack || x)).join(' ').slice(0, 4000)); show(); ce(...a); };
  console.warn = (...a) => { errors.push('warn: ' + a.map(x => String(x?.stack || x)).join(' ').slice(0, 1000)); show(); cw(...a); };
  window.addEventListener('error', e => { errors.push(`error: ${e.message} at ${e.filename}:${e.lineno}`); show(); });
  window.addEventListener('unhandledrejection', e => { errors.push(`rejection: ${e.reason?.stack || e.reason}`); show(); });
  window.__qaReport = (info) => { done = true; out.textContent = JSON.stringify({ errors, ...info }); };
  const hold = new URLSearchParams(location.search).get('hold');
  if (hold) { const im = new Image(); im.src = `/__delay?ms=${+hold}`; im.style.display = 'none'; document.body.appendChild(im); }
}

const app = new App();
window.floodtwin = app;
app.start().catch(e => { console.error(e); app.fail(`Something went wrong while starting: ${e.message}`); window.__qaReport?.({ ok: false, fatal: String(e?.stack || e) }); });
