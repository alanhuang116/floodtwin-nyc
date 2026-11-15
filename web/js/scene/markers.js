// Markers in the scene: the four tide gauges, USGS high-water marks (observed and
// simulated levels), subway stations (coloured by flooding), the probe pin, and
// flood defences (waterfront barriers per borough and drawn barriers).
import * as THREE from 'three';

const AMBER = 0xffb547, WHITE = 0xf2f5f7;

export class Markers {
  constructor(data, terrain) {
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.W = W; this.H = H; this.terrain = terrain;
    this.group = new THREE.Group(); this.group.name = 'markers';
    const ev = data.events;
    this._m4 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();

    // ---- high-water marks: a thin rod, an amber disc at the observed level and a white disc at the simulated one
    const rodG = new THREE.CylinderGeometry(1, 1, 1, 8); rodG.translate(0, 0.5, 0);
    const discG = new THREE.CylinderGeometry(1, 1, 1, 24);
    this.hwm = ev.hwm.map(h => ({ h, g: terrain.heightAt(h.x, h.y), sim: null }));
    const n = this.hwm.length;
    this.hwmRod = new THREE.InstancedMesh(rodG, new THREE.MeshBasicMaterial({ color: 0xd8dde0, transparent: true, opacity: 0.7 }), n);
    this.hwmObs = new THREE.InstancedMesh(discG, new THREE.MeshBasicMaterial({ color: AMBER }), n);
    this.hwmSim = new THREE.InstancedMesh(discG, new THREE.MeshBasicMaterial({ color: WHITE }), n);
    for (const im of [this.hwmRod, this.hwmObs, this.hwmSim]) { im.frustumCulled = false; this.group.add(im); }
    this.hwmWorld = this.hwm.map(it => new THREE.Vector3(it.h.x - W / 2, it.h.elev_m, H / 2 - it.h.y));

    // ---- tide gauges: a slim mast with a lit cap
    this.gauges = ev.gauges.map(g => ({ g, z: terrain.heightAt(g.x, g.y) }));
    const mastG = new THREE.CylinderGeometry(1, 1, 1, 10); mastG.translate(0, 0.5, 0);
    this.gaugeMast = new THREE.InstancedMesh(mastG, new THREE.MeshBasicMaterial({ color: 0xe8eef1 }), this.gauges.length);
    this.gaugeCap = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 12), new THREE.MeshBasicMaterial({ color: AMBER }), this.gauges.length);
    for (const im of [this.gaugeMast, this.gaugeCap]) { im.frustumCulled = false; this.group.add(im); }
    this.gaugeWorld = this.gauges.map(it => new THREE.Vector3(it.g.x - W / 2, 0, H / 2 - it.g.y));

    // ---- subway stations: flat discs at street level, white when dry, red once water reaches them
    this.stations = ev.subway.map(st => ({ st, z: terrain.heightAt(st.x, st.y), under: st.structure !== 'Elevated' && st.structure !== 'Viaduct' }));
    this.stMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }), this.stations.length);
    this.stMesh.frustumCulled = false;
    const c = new THREE.Color();
    this.stations.forEach((it, k) => this.stMesh.setColorAt(k, c.setRGB(0.92, 0.94, 0.96)));
    this.group.add(this.stMesh);

    // ---- probe
    this.probe = new THREE.Group(); this.probe.visible = false;
    const pr = new THREE.Mesh(rodG, new THREE.MeshBasicMaterial({ color: AMBER }));
    const ph = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: AMBER }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 40), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    this.probe.add(pr, ph, ring);
    this.probeParts = { pr, ph, ring };
    this.probeWorld = new THREE.Vector3();
    this.group.add(this.probe);

    // ---- defences
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0x9a9c97, roughness: 0.8, metalness: 0 });
    this.walls = new THREE.Group();
    this.group.add(this.walls);
    this.draft = new THREE.Group();
    this.group.add(this.draft);
    this.show = { hwm: true, subway: true };
  }

  local(lx, ly, y) { return new THREE.Vector3(lx - this.W / 2, y, this.H / 2 - ly); }

  /** Simulated peak water surface at each high-water mark (m, or null when dry). */
  setHwmSim(values) { this.hwm.forEach((it, k) => { it.sim = values?.[k] ?? null; }); }

  /** Peak depth at each station: { max } per station. */
  setStations(states) {
    const c = new THREE.Color();
    this.stations.forEach((it, k) => {
      const d = states?.[k]?.max ?? 0;
      if (d > 0.15 && it.under) c.setRGB(0.95, 0.22, 0.20);
      else if (d > 0.15) c.setRGB(0.98, 0.62, 0.20);
      else c.setRGB(0.92, 0.94, 0.96);
      this.stMesh.setColorAt(k, c);
    });
    this.stMesh.instanceColor.needsUpdate = true;
  }

  setProbe(pt) {
    if (!pt) { this.probe.visible = false; return; }
    this.probe.visible = true;
    this.probe.position.copy(this.local(pt.x, pt.y, this.terrain.heightAt(pt.x, pt.y)));
  }

  setProbeWater(wse) {
    const r = this.probeParts.ring;
    r.visible = wse != null && wse > this.probe.position.y + 0.01;
    if (r.visible) r.position.y = wse - this.probe.position.y + 0.05;
  }

  /** Walls for drawn barriers and the waterfront barrier cells of the current grid. */
  setDefences(barriers, grid, waterfront) {
    for (const ch of [...this.walls.children]) { ch.geometry.dispose(); this.walls.remove(ch); }
    for (const b of barriers || []) {
      for (let k = 0; k + 1 < b.points.length; k++) {
        const [x1, y1] = b.points[k], [x2, y2] = b.points[k + 1];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 0.5) continue;
        let gmin = 1e9;
        for (let st = 0; st <= 8; st++) gmin = Math.min(gmin, this.terrain.heightAt(x1 + (x2 - x1) * st / 8, y1 + (y2 - y1) * st / 8));
        const hgt = Math.max(0.3, b.crest - gmin + 1.5);
        const m = new THREE.Mesh(new THREE.BoxGeometry(len, hgt, 2.4), this.wallMat);
        m.position.copy(this.local((x1 + x2) / 2, (y1 + y2) / 2, b.crest - hgt / 2));
        m.rotation.y = Math.atan2(y2 - y1, x2 - x1);
        m.castShadow = true; m.receiveShadow = true;
        this.walls.add(m);
      }
    }
    const cells = grid?.waterfrontCells || [];
    if (waterfront?.boros?.length && cells.length) {
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.wallMat, cells.length);
      cells.forEach((cc, k) => {
        const i = cc % grid.nx, j = Math.floor(cc / grid.nx);
        const g = grid.z0[cc], hgt = Math.max(0.3, waterfront.crest - g + 0.8);
        this._p.copy(this.local((i + 0.5) * grid.dx, (j + 0.5) * grid.dx, waterfront.crest - hgt / 2));
        this._s.set(grid.dx * 0.42, hgt, grid.dx * 0.42);
        this._m4.compose(this._p, this._q.identity(), this._s); inst.setMatrixAt(k, this._m4);
      });
      inst.castShadow = true; inst.receiveShadow = true;
      this.walls.add(inst);
    }
  }

  /** Preview of a barrier being drawn. */
  setDraft(points, crest) {
    for (const ch of [...this.draft.children]) { ch.geometry?.dispose(); this.draft.remove(ch); }
    if (!points.length) return;
    const pts = points.map(([x, y]) => this.local(x, y, Math.max(crest ?? 0, this.terrain.heightAt(x, y)) + 1.0));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: AMBER, depthTest: false, transparent: true }));
    line.renderOrder = 20;
    this.draft.add(line);
    const dot = new THREE.SphereGeometry(1, 12, 8), dm = new THREE.MeshBasicMaterial({ color: AMBER, depthTest: false });
    for (const pt of pts) { const sp = new THREE.Mesh(dot, dm); sp.position.copy(pt); sp.scale.setScalar(5); sp.renderOrder = 21; this.draft.add(sp); }
  }

  /** Keep markers a readable size on screen and up to date. stages: current levels at the four gauges. */
  update(camera, stages) {
    const cp = camera.position, M = this._m4, Q = this._q.identity(), S = this._s, P = this._p;
    const sz = (v) => THREE.MathUtils.clamp(cp.distanceTo(v) * 0.0021, 0.6, 60);
    // high-water marks
    const showH = this.show.hwm && cp.y < 20000;
    this.hwmRod.visible = this.hwmObs.visible = this.hwmSim.visible = showH;
    if (showH) {
      this.hwm.forEach((it, k) => {
        const w = this.hwmWorld[k], s = sz(w), x = w.x, z = w.z;
        const top = Math.max(it.h.elev_m, it.g, it.sim ?? -99) + 3 * s;
        P.set(x, it.g, z); S.set(0.16 * s, Math.max(0.1, top - it.g), 0.16 * s); M.compose(P, Q, S); this.hwmRod.setMatrixAt(k, M);
        P.set(x, it.h.elev_m, z); S.set(2.0 * s, 0.32 * s, 2.0 * s); M.compose(P, Q, S); this.hwmObs.setMatrixAt(k, M);
        if (it.sim != null) { P.set(x, it.sim, z); S.set(1.45 * s, 0.32 * s, 1.45 * s); } else { P.set(x, -500, z); S.set(0.001, 0.001, 0.001); }
        M.compose(P, Q, S); this.hwmSim.setMatrixAt(k, M);
        w.y = top;
      });
      for (const im of [this.hwmRod, this.hwmObs, this.hwmSim]) im.instanceMatrix.needsUpdate = true;
    }
    // gauges: mast to the current level plus a margin, cap at the top
    this.gauges.forEach((it, k) => {
      const w = this.gaugeWorld[k], s = sz(w), lvl = stages ? stages[k] : 0;
      const base = Math.min(it.z, lvl) - 1, top = Math.max(lvl, it.z) + 18 * s;
      P.set(w.x, base, w.z); S.set(0.35 * s, top - base, 0.35 * s); M.compose(P, Q, S); this.gaugeMast.setMatrixAt(k, M);
      P.set(w.x, top, w.z); S.setScalar(2.2 * s); M.compose(P, Q, S); this.gaugeCap.setMatrixAt(k, M);
      w.y = top;
    });
    this.gaugeMast.instanceMatrix.needsUpdate = true; this.gaugeCap.instanceMatrix.needsUpdate = true;
    // stations: only near the camera
    this.stMesh.visible = this.show.subway && cp.y < 6000;
    if (this.stMesh.visible) {
      this.stations.forEach((it, k) => {
        P.set(it.st.x - this.W / 2, it.z + 0.6, this.H / 2 - it.st.y);
        const s = Math.min(sz(P), 6);
        S.set(3.2 * s, 0.5 * s, 3.2 * s); M.compose(P, Q, S); this.stMesh.setMatrixAt(k, M);
      });
      this.stMesh.instanceMatrix.needsUpdate = true;
    }
    // probe
    if (this.probe.visible) {
      const { pr, ph, ring } = this.probeParts, s = sz(this.probe.position), hgt = 12 * s;
      pr.scale.set(0.14 * s, hgt, 0.14 * s);
      ph.scale.setScalar(1.1 * s); ph.position.y = hgt;
      ring.scale.setScalar(4 * s);
      this.probeWorld.set(this.probe.position.x, this.probe.position.y + hgt, this.probe.position.z);
    }
  }
}
