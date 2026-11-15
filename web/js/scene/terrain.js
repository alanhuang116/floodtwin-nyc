// Terrain: the 20 m lidar surface as 1.6 km chunks with three levels of detail
// (20, 80 and 320 m), draped with city-wide aerial imagery and, near the camera,
// 1.8 m imagery tiles from the USGS National Map. The shader adds wetting and
// silt left by the flood, analysis footprints, FEMA zones and the mapped Sandy
// extent, and mutes ground outside the five boroughs.
import * as THREE from 'three';
import { RAMPS_GLSL } from '../ramps.js';

export const MODES = { PHOTO: 0, DEPTH: 1, VELOCITY: 2, HAZARD: 3, MAXDEPTH: 4, ARRIVAL: 5, IMPACT: 6 };
export { RAMPS_GLSL };

export const CHUNK = 1600;
const LOD_STEPS = [20, 80, 320];
const TILE_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
const DETAIL_Z = 16;

export class Terrain {
  constructor(data, shared, geo) {
    const m = data.meta;
    this.W = m.grid.width_m; this.H = m.grid.height_m;
    this.cols = m.cols; this.rows = m.rows; this.res = m.res;
    this.dem = data.dem; this.geo = geo; this.shared = shared;
    this.nci = Math.ceil(this.W / CHUNK); this.ncj = Math.ceil(this.H / CHUNK);
    this.group = new THREE.Group(); this.group.name = 'terrain';

    const tex = (arr, fmt = THREE.RedFormat, filter = THREE.NearestFilter) => {
      const t = new THREE.DataTexture(arr, m.cols, m.rows, fmt, THREE.UnsignedByteType);
      t.minFilter = t.magFilter = filter; t.needsUpdate = true; return t;
    };
    this.boroTex = tex(data.boro);
    this.femaTex = tex(data.fema);
    this.sandyTex = tex(data.sandy, THREE.RedFormat, THREE.LinearFilter);
    const u = this.uniforms = {
      uVis: shared.uVis, uState: shared.uState, uStats: shared.uStats, uSimTime: shared.uSimTime, uMode: shared.uMode,
      uDomain: shared.uDomain, uDryTime: shared.uDryTime, uRainWet: shared.uRainWet, uTEnd: shared.uTEnd, uNight: shared.uNight,
      uShowFema: shared.uShowFema, uShowSandy: shared.uShowSandy, uApron: shared.uApron, uBoro: { value: this.boroTex }, uFema: { value: this.femaTex },
      uSandy: { value: this.sandyTex }, uTexel: { value: new THREE.Vector2(1 / m.cols, 1 / m.rows) },
    };
    this.material = this._material(null);
    this.chunks = [];
    for (let j = 0; j < this.ncj; j++) for (let i = 0; i < this.nci; i++) {
      const c = { i, j, x0: i * CHUNK, y0: j * CHUNK, x1: Math.min(this.W, (i + 1) * CHUNK), y1: Math.min(this.H, (j + 1) * CHUNK),
        lods: [null, this._geometry(i, j, 80), this._geometry(i, j, 320)], lod: -1, detail: null };
      c.cx = (c.x0 + c.x1) / 2; c.cy = (c.y0 + c.y1) / 2;
      c.mesh = new THREE.Mesh(c.lods[2], this.material);
      c.mesh.receiveShadow = true; c.mesh.matrixAutoUpdate = false;
      this.group.add(c.mesh);
      this.chunks.push(c);
    }
    this.detailCache = new Map();          // key -> { tex, uv offsets }
    this.loadingDetail = new Set();
    this._buildSkirt();
  }

