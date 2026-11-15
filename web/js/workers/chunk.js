// Chunk worker: fetches a building chunk (FTC2), triangulates the footprints and
// returns compact geometry with transferable buffers.
//
// Output per chunk, all in scene axes relative to the chunk origin (x east, y up, z = -north):
//   pos   Int16 x 4 per vertex: x, y, z in quanta (0.25 m), then the facade u coordinate
//         (metres along the wall in quanta; -1 marks roof vertices)
//   tex   Float32 per vertex: texel of the building in the shared info textures
//   index Uint32 (or Uint16)
//   info  Float32 x 4 per building in texel order: class, height, ground, packed roof colour
//   ids   Int32 per building: global building id (NYC ids index the exposure table)
//   trees Float32 x 4 per tree: x, z (scene, relative to the origin), trunk diameter (cm), species
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
  // count output size first
  let nVert = 0, nIdx = 0;
  {
    let r = 0;
    for (let b = 0; b < c.nB; b++) {
      for (let k = 0; k < c.rc[b]; k++, r++) {
        const n = c.rlen[r];
        nVert += (n + 1) * 2 + n;               // wall strip with a seam vertex, then roof
        nIdx += n * 6 + (n - 2) * 3 + 6;        // walls, roof (holes add a little; reserve slack)
      }
    }
  }
  const stride = 4;
  const pos = abs ? new Float32Array(nVert * stride) : new Int16Array(nVert * stride);
  const nrm = new Int8Array(nVert * 4);           // averaged normals, used by the shadow normal bias
  const tex = new Float32Array(nVert);
  let idx = new Uint32Array(nIdx + 64);
  let vo = 0, io = 0;
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
    pos[o] = sx(x); pos[o + 1] = sy(z); pos[o + 2] = sz(y); pos[o + 3] = u < 0 ? -1 : su(u);
    nrm[4 * vo] = Math.round(nx * 127); nrm[4 * vo + 1] = Math.round(ny * 127); nrm[4 * vo + 2] = Math.round(nz * 127);
    tex[vo] = t;
    return vo++;
  };
  const edgeN = (i, j, out) => {
    const dx = xs[j] - xs[i], dy = ys[j] - ys[i], L = Math.hypot(dx, dy) || 1;
    out[0] = dy / L; out[1] = -dx / L;             // right of travel: outward for CCW exteriors and CW holes
  };
  const n1 = [0, 0], n2 = [0, 0];

  const info = new Float32Array(c.nB * 4);
  let r = 0;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity, 0];
  for (let b = 0; b < c.nB; b++) {
    const t = texBase + b;
    const h = c.h[b] / 10, g = c.g[b] / 100;
    const z0 = g - SINK, z1 = g + h;
    info[4 * b] = c.cls[b]; info[4 * b + 1] = h; info[4 * b + 2] = g;
    info[4 * b + 3] = (c.roof[3 * b] << 16) | (c.roof[3 * b + 1] << 8) | c.roof[3 * b + 2];
    bounds[4] = Math.max(bounds[4], z1);
    // rings of this building: exteriors (CCW) start a polygon, holes (CW) attach to the last exterior
    const rings = [];
    for (let k = 0; k < c.rc[b]; k++, r++) rings.push(r);
    const polys = [];
    for (const rr of rings) {
      const a = ringOffset[rr], n = c.rlen[rr];
      if (n < 3) continue;
      const area = signedArea(xs, ys, a, n);
      if (Math.abs(area) < 0.05) continue;
      if (area > 0 || !polys.length) polys.push({ ext: { a, n, ccw: area > 0 }, holes: [] });
      else polys[polys.length - 1].holes.push({ a, n });
    }
    for (const p of polys) {
      const all = [p.ext, ...p.holes];
      // walls: outward normals need exteriors CCW and holes CW (seen from above); flat shading in
      // the material takes the normal from the triangle, so only the winding has to be right
      for (const ring of all) {
        const { a, n } = ring;
        let u = 0;
        const base = vo;
        const flip = ring === p.ext ? !p.ext.ccw : false;
        for (let k = 0; k <= n; k++) {
          const i = a + (k % n);
          if (k > 0) { const ip = a + (k - 1); u += Math.hypot(xs[i] - xs[ip], ys[i] - ys[ip]); }
          edgeN(a + ((k - 1 + n) % n), i, n1); edgeN(i, a + ((k + 1) % n), n2);
          let mx = n1[0] + n2[0], my = n1[1] + n2[1];
          const L = Math.hypot(mx, my);
          if (L < 1e-3) { mx = n2[0]; my = n2[1]; } else { mx /= L; my /= L; }
          if (flip) { mx = -mx; my = -my; }
          put(xs[i], ys[i], z0, u, t, mx, 0, -my);
          put(xs[i], ys[i], z1, u, t, mx, 0, -my);
          if (k < n) { bounds[0] = Math.min(bounds[0], xs[i]); bounds[1] = Math.min(bounds[1], ys[i]); bounds[2] = Math.max(bounds[2], xs[i]); bounds[3] = Math.max(bounds[3], ys[i]); }
        }
        for (let k = 0; k < n; k++) {
          const b0 = base + 2 * k, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3;
          // ring CCW seen from above (x east, y north); in scene axes z = -y, so the outward
          // face of edge (k, k+1) is wound b0, b1, t1 / b0, t1, t0
          if (!flip) { pushIdx(b0, b1, t1); pushIdx(b0, t1, t0); }
          else { pushIdx(b0, t1, b1); pushIdx(b0, t0, t1); }
        }
      }
      // roof
      const base = vo;
      for (const ring of all) for (let k = 0; k < ring.n; k++) put(xs[ring.a + k], ys[ring.a + k], z1, -1, t, 0, 1, 0);
      const n0 = p.ext.n;
      const up = (i0, i1, i2) => {
        // the triangle faces up in scene axes when it is counter-clockwise on the map (x east, y north)
        const ax = xs[i0], ay = ys[i0], bx = xs[i1], by = ys[i1], cx = xs[i2], cy = ys[i2];
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      };
      const vIndex = (q) => {
        // q indexes the concatenated ring vertices; map to the source vertex for the orientation test
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
  return { pos: pos.subarray(0, vo * stride).slice(), nrm: nrm.slice(0, vo * 4), tex: tex.slice(0, vo), index, info, ids: Int32Array.from(c.ids),
    trees, nVert: vo, bounds, ox: c.ox, oy: c.oy };
}


if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) self.onmessage = async (e) => {
  const { id, url, texBase, centre, raw } = e.data;
  try {
    const buf = raw || await (await fetch(url)).arrayBuffer();
    const c = parse(await gunzip(buf));
    const out = build(c, texBase, centre);
    const transfer = [out.pos.buffer, out.nrm.buffer, out.tex.buffer, out.index.buffer, out.info.buffer, out.ids.buffer];
    if (out.trees) transfer.push(out.trees.buffer);
    self.postMessage({ id, ok: true, out, abs: !!c.absolute }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
