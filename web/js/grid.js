// Builds the simulation grid from the 20 m source layers at a chosen cell size
// (20, 40 or 80 m). All arrays are row 0 = south, index = j * nx + i.

// CITY_TIDAL: city ground below 0.8 m NAVD88 (about mean higher high water), covered by ordinary
// high tides; it floods like any land but is left out of flooded-area statistics
export const KIND = { LAND: 0, SEA: 1, CITY: 3, CITY_TIDAL: 4 };
export const TIDAL_Z = 0.8;
export const DEFAULT_N = { paved: 0.030, green: 0.045, river: 0.025 };
export const BOROUGHS = ['', 'Manhattan', 'The Bronx', 'Brooklyn', 'Queens', 'Staten Island'];

/**
 * @param {object} data  loaded assets (dem, cover, por, boro, fema, sandy, bw, meta)
 * @param {object} o     { dx, drainage (mm/h over the whole cell), infiltration (mm/h on green ground),
 *                         nPaved, nGreen, porosity (bool), waterfront: { boros: [1..5], crest }, barriers: [{points, crest}] }
 */
export function buildGrid(data, o) {
  const m = data.meta, C = m.cols, R = m.rows;
  const dx = o.dx, f = Math.round(dx / m.res);
  const nx = Math.floor(C / f), ny = Math.floor(R / f), N = nx * ny;
  const z = new Float32Array(N), n = new Float32Array(N), loss = new Float32Array(N), por = new Float32Array(N);
  const kind = new Uint8Array(N), veg = new Float32Array(N), boro = new Uint8Array(N), sandy = new Uint8Array(N), fema = new Uint8Array(N);
  const nP = o.nPaved ?? DEFAULT_N.paved, nG = o.nGreen ?? DEFAULT_N.green;
  const drain = (o.drainage ?? 0) / 3.6e6, infil = (o.infiltration ?? 0) / 3.6e6;
  const ff = f * f;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let zs = 0, zl = 0, nl = 0, sea = 0, vg = 0, cv = 0, bmax = 0, sd = 0, fm = 0;
      for (let b = 0; b < f; b++) {
        const r = j * f + b;
        for (let a = 0; a < f; a++) {
          const k = r * C + i * f + a;
          const cov = data.cover[k];
          zs += data.dem[k];
          if (cov === 255) sea++;
          else { zl += data.dem[k]; nl++; vg += cov / 250; cv += data.por[k] / 250; }
          if (data.boro[k] > bmax) bmax = data.boro[k];
          sd += data.sandy[k];
          if (data.fema[k] > fm) fm = data.fema[k];
        }
      }
      const c = j * nx + i;
      if (sea * 2 > ff) {
        kind[c] = KIND.SEA; z[c] = zs / ff; n[c] = DEFAULT_N.river; por[c] = 1;
      } else {
        z[c] = nl ? zl / nl : zs / ff;
        kind[c] = bmax > 0 ? (z[c] < TIDAL_Z ? KIND.CITY_TIDAL : KIND.CITY) : KIND.LAND;
        veg[c] = nl ? vg / nl : 0;
        const cover = nl ? cv / nl : 0;
        por[c] = o.porosity === false ? 1 : Math.max(0.1, 1 - cover);
        n[c] = nP * (1 - veg[c]) + nG * veg[c];
        // losses act on the open part: whole-cell drainage concentrated into it, infiltration on its green share
        loss[c] = drain / por[c] + infil * veg[c];
      }
      boro[c] = bmax; sandy[c] = sd * 2 > ff ? 1 : 0; fema[c] = fm;
    }
  }

  // boundary gauge weights: bilinear from the 80 m grid, renormalised
  const bw = new Uint8Array(N * 4);
  const BW = m.bw_cols, BH = m.bw_rows, s = m.bw_res;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (kind[c] !== KIND.SEA) continue;
    const fx = Math.min(Math.max(((i + 0.5) * dx) / s - 0.5, 0), BW - 1.001), fy = Math.min(Math.max(((j + 0.5) * dx) / s - 0.5, 0), BH - 1.001);
    const i0 = Math.floor(fx), j0 = Math.floor(fy), ax = fx - i0, ay = fy - j0;
    const w = [0, 0, 0, 0];
    let tot = 0;
    for (const [di, dj, wt] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]]) {
      const q = ((j0 + dj) * BW + i0 + di) * 4;
      const sum = data.bw[q] + data.bw[q + 1] + data.bw[q + 2] + data.bw[q + 3];
      if (!sum) continue;
      for (let k = 0; k < 4; k++) w[k] += wt * data.bw[q + k];
      tot += wt * sum;
    }
    if (!tot) { w[0] = 255; tot = 255; }
    for (let k = 0; k < 4; k++) bw[c * 4 + k] = Math.round((w[k] / tot) * 255);
  }

  const seaAdj = (c, i, j) =>
    (i > 0 && kind[c - 1] === KIND.SEA) || (i < nx - 1 && kind[c + 1] === KIND.SEA) ||
    (j > 0 && kind[c - nx] === KIND.SEA) || (j < ny - 1 && kind[c + nx] === KIND.SEA);

  // defences raise the bed to their crest
  const z0 = z.slice();
  const defended = new Set(), waterfrontCells = [];
  const raise = (c, crest) => { if (kind[c] === KIND.SEA) return; z[c] = Math.max(z[c], crest); loss[c] = 0; defended.add(c); };
  const wf = o.waterfront;
  if (wf && wf.boros?.length) {
    const set = new Set(wf.boros);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if ((kind[c] === KIND.CITY || kind[c] === KIND.CITY_TIDAL) && set.has(boro[c]) && seaAdj(c, i, j)) { raise(c, wf.crest); waterfrontCells.push(c); }
    }
  }
  for (const b of o.barriers || []) {
    for (let k = 0; k + 1 < b.points.length; k++) {
      const [x1, y1] = b.points[k], [x2, y2] = b.points[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (dx * 0.4)));
      let pi = -1, pj = -1;
      for (let st = 0; st <= steps; st++) {
        const x = x1 + ((x2 - x1) * st) / steps, y = y1 + ((y2 - y1) * st) / steps;
        const i = Math.floor(x / dx), j = Math.floor(y / dx);
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        raise(j * nx + i, b.crest);
        if (pi >= 0 && pi !== i && pj !== j) raise(pj * nx + i, b.crest);   // keep the line 4-connected
        pi = i; pj = j;
      }
    }
  }

  let minCoastZ = 99;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (kind[c] !== KIND.SEA && seaAdj(c, i, j)) minCoastZ = Math.min(minCoastZ, z[c]);
  }
  const bed = new Float32Array(N * 4);
  for (let c = 0; c < N; c++) { bed[4 * c] = z[c]; bed[4 * c + 1] = n[c]; bed[4 * c + 2] = kind[c]; bed[4 * c + 3] = loss[c]; }
  return { nx, ny, dx, f, N, z, z0, n, kind, loss, por, veg, boro, sandy, fema, bed, bw, minCoastZ, defended: [...defended], waterfrontCells };
}

/** Cell index of each building (exposure arrays), -1 outside the grid. */
export function buildingCells(expo, g) {
  const out = new Float32Array(expo.n);
  for (let k = 0; k < expo.n; k++) {
    const i = Math.floor(expo.x[k] / g.dx), j = Math.floor(expo.y[k] / g.dx);
    out[k] = i >= 0 && j >= 0 && i < g.nx && j < g.ny ? j * g.nx + i : -1;
  }
  return out;
}

/** Cell index of points ({ x, y } in local metres), nudged off boundary water when possible. */
export function pointCells(points, g) {
  return Float32Array.from(points.map(p => {
    const ci = Math.min(g.nx - 1, Math.max(0, Math.floor(p.x / g.dx))), cj = Math.min(g.ny - 1, Math.max(0, Math.floor(p.y / g.dx)));
    let best = cj * g.nx + ci, bd = g.kind[best] === KIND.SEA ? 1e9 : 0;
    for (let r = 1; r <= 2 && bd > 0; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const q = j * g.nx + i, d = di * di + dj * dj;
      if (g.kind[q] !== KIND.SEA && d < bd) { bd = d; best = q; }
    }
    return best;
  }));
}