  zAt(lx, ly) {
    const C = this.cols, R = this.rows;
    const fx = Math.min(Math.max(lx / this.res - 0.5, 0), C - 1.001), fy = Math.min(Math.max(ly / this.res - 0.5, 0), R - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j, k = j * C + i, d = this.dem;
    return (d[k] * (1 - a) + d[k + 1] * a) * (1 - b) + (d[k + C] * (1 - a) + d[k + C + 1] * a) * b;
  }
  heightAt(lx, ly) { return this.zAt(lx, ly); }

  _geometry(ci, cj, step) {
    const x0 = ci * CHUNK, y0 = cj * CHUNK, x1 = Math.min(this.W, x0 + CHUNK), y1 = Math.min(this.H, y0 + CHUNK);
    const nx = Math.round((x1 - x0) / step), ny = Math.round((y1 - y0) / step);
    const vx = nx + 1, vy = ny + 1, W = this.W, H = this.H;
    const nSk = 2 * (nx + ny) * 2;                      // skirt vertices around the edge
    const pos = new Float32Array((vx * vy + nSk) * 3), nor = new Float32Array((vx * vy + nSk) * 3);
    const d = Math.max(step, 20);
    for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
      const x = x0 + i * step, y = y0 + j * step, k = j * vx + i;
      const z = this.zAt(x, y);
      pos[3 * k] = x - W / 2; pos[3 * k + 1] = z; pos[3 * k + 2] = H / 2 - y;
      const dzx = (this.zAt(x + d, y) - this.zAt(x - d, y)) / (2 * d), dzy = (this.zAt(x, y + d) - this.zAt(x, y - d)) / (2 * d);
      const l = Math.hypot(dzx, 1, dzy);
      nor[3 * k] = -dzx / l; nor[3 * k + 1] = 1 / l; nor[3 * k + 2] = dzy / l;
    }
    const idx = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * vx + i, b = a + 1, c = a + vx, e = c + 1;
      idx.push(a, b, c, b, e, c);
    }
    // skirt: a curtain 40 m deep under the chunk edge hides cracks between levels of detail
    const ring = [];
    for (let i = 0; i < nx; i++) ring.push(i);
    for (let j = 0; j < ny; j++) ring.push(j * vx + nx);
    for (let i = nx; i > 0; i--) ring.push(ny * vx + i);
    for (let j = ny; j > 0; j--) ring.push(j * vx);
    let o = vx * vy;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      for (const src of [a, b]) {
        pos[3 * o] = pos[3 * src]; pos[3 * o + 1] = pos[3 * src + 1] - 40; pos[3 * o + 2] = pos[3 * src + 2];
        nor[3 * o] = nor[3 * src]; nor[3 * o + 1] = nor[3 * src + 1]; nor[3 * o + 2] = nor[3 * src + 2];
        o++;
      }
      const s0 = o - 2, s1 = o - 1;
      idx.push(a, s0, b, b, s0, s1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, o * 3), 3));
    g.setIndex(idx);
    g.computeBoundingSphere(); g.computeBoundingBox();
    g.userData = { vx, vy, step, x0, y0 };
    return g;
  }

  _material(detail) {
    const u = this.uniforms;
    const mat = new THREE.MeshStandardMaterial({ map: this.shared.imageryTex, roughness: 0.94, metalness: 0, envMapIntensity: 0.5 });
    const own = { uDetail: { value: detail?.tex || null }, uHasDetail: { value: detail ? 1 : 0 } };
    mat.userData.own = own;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u, own);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
