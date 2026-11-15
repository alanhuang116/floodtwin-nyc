// Bridges: decks from OpenStreetMap ways at their navigation clearance, towers and
// main cables for the suspension bridges, arches for the arch bridges, and the cable
// lights that string the harbour at night (data/bridges.json, scripts/build_bridges.py).
import * as THREE from 'three';

const TOWER_COLOUR = {
  'Brooklyn Bridge': [0.60, 0.55, 0.46], 'Verrazzano-Narrows Bridge': [0.56, 0.58, 0.59], 'George Washington Bridge': [0.45, 0.48, 0.50],
  'Manhattan Bridge': [0.42, 0.50, 0.57], 'Williamsburg Bridge': [0.36, 0.34, 0.32], 'Bronx-Whitestone Bridge': [0.50, 0.52, 0.53],
  'Throgs Neck Bridge': [0.52, 0.54, 0.55], 'Bayonne Bridge': [0.50, 0.52, 0.52], 'Hell Gate Bridge': [0.62, 0.38, 0.33],
};

export class Bridges {
  constructor(data, W, H) {
    this.group = new THREE.Group(); this.group.name = 'bridges';
    const sx = (x) => x - W / 2, sz = (y) => H / 2 - y;
    const pos = [], col = [], idx = [];
    let v = 0;
    const deckCol = [0.30, 0.31, 0.32], sideCol = [0.20, 0.205, 0.21];
    // a box between two deck points: top, sides and underside, width w and thickness t
    const segment = (x0, y0, z0, x1, y1, z1, w, t, ct = deckCol, cs = sideCol) => {
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
      if (L < 0.2) return;
      const nx = -dy / L * w / 2, ny = dx / L * w / 2;
      const P = [[x0 + nx, y0 + ny, z0], [x1 + nx, y1 + ny, z1], [x1 - nx, y1 - ny, z1], [x0 - nx, y0 - ny, z0]];
      const quad = (a, b, c, d, cc) => {
        for (const p of [a, b, c, d]) { pos.push(sx(p[0]), p[2], sz(p[1])); col.push(...cc); }
        idx.push(v, v + 2, v + 1, v, v + 3, v + 2); v += 4;
      };
      const down = (p) => [p[0], p[1], p[2] - t];
      // with this index order, a clockwise map quad (left start, left end, right end, right start) faces up
      quad(P[0], P[1], P[2], P[3], ct);
      quad(P[0], P[1], down(P[1]), down(P[0]), cs);
      quad(P[2], P[3], down(P[3]), down(P[2]), cs);
      quad(down(P[0]), down(P[1]), down(P[2]), down(P[3]), cs);
    };
    const addWay = (way, t) => {
      const p = way.p;
      for (let k = 0; k + 5 < p.length; k += 3) segment(p[k], p[k + 1], p[k + 2], p[k + 3], p[k + 4], p[k + 5], way.w, t);
    };
    for (const b of data.bridges) for (const w of b.ways) addWay(w, 2.2);
    for (const w of data.decks) addWay(w, 1.4);
    // towers: two legs and cross beams, oriented across the deck
    for (const b of data.bridges) {
      if (!b.towers) continue;
      const [t0, t1] = b.towers;
      const ax = t1[0] - t0[0], ay = t1[1] - t0[1], L = Math.hypot(ax, ay) || 1;
      const ux = ax / L, uy = ay / L, nx = -uy, ny = ux;
      const c = TOWER_COLOUR[b.name] || [0.5, 0.52, 0.53];
      const stone = b.name === 'Brooklyn Bridge';
      for (const [x, y, h, w] of b.towers) {
        const legW = stone ? 9 : Math.max(5, h * 0.045), depth = stone ? 14 : Math.max(5, h * 0.05);
        const box = (cx, cy, z0, z1, wx, wy) => {
          // wx across the deck (normal), wy along the deck (axis)
          const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, bb]) => [cx + nx * a * wx / 2 + ux * bb * wy / 2, cy + ny * a * wx / 2 + uy * bb * wy / 2]);
          const quad = (pa, pb, pc, pd) => { for (const p of [pa, pb, pc, pd]) { pos.push(sx(p[0]), p[2], sz(p[1])); col.push(...c); } idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4; };
          const lo = corners.map(p => [p[0], p[1], z0]), hi = corners.map(p => [p[0], p[1], z1]);
          for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; quad(lo[k], lo[k2], hi[k2], hi[k]); }
          quad(hi[0], hi[1], hi[2], hi[3]);
        };
        const half = w / 2;
        if (stone) {
          box(x, y, -2, h * 0.62, w + 8, depth);                         // the masonry pier below the arches
          box(x + nx * (half * 0.55), y + ny * (half * 0.55), h * 0.62, h, legW * 1.4, depth * 0.9);
          box(x - nx * (half * 0.55), y - ny * (half * 0.55), h * 0.62, h, legW * 1.4, depth * 0.9);
          box(x, y, h * 0.9, h, w * 0.7, depth * 0.9);
        } else {
          box(x + nx * half, y + ny * half, -2, h, legW, depth);
          box(x - nx * half, y - ny * half, -2, h, legW, depth);
          for (const f of [0.42, 0.72, 0.97]) box(x, y, h * f - 3, h * f, w, depth * 0.8);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.12, flatShading: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, this.material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);

    // cables and arches as tubes; lights strung along the main cables
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x8c9297, roughness: 0.55, metalness: 0.4 });
    const archMat = new THREE.MeshStandardMaterial({ color: 0x80878b, roughness: 0.6, metalness: 0.35 });
    const lights = [];
    const tube = (arr, r, mat) => {
      const pts = [];
      for (let k = 0; k < arr.length; k += 3) pts.push(new THREE.Vector3(sx(arr[k]), arr[k + 2], sz(arr[k + 1])));
      const curve = new THREE.CatmullRomCurve3(pts);
      const m = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, r, 6, false), mat);
      m.castShadow = true;
      this.group.add(m);
      return curve;
    };
    for (const b of data.bridges) {
      for (const c of b.cables || []) {
        const curve = tube(c, 0.9, cableMat);
        const len = curve.getLength(), n = Math.floor(len / 28);
        for (let k = 1; k < n; k++) lights.push(curve.getPointAt(k / n));
      }
      for (const a of b.arches || []) tube(a, 2.6, archMat);
    }
    this.lightMat = new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0 , depthWrite: false });
    if (lights.length) {
      const lm = new THREE.InstancedMesh(new THREE.SphereGeometry(1.1, 8, 6), this.lightMat, lights.length);
      const m4 = new THREE.Matrix4();
      lights.forEach((p, k) => { m4.makeTranslation(p.x, p.y, p.z); lm.setMatrixAt(k, m4); });
      lm.instanceMatrix.needsUpdate = true;
      lm.computeBoundingSphere();
      this.group.add(lm);
      this.lights = lm;
    }
  }

  /** night: 0 day to 1 night; camDist scales the light points so they stay visible. */
  update(night, camera) {
    if (!this.lights) return;
    this.lightMat.opacity = Math.min(1, night * 1.2);
    this.lightMat.color.setRGB(1.0 * (1 + 2.5 * night), 0.94 * (1 + 2.5 * night), 0.84 * (1 + 2.5 * night));
    this.lights.visible = night > 0.05;
  }
}
