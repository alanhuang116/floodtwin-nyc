// node --experimental-default-type=module tests/chunk_test.js
import { parse, build } from '../web/js/workers/chunk.js';
import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';

function encode(buildings) {
  // minimal FTC2 writer for tests: buildings = [{ rings: [[x, y]...], h, g }]
  const ids = [], hs = [], gs = [], cls = [], rc = [], roof = [], rlen = [], verts = [];
  buildings.forEach((b, k) => {
    ids.push(k); hs.push(Math.round(b.h * 10)); gs.push(Math.round(b.g * 100)); cls.push(0); rc.push(b.rings.length); roof.push(200, 100, 50);
    for (const r of b.rings) {
      rlen.push(r.length);
      let px = 0, py = 0;
      r.forEach(([x, y], i) => { const qx = Math.round(x / 0.25), qy = Math.round(y / 0.25); verts.push(i ? qx - px : qx, i ? qy - py : qy); px = qx; py = qy; });
    }
  });
  const parts = [];
  const head = new ArrayBuffer(36); const dv = new DataView(head);
  'FTC2'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, 0, true); dv.setUint32(8, ids.length, true); dv.setUint32(12, rlen.length, true); dv.setUint32(16, verts.length / 2, true);
  dv.setFloat32(20, 0, true); dv.setFloat32(24, 0, true); dv.setUint32(28, 0, true);
  const pad = a => { const n = (4 - (a.byteLength % 4)) % 4; return n ? [a, new Uint8Array(n)] : [a]; };
  const body = [new Uint8Array(head), new Uint8Array(new Uint32Array(ids).buffer), new Uint8Array(new Uint16Array(hs).buffer),
    new Uint8Array(new Int16Array(gs).buffer), new Uint8Array(cls), new Uint8Array(rc), new Uint8Array(roof)];
  const first = new Uint8Array(body.reduce((s, a) => s + a.byteLength, 0)); let o = 0; for (const a of body) { first.set(a, o); o += a.byteLength; }
  parts.push(...pad(first), ...pad(new Uint8Array(new Uint16Array(rlen).buffer)), ...pad(new Uint8Array(new Int16Array(verts).buffer)));
  const out = new Uint8Array(parts.reduce((s, a) => s + a.byteLength, 0)); o = 0; for (const a of parts) { out.set(a, o); o += a.byteLength; }
  return out.buffer;
}

function normals(out) {
  const P = out.pos, I = out.index, res = { up: 0, down: 0, walls: [] };
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]].map(i => [P[4 * i], P[4 * i + 1], P[4 * i + 2]]);
    const e1 = v[1].map((x, k) => x - v[0][k]), e2 = v[2].map((x, k) => x - v[0][k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const c = [0, 1, 2].map(k => (v[0][k] + v[1][k] + v[2][k]) / 3);
    if (Math.abs(n[1]) > 1e-6 && Math.abs(n[0]) < 1e-6 && Math.abs(n[2]) < 1e-6) { if (n[1] > 0) res.up++; else res.down++; }
    else res.walls.push({ c, n });
  }
  return res;
}

// synthetic: 20 x 10 m block (CCW) with a 4 x 4 courtyard (CW)
const ext = [[0, 0], [20, 0], [20, 10], [0, 10]], hole = [[8, 3], [8, 7], [12, 7], [12, 3]];
const c = parse(encode([{ rings: [ext, hole], h: 12, g: 2 }]));
const out = build(c, 0, null);
const N = normals(out);
let ok = 0, bad = 0;
for (const w of N.walls) {
  // scene -> map: x = X * 0.25, y = -Z * 0.25 ; normal map = (nX, -nZ)
  const x = w.c[0] * 0.25, y = -w.c[2] * 0.25, nx = w.n[0], ny = -w.n[2], L = Math.hypot(nx, ny);
  const px = x + (nx / L) * 0.5, py = y + (ny / L) * 0.5;
  const inBlock = px > 0 && px < 20 && py > 0 && py < 10, inHole = px > 8 && px < 12 && py > 3 && py < 7;
  if (!inBlock || inHole) ok++; else bad++;
}
console.log('synthetic: roof up', N.up, 'down', N.down, '| walls outward', ok, 'inward', bad);

// real chunks: roof orientation and timing
const dir = 'web/data/chunks';
const files = readdirSync(dir).filter(f => f.endsWith('.bin.gz')).sort((a, b) => readFileSync(`${dir}/${b}`).length - readFileSync(`${dir}/${a}`).length).slice(0, 3);
for (const f of files) {
  const raw = gunzipSync(readFileSync(`${dir}/${f}`));
  const t0 = performance.now();
  const cc = parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const o = build(cc, 0, null);
  const ms = performance.now() - t0;
  const n = normals(o);
  console.log(f, `${cc.nB} buildings, ${o.nVert} verts, ${o.index.length / 3} tris, ${ms.toFixed(0)} ms; roof up ${n.up} down ${n.down}; trees ${cc.nT}`);
}
