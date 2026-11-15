// Loads and decodes the scene assets in web/data/.
// Rasters are row 0 = south; images are row 0 = north (flipped on upload).

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function gunzip(bytes) {
  // a server may already have removed the gzip layer (Content-Encoding: gzip)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${url}: image failed to load`));
    img.src = url;
  });
}

/** Row-delta, zigzag uint16 DEM to metres (Float32Array, row 0 = south). */
export function decodeDem(raw, cols, rows, enc) {
  const u = new Uint16Array(raw.buffer, raw.byteOffset, cols * rows);
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    let acc = 0;
    const o = r * cols;
    for (let c = 0; c < cols; c++) {
      const v = u[o + c];
      const d = (v >>> 1) ^ -(v & 1);
      acc = c === 0 ? d : acc + d;
      z[o + c] = acc * enc.scale - enc.offset;
    }
  }
  return z;
}

/** 16-byte exposure records, one per NYC building in id order. */
export function decodeExposure(raw, city) {
  const n = raw.byteLength / 16, dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const [sx, sy] = city.exposure.position_scale;
  const out = { n, x: new Float32Array(n), y: new Float32Array(n), arch: new Uint8Array(n), ffh: new Float32Array(n),
    storeys: new Uint8Array(n), boro: new Uint8Array(n), nta: new Uint16Array(n), vs: new Float32Array(n), vc: new Float32Array(n), pop: new Uint16Array(n) };
  const val = c => (c ? Math.pow(1.01, c) : 0);
  for (let k = 0; k < n; k++) {
    const o = k * 16;
    out.x[k] = dv.getUint16(o, true) * sx; out.y[k] = dv.getUint16(o + 2, true) * sy;
    out.arch[k] = dv.getUint8(o + 4); out.ffh[k] = dv.getUint8(o + 5) / 10; out.storeys[k] = dv.getUint8(o + 6);
    out.boro[k] = dv.getUint8(o + 7); out.nta[k] = dv.getUint16(o + 8, true);
    out.vs[k] = val(dv.getUint16(o + 10, true)); out.vc[k] = val(dv.getUint16(o + 12, true)); out.pop[k] = dv.getUint16(o + 14, true);
  }
  return out;
}

/**
 * Load everything needed at start. progress(fraction, label) is called as files arrive.
 * Building chunks are streamed later by the scene.
 */
export async function loadAll(base, progress = () => {}) {
  const files = [
    ['meta', 'meta.json', 4e3], ['events', 'events.json', 1.7e5], ['city', 'city.json', 5e4],
    ['dem', 'dem_20m.bin.gz', 5.8e6], ['cover', 'cover_20m.bin.gz', 1.3e6], ['por', 'por_20m.bin.gz', 8.4e5],
    ['boro', 'boro_20m.bin.gz', 4e4], ['fema', 'fema_20m.bin.gz', 1.8e5], ['sandy', 'sandy_20m.bin.gz', 9e4],
    ['bw', 'bw_80m.bin.gz', 7e4], ['exposure', 'exposure.bin.gz', 7.1e6], ['tall', 'tall.bin.gz', 3.7e5],
  ];
  const images = [['imagery', 'imagery.webp', 3.7e6]];
  const labels = {
    meta: 'Reading the domain', events: 'Loading tide gauges and Hurricane Sandy records', city: 'Indexing 1.08 million buildings',
    dem: 'Loading lidar terrain for five boroughs', cover: 'Loading land cover', por: 'Loading building cover',
    boro: 'Loading borough lines', fema: 'Loading FEMA flood zones', sandy: 'Loading the mapped Sandy flood extent',
    bw: 'Loading boundary gauge weights', exposure: 'Loading building values and occupancy', tall: 'Loading the skyline',
    imagery: 'Loading aerial imagery',
  };
  const weight = [...files, ...images].reduce((s, f) => s + f[2], 0);
  const got = {};
  const bump = (key, w) => { got[key] = w; progress(Math.min(1, Object.values(got).reduce((a, b) => a + b, 0) / weight), labels[key]); };
  const out = {};
  await Promise.all([
    ...files.map(async ([key, name, w]) => {
      const bytes = await fetchBytes(`${base}/${name}`, (g, t) => bump(key, w * (t ? g / t : 0.5)));
      bump(key, w);
      out[key] = name.endsWith('.json') ? JSON.parse(new TextDecoder().decode(bytes)) : await gunzip(bytes);
    }),
    ...images.map(async ([key, name, w]) => { out[key] = await loadImage(`${base}/${name}`); bump(key, w); }),
  ]);
  const m = out.meta;
  out.dem = decodeDem(out.dem, m.cols, m.rows, m.dem_encoding);
  out.exposure = decodeExposure(out.exposure, out.city);
  return out;
}

/** Inverse transverse Mercator (NAD83 / UTM 18N) and its forward transform, for map tiles and labels. */
export function makeGeo(meta) {
  const a = 6378137.0, f = 1 / 298.257222101, k0 = 0.9996, lon0 = -75 * Math.PI / 180, E0 = 500000;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), n = f / (2 - f);
  const A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
  const be = [n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480];
  const de = [2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15];
  const x0 = meta.grid.x0, y0 = meta.grid.y0;
  return {
    toLonLat(lx, ly) {                     // local metres -> degrees (Kruger series)
      const xi = (ly + y0) / (k0 * A), eta = (lx + x0 - E0) / (k0 * A);
      let xp = xi, ep = eta;
      for (let j = 1; j <= 3; j++) { xp -= be[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); ep -= be[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
      const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
      let phi = chi;
      for (let j = 1; j <= 3; j++) phi += de[j - 1] * Math.sin(2 * j * chi);
      const lam = lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp));
      return [lam * 180 / Math.PI, phi * 180 / Math.PI];
    },
    toLocal(lon, lat) {
      const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180 - lon0;
      const t = Math.sinh(Math.atanh(Math.sin(phi)) - 2 * Math.sqrt(n) / (1 + n) * Math.atanh(2 * Math.sqrt(n) / (1 + n) * Math.sin(phi)));
      const xp = Math.atan2(t, Math.cos(lam)), ep = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
      let xi = xp, eta = ep;
      for (let j = 1; j <= 3; j++) { xi += al[j - 1] * Math.sin(2 * j * xp) * Math.cosh(2 * j * ep); eta += al[j - 1] * Math.cos(2 * j * xp) * Math.sinh(2 * j * ep); }
      return [E0 + k0 * A * eta - x0, k0 * A * xi - y0];
    },
    ep2,
  };
}
