// node --experimental-default-type=module tests/chunk_test.js
// Checks the building generator: roofs face up, walls face out, parapets and pitched roofs are
// built, and measures triangle counts and build time on the largest real chunks.
import { parse, build } from '../web/js/workers/chunk.js';
import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';

function encode(buildings) {
  // minimal FTC2 writer for tests: buildings = [{ rings: [[x, y]...], h, g, cls }]
  const ids = [], hs = [], gs = [], cls = [], rc = [], roof = [], rlen = [], verts = [];
  buildings.forEach((b, k) => {
    ids.push(k + 1); hs.push(Math.round(b.h * 10)); gs.push(Math.round(b.g * 100)); cls.push(b.cls ?? 0); rc.push(b.rings.length); roof.push(200, 100, 50);
    for (const r of b.rings) {
      rlen.push(r.length);
      let px = 0, py = 0;
      r.forEach(([x, y], i) => { const qx = Math.round(x / 0.25), qy = Math.round(y / 0.25); verts.push(i ? qx - px : qx, i ? qy - py : qy); px = qx; py = qy; });
    }
  });
  const head = new ArrayBuffer(36); const dv = new DataView(head);
  'FTC2'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, 0, true); dv.setUint32(8, ids.length, true); dv.setUint32(12, rlen.length, true); dv.setUint32(16, verts.length / 2, true);
  const pad = a => { const n = (4 - (a.byteLength % 4)) % 4; return n ? [a, new Uint8Array(n)] : [a]; };
  const body = [new Uint8Array(head), new Uint8Array(new Uint32Array(ids).buffer), new Uint8Array(new Uint16Array(hs).buffer),
    new Uint8Array(new Int16Array(gs).buffer), new Uint8Array(cls), new Uint8Array(rc), new Uint8Array(roof)];
  const first = new Uint8Array(body.reduce((s, a) => s + a.byteLength, 0)); let o = 0; for (const a of body) { first.set(a, o); o += a.byteLength; }
  const parts = [...pad(first), ...pad(new Uint8Array(new Uint16Array(rlen).buffer)), ...pad(new Uint8Array(new Int16Array(verts).buffer))];
  const out = new Uint8Array(parts.reduce((s, a) => s + a.byteLength, 0)); o = 0; for (const a of parts) { out.set(a, o); o += a.byteLength; }
  return out.buffer;
}

function classify(out) {
  const P = out.pos, I = out.index, res = { flatUp: 0, flatDown: 0, pitchUp: 0, pitchDown: 0, plain: 0, walls: [] };
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]].map(i => [P[4 * i], P[4 * i + 1], P[4 * i + 2]]);
    const code = P[4 * I[t] + 3];
    const e1 = v[1].map((x, k) => x - v[0][k]), e2 = v[2].map((x, k) => x - v[0][k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const c = [0, 1, 2].map(k => (v[0][k] + v[1][k] + v[2][k]) / 3);
    if (code === -1) { if (n[1] > 0) res.flatUp++; else res.flatDown++; }
    else if (code === -3) { if (n[1] > 0) res.pitchUp++; else res.pitchDown++; }
    else if (code === -2) res.plain++;
    else res.walls.push({ c, n });
  }
  return res;
}

const inPoly = (r, x, y) => {
  let inn = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; }
  return inn;
};

// synthetic: a 20 x 10 m block (CCW) with a courtyard (CW), 12 m tall -> parapet; a 10 x 8 m house -> pitched roof
const block = { rings: [[[0, 0], [20, 0], [20, 10], [0, 10]], [[8, 3], [8, 7], [12, 7], [12, 3]]], h: 12, g: 2, cls: 1 };
const house = { rings: [[[40, 0], [50, 0], [50, 8], [40, 8]]], h: 8, g: 2, cls: 0 };
for (const [name, bld] of [['block', block], ['house', house]]) {
  const out = build(parse(encode([bld])), 0, null);
  const R = classify(out);
  let ok = 0, bad = 0;
  const ext = bld.rings[0], hole = bld.rings[1];
  for (const w of R.walls) {
    const L3 = Math.hypot(...w.n);
    if (L3 === 0 || Math.abs(w.n[1]) > 1e-6 * L3) continue;
    const x = w.c[0] * 0.25, y = -w.c[2] * 0.25, nx = w.n[0], ny = -w.n[2], L = Math.hypot(nx, ny);
    const px = x + (nx / L) * 0.5, py = y + (ny / L) * 0.5;
    const solid = inPoly(ext, px, py) && !(hole && inPoly(hole, px, py));
    if (!solid) ok++; else bad++;
  }
  console.log(`${name}: flat roof up ${R.flatUp} down ${R.flatDown} | pitched up ${R.pitchUp} down ${R.pitchDown} | plain ${R.plain} | walls out ${ok} in ${bad}`);
}

// real chunks: orientation, triangles and time
const dir = 'web/data/chunks';
const files = readdirSync(dir).filter(f => f.endsWith('.bin.gz')).sort((a, b) => readFileSync(`${dir}/${b}`).length - readFileSync(`${dir}/${a}`).length);
for (const f of files.slice(0, 4)) {
  const raw = gunzipSync(readFileSync(`${dir}/${f}`));
  const t0 = performance.now();
  const cc = parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const o = build(cc, 0, null);
  const ms = performance.now() - t0;
  const R = classify(o);
  console.log(f, `${cc.nB} buildings, ${o.nVert} verts, ${o.index.length / 3} tris, ${ms.toFixed(0)} ms; flat up ${R.flatUp} down ${R.flatDown}; pitched up ${R.pitchUp} down ${R.pitchDown}; plain ${R.plain}; tanks ${o.tanks.length / 4}`);
}
