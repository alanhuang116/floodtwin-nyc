// Simulation controller: builds the model for a configuration, advances the GPU
// solver against the scenario clock within a frame-time budget, records time
// series and snapshots (for scrubbing back), and turns peak depths at 1.08
// million buildings into FloodVuln damage ratios and losses, by borough and
// neighbourhood, with subway stations, hospitals and high-water marks alongside.
import { buildGrid, buildingCells, pointCells, KIND, BOROUGHS } from './grid.js';
import { FloodSolver } from './solver.js';
import { makeScenario } from './scenarios.js';
import { makeVuln, entryWeight } from './vuln.js';

const LOG_EVERY = 300;            // s of simulated time between time-series points
// FloodVuln curves are conditional on water entering the building. A building counts as
// flooded, and takes damage, once 15 cm of water stands against it.
export const ENTRY_M = 0.15;

export class Simulation {
  constructor(renderer, data) {
    this.renderer = renderer; this.data = data;
    this.vuln = makeVuln(data.events);
    this.arch = data.city.archetypes;
    this.ntas = data.city.ntas;
    const E = this.expo = data.exposure, n = E.n;
    this.n = n;
    this.share = new Float32Array(n);
    this.value = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      this.share[k] = Math.min(1, 2 / Math.max(1, E.storeys[k]));    // damage reaches the two lowest storeys
      this.value[k] = E.vs[k] + E.vc[k];
    }
    // exposure by borough and neighbourhood (for shares)
    this.exposedBoro = new Float64Array(6); this.exposedNta = new Float64Array(this.ntas.length);
    for (let k = 0; k < n; k++) { this.exposedBoro[E.boro[k]] += this.value[k]; if (E.nta[k] < this.ntas.length) this.exposedNta[E.nta[k]] += this.value[k]; }
    // sample points: high-water marks, subway stations, hospitals
    const ev = data.events;
    this.hwm = ev.hwm;
    this.subway = ev.subway;
    this.hospitals = ev.hospitals;
    this.points = [...this.hwm, ...this.subway, ...this.hospitals].map(p => ({ x: p.x, y: p.y }));
    this.offSub = this.hwm.length; this.offHosp = this.offSub + this.subway.length;
    this.handlers = {};
    this.status = 'idle';
    this.speed = 600;
    this.maxSteps = 24;
    this.ft = 1 / 60;
    this.simRate = 0;
    this.t = 0;
    this.series = [];
    this.snaps = [];
    this.snapBudget = 320e6;
    this.probe = null;
    this.bDepthMax = new Float32Array(n);
    this.bDepthNow = new Float32Array(n);
    this.bDr = new Float32Array(n).fill(-1);
    this.bLoss = new Float32Array(n);
    this.bFlags = new Uint8Array(n);
  }

  on(e, f) { (this.handlers[e] ||= []).push(f); }
  emit(e, x) { for (const f of this.handlers[e] || []) f(x); }

  /**
   * model: { dx, drainage, infiltration, nPaved, nGreen, porosity, waterfront: { boros, crest }, barriers }
   * ev: scenario parameters (see scenarios.js)
   */
  configure(model, ev) {
    const gkey = JSON.stringify([model.dx, model.drainage, model.infiltration, model.nPaved, model.nGreen, model.porosity, model.waterfront, model.barriers]);
    if (gkey !== this.gkey) {
      const g = buildGrid(this.data, { dx: model.dx, drainage: model.drainage, infiltration: model.infiltration, nPaved: model.nPaved,
        nGreen: model.nGreen, porosity: model.porosity, waterfront: model.waterfront, barriers: model.barriers });
      if (!this.solver || this.solver.nx !== g.nx || this.solver.ny !== g.ny) {
        this.disposeSnaps();
        this.solver?.dispose();
        this.solver = new FloodSolver(this.renderer, g);
        this.solver.setBuildingCells(buildingCells(this.expo, g));
        this.solver.setPointCells(pointCells(this.points, g));
        this.bCell = new Int32Array(this.n);
        for (let k = 0; k < this.n; k++) {
          const i = Math.floor(this.expo.x[k] / g.dx), j = Math.floor(this.expo.y[k] / g.dx);
          this.bCell[k] = i >= 0 && j >= 0 && i < g.nx && j < g.ny ? j * g.nx + i : -1;
        }
      } else this.solver.setBed(g.bed, g.por, g.bw);
      this.solver.minCoastZ = g.minCoastZ;
      this.grid = g; this.gkey = gkey;
      const bytes = g.N * 16;          // two half-float RGBA targets per snapshot
      this.maxSnaps = Math.max(2, Math.floor(this.snapBudget / bytes));
      this.emit('grid', g);
    }
    const p = this.solver.params;
    p.theta = model.theta ?? 0.8; p.frMax = model.frMax ?? 1.0; p.alpha = model.alpha ?? 0.7;
    this.model = model;
    this.params = ev;
    this.scenario = makeScenario(ev, this.data.events);
    this.snapEvery = Math.max(1800, Math.ceil(this.scenario.duration / (this.maxSnaps - 1) / 1800) * 1800);
    this.reset();
  }

  reset() {
    const s = this.solver, sc = this.scenario;
    this.seekTarget = null;
    s.reset();
    this.disposeSnaps();
    this.t = 0; this.series = []; this.status = 'idle';
    this.lastStats = 0; this.nextLog = 0; this.nextSnap = 0; this.maxArea = 0;
    this.results = null; this.probeSeries = []; this.extent = null;
    this.epoch = (this.epoch || 0) + 1;
    this.bDepthMax.fill(0); this.bDepthNow.fill(0); this.bDr.fill(-1); this.bLoss.fill(0); this.bFlags.fill(0);
    s.setGauges(sc.gauges(0)); s.rain = 0;
    s.step(1e-4);                 // fill the boundary water
    s.time = 0;
    s.updateStats(); s.updateVis(); s.reduceSync();
    this._snap();
    this._log();
    this._sampleSoon = true;
    this.emit('reset', this);
  }

  play() {
    if (this.status === 'done') this.seek(0);
    this.status = 'running';
    this.emit('status', this.status);
  }

  pause() {
    if (this.status === 'running') this.status = 'paused';
    if (this.seekTarget != null) this.resumeAfterSeek = false;
    this.emit('status', this.status);
  }

  /** Jump to simulated time tt: restore the latest snapshot before it, then run forward. */
  seek(tt) {
    const sc = this.scenario, s = this.solver;
    tt = Math.max(0, Math.min(sc.duration, tt));
    const wasRunning = this.status === 'running' || (this.seekTarget != null && this.resumeAfterSeek);
    if (tt < this.t - 0.5) {
      let snap = this.snaps[0];
      for (const sn of this.snaps) if (sn.time <= tt + 1e-6) snap = sn;
      s.restore(snap);
      this.t = snap.time; s.time = snap.time;
      this.snaps = this.snaps.filter(sn => { if (sn.time > snap.time + 1e-6) { sn.state.dispose(); sn.stats.dispose(); return false; } return true; });
      this.nextSnap = snap.time + this.snapEvery;
      this.series = this.series.filter(p => p.t <= this.t + 1e-6);
      this.probeSeries = this.probeSeries.filter(p => p[0] <= this.t + 1e-6);
      this.nextLog = (Math.floor(this.t / LOG_EVERY) + 1) * LOG_EVERY;
      this.lastStats = this.t;
      this.maxArea = this.series.reduce((m, p) => Math.max(m, p.area), 0);
      this.epoch++;
      s.setGauges(sc.gauges(this.t));
      s.reduceSync();
    }
    if (tt > this.t + 0.01) {
      this.seekTarget = tt; this.resumeAfterSeek = wasRunning; this.status = 'seeking';
    } else {
      this.seekTarget = null; this.status = wasRunning ? 'running' : (this.t >= sc.duration - 1e-6 ? 'done' : 'paused');
    }
    this._sampleSoon = true;
    this.emit('status', this.status);
    this.emit('seek', this.t);
  }

  /** Advance by one display frame. realDt: wall-clock seconds since the last frame. */
  update(realDt, now) {
    const s = this.solver, sc = this.scenario;
    if (!s) return;
    let steps = 0, advanced = 0;
    const seeking = this.seekTarget != null;
    const maxSteps = Math.round(seeking ? this.maxSteps * 1.4 : this.maxSteps);
    if (this.status === 'running' || seeking) {
      const end = seeking ? this.seekTarget : sc.duration;
      let budget = seeking || !isFinite(this.speed) ? Infinity : this.speed * Math.min(realDt, 0.1);
      while (budget > 1e-6 && steps < maxSteps && this.t < end - 1e-6) {
        s.setGauges(sc.gauges(this.t));
        s.rain = sc.rain(this.t) / 3.6e6;
        let dt = Math.min(s.stableDt(), budget, end - this.t);
        if (this.nextSnap > this.t) dt = Math.min(dt, this.nextSnap - this.t);
        dt = Math.max(dt, 1e-4);
        s.step(dt);
        this.t += dt; budget -= dt; advanced += dt; steps++;
        if (this.t - this.lastStats >= 10) { s.updateStats(); this.lastStats = this.t; }
        if (this.t >= this.nextSnap - 1e-6) this._snap();
        if (this.t >= this.nextLog - 1e-6) this._log();
      }
      s.reduce();
      if (!(s.cmax < 1e3)) { this.status = 'error'; this.emit('error', 'The solver became unstable. Try a larger cell size.'); return; }
      if (seeking && this.t >= this.seekTarget - 1e-6) {
        this.seekTarget = null;
        this.status = this.resumeAfterSeek ? 'running' : 'paused';
        s.updateStats(); this.lastStats = this.t;
        this._sampleSoon = true;
        this.emit('status', this.status);
      }
      if (this.t >= sc.duration - 1e-6 && this.status !== 'done') {
        this.status = 'done';
        s.updateStats();
        this._log(true);
        this._sampleSoon = true;
        this._extentSoon = true;
        this.emit('status', this.status);
      }
      this._adapt(realDt, steps >= maxSteps);
    }
    s.updateVis();
    this.stepsLastFrame = steps;
    this.simRate = this.simRate * 0.9 + (advanced / Math.max(realDt, 1e-3)) * 0.1;
    if (this._sampleSoon || (steps > 0 && now - (this._lastSample || 0) > 0.8)) this._sample(now);
    if (this._extentSoon && this.status !== 'running') { this._extentSoon = false; this.computeExtent(); }
    if (this.probe && now - (this._lastProbe || 0) > 0.2) this._readProbe(now);
  }

  /** Run synchronously to simulated time tt (tests, screenshots). */
  runSync(tt) {
    const s = this.solver, sc = this.scenario;
    tt = Math.min(tt, sc.duration);
    this.epoch++;
    let n = 0;
    while (this.t < tt - 1e-6) {
      s.setGauges(sc.gauges(this.t)); s.rain = sc.rain(this.t) / 3.6e6;
      if (n % 20 === 0) s.reduceSync();
      let dt = Math.min(s.stableDt(), tt - this.t);
      if (this.nextSnap > this.t) dt = Math.min(dt, this.nextSnap - this.t);
      s.step(Math.max(dt, 1e-4)); this.t += Math.max(dt, 1e-4); n++;
      if (this.t - this.lastStats >= 10) { s.updateStats(); this.lastStats = this.t; }
      if (this.t >= this.nextSnap - 1e-6) this._snap();
      if (this.t >= this.nextLog - 1e-6) { s.reduceSync(); this._log(); }
    }
    s.updateStats(); s.updateVis(); s.reduceSync();
    this._process(s.sampleSync(), this.t);
    this._log(true);
    this.status = this.t >= sc.duration - 1e-6 ? 'done' : 'paused';
    if (this.status === 'done') this.computeExtent();
    return n;
  }

  _adapt(realDt, limited) {
    this.ft = this.ft * 0.92 + Math.min(realDt, 0.2) * 0.08;
    if (this.ft > 1 / 34) this.maxSteps = Math.max(2, this.maxSteps * 0.9);
    else if (this.ft < 1 / 52 && limited) this.maxSteps = Math.min(600, this.maxSteps * 1.07 + 0.5);
  }

  _snap() {
    if (this.snaps.length < this.maxSnaps && (!this.snaps.length || this.t > this.snaps.at(-1).time + 1)) this.snaps.push(this.solver.snapshot());
    this.nextSnap = (Math.floor(this.t / this.snapEvery + 1e-6) + 1) * this.snapEvery;
  }

  disposeSnaps() {
    for (const sn of this.snaps) { sn.state.dispose(); sn.stats.dispose(); }
    this.snaps = [];
  }

  _log(force) {
    const s = this.solver, sc = this.scenario, r = this.results;
    const p = { t: this.t, stage: sc.stage(this.t), gauges: sc.gauges(this.t), rain: sc.rain(this.t), area: s.wetCity / 1e6, vol: s.volCity / 1e6,
      wet: r?.wet ?? 0, loss: r ? r.loss : 0, aboveFF: r?.aboveFF ?? 0, res: r?.residents ?? 0, sub: r?.subwayFlooded ?? 0 };
    if (this.series.length && Math.abs(this.series.at(-1).t - p.t) < 1) this.series[this.series.length - 1] = p;
    else this.series.push(p);
    this.maxArea = Math.max(this.maxArea, p.area);
    if (!force) this.nextLog = (Math.floor(this.t / LOG_EVERY + 1e-6) + 1) * LOG_EVERY;
    this.emit('log', p);
  }

  _sample(now) {
    const pr = this.solver.sample();
    if (!pr) return;
    this._sampleSoon = false;
    this._lastSample = now;
    const tAt = this.t, epoch = this.epoch;
    // a reset, a jump back or a synchronous run makes in-flight samples stale
    pr.then(buf => { if (epoch === this.epoch) this._process(buf, tAt); }).catch(() => {});
  }

  _process({ b, p }, tAt) {
    const E = this.expo, n = this.n, V = this.vuln, A = this.arch, g = this.grid;
    const R = { t: tAt, wet: 0, aboveFF: 0, loss: 0, struct: 0, contents: 0, low: 0, high: 0, residents: 0, residentsWet: 0,
      boro: Array.from({ length: 6 }, () => ({ wet: 0, aboveFF: 0, loss: 0, residents: 0 })), nta: new Float64Array(this.ntas.length),
      ntaWet: new Uint32Array(this.ntas.length) };
    const dmax = this.bDepthMax, dnow = this.bDepthNow, dr = this.bDr, bl = this.bLoss, fl = this.bFlags;
    for (let k = 0; k < n; k++) {
      const hm = b[4 * k], hn = b[4 * k + 1];
      dmax[k] = hm; dnow[k] = hn;
      if (!(hm > ENTRY_M)) { dr[k] = -1; bl[k] = 0; fl[k] = 0; continue; }
      const bo = E.boro[k], rb = R.boro[bo];
      R.wet++; rb.wet++;
      R.residentsWet += E.pop[k];
      if (E.nta[k] < this.ntas.length) R.ntaWet[E.nta[k]]++;
      let f = 1, d = 0, loss = 0;
      if (E.arch[k] !== 255) {
        const c = this.bCell[k], z = c >= 0 ? g.z0[c] : 0;
        const an = A[E.arch[k]];
        const dd = V.damage(an, 'NY', z + hm, z, E.ffh[k]);
        const sh = this.share[k] * entryWeight(an, hm, E.ffh[k], ENTRY_M);
        d = dd.mean * sh / this.share[k];
        loss = dd.mean * this.value[k] * sh;
        R.struct += dd.mean * E.vs[k] * sh; R.contents += dd.mean * E.vc[k] * sh;
        R.low += dd.p10 * this.value[k] * sh; R.high += dd.p90 * this.value[k] * sh;
        if (dd.d > 0) { f |= 2; R.aboveFF++; rb.aboveFF++; R.residents += E.pop[k]; rb.residents += E.pop[k]; }
        rb.loss += loss;
        if (E.nta[k] < this.ntas.length) R.nta[E.nta[k]] += loss;
      }
      dr[k] = E.arch[k] !== 255 ? d : 0; bl[k] = loss; fl[k] = f;
    }
    R.loss = R.struct + R.contents;
    // high-water marks: peak water surface over the 3 x 3 cells around each
    R.hwm = this.hwm.map((h, k) => (p[4 * k] > -90 ? p[4 * k] : null));
    const errs = [];
    this.hwm.forEach((h, k) => { if (R.hwm[k] != null) errs.push(R.hwm[k] - h.elev_m); });
    R.hwmStats = errs.length ? {
      n: errs.length, dry: this.hwm.filter((h, k) => R.hwm[k] == null).length,
      bias: errs.reduce((a, x) => a + x, 0) / errs.length, mae: errs.reduce((a, x) => a + Math.abs(x), 0) / errs.length,
      rmse: Math.sqrt(errs.reduce((a, x) => a + x * x, 0) / errs.length) } : null;
    // subway stations and hospitals: peak depth at the point's cell
    const at = (o, k) => ({ max: p[4 * (o + k) + 2], now: p[4 * (o + k) + 3] });
    R.subway = this.subway.map((s, k) => at(this.offSub, k));
    R.subwayFlooded = R.subway.filter((v, k) => v.max > 0.15 && this.subway[k].structure !== 'Elevated' && this.subway[k].structure !== 'Viaduct').length;
    R.hospitals = this.hospitals.map((s, k) => at(this.offHosp, k));
    R.hospitalsFlooded = R.hospitals.filter(v => v.max > 0.15).length;
    // largest losses
    const idx = [];
    for (let k = 0; k < n; k++) if (bl[k] > 2e5) idx.push(k);
    idx.sort((a, c) => bl[c] - bl[a]);
    R.top = idx.slice(0, 20);
    this.results = R;
    if (this.series.length) {
      const last = this.series.at(-1);
      if (Math.abs(last.t - tAt) < LOG_EVERY) Object.assign(last, { wet: R.wet, loss: R.loss, aboveFF: R.aboveFF, res: R.residents, sub: R.subwayFlooded });
    }
    this.emit('results', R);
  }

  /** Agreement with the mapped Sandy inundation zone on city land (needs a full stats read). */
  computeExtent() {
    const g = this.grid, st = this.solver.readStats(), A = g.dx * g.dx;
    let hit = 0, miss = 0, fa = 0, wetKm2 = 0;
    for (let c = 0; c < g.N; c++) {
      if (g.kind[c] !== KIND.CITY) continue;
      const wet = st[4 * c] > 0.10, obs = g.sandy[c] === 1;
      if (wet) wetKm2 += A;
      if (wet && obs) hit++; else if (!wet && obs) miss++; else if (wet && !obs) fa++;
    }
    this.extent = { hit, miss, fa, csi: hit / Math.max(1, hit + miss + fa), hitRate: hit / Math.max(1, hit + miss), far: fa / Math.max(1, hit + fa),
      obsKm2: (hit + miss) * A / 1e6, simKm2: wetKm2 / 1e6, t: this.t };
    this.emit('extent', this.extent);
    return this.extent;
  }

  // ---- probe ----
  setProbe(pt) {
    this.probe = pt;
    this.probeSeries = [];
    this.probeValue = null;
    this._lastProbeT = -1e9;
    if (pt) this._readProbe(0);
  }

  _readProbe(now) {
    const g = this.grid, pt = this.probe;
    const i = Math.floor(pt.x / g.dx), j = Math.floor(pt.y / g.dx);
    const pr = this.solver.readCell(i, j);
    if (!pr) return;
    this._lastProbe = now;
    const c = j * g.nx + i, tAt = this.t;
    pr.then(v => {
      if (!v || this.probe !== pt) return;
      const z = g.z[c];
      v.z = z; v.kind = g.kind[c]; v.wse = v.h > 0.005 ? z + v.h : null;
      v.speed = Math.hypot(v.u, v.v);
      v.hazard = v.h > 0.02 ? v.h * (v.speed + 0.5) + (v.h > 0.25 ? 0.5 : 0) : 0;
      v.boro = BOROUGHS[g.boro[c]] || '';
      this.probeValue = v;
      if (tAt - this._lastProbeT >= 60 || !this.probeSeries.length) {
        this.probeSeries.push([tAt, v.h, v.speed]);
        this._lastProbeT = tAt;
      }
      this.emit('probe', v);
    });
  }

  /** Everything known about one NYC building (exposure id). */
  buildingInfo(k) {
    const E = this.expo, g = this.grid;
    if (k == null || k < 0 || k >= this.n) return null;
    const archName = E.arch[k] !== 255 ? this.arch[E.arch[k]] : null;
    const c = this.bCell[k], z = c >= 0 ? g.z0[c] : 0;
    const info = { k, boro: BOROUGHS[E.boro[k]], nta: this.ntas[E.nta[k]]?.name, ntaCode: this.ntas[E.nta[k]]?.code, x: E.x[k], y: E.y[k],
      arch: archName, archLabel: archName ? this.data.events.vulnerability.archetypes[archName] : null, ffh: E.ffh[k], storeys: E.storeys[k],
      vs: E.vs[k], vc: E.vc[k], pop: E.pop[k], share: this.share[k], depthMax: this.bDepthMax[k], depthNow: this.bDepthNow[k], ground: z };
    if (archName) {
      info.damage = this.vuln.damage(archName, 'NY', info.depthMax > ENTRY_M ? z + info.depthMax : -99, z, info.ffh);
      info.entry = entryWeight(archName, info.depthMax, info.ffh, ENTRY_M);
      info.loss = info.damage.mean * (info.vs + info.vc) * info.share * info.entry;
      info.curve = this.vuln.curve(archName, 'NY');
    }
    return info;
  }
}

export { KIND, BOROUGHS };
