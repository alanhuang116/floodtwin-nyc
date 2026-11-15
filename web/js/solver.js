// GPU implementation of the FloodTwin NYC hydraulic solver (WebGL2 fragment
// shaders on float render targets): local inertial shallow-water equations
// with single porosity for sub-grid buildings, and a boundary whose level is a
// weighted mix of four tide gauges. The scheme, variable layout and order of
// operations follow sim/solver.py; tests/gpu_parity.py compares them.
//
// State texture (RGBA32F, one texel per cell):
//   r = h   depth of water in the open part of the cell (m)
//   g = qx  unit discharge across the east face, per metre of open face (m^2/s)
//   b = qy  unit discharge across the north face (m^2/s)
//   a = time the cell was last wet (s), used to draw drying ground
// Bed texture (RGBA32F): r = z (m NAVD88), g = Manning n, b = kind
//   (0 land, 1 boundary water, 3 city land, 4 city ground below 0.8 m), a = loss rate in the open part (m/s)
// Porosity texture (R32F): open fraction phi in (0, 1]
// Weights texture (RGBA8): share of each boundary gauge in a boundary cell's level
import * as THREE from 'three';

const VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform ivec2 uSize;
bool inside(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < uSize.x && c.y < uSize.y; }
bool isSea(float k) { return k > 0.5 && k < 1.5; }
`;

const MOMENTUM = /* glsl */`${COMMON}
uniform sampler2D uState, uBed, uPor;
uniform float uDt, uDx, uTheta, uThetaC, uFrMax, uHdry, uG;
out vec4 outColor;
vec4 S(ivec2 c) { return inside(c) ? texelFetch(uState, c, 0) : vec4(0.0); }
vec4 Bd(ivec2 c) { return texelFetch(uBed, clamp(c, ivec2(0), uSize - 1), 0); }
float P(ivec2 c) { return texelFetch(uPor, clamp(c, ivec2(0), uSize - 1), 0).r; }