uniform vec2 uDomain;
varying vec2 vTUv;
varying float vViewDist;
${detail ? 'attribute vec2 uvDetail;\nvarying vec2 vDetailUv;' : ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vTUv = vec2((position.x + 0.5 * uDomain.x) / uDomain.x, (0.5 * uDomain.y - position.z) / uDomain.y);
  ${detail ? 'vDetailUv = uvDetail;' : ''}`)
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vViewDist = -mvPosition.z;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vTUv;
varying float vViewDist;
uniform sampler2D uVis, uState, uStats, uBoro, uFema, uSandy, uDetail;
uniform float uSimTime, uDryTime, uRainWet, uTEnd, uShowFema, uShowSandy, uNight, uHasDetail;
uniform vec3 uApron;
uniform vec2 uTexel;
uniform int uMode;
${detail ? 'varying vec2 vDetailUv;' : ''}
${RAMPS_GLSL}
float code(sampler2D t, vec2 uv) { return floor(texture2D(t, uv).r * 255.0 + 0.5); }`)
        .replace('#include <map_fragment>', `
  vec4 sampledDiffuseColor = texture2D(map, vTUv);
  ${detail ? `vec4 dc = texture2D(uDetail, vDetailUv);
  float dw = uHasDetail * (1.0 - smoothstep(1800.0, 3200.0, vViewDist));
  sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, dc.rgb, dw);` : ''}
  diffuseColor *= sampledDiffuseColor;
  // outside the five boroughs: muted context
  float inCity = step(0.5, code(uBoro, vTUv));
  float lum0 = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(mix(diffuseColor.rgb, vec3(lum0), 0.55) * 0.82, diffuseColor.rgb, inCity);
  vec4 st = texture2D(uStats, vTUv);
  vec4 vis = texture2D(uVis, vTUv);
  float lastWet = texture2D(uState, vTUv).w;
  float wetness = lastWet > 0.0 ? clamp(1.0 - (uSimTime - lastWet) / uDryTime, 0.0, 1.0) : 0.0;
  wetness = max(wetness, uRainWet);
  diffuseColor.rgb *= mix(1.0, 0.55, wetness);
  float silt = smoothstep(0.05, 0.7, st.x) * (1.0 - step(0.03, vis.y));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.36, 0.27) * (0.6 + 0.8 * dot(diffuseColor.rgb, vec3(0.33))), 0.4 * silt);
  if (uMode != 0) {
    float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * 0.8, 0.75);
  }
  if (uMode == 4 && st.x > 0.03) diffuseColor.rgb = mix(diffuseColor.rgb, rampDepth(st.x), 0.92);
  if (uMode == 5 && st.y >= 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, rampArrival(st.y, uTEnd), 0.92);
  if (uShowFema > 0.5) {
    float zc = code(uFema, vTUv);
    if (zc > 0.5) {
      vec3 zcol = zc > 2.5 ? vec3(0.694, 0.100, 0.019) : zc > 1.5 ? vec3(0.041, 0.242, 0.783) : vec3(0.010, 0.342, 0.162);
      float e = step(0.5, abs(code(uFema, vTUv + vec2(uTexel.x, 0.0)) - zc)) + step(0.5, abs(code(uFema, vTUv - vec2(uTexel.x, 0.0)) - zc))
              + step(0.5, abs(code(uFema, vTUv + vec2(0.0, uTexel.y)) - zc)) + step(0.5, abs(code(uFema, vTUv - vec2(0.0, uTexel.y)) - zc));
      diffuseColor.rgb = mix(diffuseColor.rgb, zcol, 0.25 + 0.6 * min(e, 1.0));
    }
  }
  if (uShowSandy > 0.5) {
    // the mapped Sandy inundation zone as an outline
    float s0 = texture2D(uSandy, vTUv).r;
    float edge = smoothstep(0.15, 0.5, s0) * (1.0 - smoothstep(0.5, 0.85, s0));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.71, 0.28), 0.9 * edge);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.78, 0.45), 0.10 * step(0.5, s0));
  }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.3, wetness * 0.85);`)
        .replace('#include <fog_fragment>', `#include <fog_fragment>
  {
    // the model dissolves into the haze over its last few kilometres
    vec2 eu = vTUv;
    float ed = min(min(eu.x, 1.0 - eu.x), min(eu.y, 1.0 - eu.y));
    float ef = 1.0 - smoothstep(0.0, 0.075, ed);
    float ffe = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(uApron, fogColor, ffe), ef);
  }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // street lighting at night: grey pavement catches a warm glow inside the city
  float lum = dot(diffuseColor.rgb, vec3(0.33));
  float pave = smoothstep(0.04, 0.16, lum) * (1.0 - smoothstep(0.03, 0.09, abs(diffuseColor.g - 0.5 * (diffuseColor.r + diffuseColor.b))));
  float dark = smoothstep(0.03, 0.12, st.x);              // flooded streets lose their lights
  totalEmissiveRadiance += vec3(1.0, 0.58, 0.26) * uNight * (0.003 + pave * 0.028) * mix(0.6, 1.0, inCity) * (1.0 - dark);`);
    };
    mat.customProgramCacheKey = () => (detail ? 'terrain-detail' : 'terrain');
    return mat;
  }

  _buildSkirt() {
    // outer walls of the model down to a base slab, so the city reads as a cut block
    const W = this.W, H = this.H, base = -60, step = 80;
    const ring = [];
    for (let x = 0; x <= W; x += step) ring.push([x, 0]);
    for (let y = step; y <= H; y += step) ring.push([W, y]);
    for (let x = W - step; x >= 0; x -= step) ring.push([x, H]);
    for (let y = H - step; y >= step; y -= step) ring.push([0, y]);
    const sp = [], sc = [], si = [];
    ring.forEach(([x, y]) => {
      const z = this.zAt(Math.min(x, W - 1), Math.min(y, H - 1));
      sp.push(x - W / 2, z, H / 2 - y, x - W / 2, base, H / 2 - y);
      const t = 0.10 + 0.04 * Math.sin(z * 0.5);
      sc.push(t, t * 1.06, t * 1.12, 0.03, 0.035, 0.04);
    });
    for (let k = 0; k < ring.length; k++) { const a = 2 * k, b = 2 * ((k + 1) % ring.length); si.push(a, a + 1, b, b, a + 1, b + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    g.setIndex(si); g.computeVertexNormals();
    this.skirt = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
    this.base = new THREE.Mesh(new THREE.BoxGeometry(W, 4, H), new THREE.MeshStandardMaterial({ color: 0x0b0d0f, roughness: 1 }));
    this.base.position.y = base - 2;
    this.group.add(this.skirt, this.base);
    this.skirt.visible = false; this.base.visible = false;     // the edges dissolve into haze instead
  }

  /** Pick levels of detail and imagery tiles for the camera; call once per frame. */
  update(camera, target) {
    const W = this.W, H = this.H, cam = camera.position;
    const tx = target.x + W / 2, ty = H / 2 - target.z;
    for (const c of this.chunks) {
      const dx = c.cx - W / 2 - cam.x, dz = (H / 2 - c.cy) - cam.z, dy = cam.y - 10;
      const d = Math.hypot(dx, dy, dz);
      const lod = d < 5200 ? 0 : d < 17000 ? 1 : 2;
      if (lod !== c.lod) {
        if (lod === 0 && !c.lods[0]) c.lods[0] = this._geometry(c.i, c.j, 20);
        c.mesh.geometry = c.lods[lod];
        if (c.lod === 0 && lod !== 0 && c.detail) this._dropDetail(c);
        c.lod = lod;
        if (lod > 0 && c.lods[0] && d > 9000) { c.lods[0].dispose(); c.lods[0] = null; }
      }
      // imagery tiles for chunks near the point the camera looks at
      const near = Math.hypot(c.cx - tx, c.cy - ty) < 2600 && d < 4500;
      if (near && lod === 0 && !c.detail && !this.loadingDetail.has(c)) this._loadDetail(c);
    }
  }

  _dropDetail(c) {
    c.mesh.material = this.material;
    c.detail = null;
  }

  async _loadDetail(c) {
    this.loadingDetail.add(c);
    const key = `${c.i}_${c.j}`;
    try {
      let d = this.detailCache.get(key);
      if (!d) {
        d = await this._fetchDetail(c);
        this.detailCache.set(key, d);
        if (this.detailCache.size > 24) {                // drop the oldest imagery
          const [k0, v0] = this.detailCache.entries().next().value;
          v0.tex.dispose(); this.detailCache.delete(k0);
          for (const ch of this.chunks) if (`${ch.i}_${ch.j}` === k0 && ch.detail) this._dropDetail(ch);
        }
      }
      if (c.lod === 0 && c.lods[0]) {
        const g = c.lods[0];
        if (!g.getAttribute('uvDetail')) g.setAttribute('uvDetail', new THREE.BufferAttribute(this._detailUv(g, d), 2));
        if (!d.material) d.material = this._material(d);
        c.mesh.material = d.material;
        c.detail = d;
      }
    } catch (e) { /* imagery is optional: keep the base texture */ }
    this.loadingDetail.delete(c);
  }

  _merc(lon, lat, z) {
    const n = 2 ** z, s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * n * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256];
  }

  async _fetchDetail(c) {
    const corners = [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]].map(([x, y]) => this._merc(...this.geo.toLonLat(x, y), DETAIL_Z));
    const px0 = Math.min(...corners.map(p => p[0])), px1 = Math.max(...corners.map(p => p[0]));
    const py0 = Math.min(...corners.map(p => p[1])), py1 = Math.max(...corners.map(p => p[1]));
    const tx0 = Math.floor(px0 / 256), tx1 = Math.floor(px1 / 256), ty0 = Math.floor(py0 / 256), ty1 = Math.floor(py1 / 256);
    const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
    const canvas = document.createElement('canvas');
    canvas.width = nx * 256; canvas.height = ny * 256;
    const ctx = canvas.getContext('2d');
    const jobs = [];
    for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
      jobs.push(new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { ctx.drawImage(img, (x - tx0) * 256, (y - ty0) * 256); resolve(true); };
        img.onerror = () => resolve(false);
        img.src = TILE_URL.replace('{z}', DETAIL_Z).replace('{x}', x).replace('{y}', y);
      }));
    }
    const ok = await Promise.all(jobs);
    if (ok.filter(Boolean).length < ok.length * 0.6) throw new Error('imagery tiles unavailable');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
    return { tex, ox: tx0 * 256, oy: ty0 * 256, w: canvas.width, h: canvas.height };
  }

  _detailUv(g, d) {
    const pos = g.getAttribute('position'), n = pos.count, uv = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const lx = pos.getX(k) + this.W / 2, ly = this.H / 2 - pos.getZ(k);
      const [px, py] = this._merc(...this.geo.toLonLat(lx, ly), DETAIL_Z);
      uv[2 * k] = (px - d.ox) / d.w; uv[2 * k + 1] = 1 - (py - d.oy) / d.h;
    }
    return uv;
  }
}
