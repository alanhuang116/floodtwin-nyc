// Chunk worker: fetches a building chunk (FTC2), builds 3D buildings from the footprints
// and returns compact geometry with transferable buffers.
//
// Each building becomes walls, plus either a flat roof (with a parapet and coping once it is a
// few storeys tall, and stair and plant bulkheads on large roofs) or, for detached houses, a gable
// or hip roof over the footprint's oriented rectangle with its ridge at the measured roof height.
//
// Output per chunk, all in scene axes relative to the chunk origin (x east, y up, z = -north):
//   pos   Int16 x 4 per vertex: x, y, z in quanta (0.25 m), then the surface code: the facade
//         u coordinate (metres along the wall in quanta) or -1 flat roof, -2 plain masonry,
//         -3 pitched roof
//   nrm   Int8 x 4 per vertex: normal (for the shadow normal bias; lighting uses flat shading)
//   tex   Float32 per vertex: texel of the building in the shared info textures
//   index Uint32 (or Uint16)
//   info  Float32 x 4 per building in texel order: class, height, ground, packed roof colour
//   ids   Int32 per building: global building id (NYC ids index the exposure table)
//   trees Float32 x 4 per tree: x, z (scene, relative to the origin), trunk diameter (cm), species
//   tanks Float32 x 4 per rooftop water tank: x, z, roof height, scale
// The tall layer (absolute coordinates) is returned as Float32 positions relative to the
// domain centre instead, with u in metres.
import { ShapeUtils, Vector2 } from '../../vendor/three/three.core.js';

const Q = 0.25, SINK = 3.0;            // walls start 3 m below the ground so they meet sloping ground

async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return buf;      // already inflated by the server
  const ds = new DecompressionStream('gzip');
  return await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
}

export function parse(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FTC2') throw new Error('bad chunk ' + magic);
  const absolute = dv.getUint32(4, true), nB = dv.getUint32(8, true), nR = dv.getUint32(12, true), nV = dv.getUint32(16, true);
  const ox = dv.getFloat32(20, true), oy = dv.getFloat32(24, true), nT = dv.getUint32(28, true);
  let o = 36;
  const pad = () => { o = (o + 3) & ~3; };
  const ids = new Uint32Array(buf, o, nB); o += nB * 4;
  const h = new Uint16Array(buf.slice(o, o + nB * 2)); o += nB * 2;
  const g = new Int16Array(buf.slice(o, o + nB * 2)); o += nB * 2;
  const cls = new Uint8Array(buf, o, nB); o += nB;
  const rc = new Uint8Array(buf, o, nB); o += nB;
  const roof = new Uint8Array(buf, o, nB * 3); o += nB * 3;
  pad();
  const rlen = new Uint16Array(buf.slice(o, o + nR * 2)); o += nR * 2; pad();
  let verts;
  if (absolute) { verts = new Int32Array(buf.slice(o, o + nV * 8)); o += nV * 8; }
  else { verts = new Int16Array(buf.slice(o, o + nV * 4)); o += nV * 4; }
  pad();
  let tq = null, td = null, tsp = null;
  if (nT) {
    tq = new Int16Array(buf.slice(o, o + nT * 4)); o += nT * 4; pad();
    td = new Uint8Array(buf, o, nT); o += nT; pad();
    tsp = new Uint8Array(buf, o, nT); o += nT; pad();
  }
  return { absolute, nB, nR, nV, ox, oy, nT, ids: Uint32Array.from(ids), h, g, cls, rc, roof, rlen, verts, tq, td, tsp };
}

function signedArea(xs, ys, a, n) {
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) s += xs[a + j] * ys[a + i] - xs[a + i] * ys[a + j];
  return s / 2;
}