float faceFlux(float qn, float qUp, float qDn, float qCross, float hL, vec4 bL, float pL,
               float hR, vec4 bR, float pR, bool edge) {
  float zL = bL.x, zR = bR.x;
  float etaL = zL + hL, etaR = zR + hR;
  float hf = max(etaL, etaR) - max(zL, zR);
  bool seaL = isSea(bL.z), seaR = isSea(bR.z);
  if (edge || (seaL && seaR) || hf < uHdry) return 0.0;
  float qstar = uTheta * qn + uThetaC * (qUp + qDn);
  float qmag = sqrt(qn * qn + qCross * qCross);
  float nf = 0.5 * (bL.y + bR.y);
  float num = qstar - uG * hf * uDt * (etaR - etaL) / uDx;
  float den = 1.0 + uG * uDt * nf * nf * qmag / pow(hf, 7.0 / 3.0);
  float q = num / den;
  float qfr = uFrMax * hf * sqrt(uG * hf);
  q = clamp(q, -qfr, qfr);
  // positivity: a face may take at most a quarter of the donor's stored water per step
  bool donorSea = q > 0.0 ? seaL : seaR;
  if (!donorSea) {
    float psi = min(pL, pR);
    float hD = q > 0.0 ? hL * pL : hR * pR;
    float ql = hD * uDx / (4.0 * uDt * psi);
    q = clamp(q, -ql, ql);
  }
  return q;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 sC = S(c);
  vec4 sE = S(c + ivec2(1, 0)), sW = S(c - ivec2(1, 0));
  vec4 sN = S(c + ivec2(0, 1)), sS = S(c - ivec2(0, 1));
  vec4 sSE = S(c + ivec2(1, -1)), sNW = S(c + ivec2(-1, 1));
  vec4 bC = Bd(c), bE = Bd(c + ivec2(1, 0)), bN = Bd(c + ivec2(0, 1));
  float pC = P(c), pE = P(c + ivec2(1, 0)), pN = P(c + ivec2(0, 1));
  float qyCross = 0.25 * (sC.z + sE.z + sS.z + sSE.z);
  float qx = faceFlux(sC.y, sW.y, sE.y, qyCross, sC.x, bC, pC, sE.x, bE, pE, c.x >= uSize.x - 1);
  float qxCross = 0.25 * (sC.y + sN.y + sW.y + sNW.y);
  float qy = faceFlux(sC.z, sS.z, sN.z, qxCross, sC.x, bC, pC, sN.x, bN, pN, c.y >= uSize.y - 1);
  outColor = vec4(sC.x, qx, qy, sC.w);
}`;

const MAX_SOURCES = 16;
const CONTINUITY = /* glsl */`${COMMON}
uniform sampler2D uState, uBed, uPor, uBW;
uniform float uDt, uDx, uRain, uTime, uWetTh;
uniform vec4 uGauge;                  // boundary level at the four gauges, m NAVD88
uniform int uNumSources;
uniform vec4 uSources[${MAX_SOURCES}];   // xy cell, radius in cells, rate m^3/s
uniform float uSourceCells[${MAX_SOURCES}];
out vec4 outColor;
float P(ivec2 c) { return texelFetch(uPor, clamp(c, ivec2(0), uSize - 1), 0).r; }

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 sC = texelFetch(uState, c, 0);
  float pC = P(c);
  float qxW = c.x > 0 ? texelFetch(uState, c - ivec2(1, 0), 0).y : 0.0;
  float qyS = c.y > 0 ? texelFetch(uState, c - ivec2(0, 1), 0).z : 0.0;
  float psiE = min(pC, P(c + ivec2(1, 0))), psiW = min(pC, P(c - ivec2(1, 0)));
  float psiN = min(pC, P(c + ivec2(0, 1))), psiS = min(pC, P(c - ivec2(0, 1)));
  vec4 b = texelFetch(uBed, c, 0);
  // rain on the whole cell, roofs included, ends up in its open part
  float h = sC.x + uDt * ((psiW * qxW - psiE * sC.y + psiS * qyS - psiN * sC.z) / (uDx * pC)) + uDt * uRain / pC;
  float lost = min(b.w * uDt, max(h, 0.0));
  h = max(h - lost, 0.0);
  for (int k = 0; k < ${MAX_SOURCES}; k++) {
    if (k >= uNumSources) break;
    vec4 s = uSources[k];
    if (length(vec2(c) - s.xy) <= s.z) h = max(h + s.w * uDt / (uSourceCells[k] * uDx * uDx * pC), 0.0);
  }
  if (isSea(b.z)) {
    vec4 w = texelFetch(uBW, c, 0);
    float stage = dot(w, uGauge) / max(w.r + w.g + w.b + w.a, 1e-3);
    h = max(stage - b.x, 0.0);
  }
  float wet = h > uWetTh ? uTime : sC.w;
  outColor = vec4(h, sC.y, sC.z, wet);
}`;

// Running statistics: max depth, arrival of 10 cm, max speed, max hazard rating
const STATS = /* glsl */`${COMMON}
uniform sampler2D uState, uBed, uPrev;
uniform float uTime;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, c, 0);
  vec4 b = texelFetch(uBed, c, 0);
  vec4 p = texelFetch(uPrev, c, 0);
  if (!isSea(b.z)) {
    float h = s.x;
    float qxW = c.x > 0 ? texelFetch(uState, c - ivec2(1, 0), 0).y : 0.0;
    float qyS = c.y > 0 ? texelFetch(uState, c - ivec2(0, 1), 0).z : 0.0;
    vec2 q = 0.5 * vec2(s.y + qxW, s.z + qyS);
    float v = h > 0.05 ? length(q) / h : 0.0;
    float df = h > 0.25 ? 0.5 : 0.0;
    float hr = h > 0.02 ? h * (v + 0.5) + df : 0.0;
    p.x = max(p.x, h);
    if (p.y < 0.0 && h > 0.10) p.y = uTime;
    p.z = max(p.z, v);
    p.w = max(p.w, hr);
  }
  outColor = p;
}`;

// Field used to draw the water: r = water surface (extended one ring into dry
// cells so the surface meets the ground cleanly), g = depth, b, a = velocity
const VIS = /* glsl */`${COMMON}
uniform sampler2D uState, uBed;
uniform float uVisTh;
out vec4 outColor;
vec4 S(ivec2 c) { return texelFetch(uState, clamp(c, ivec2(0), uSize - 1), 0); }
vec4 Bd(ivec2 c) { return texelFetch(uBed, clamp(c, ivec2(0), uSize - 1), 0); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = S(c), b = Bd(c);
  float h = s.x;
  float eta = b.x - 4.0;
  vec2 vel = vec2(0.0);
  if (h > uVisTh) {
    eta = b.x + h;
    vec2 q = 0.5 * vec2(s.y + S(c - ivec2(1, 0)).y, s.z + S(c - ivec2(0, 1)).z);
    vel = q / max(h, 0.05);
  } else {
    float best = -1e9;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      ivec2 n = c + ivec2(i, j);
      if (!inside(n)) continue;
      vec4 sn = S(n);
      if (sn.x > uVisTh) best = max(best, Bd(n).x + sn.x);
    }
    if (best > -1e8) eta = best;
  }
  outColor = vec4(eta, h, vel);
}`;

// Reduction, first level over 4 x 4 cells: r = max wave speed (|u| + sqrt(g h_eff)),
// g = cells inside the city deeper than 10 cm, b = water volume inside the city
// (open fraction times depth, in cell units), a = land cells deeper than 10 cm anywhere
const REDUCE0 = /* glsl */`${COMMON}
uniform sampler2D uState, uBed, uPor;
uniform vec4 uGauge;
uniform float uG;
uniform ivec2 uSrcSize;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * 4;
  float cmax = 0.0, wetCity = 0.0, volCity = 0.0, wetAll = 0.0;
  float stageMax = max(max(uGauge.x, uGauge.y), max(uGauge.z, uGauge.w));
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 c = o + ivec2(i, j);
    if (c.x >= uSrcSize.x || c.y >= uSrcSize.y) continue;
    vec4 b = texelFetch(uBed, c, 0);
    if (isSea(b.z)) continue;
    vec4 s = texelFetch(uState, c, 0);
    float h = s.x;
    float heff = h;
    for (int k = 0; k < 4; k++) {
      ivec2 n = c + (k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1));
      if (n.x < 0 || n.y < 0 || n.x >= uSrcSize.x || n.y >= uSrcSize.y) continue;
      if (isSea(texelFetch(uBed, n, 0).z)) heff = max(heff, stageMax - b.x);
    }
    // advection speed only where the water is deep enough for q / h to mean something: thin
    // films at a wet front carry limiter-bounded fluxes whose ratio would collapse the step
    float u = 0.0;
    if (h > 0.05) {
      float qxW = c.x > 0 ? texelFetch(uState, c - ivec2(1, 0), 0).y : 0.0;
      float qyS = c.y > 0 ? texelFetch(uState, c - ivec2(0, 1), 0).z : 0.0;
      u = min(length(0.5 * vec2(s.y + qxW, s.z + qyS)) / h, 2.0 * sqrt(uG * h));
    }
    cmax = max(cmax, u + sqrt(uG * max(heff, 0.0)));
    bool city = b.z > 2.5 && b.z < 3.5;          // city land, intertidal ground excluded
    if (h > 0.10) { wetAll += 1.0; if (city) wetCity += 1.0; }
    if (city) volCity += h * texelFetch(uPor, c, 0).r;
  }
  outColor = vec4(cmax, wetCity, volCity, wetAll);
}`;
const REDUCE = /* glsl */`${COMMON}
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * 4;
  float m = 0.0; vec3 s = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 c = o + ivec2(i, j);
    if (c.x >= uSrcSize.x || c.y >= uSrcSize.y) continue;
    vec4 t = texelFetch(uSrc, c, 0);
    m = max(m, t.x);
    s += t.yzw;
  }
  outColor = vec4(m, s);
}`;

// Buildings: one texel per building holding its cell index. Output r = peak
// depth so far at the building, g = current depth. The water surface at a
// building is capped by the highest surface in the open cells around it: in a
// densely built cell, rain from roofs pools in the small open part, which is a
// storage artefact of the coarse grid rather than water against the walls.
const BUILDINGS = /* glsl */`${COMMON}
uniform sampler2D uState, uStats, uIdx, uBed, uPor;
uniform int uCount, uWidth;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int k = p.y * uWidth + p.x;
  if (k >= uCount) { outColor = vec4(0.0); return; }
  float id = texelFetch(uIdx, p, 0).r;
  if (id < 0.0) { outColor = vec4(0.0); return; }
  ivec2 c = ivec2(int(mod(id, float(uSize.x))), int(floor(id / float(uSize.x))));
  float z = texelFetch(uBed, c, 0).x;
  float hm = texelFetch(uStats, c, 0).x, hn = texelFetch(uState, c, 0).x;
  if (texelFetch(uPor, c, 0).r < 0.5) {
    float capM = -1e9, capN = -1e9;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      ivec2 n = clamp(c + ivec2(i, j), ivec2(0), uSize - 1);
      if (texelFetch(uPor, n, 0).r < 0.5) continue;
      vec4 bn = texelFetch(uBed, n, 0);
      capM = max(capM, bn.x + texelFetch(uStats, n, 0).x);
      capN = max(capN, bn.x + texelFetch(uState, n, 0).x);
    }
    if (capM > -1e8) { hm = clamp(capM - z, 0.0, hm); hn = clamp(capN - z, 0.0, hn); }
  }
  outColor = vec4(hm, hn, 0.0, 0.0);
}`;

// Points (high-water marks, stations): peak and current water surface, max over
// the 3 x 3 cells around the point (-99 when dry), and the point cell's depths.
const POINTS = /* glsl */`${COMMON}
uniform sampler2D uState, uStats, uBed, uIdx;
uniform int uCount, uWidth;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int k = p.y * uWidth + p.x;
  if (k >= uCount) { outColor = vec4(-99.0); return; }
  float id = texelFetch(uIdx, p, 0).r;
  ivec2 c0 = ivec2(int(mod(id, float(uSize.x))), int(floor(id / float(uSize.x))));
  vec4 r = vec4(-99.0, -99.0, 0.0, 0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 c = clamp(c0 + ivec2(i, j), ivec2(0), uSize - 1);
    vec4 b = texelFetch(uBed, c, 0);
    if (isSea(b.z)) continue;
    float hm = texelFetch(uStats, c, 0).x, h = texelFetch(uState, c, 0).x;
    if (hm > 0.005) r.x = max(r.x, b.x + hm);
    if (h > 0.005) r.y = max(r.y, b.x + h);
    if (i == 0 && j == 0) { r.z = hm; r.w = h; }
  }
  outColor = r;
}`;

function target(w, h, { linear = false, type = THREE.FloatType, format = THREE.RGBAFormat } = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type, format, minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter, magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

function mat(fragmentShader, uniforms) {
  return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

function dataTex(data, w, h, format, type) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export class FloodSolver {
  /** grid: { nx, ny, dx, bed (Float32 RGBA), por (Float32), bw (Uint8 RGBA) }, row 0 = south */
  constructor(renderer, grid) {
    this.renderer = renderer;
    this.nx = grid.nx; this.ny = grid.ny; this.dx = grid.dx;
    this.params = { theta: 0.8, frMax: 1.0, hDry: 1e-3, g: 9.81, alpha: 0.7, dtMax: 3.0, wetTh: 0.02, visTh: 0.015 };
    this.time = 0; this.gauge = new THREE.Vector4(-5, -5, -5, -5); this.rain = 0;
    this.cmax = 0; this.wetCity = 0; this.volCity = 0; this.wetAll = 0; this._reducing = false;
    this.bedTex = dataTex(grid.bed, this.nx, this.ny, THREE.RGBAFormat, THREE.FloatType);
    this.porTex = dataTex(grid.por, this.nx, this.ny, THREE.RedFormat, THREE.FloatType);
    this.bwTex = dataTex(grid.bw, this.nx, this.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.a = target(this.nx, this.ny); this.b = target(this.nx, this.ny);
    this.statsA = target(this.nx, this.ny); this.statsB = target(this.nx, this.ny);
    this.vis = target(this.nx, this.ny, { linear: true, type: THREE.HalfFloatType });
    const iv = new THREE.Vector2(this.nx, this.ny), size = { value: iv };
    const tex = { uBed: { value: this.bedTex }, uPor: { value: this.porTex } };
    this.mMom = mat(MOMENTUM, { uSize: size, uState: { value: null }, ...tex, uDt: { value: 1 }, uDx: { value: this.dx },
      uTheta: { value: 0.8 }, uThetaC: { value: 0.1 }, uFrMax: { value: 1 }, uHdry: { value: 1e-3 }, uG: { value: 9.81 } });
    this.mCon = mat(CONTINUITY, { uSize: size, uState: { value: null }, ...tex, uBW: { value: this.bwTex },
      uDt: { value: 1 }, uDx: { value: this.dx }, uGauge: { value: this.gauge }, uRain: { value: 0 }, uTime: { value: 0 }, uWetTh: { value: 0.02 },
      uNumSources: { value: 0 }, uSources: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
      uSourceCells: { value: new Array(MAX_SOURCES).fill(1) } });
    this.mStats = mat(STATS, { uSize: size, uState: { value: null }, uBed: { value: this.bedTex }, uPrev: { value: null }, uTime: { value: 0 } });
    this.mVis = mat(VIS, { uSize: size, uState: { value: null }, uBed: { value: this.bedTex }, uVisTh: { value: 0.015 } });
    this.mRed0 = mat(REDUCE0, { uSize: size, uState: { value: null }, ...tex, uGauge: { value: this.gauge }, uG: { value: 9.81 }, uSrcSize: { value: iv } });
    this.mRed = mat(REDUCE, { uSize: size, uSrc: { value: null }, uSrcSize: { value: new THREE.Vector2() } });
    this.redTargets = [];
    let w = this.nx, h = this.ny;
    while (w > 4 || h > 4) { w = Math.ceil(w / 4); h = Math.ceil(h / 4); this.redTargets.push(target(w, h)); }
    this.redBuffer = new Float32Array(this.redTargets.at(-1).width * this.redTargets.at(-1).height * 4);
    this.quad = new THREE.Mesh(new THREE.BufferGeometry(), this.mMom);
    this.quad.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.reset();
  }

  _pass(material, tgt) {
    this.quad.material = material;
    this.renderer.setRenderTarget(tgt);
    this.renderer.render(this.scene, this.camera);
  }

  _clear(tgt, value = [0, 0, 0, 0]) {
    const r = this.renderer, prev = r.getClearColor(new THREE.Color()), pa = r.getClearAlpha();
    r.setRenderTarget(tgt); r.setClearColor(new THREE.Color(value[0], value[1], value[2]), value[3]); r.clear(true, false, false);
    r.setClearColor(prev, pa);
  }

  reset() {
    this.time = 0;
    this._clear(this.a); this._clear(this.b);
    this._clear(this.statsA, [0, -1, 0, 0]); this._clear(this.statsB, [0, -1, 0, 0]);
    this.cmax = 0; this.wetCity = 0; this.volCity = 0; this.wetAll = 0;
    this.updateVis();
    this.renderer.setRenderTarget(null);
  }

  setBed(bed, por, bw) {
    this.bedTex.image.data.set(bed); this.bedTex.needsUpdate = true;
    if (por) { this.porTex.image.data.set(por); this.porTex.needsUpdate = true; }
    if (bw) { this.bwTex.image.data.set(bw); this.bwTex.needsUpdate = true; }
  }

  setSources(list) {
    const u = this.mCon.uniforms, s = list.slice(0, MAX_SOURCES);
    u.uNumSources.value = s.length;
    s.forEach((q, k) => { u.uSources.value[k].set(q.i, q.j, q.r, q.rate); u.uSourceCells.value[k] = Math.max(1, q.cells || 1); });
  }

  setGauges(levels) { this.gauge.set(levels[0], levels[1], levels[2], levels[3]); }

  stableDt() {
    const p = this.params;
    const stageMax = Math.max(this.gauge.x, this.gauge.y, this.gauge.z, this.gauge.w);
    const c = Math.max(this.cmax * 1.15, Math.sqrt(p.g * Math.max(0.05, stageMax - this.minCoastZ || 0.05)));
    return Math.min(p.dtMax, p.alpha * this.dx / Math.max(c, 0.05));
  }

  step(dt) {
    const p = this.params, um = this.mMom.uniforms, uc = this.mCon.uniforms;
    um.uState.value = this.a.texture; um.uDt.value = dt; um.uTheta.value = p.theta; um.uThetaC.value = (1 - p.theta) * 0.5;
    um.uFrMax.value = p.frMax; um.uHdry.value = p.hDry; um.uG.value = p.g;
    this._pass(this.mMom, this.b);
    uc.uState.value = this.b.texture; uc.uDt.value = dt; uc.uRain.value = this.rain;
    this.time += dt;
    uc.uTime.value = this.time; uc.uWetTh.value = p.wetTh;
    this._pass(this.mCon, this.a);
  }

  updateStats() {
    const u = this.mStats.uniforms;
    u.uState.value = this.a.texture; u.uPrev.value = this.statsA.texture; u.uTime.value = this.time;
    this._pass(this.mStats, this.statsB);
    [this.statsA, this.statsB] = [this.statsB, this.statsA];
  }

  updateVis() {
    const u = this.mVis.uniforms;
    u.uState.value = this.a.texture; u.uVisTh.value = this.params.visTh;
    this._pass(this.mVis, this.vis);
  }

  _reduceChain() {
    const u0 = this.mRed0.uniforms;
    u0.uState.value = this.a.texture; u0.uG.value = this.params.g;
    this._pass(this.mRed0, this.redTargets[0]);
    for (let k = 1; k < this.redTargets.length; k++) {
      const src = this.redTargets[k - 1];
      this.mRed.uniforms.uSrc.value = src.texture; this.mRed.uniforms.uSrcSize.value.set(src.width, src.height);
      this._pass(this.mRed, this.redTargets[k]);
    }
    return this.redTargets.at(-1);
  }

  reduce() {
    if (this._reducing) return;
    const last = this._reduceChain();
    this._reducing = true;
    this.renderer.readRenderTargetPixelsAsync(last, 0, 0, last.width, last.height, this.redBuffer)
      .then(buf => { this._readReduction(buf); this._reducing = false; }).catch(() => { this._reducing = false; });
  }

  reduceSync() {
    const last = this._reduceChain();
    this.renderer.readRenderTargetPixels(last, 0, 0, last.width, last.height, this.redBuffer);
    this._readReduction(this.redBuffer);
    return this.cmax;
  }

  _readReduction(buf) {
    let c = 0, wc = 0, vc = 0, wa = 0;
    for (let k = 0; k < buf.length; k += 4) { c = Math.max(c, buf[k]); wc += buf[k + 1]; vc += buf[k + 2]; wa += buf[k + 3]; }
    const A = this.dx * this.dx;
    this.cmax = c; this.wetCity = wc * A; this.volCity = vc * A; this.wetAll = wa * A;
  }

  readState() { const o = new Float32Array(this.nx * this.ny * 4); this.renderer.readRenderTargetPixels(this.a, 0, 0, this.nx, this.ny, o); return o; }
  readStats() { const o = new Float32Array(this.nx * this.ny * 4); this.renderer.readRenderTargetPixels(this.statsA, 0, 0, this.nx, this.ny, o); return o; }

  writeState(data) {
    const t = dataTex(data, this.nx, this.ny, THREE.RGBAFormat, THREE.FloatType);
    this._copy(t, this.a); t.dispose();
  }

  // ---- snapshots (timeline scrubbing) ----
  _copy(src, dst) {
    if (!this.mCopy) this.mCopy = mat(`${COMMON}\nuniform sampler2D uSrc;\nout vec4 outColor;\nvoid main(){ outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`,
      { uSize: { value: new THREE.Vector2(this.nx, this.ny) }, uSrc: { value: null } });
    this.mCopy.uniforms.uSrc.value = src;
    this._pass(this.mCopy, dst);
  }

  snapshot() {
    const snap = { time: this.time, state: target(this.nx, this.ny, { type: THREE.HalfFloatType }), stats: target(this.nx, this.ny, { type: THREE.HalfFloatType }) };
    this._copy(this.a.texture, snap.state); this._copy(this.statsA.texture, snap.stats);
    return snap;
  }

  restore(snap) {
    this._copy(snap.state.texture, this.a); this._copy(snap.stats.texture, this.statsA);
    this.time = snap.time; this.updateVis();
  }

  readCell(i, j) {
    if (this._cellReading || i < 1 || j < 1 || i >= this.nx || j >= this.ny) return null;
    this._cellReading = true;
    const a = new Float32Array(16), st = new Float32Array(4), r = this.renderer;
    return Promise.all([r.readRenderTargetPixelsAsync(this.a, i - 1, j - 1, 2, 2, a), r.readRenderTargetPixelsAsync(this.statsA, i, j, 1, 1, st)])
      .then(() => {
        this._cellReading = false;
        // a holds (i-1, j-1), (i, j-1), (i-1, j), (i, j)
        const h = a[12], qx = 0.5 * (a[13] + a[9]), qy = 0.5 * (a[14] + a[6]);
        return { h, u: h > 0.01 ? qx / h : 0, v: h > 0.01 ? qy / h : 0, maxDepth: st[0], arrival: st[1], maxSpeed: st[2], maxHazard: st[3] };
      }).catch(() => { this._cellReading = false; return null; });
  }

  // ---- sampling: buildings (one cell each) and points (3 x 3) ----
  _sampler(cells, shader) {
    const n = cells.length, w = 1024, h = Math.max(1, Math.ceil(n / w));
    const data = new Float32Array(w * h).fill(-1); data.set(cells);
    const idx = dataTex(data, w, h, THREE.RedFormat, THREE.FloatType);
    const out = target(w, h);
    const m = mat(shader, { uSize: { value: new THREE.Vector2(this.nx, this.ny) }, uState: { value: null }, uStats: { value: null },
      uBed: { value: this.bedTex }, uPor: { value: this.porTex }, uIdx: { value: idx }, uCount: { value: n }, uWidth: { value: w } });
    return { n, w, h, idx, out, m, buf: new Float32Array(w * h * 4), reading: false };
  }

  setBuildingCells(cells) { this._disposeSampler(this.bS); this.bS = this._sampler(cells, BUILDINGS); }
  setPointCells(cells) { this._disposeSampler(this.pS); this.pS = cells.length ? this._sampler(cells, POINTS) : null; }

  _disposeSampler(s) { if (s) { s.idx.dispose(); s.out.dispose(); s.m.dispose(); } }

  _run(s) {
    s.m.uniforms.uState.value = this.a.texture; s.m.uniforms.uStats.value = this.statsA.texture;
    this._pass(s.m, s.out);
  }

  /** Asynchronous sample of buildings and points; resolves { b, p } buffers, or null if one is in flight. */
  sample() {
    const s = this.bS, q = this.pS;
    if (!s || s.reading || (q && q.reading)) return null;
    this._run(s); if (q) this._run(q);
    s.reading = true; if (q) q.reading = true;
    const r = this.renderer;
    return Promise.all([
      r.readRenderTargetPixelsAsync(s.out, 0, 0, s.w, s.h, s.buf),
      q ? r.readRenderTargetPixelsAsync(q.out, 0, 0, q.w, q.h, q.buf) : Promise.resolve(null),
    ]).then(([b, p]) => { s.reading = false; if (q) q.reading = false; return { b, p }; })
      .catch(e => { s.reading = false; if (q) q.reading = false; throw e; });
  }

  sampleSync() {
    const s = this.bS, q = this.pS, r = this.renderer;
    this._run(s); r.readRenderTargetPixels(s.out, 0, 0, s.w, s.h, s.buf);
    if (q) { this._run(q); r.readRenderTargetPixels(q.out, 0, 0, q.w, q.h, q.buf); }
    return { b: s.buf, p: q ? q.buf : null };
  }

  dispose() {
    [this.a, this.b, this.statsA, this.statsB, this.vis, ...this.redTargets].forEach(t => t?.dispose());
    [this.mMom, this.mCon, this.mStats, this.mVis, this.mRed0, this.mRed, this.mCopy].forEach(m => m?.dispose());
    [this.bedTex, this.porTex, this.bwTex].forEach(t => t.dispose());
    this._disposeSampler(this.bS); this._disposeSampler(this.pS);
  }
}

export { MAX_SOURCES };