function isConvex(xs, ys, a, n) {
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const i1 = a + i, i2 = a + (i + 1) % n, i3 = a + (i + 2) % n;
    const cr = (xs[i2] - xs[i1]) * (ys[i3] - ys[i2]) - (ys[i2] - ys[i1]) * (xs[i3] - xs[i2]);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/**
 * Builds the geometry for one parsed chunk.
 * texBase: texel index of the chunk's first building; centre: [W/2, H/2] for absolute chunks.
 */
export function build(c, texBase, centre) {
  const abs = !!c.absolute;
  const ringOffset = new Uint32Array(c.nR + 1);
  for (let r = 0; r < c.nR; r++) ringOffset[r + 1] = ringOffset[r] + c.rlen[r];
  // decode ring vertices to metres (local to the origin for chunks, absolute for the tall layer)
  const xs = new Float64Array(c.nV), ys = new Float64Array(c.nV);
  {
    let v = 0;
    for (let r = 0; r < c.nR; r++) {
      const n = c.rlen[r];
      let x = 0, y = 0;
      for (let k = 0; k < n; k++, v++) {
        if (abs) { x = c.verts[2 * v] * Q; y = c.verts[2 * v + 1] * Q; }
        else if (k === 0) { x = c.verts[2 * v] * Q; y = c.verts[2 * v + 1] * Q; }
        else { x += c.verts[2 * v] * Q; y += c.verts[2 * v + 1] * Q; }
        xs[v] = x; ys[v] = y;
      }
    }
  }
  let nVertEst = 0;
  for (let r = 0; r < c.nR; r++) nVertEst += (c.rlen[r] + 1) * 6 + c.rlen[r];
  const stride = 4;
  // growable vertex buffers: roofs, parapets and rooftop structures vary from building to building
  let cap = Math.max(4096, nVertEst + 64 * c.nB);
  let pos = abs ? new Float32Array(cap * stride) : new Int16Array(cap * stride);
  let nrm = new Int8Array(cap * 4);
  let tex = new Float32Array(cap);
  let vo = 0, io = 0;
  const grow = (need) => {
    if (vo + need <= cap) return;
    let nc = cap * 2;
    while (vo + need > nc) nc *= 2;
    const p2 = abs ? new Float32Array(nc * stride) : new Int16Array(nc * stride); p2.set(pos); pos = p2;
    const n2 = new Int8Array(nc * 4); n2.set(nrm); nrm = n2;
    const t2 = new Float32Array(nc); t2.set(tex); tex = t2;
    cap = nc;
  };
  let idx = new Uint32Array(Math.max(4096, nVertEst * 4));
  const pushIdx = (a, b2, c2) => {
    if (io + 3 > idx.length) { const g = new Uint32Array(idx.length * 2); g.set(idx); idx = g; }
    idx[io++] = a; idx[io++] = b2; idx[io++] = c2;
  };
  const sx = abs ? (x) => x - centre[0] : (x) => Math.round(x / Q);
  const sz = abs ? (y) => centre[1] - y : (y) => -Math.round(y / Q);
  const sy = abs ? (z) => z : (z) => Math.round(z / Q);
  const su = abs ? (u) => u : (u) => Math.round(u / Q) % 32000;
  const put = (x, y, z, u, t, nx, ny, nz) => {
    const o = vo * stride;
    pos[o] = sx(x); pos[o + 1] = sy(z); pos[o + 2] = sz(y); pos[o + 3] = u < 0 ? u : su(u);
    nrm[4 * vo] = Math.round(nx * 127); nrm[4 * vo + 1] = Math.round(ny * 127); nrm[4 * vo + 2] = Math.round(nz * 127);
    tex[vo] = t;
    return vo++;
  };
  const edgeN = (i, j, out) => {
    const dx = xs[j] - xs[i], dy = ys[j] - ys[i], L = Math.hypot(dx, dy) || 1;
    out[0] = dy / L; out[1] = -dx / L;             // right of travel: outward for CCW exteriors and CW holes
  };
  const n1 = [0, 0], n2 = [0, 0];
  const rnd = (id, k) => { const v = Math.sin(id * 12.9898 + k * 78.233 + 4.123) * 43758.5453; return v - Math.floor(v); };

  // a planar polygon of 3 or 4 map points [x, y, z], wound to face `dir` (map axes; default up).
  // Map axes (x east, y north, z up) and scene axes (x, z, -y) share handedness, so a triangle
  // that is counter-clockwise seen from its map normal is front-facing in the scene.
  const face = (pts, u, t, dir) => {
    const [a, b2, c2] = pts;
    const e1 = [b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]], e2 = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    const want = dir || [0, 0, 1];
    const flipF = nx * want[0] + ny * want[1] + nz * want[2] < 0;
    if (flipF) { nx = -nx; ny = -ny; nz = -nz; }
    const base = vo;
    for (const p of pts) put(p[0], p[1], p[2], typeof u === 'function' ? u(p) : u, t, nx, nz, -ny);
    const tri = (i0, i1, i2) => (flipF ? pushIdx(base + i0, base + i2, base + i1) : pushIdx(base + i0, base + i1, base + i2));
    tri(0, 1, 2);
    if (pts.length === 4) tri(0, 2, 3);
  };
  const inside = (px, py, ring) => {
    let inn = false;
    for (let i = 0, j = ring.n - 1; i < ring.n; j = i++) {
      const xi = xs[ring.a + i], yi = ys[ring.a + i], xj = xs[ring.a + j], yj = ys[ring.a + j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inn = !inn;
    }
    return inn;
  };
  // minimum-area rectangle aligned with one of the ring's edges: u the long axis, v the short one
  const obb = (ring) => {
    let best = null;
    for (let k = 0; k < ring.n; k++) {
      const i = ring.a + k, j = ring.a + (k + 1) % ring.n;
      let ux = xs[j] - xs[i], uy = ys[j] - ys[i];
      const L = Math.hypot(ux, uy);
      if (L < 0.5) continue;
      ux /= L; uy /= L;
      let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
      for (let q = 0; q < ring.n; q++) {
        const x = xs[ring.a + q], y = ys[ring.a + q], sv = x * ux + y * uy, tv = -x * uy + y * ux;
        if (sv < s0) s0 = sv; if (sv > s1) s1 = sv; if (tv < t0) t0 = tv; if (tv > t1) t1 = tv;
      }
      const area = (s1 - s0) * (t1 - t0);
      if (!best || area < best.area) best = { area, ux, uy, s0, s1, t0, t1 };
    }
    if (!best) return null;
    let { ux, uy, s0, s1, t0, t1 } = best;
    const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2;
    const cx = ux * sm - uy * tm, cy = uy * sm + ux * tm;
    let L = s1 - s0, B = t1 - t0;
    if (B > L) { [L, B] = [B, L]; [ux, uy] = [-uy, ux]; }
    return { ux, uy, vx: -uy, vy: ux, L, B, cx, cy, area: best.area };
  };

  const info = new Float32Array(c.nB * 4);
  const tanks = [];
  let r = 0;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity, 0];
  for (let b = 0; b < c.nB; b++) {
    const t = texBase + b;
    const id = c.ids[b];
    const h = c.h[b] / 10, g = c.g[b] / 100, cls = c.cls[b];
    const z0 = g - SINK, z1 = g + h;
    info[4 * b] = cls; info[4 * b + 1] = h; info[4 * b + 2] = g;
    info[4 * b + 3] = (c.roof[3 * b] << 16) | (c.roof[3 * b + 1] << 8) | c.roof[3 * b + 2];
    bounds[4] = Math.max(bounds[4], z1);
    // rings of this building: exteriors (CCW) start a polygon, holes (CW) attach to the last exterior
    const rings = [];
    let est = 96;
    for (let k = 0; k < c.rc[b]; k++, r++) { rings.push(r); est += (c.rlen[r] + 1) * 6 + c.rlen[r]; }
    grow(est);
    const polys = [];
    for (const rr of rings) {
      const a = ringOffset[rr], n = c.rlen[rr];
      if (n < 3) continue;
      const area = signedArea(xs, ys, a, n);
      if (Math.abs(area) < 0.05) continue;
      if (area > 0 || !polys.length) polys.push({ ext: { a, n, ccw: area > 0 }, holes: [] });
      else polys[polys.length - 1].holes.push({ a, n });
    }
    if (!polys.length) continue;
    const ext0 = polys[0].ext, area0 = Math.abs(signedArea(xs, ys, ext0.a, ext0.n));
    let perim0 = 0;
    for (let k = 0; k < ext0.n; k++) { const i = ext0.a + k, j = ext0.a + (k + 1) % ext0.n; perim0 += Math.hypot(xs[j] - xs[i], ys[j] - ys[i]); }

    // ---- roof form
    let pitched = null;
    if (cls === 0 && polys.length === 1 && !polys[0].holes.length && ext0.n <= 10 && h >= 4.5 && h <= 12.5 && area0 <= 320) {
      const o = obb(ext0);
      if (o && o.B >= 6.0 && o.B <= 14 && o.L <= 32 && area0 / o.area > 0.84 && rnd(id, 1) < 0.88) {
        let rise = Math.min(3.4, Math.max(1.5, 0.30 * o.B));
        if (h - rise < 2.6) rise = Math.max(1.0, h - 2.6);
        pitched = { ...o, rise, hip: rnd(id, 2) > 0.58 };
      }
    }
    const parapet = !pitched && cls !== 5 && h >= 9 && perim0 >= 22 ? (h < 30 ? 0.85 : 1.25) : 0;
    const inset = h < 30 ? 0.32 : 0.45;
    const wallTop = pitched ? z1 - pitched.rise : z1;
    const roofZ = z1 - parapet;

    // about two in five mid-rise residential and older commercial roofs carry a wooden water tank
    if ((cls === 1 || cls === 2) && h >= 16 && h <= 95 && rnd(id, 0) < 0.42) {
      let mx = 0, my = 0;
      for (let k = 0; k < ext0.n; k++) { mx += xs[ext0.a + k]; my += ys[ext0.a + k]; }
      mx /= ext0.n; my /= ext0.n;
      if (inside(mx, my, ext0)) tanks.push(abs ? mx - centre[0] : mx, abs ? centre[1] - my : -my, roofZ, Math.min(1.5, Math.max(0.8, Math.sqrt(area0) / 22)));
    }

    for (const p of polys) {
      const all = [p.ext, ...p.holes];
      for (const ring of all) {
        const { a, n } = ring;
        let u = 0;
        const base = vo;
        const flip = ring === p.ext ? !p.ext.ccw : false;
        const bis = new Float32Array((n + 1) * 3);  // bisector normal and mitre factor per vertex
        for (let k = 0; k <= n; k++) {
          const i = a + (k % n);
          if (k > 0) { const ip = a + (k - 1); u += Math.hypot(xs[i] - xs[ip], ys[i] - ys[ip]); }
          edgeN(a + ((k - 1 + n) % n), i, n1); edgeN(i, a + ((k + 1) % n), n2);
          let mx = n1[0] + n2[0], my = n1[1] + n2[1];
          const L = Math.hypot(mx, my);
          if (L < 1e-3) { mx = n2[0]; my = n2[1]; } else { mx /= L; my /= L; }
          const mit = 1 / Math.max(0.4, mx * n1[0] + my * n1[1]);
          if (flip) { mx = -mx; my = -my; }
          bis[3 * k] = mx; bis[3 * k + 1] = my; bis[3 * k + 2] = Math.min(2.5, mit);
          put(xs[i], ys[i], z0, u, t, mx, 0, -my);
          put(xs[i], ys[i], wallTop, u, t, mx, 0, -my);
          if (k < n) { bounds[0] = Math.min(bounds[0], xs[i]); bounds[1] = Math.min(bounds[1], ys[i]); bounds[2] = Math.max(bounds[2], xs[i]); bounds[3] = Math.max(bounds[3], ys[i]); }
        }
        for (let k = 0; k < n; k++) {
          const b0 = base + 2 * k, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3;
          // ring CCW seen from above (x east, y north); in scene axes z = -y, so the outward
          // face of edge (k, k+1) is wound b0, b1, t1 / b0, t1, t0
          if (!flip) { pushIdx(b0, b1, t1); pushIdx(b0, t1, t0); }
          else { pushIdx(b0, t1, b1); pushIdx(b0, t0, t1); }
        }
        if (parapet > 0) {
          // the inner face of the parapet, offset inward along the bisector, then its coping
          const ib = vo;
          for (let k = 0; k <= n; k++) {
            const i = a + (k % n), d = inset * bis[3 * k + 2], mx = bis[3 * k], my = bis[3 * k + 1];
            put(xs[i] - mx * d, ys[i] - my * d, roofZ - 0.05, -2, t, -mx, 0, my);
            put(xs[i] - mx * d, ys[i] - my * d, z1, -2, t, -mx, 0, my);
          }
          for (let k = 0; k < n; k++) {
            const b0 = ib + 2 * k, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3;
            if (!flip) { pushIdx(b0, t1, b1); pushIdx(b0, t0, t1); } else { pushIdx(b0, b1, t1); pushIdx(b0, t1, t0); }
          }
          const cb = vo;
          for (let k = 0; k <= n; k++) {
            const i = a + (k % n), d = inset * bis[3 * k + 2], mx = bis[3 * k], my = bis[3 * k + 1];
            put(xs[i] + mx * 0.06, ys[i] + my * 0.06, z1 + 0.06, -2, t, 0, 1, 0);
            put(xs[i] - mx * d, ys[i] - my * d, z1 + 0.06, -2, t, 0, 1, 0);
          }
          for (let k = 0; k < n; k++) {
            const o0 = cb + 2 * k, i0 = o0 + 1, o1 = o0 + 2, i1 = o0 + 3;
            if (!flip) { pushIdx(o0, o1, i1); pushIdx(o0, i1, i0); } else { pushIdx(o0, i1, o1); pushIdx(o0, i0, i1); }
          }
        }
      }

      if (pitched) {
        // ---- gable or hip roof over the oriented rectangle, with a 0.35 m overhang
        const P = pitched, ov = 0.35, half = P.B / 2, slope = P.rise / half;
        const ze = wallTop, zr = z1, zEave = ze - ov * slope;
        const at = (s, w, z) => [P.cx + P.ux * s + P.vx * w, P.cy + P.uy * s + P.vy * w, z];
        const a2 = P.L / 2 + ov, b2 = half + ov;
        if (!P.hip) {
          face([at(-a2, b2, zEave), at(a2, b2, zEave), at(a2, 0, zr), at(-a2, 0, zr)], -3, t);
          face([at(-a2, -b2, zEave), at(a2, -b2, zEave), at(a2, 0, zr), at(-a2, 0, zr)], -3, t);
          // gable walls at both ends, flush with the end walls
          for (const sgn of [-1, 1]) {
            const s = sgn * P.L / 2, dir = [P.ux * sgn, P.uy * sgn, 0];
            face([at(s, -half, ze), at(s, half, ze), at(s, 0, zr)], (q) => Math.max(0, (q[0] - P.cx) * P.vx + (q[1] - P.cy) * P.vy + half), t, dir);
          }
        } else {
          const rl = Math.max(0, P.L / 2 - half);
          face([at(-a2, b2, zEave), at(a2, b2, zEave), at(rl, 0, zr), at(-rl, 0, zr)], -3, t);
          face([at(-a2, -b2, zEave), at(a2, -b2, zEave), at(rl, 0, zr), at(-rl, 0, zr)], -3, t);
          face([at(-a2, -b2, zEave), at(-a2, b2, zEave), at(-rl, 0, zr)], -3, t);
          face([at(a2, -b2, zEave), at(a2, b2, zEave), at(rl, 0, zr)], -3, t);
        }
        // a cap over the wall tops under the eaves, so nothing shows through at the corners
        const base = vo;
        for (let k = 0; k < p.ext.n; k++) put(xs[p.ext.a + k], ys[p.ext.a + k], ze, -2, t, 0, 1, 0);
        for (let k = 1; k + 1 < p.ext.n; k++) pushIdx(base, base + k, base + k + 1);
        continue;
      }

      // ---- flat roof
      const base = vo;
      for (const ring of all) for (let k = 0; k < ring.n; k++) put(xs[ring.a + k], ys[ring.a + k], roofZ, -1, t, 0, 1, 0);
      const n0 = p.ext.n;
      const up = (i0, i1, i2) => {
        // the triangle faces up in scene axes when it is counter-clockwise on the map (x east, y north)
        const ax = xs[i0], ay = ys[i0], bx = xs[i1], by = ys[i1], cx = xs[i2], cy = ys[i2];
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      };
      const vIndex = (q) => {
        let off = q;
        for (const ring of all) { if (off < ring.n) return ring.a + off; off -= ring.n; }
        return all[0].a;
      };
      if (!p.holes.length && isConvex(xs, ys, p.ext.a, n0)) {
        for (let k = 1; k + 1 < n0; k++) {
          const cr = up(p.ext.a, p.ext.a + k, p.ext.a + k + 1);
          if (cr > 0) pushIdx(base, base + k, base + k + 1); else pushIdx(base, base + k + 1, base + k);
        }
      } else {
        const contour = [], holes = [];
        for (let k = 0; k < n0; k++) contour.push(new Vector2(xs[p.ext.a + k], ys[p.ext.a + k]));
        for (const hr of p.holes) {
          const hv = [];
          for (let k = 0; k < hr.n; k++) hv.push(new Vector2(xs[hr.a + k], ys[hr.a + k]));
          holes.push(hv);
        }
        let faces = [];
        try { faces = ShapeUtils.triangulateShape(contour, holes); } catch { faces = []; }
        for (const f of faces) {
          const cr = up(vIndex(f[0]), vIndex(f[1]), vIndex(f[2]));
          if (cr > 0) pushIdx(base + f[0], base + f[1], base + f[2]); else pushIdx(base + f[0], base + f[2], base + f[1]);
        }
      }

      // ---- rooftop structures: stair and elevator bulkheads, plant rooms
      const areaP = Math.abs(signedArea(xs, ys, p.ext.a, p.ext.n));
      if (p === polys[0] && cls >= 1 && cls <= 4 && areaP > 450 && h >= 15) {
        const o = obb(p.ext);
        const count = areaP > 3000 ? 3 : areaP > 1200 ? 2 : 1;
        for (let q = 0; q < count && o; q++) {
          const w = Math.min(10, Math.max(3, Math.sqrt(areaP) * 0.16)) * (0.8 + 0.4 * rnd(id, 10 + q));
          const d2 = w * (0.55 + 0.4 * rnd(id, 20 + q)), hq = 2.6 + 1.6 * rnd(id, 30 + q);
          for (let tries = 0; tries < 6; tries++) {
            const ss = (rnd(id, 40 + q * 7 + tries) - 0.5) * Math.max(0, o.L - w) * 0.85;
            const tt = (rnd(id, 50 + q * 7 + tries) - 0.5) * Math.max(0, o.B - d2) * 0.85;
            const cx = o.cx + o.ux * ss + o.vx * tt, cy = o.cy + o.uy * ss + o.vy * tt;
            const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([e1, e2]) => [cx + o.ux * e1 * w / 2 + o.vx * e2 * d2 / 2, cy + o.uy * e1 * w / 2 + o.vy * e2 * d2 / 2]);
            if (!cs.every(([px, py]) => inside(px, py, p.ext) && !p.holes.some(hr => inside(px, py, hr)))) continue;
            const zb = roofZ - 0.1, zt = roofZ + hq;
            for (let k = 0; k < 4; k++) {
              const [ax, ay] = cs[k], [bx, by] = cs[(k + 1) % 4];
              const outward = [(ax + bx) / 2 - cx, (ay + by) / 2 - cy, 0];
              face([[ax, ay, zb], [bx, by, zb], [bx, by, zt], [ax, ay, zt]], -2, t, outward);
            }
            face(cs.map(([px, py]) => [px, py, zt]), -1, t);
            break;
          }
        }
      }
    }
  }
  const index = vo < 65536 ? Uint16Array.from(idx.subarray(0, io)) : idx.slice(0, io);
  // trees
  let trees = null;
  if (c.nT) {
    trees = new Float32Array(c.nT * 4);
    for (let k = 0; k < c.nT; k++) {
      trees[4 * k] = c.tq[2 * k] * Q; trees[4 * k + 1] = -c.tq[2 * k + 1] * Q;
      trees[4 * k + 2] = c.td[k]; trees[4 * k + 3] = c.tsp[k];
    }
  }
  return { pos: pos.slice(0, vo * stride), nrm: nrm.slice(0, vo * 4), tex: tex.slice(0, vo), index, info, ids: Int32Array.from(c.ids),
    trees, tanks: Float32Array.from(tanks), nVert: vo, bounds, ox: c.ox, oy: c.oy };
}


if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) self.onmessage = async (e) => {
  const { id, url, texBase, centre, raw } = e.data;
  try {
    const buf = raw || await (await fetch(url)).arrayBuffer();
    const c = parse(await gunzip(buf));
    const out = build(c, texBase, centre);
    const transfer = [out.pos.buffer, out.nrm.buffer, out.tex.buffer, out.index.buffer, out.info.buffer, out.ids.buffer];
    if (out.trees) transfer.push(out.trees.buffer);
    transfer.push(out.tanks.buffer);
    self.postMessage({ id, ok: true, out, abs: !!c.absolute }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
