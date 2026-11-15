// The city: 1.08 million NYC building footprints (plus OpenStreetMap context
// across the rivers) streamed in 1.6 km chunks around the camera, an always-on
// skyline layer of every building 40 m and taller, and 650,000 street trees.
//
// Geometry is built in workers (workers/chunk.js). Every building owns one texel
// in two shared textures laid out chunk by chunk: static info (class, height,
// ground, roof colour) and dynamic damage written by the loss model. Facades are
// procedural; flood marks come straight from the solver's peak-depth field.
import * as THREE from 'three';
import { RAMPS_GLSL } from '../ramps.js';

export const TEX_W = 1024;
const Q = 0.25;

// quality presets: load radius (m), tree radius (m), loaded chunk budget, tree detail
export const CITY_QUALITY = {
  high: { radius: 9000, trees: 3200, budget: 170, treeDetail: 1 },
  balanced: { radius: 6500, trees: 2300, budget: 110, treeDetail: 1 },
  performance: { radius: 4200, trees: 1400, budget: 60, treeDetail: 0 },
};

// late October canopy: [summer green, autumn colour, share turned], sRGB
const SPECIES = {
  'London planetree': ['#5d6b3a', '#a08a4a', 0.35], honeylocust: ['#7a8a3a', '#d6b13a', 0.7], 'Callery pear': ['#4f6a34', '#9c3a2a', 0.45],
  'pin oak': ['#4c5e33', '#8a4a26', 0.5], 'Norway maple': ['#56703a', '#d9a53a', 0.55], 'littleleaf linden': ['#5f7a3c', '#c2a640', 0.5],
  cherry: ['#5a6b38', '#c0562e', 0.7], 'Japanese zelkova': ['#55703a', '#c06a2a', 0.6], ginkgo: ['#6d8a3a', '#f0c830', 0.4],
  Sophora: ['#5a7a3a', '#9aa040', 0.25], 'red maple': ['#5a6a38', '#c0302a', 0.75], 'green ash': ['#5a7038', '#c8b040', 0.6],
  'American linden': ['#5a7a3c', '#b8a040', 0.45], 'silver maple': ['#6a7a48', '#c8b058', 0.5], sweetgum: ['#4f6a34', '#a8283a', 0.6],
  Other: ['#556a36', '#b08a3a', 0.45],
};
const srgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(c => Math.pow(c / 255, 2.2)); };

const BUILDING_VERT = /* glsl */`
attribute float aU;
attribute float aTex;
uniform sampler2D uBInfo, uBDmg;
flat varying vec4 vInfo;
flat varying vec3 vRoof;
flat varying vec4 vDmg;
flat varying float vTexId;
flat varying float vRoofFlag;
varying float vFacU;
varying vec3 vWPos;`;

const BUILDING_FRAG_HEAD = /* glsl */`
flat varying vec4 vInfo;
flat varying vec3 vRoof;
flat varying vec4 vDmg;
flat varying float vTexId;
flat varying float vRoofFlag;
varying float vFacU;
varying vec3 vWPos;
uniform sampler2D uStats, uVis, uBed;
uniform vec2 uDomain, uFade;
uniform int uMode;
uniform float uNight, uSelected, uFlood;
uniform vec3 uApron;
float h21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i]) + 0.5) / 16.0;
}
vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
${RAMPS_GLSL}`;

function buildingMaterial(u) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.0, flatShading: true, envMapIntensity: 1.0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${BUILDING_VERT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    int ti = int(aTex + 0.5);
    ivec2 tc = ivec2(ti % ${TEX_W}, ti / ${TEX_W});
    vec4 inf = texelFetch(uBInfo, tc, 0);
    vInfo = vec4(inf.xyz, fract(sin(float(ti) * 12.9898 + 4.1) * 43758.5453));
    float rp = inf.w;
    vRoof = vec3(floor(rp / 65536.0), mod(floor(rp / 256.0), 256.0), mod(rp, 256.0)) / 255.0;
    vDmg = texelFetch(uBDmg, tc, 0);
    vTexId = float(ti);
    vRoofFlag = aU < -0.5 ? 1.0 : 0.0;
    vFacU = aU * length(modelMatrix[0].xyz);
    vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${BUILDING_FRAG_HEAD}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  float camDist = length(vWPos - cameraPosition);
  if (camDist > uFade.x) {
    float k = (camDist - uFade.x) / max(uFade.y - uFade.x, 1.0);
    if (k > bayer4(gl_FragCoord.xy)) discard;
  }
  float cls = vInfo.x, bh = vInfo.y, g0 = vInfo.z, seed = vInfo.w;
  bool roofFace = vRoofFlag > 0.5;
  bool tall = bh > 60.0;
  bool curtain = tall && seed < 0.62 || (cls > 1.5 && cls < 2.5 && bh > 30.0 && seed < 0.4);
  float vh = vWPos.y - g0;
  vec3 albedo;
  float glass = 0.0, lit = 0.0, metal = 0.0;
  float s1 = fract(seed * 7.13), s2 = fract(seed * 13.7), s3 = fract(seed * 29.3);
  if (roofFace) {
    vec3 rc = toLin(vRoof);
    float l = dot(rc, vec3(0.3, 0.59, 0.11));
    albedo = mix(rc, vec3(l), 0.35) * (0.9 + 0.12 * vnoise(vWPos.xz * 0.35) + 0.06 * vnoise(vWPos.xz * 1.7));
    if (tall) albedo = mix(albedo, vec3(0.16, 0.165, 0.17), 0.3);
  } else {
    // ---- palette by building class (sRGB, converted)
    vec3 pal;
    if (curtain) {
      pal = s1 < 0.3 ? vec3(0.40, 0.50, 0.56) : s1 < 0.55 ? vec3(0.46, 0.50, 0.54) : s1 < 0.75 ? vec3(0.52, 0.47, 0.42) : vec3(0.60, 0.64, 0.68);
    } else if (cls < 0.5) {
      pal = s1 < 0.24 ? vec3(0.50, 0.30, 0.24) : s1 < 0.42 ? vec3(0.60, 0.33, 0.25) : s1 < 0.55 ? vec3(0.44, 0.31, 0.26)
          : s1 < 0.68 ? vec3(0.70, 0.62, 0.50) : s1 < 0.84 ? vec3(0.78, 0.76, 0.70) : vec3(0.62, 0.64, 0.64);
    } else if (cls < 1.5) {
      pal = s1 < 0.35 ? vec3(0.56, 0.36, 0.28) : s1 < 0.62 ? vec3(0.70, 0.62, 0.50) : s1 < 0.82 ? vec3(0.78, 0.74, 0.66) : vec3(0.60, 0.58, 0.55);
    } else if (cls < 2.5) {
      pal = s1 < 0.45 ? vec3(0.74, 0.70, 0.62) : s1 < 0.75 ? vec3(0.62, 0.60, 0.57) : vec3(0.56, 0.42, 0.34);
    } else if (cls < 3.5) {
      pal = s1 < 0.5 ? vec3(0.58, 0.58, 0.56) : s1 < 0.8 ? vec3(0.50, 0.53, 0.56) : vec3(0.62, 0.52, 0.42);
    } else if (cls < 4.5) {
      pal = s1 < 0.5 ? vec3(0.76, 0.71, 0.62) : vec3(0.58, 0.36, 0.28);
    } else pal = vec3(0.56, 0.56, 0.54);
    albedo = toLin(pal) * (0.88 + 0.24 * s2);
    // ---- facade grid
    float floorH = curtain ? 3.9 : cls < 1.5 ? 3.0 + 0.2 * s3 : cls < 2.5 ? 3.9 : cls < 3.5 ? 5.0 : cls < 4.5 ? 4.2 : 2.8;
    float colW = curtain ? 1.5 : tall ? 2.0 : cls < 1.5 ? 2.5 + 0.4 * s2 : cls < 2.5 ? 2.6 : cls < 3.5 ? 4.0 : 3.0;
    float base = (cls > 1.5 && cls < 2.5) || (cls > 0.5 && cls < 1.5 && s3 > 0.55) ? 4.6 : 0.0;   // shopfront storey
    float floors = max(1.0, floor((bh - base) / floorH));
    float fy = (vh - base) / floorH, fx = vFacU / colW;
    float fl = floor(fy), cx = floor(fx);
    float px = fract(fx), py = fract(fy);
    // fade the grid to its average once a window is smaller than a pixel or two
    float aa = clamp(1.6 - 8.0 * max(fwidth(fx), fwidth(fy)), 0.0, 1.0);
    float win = 0.0, cover = 0.0;
    vec3 glassCol = curtain ? toLin(pal * 0.78) : vec3(0.035, 0.04, 0.045);
    if (cls < 4.5 && vh > base && fl < floors) {
      if (curtain) {
        float mull = step(0.06, px) * step(px, 0.94) * step(0.10, py) * step(py, 0.97);
        win = mull; cover = 0.8;
      } else {
        float ww = cls > 2.5 && cls < 3.5 ? 0.7 : tall ? 0.62 : 0.46, wh = cls > 2.5 && cls < 3.5 ? 0.45 : 0.56;
        win = step(0.5 - ww * 0.5, px) * step(px, 0.5 + ww * 0.5) * step(0.28, py) * step(py, 0.28 + wh);
        cover = ww * wh;
      }
    }
    if (base > 0.0 && vh > 0.3 && vh < base) {
      float sx = fract(vFacU / 5.5);
      win = step(0.06, sx) * step(sx, 0.94) * step(0.12, vh / base) * step(vh / base, 0.86);
      cover = 0.7; fl = -1.0;
    }
    float w = mix(cover, win, aa);
    albedo = mix(albedo, glassCol, w * (curtain ? 1.0 : 0.88));
    glass = w;
    metal = curtain ? 0.45 * w : 0.18 * w;
    // cornice band on older masonry, darker spandrels on towers
    if (!curtain && cls < 2.5 && bh < 45.0) albedo *= 1.0 - 0.25 * smoothstep(bh - 0.9, bh - 0.4, vh) * (1.0 - smoothstep(bh - 0.25, bh, vh));
    // weathering and occlusion at the foot of the wall
    albedo *= 0.94 + 0.06 * h21(floor(vec2(vFacU * 3.0, vh * 9.0)));
    albedo *= mix(0.55, 1.0, smoothstep(-0.5, 4.0, vh));
    // night: each building has its own share of lit windows; whole floors switch together in offices
    float occ = 0.12 + 0.38 * fract(seed * 53.7);
    float id = h21(vec2(cx + seed * 91.0, fl + seed * 37.0));
    float floorOn = h21(vec2(fl * 1.7 + seed * 11.0, seed * 5.3));
    float on = curtain ? step(1.0 - occ, floorOn) * step(0.25, id) : step(1.0 - occ, id);
    // far away, a coarse pattern of lit floors keeps the speckle instead of a flat glow
    float coarse = step(1.0 - occ, h21(vec2(floor(fy / 2.0) + seed * 7.0, floor(fx / 4.0) + seed * 3.0)));
    lit = mix(cover * coarse * 0.55, win * on * (0.55 + 0.9 * fract(id * 17.0)), aa) * step(vh, bh);
    if (base > 0.0 && vh < base) lit = win * 0.8;
    // spandrel bands and a slight lift toward the top, so towers read at a distance
    if (curtain) {
      float band = 1.0 - smoothstep(0.0, 0.08, abs(fract(vh / (floorH * 4.0)) - 0.5) - 0.42);
      albedo *= 1.0 - 0.18 * band * (1.0 - aa * 0.5);
      albedo *= 0.85 + 0.3 * smoothstep(0.0, bh, vh);
    }
  }
  // ---- flood marks: peak water surface at this spot, from the solver
  vec2 fuv = vec2((vWPos.x + 0.5 * uDomain.x) / uDomain.x, (0.5 * uDomain.y - vWPos.z) / uDomain.y);
  float hm = uFlood > 0.5 ? texture2D(uStats, fuv).x : 0.0;
  float wseMax = hm > 0.03 ? texture2D(uBed, fuv).x + hm : -99.0;
  if (!roofFace && wseMax > g0 + 0.02) {
    float below = step(vWPos.y, wseMax);
    albedo = mix(albedo, albedo * vec3(0.55, 0.50, 0.42), 0.8 * below);
    float line = 1.0 - smoothstep(0.0, 0.06, abs(vWPos.y - wseMax));
    albedo = mix(albedo, vec3(0.08, 0.07, 0.05), 0.55 * line);
    glass *= 1.0 - 0.6 * below;
  }
  float powerOut = step(g0 + 0.35, wseMax);
  // ---- analysis colouring: damage ratio per building (from the loss model)
  if (uMode == 6) {
    float dr = vDmg.r * 255.0 > 0.5 ? vDmg.r : -1.0;
    vec3 dc = vDmg.a > 0.5 ? (dr < 0.0 ? vec3(0.42, 0.44, 0.45) : rampDamage(dr)) : vec3(0.20, 0.21, 0.22);
    if (vDmg.g > 0.5 && dr < 0.0) dc = vec3(0.62, 0.66, 0.72);
    albedo = dc * (roofFace ? 1.0 : 0.8);
    glass = 0.0; metal = 0.0; lit = 0.0;
  }
  bool selected = abs(vTexId - uSelected) < 0.5;
  if (selected) albedo = mix(albedo, vec3(0.95, 0.55, 0.16), 0.5);
  diffuseColor.rgb = albedo;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, curtain ? 0.10 : 0.18, glass);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  metalnessFactor = metal;`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
  {
    // the model dissolves into the haze over its last few kilometres
    vec2 eu = fuv;
    float ed = min(min(eu.x, 1.0 - eu.x), min(eu.y, 1.0 - eu.y));
    float ef = 1.0 - smoothstep(0.0, 0.075, ed);
    float ffe = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(uApron, fogColor, ffe), ef);
  }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  vec3 warm = cls > 1.5 && cls < 2.5 ? vec3(0.92, 0.82, 0.62) : vec3(1.0, 0.64, 0.32);
  totalEmissiveRadiance += warm * lit * uNight * (1.0 - powerOut) * 1.5;
  if (selected) totalEmissiveRadiance += vec3(0.30, 0.15, 0.03);`);
  };
  mat.customProgramCacheKey = () => 'nyc-building-v1';
  return mat;
}

const PICK_VERT = /* glsl */`
attribute float aTex;
flat varying float vT;
void main() { vT = aTex + 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PICK_FRAG = /* glsl */`
flat varying float vT;
void main() { gl_FragColor = vec4(mod(vT, 256.0), mod(floor(vT / 256.0), 256.0), floor(vT / 65536.0), 255.0) / 255.0; }`;

function tankGeometry() {
  // a wooden tank on a steel stand with a conical cap, 1 m units scaled per roof
  const parts = [];
  const add = (g, col) => { g.computeVertexNormals(); parts.push([g.index ? g.toNonIndexed() : g, col]); };
  const barrel = new THREE.CylinderGeometry(2.1, 2.2, 3.8, 12, 1, false); barrel.translate(0, 3.3 + 1.9, 0); add(barrel, [0.26, 0.215, 0.18]);
  const cap = new THREE.ConeGeometry(2.3, 1.3, 12); cap.translate(0, 3.3 + 3.8 + 0.65, 0); add(cap, [0.16, 0.155, 0.15]);
  for (const [x, z] of [[1.4, 1.4], [-1.4, 1.4], [1.4, -1.4], [-1.4, -1.4]]) { const leg = new THREE.BoxGeometry(0.22, 3.3, 0.22); leg.translate(x, 1.65, z); add(leg, [0.18, 0.18, 0.19]); }
  const pos = [], nor = [], col = [];
  for (const [g, c] of parts) {
    const P = g.attributes.position, N = g.attributes.normal;
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); col.push(...c); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

function treeGeometry(detail) {
  // a unit tree, 1 m tall: trunk to 0.42, a lumpy crown centred at 0.64
  const crown = new THREE.IcosahedronGeometry(0.34, detail);
  const p = crown.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + 0.16 * Math.sin(x * 17.1 + z * 9.3) * Math.cos(y * 13.7 + x * 5.1);
    p.setXYZ(i, x * n, y * n * 1.12 + 0.64, z * n);
  }
  crown.computeVertexNormals();
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.5, 5, 1, true);
  trunk.translate(0, 0.25, 0);
  const merge = (geos) => {
    const out = new THREE.BufferGeometry();
    const pos = [], nor = [], col = [], idx = [];
    let base = 0;
    for (const [g, c] of geos) {
      const gi = g;
      const P = gi.attributes.position, N = gi.attributes.normal;
      for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); col.push(...c); }
      if (gi.index) for (let i = 0; i < gi.index.count; i++) idx.push(gi.index.getX(i) + base);
      else for (let i = 0; i < P.count; i++) idx.push(i + base);
      base += P.count;
    }
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.setIndex(idx);
    return out;
  };
  return merge([[crown, [1, 1, 1]], [trunk, [0.16, 0.12, 0.09]]]);
}

export class City {
  /**
   * @param {object} o { data, shared, terrain, renderer, base (URL of web/data/), quality }
   */
  constructor(o) {
    const { data, shared, terrain, renderer } = o;
    const m = data.meta, c = data.city;
    this.W = m.grid.width_m; this.H = m.grid.height_m;
    this.CH = c.chunk;
    this.nNYC = c.nyc_buildings;
    this.terrain = terrain; this.renderer = renderer; this.shared = shared;
    this.base = o.base;
    this.group = new THREE.Group(); this.group.name = 'city';
    this.pickScene = new THREE.Scene();
    this.speciesNames = c.tree_species;

    // ---- texel layout: chunks in index order, then the skyline layer
    let row = 0;
    this.chunks = c.chunks.map(ch => {
      const rows = Math.ceil(ch.n / TEX_W);
      const rec = { ...ch, nTrees: ch.trees, key: `${ch.i}_${ch.j}`, row0: row, rows, state: 0, mesh: null, pick: null, treeMesh: null, treeData: null,
        ids: null, cx: (ch.i + 0.5) * this.CH, cy: (ch.j + 0.5) * this.CH, d: 1e9, used: 0 };
      row += rows;
      return rec;
    });
    const tv = new DataView(data.tall.buffer, data.tall.byteOffset, data.tall.byteLength);
    this.nTall = tv.getUint32(8, true);
    this.tallRow0 = row; row += Math.ceil(this.nTall / TEX_W);
    this.rows = row;
    this.info = new Float32Array(TEX_W * row * 4);
    this.infoTex = new THREE.DataTexture(this.info, TEX_W, row, THREE.RGBAFormat, THREE.FloatType);
    this.infoTex.needsUpdate = true;
    this.dmg = new Uint8Array(TEX_W * row * 4);
    this.dmgTex = new THREE.DataTexture(this.dmg, TEX_W, row, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.dmgTex.needsUpdate = true;
    this.texId = new Int32Array(TEX_W * row).fill(-1);

    // ---- materials
    const common = {
      uBInfo: { value: this.infoTex }, uBDmg: { value: this.dmgTex }, uStats: shared.uStats, uVis: shared.uVis, uBed: shared.uBed,
      uDomain: shared.uDomain, uMode: shared.uMode, uNight: shared.uNight, uSelected: shared.uSelected, uFlood: shared.uFlood, uApron: shared.uApron,
    };
    this.uChunk = { ...common, uFade: { value: new THREE.Vector2(1e9, 1e9) } };
    this.uTall = { ...common, uFade: { value: new THREE.Vector2(1e9, 1e9) } };
    this.matChunk = buildingMaterial(this.uChunk);
    this.matTall = buildingMaterial(this.uTall);
    this.pickMat = new THREE.ShaderMaterial({ vertexShader: PICK_VERT, fragmentShader: PICK_FRAG });

    // ---- trees
    this.treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.6 });
    this.treeGeos = [treeGeometry(0), treeGeometry(1)];
    this.tankGeo = tankGeometry();
    this.tankMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
    this.treeColours = c.tree_species.map(name => {
      const s = SPECIES[name] || SPECIES.Other;
      return { green: srgb(s[0]), autumn: srgb(s[1]), turned: s[2] };
    });

    // ---- workers
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = [];
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('../workers/chunk.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onResult(w, e.data);
      w.onerror = (e) => { console.warn('chunk worker', e.message); w.busy = null; };
      w.busy = null;
      this.workers.push(w);
    }
    this.queue = [];
    this.loaded = 0;
    this.stats = { chunks: 0, triangles: 0, trees: 0, pending: 0 };
    this.setQuality(o.quality || 'high');
    this._lastPlan = -1;
    this._clock = 0;
    this.onChunk = null;              // callback(chunk) when a chunk is ready (damage fill, labels)
    this.damage = null;               // { dr: Float32Array, flags: Uint8Array } per NYC building

    // the skyline goes first, straight from the bytes already loaded
    const raw = data.tall.slice().buffer;
    this._post({ id: 'tall', raw, texBase: this.tallRow0 * TEX_W, centre: [this.W / 2, this.H / 2] }, [raw]);
  }

  setQuality(name) {
    this.q = CITY_QUALITY[name] || CITY_QUALITY.high;
    this.uChunk.uFade.value.set(this.q.radius * 0.82, this.q.radius);
    this._lastPlan = -1;
  }

  // ---------------------------------------------------------------- workers
  _post(job, transfer = []) {
    const w = this.workers.find(x => x.busy === null);
    if (!w) { this.queue.push([job, transfer]); return; }
    w.busy = job.id;
    w.postMessage(job, transfer);
  }

  _drain() {
    while (this.queue.length) {
      const w = this.workers.find(x => x.busy === null);
      if (!w) return;
      const [job, transfer] = this.queue.shift();
      w.busy = job.id;
      w.postMessage(job, transfer);
    }
  }

  _onResult(w, msg) {
    w.busy = null;
    if (msg.id === 'tall') {
      if (msg.ok) this._addTall(msg.out); else console.warn('skyline failed', msg.error);
    } else {
      const ch = this.chunks[msg.id];
      if (msg.ok && ch && ch.state === 1) this._addChunk(ch, msg.out);
      else if (ch) { if (!msg.ok) console.warn('chunk', ch.key, msg.error); ch.state = msg.ok ? 0 : 3; }
    }
    this._drain();
  }

  // ---------------------------------------------------------------- geometry
  _geometry(out, abs) {
    const g = new THREE.BufferGeometry();
    const ib = new THREE.InterleavedBuffer(out.pos, 4);
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0, false));
    g.setAttribute('aU', new THREE.InterleavedBufferAttribute(ib, 1, 3, false));
    g.setAttribute('normal', new THREE.BufferAttribute(out.nrm, 4, true));
    g.setAttribute('aTex', new THREE.BufferAttribute(out.tex, 1));
    g.setIndex(new THREE.BufferAttribute(out.index, 1));
    const [x0, y0, x1, y1, zt] = out.bounds;
    if (abs) {
      g.computeBoundingSphere();
    } else {
      // in the mesh's own (quantised) units
      const cx = (x0 + x1) / 2 / Q, cy = (y0 + y1) / 2 / Q, r = Math.hypot(x1 - x0, y1 - y0, zt) / 2 / Q + 40;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, zt / 2 / Q, -cy), r);
    }
    return g;
  }

  _writeInfo(row0, info, ids) {
    const n = ids.length;
    this.info.set(info, row0 * TEX_W * 4);
    this.texId.set(ids, row0 * TEX_W);
    const rows = Math.ceil(n / TEX_W);
    for (let r = 0; r < rows; r++) this.infoTex.addUpdateRange((row0 + r) * TEX_W * 4, TEX_W * 4);
    this.infoTex.needsUpdate = true;
    this._fillDamage(row0, ids);
  }

  _addTall(out) {
    this._writeInfo(this.tallRow0, out.info, out.ids);
    const g = this._geometry(out, true);
    const mesh = new THREE.Mesh(g, this.matTall);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'skyline';
    this.group.add(mesh);
    this.tall = { mesh, ids: out.ids, row0: this.tallRow0 };
    const pick = new THREE.Mesh(g, this.pickMat);
    this.pickScene.add(pick);
    this.stats.triangles += out.index.length / 3;
    if (out.tanks?.length) { this.tallTanks = this._tankMesh(out.tanks, 0, 0); this.group.add(this.tallTanks); }
  }

  _addChunk(ch, out) {
    ch.state = 2;
    ch.ids = out.ids;
    this._writeInfo(ch.row0, out.info, out.ids);
    if (out.nVert > 0) {
      const g = this._geometry(out, false);
      const mesh = new THREE.Mesh(g, this.matChunk);
      mesh.position.set(out.ox - this.W / 2, 0, this.H / 2 - out.oy);
      mesh.scale.set(Q, Q * 0.02, Q);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.rise = 0;
      this.group.add(mesh);
      ch.mesh = mesh;
      const pick = new THREE.Mesh(g, this.pickMat);
      pick.position.copy(mesh.position); pick.scale.set(Q, Q, Q);
      pick.updateMatrixWorld(true);
      pick.matrixAutoUpdate = false;
      this.pickScene.add(pick);
      ch.pick = pick;
      ch.tris = out.index.length / 3;
      this.stats.triangles += ch.tris;
    }
    ch.treeData = out.trees;
    ch.tankData = out.tanks;
    ch.ox = out.ox; ch.oy = out.oy;
    this.stats.chunks++;
    this.onChunk?.(ch);
  }

  _unload(ch) {
    if (ch.mesh) {
      this.group.remove(ch.mesh); ch.mesh.geometry.dispose();
      this.pickScene.remove(ch.pick);
      this.stats.triangles -= ch.tris || 0;
    }
    this._dropTrees(ch);
    this._dropTanks(ch);
    ch.mesh = null; ch.pick = null; ch.treeData = null; ch.tankData = null; ch.ids = null;
    ch.state = 0;
    this.stats.chunks--;
  }

  // ---------------------------------------------------------------- trees
  _makeTrees(ch) {
    const T = ch.treeData;
    if (!T || !T.length) return;
    const n = T.length / 4;
    const mesh = new THREE.InstancedMesh(this.treeGeos[this.q.treeDetail], this.treeMat, n);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < n; k++) {
      const lx = ch.ox + T[4 * k], ly = ch.oy - T[4 * k + 1];
      const dbh = T[4 * k + 2], sp = T[4 * k + 3];
      const r = Math.sin(k * 12.9898 + ch.i * 78.233 + ch.j * 37.719) * 43758.5453, rnd = r - Math.floor(r);
      const hgt = Math.min(24, 4.5 + 0.42 * dbh) * (0.9 + 0.2 * rnd);
      const z = this.terrain.heightAt(lx, ly);
      p.set(lx - this.W / 2, z - 0.2, this.H / 2 - ly);
      q.setFromAxisAngle(up, rnd * Math.PI * 2);
      const wide = 0.95 + 0.3 * ((rnd * 7.31) % 1);
      s.set(hgt * wide, hgt, hgt * wide);
      mtx.compose(p, q, s);
      mesh.setMatrixAt(k, mtx);
      const tc = this.treeColours[sp] || this.treeColours[this.treeColours.length - 1];
      const t = ((rnd * 3.77) % 1) < tc.turned ? 0.55 + 0.45 * ((rnd * 5.13) % 1) : 0.15 * ((rnd * 9.7) % 1);
      const v = 0.82 + 0.3 * ((rnd * 11.3) % 1);
      col.setRGB((tc.green[0] + (tc.autumn[0] - tc.green[0]) * t) * v, (tc.green[1] + (tc.autumn[1] - tc.green[1]) * t) * v,
        (tc.green[2] + (tc.autumn[2] - tc.green[2]) * t) * v);
      mesh.setColorAt(k, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.layers.set(2);
    mesh.name = 'trees';
    this.group.add(mesh);
    ch.treeMesh = mesh;
    this.stats.trees += n;
  }

  /** Instanced water tanks; T = [x, z, roof, scale] per tank, relative to (ox, oz) in scene axes. */
  _tankMesh(T, ox, oz) {
    const n = T.length / 4;
    const mesh = new THREE.InstancedMesh(this.tankGeo, this.tankMat, n);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < n; k++) {
      p.set(ox + T[4 * k], T[4 * k + 2] - 0.1, oz + T[4 * k + 1]);
      q.setFromAxisAngle(up, k * 2.39996);
      s.setScalar(T[4 * k + 3]);
      mtx.compose(p, q, s);
      mesh.setMatrixAt(k, mtx);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'tanks';
    return mesh;
  }

  _makeTanks(ch) {
    if (!ch.tankData || !ch.tankData.length || ch.tankMesh) return;
    ch.tankMesh = this._tankMesh(ch.tankData, ch.ox - this.W / 2, this.H / 2 - ch.oy);
    this.group.add(ch.tankMesh);
  }

  _dropTanks(ch) {
    if (!ch.tankMesh) return;
    this.group.remove(ch.tankMesh); ch.tankMesh.dispose(); ch.tankMesh = null;
  }

  _dropTrees(ch) {
    if (!ch.treeMesh) return;
    this.group.remove(ch.treeMesh); ch.treeMesh.dispose();
    this.stats.trees -= ch.treeMesh.count;
    ch.treeMesh = null;
  }

  // ---------------------------------------------------------------- streaming
  /** Call every frame with the camera; t = wall-clock seconds. */
  update(camera, t) {
    const dtw = this._clock ? Math.min(0.1, t - this._clock) : 0;
    this._clock = t;
    // rising animation for freshly loaded chunks
    for (const ch of this.chunks) {
      const m = ch.mesh;
      if (m && m.userData.rise < 1) {
        m.userData.rise = Math.min(1, m.userData.rise + dtw / 0.9);
        const e = 1 - Math.pow(1 - m.userData.rise, 3);
        m.scale.y = Q * Math.max(0.02, e);
      }
    }
    if (t - this._lastPlan < 0.25) return;
    this._lastPlan = t;
    const lx = camera.position.x + this.W / 2, ly = this.H / 2 - camera.position.z, cz = camera.position.y;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const box = new THREE.Box3();
    const R = this.q.radius, RT = this.q.trees, H2 = this.CH / 2;
    const want = [];
    for (let k = 0; k < this.chunks.length; k++) {
      const ch = this.chunks[k];
      const dx = Math.max(Math.abs(lx - ch.cx) - H2, 0), dy = Math.max(Math.abs(ly - ch.cy) - H2, 0);
      const dz = Math.max(cz - Math.max(ch.hmax, 10), 0);
      ch.d = Math.hypot(dx, dy, dz);
      box.min.set(ch.cx - H2 - this.W / 2, -10, this.H / 2 - ch.cy - H2);
      box.max.set(ch.cx + H2 - this.W / 2, Math.max(ch.hmax, 20) + 10, this.H / 2 - ch.cy + H2);
      ch.vis = frustum.intersectsBox(box);
      if (ch.state === 0 && ch.d < R && (ch.n > 0 || ch.nTrees > 0)) want.push(ch);
      if (ch.state === 2) {
        if (ch.d > R * 1.4) { this._unload(ch); continue; }
        if (ch.mesh) ch.mesh.visible = ch.d < R;
        if (!ch.treeMesh && ch.treeData && ch.d < RT && ch.vis && this.showTrees !== false) this._makeTrees(ch);
        else if (ch.treeMesh && ch.d > RT * 1.3) this._dropTrees(ch);
        if (ch.treeMesh) ch.treeMesh.visible = ch.d < RT && this.showTrees !== false;
        if (!ch.tankMesh && ch.tankData && ch.d < RT && ch.vis) this._makeTanks(ch);
        else if (ch.tankMesh && ch.d > RT * 1.3) this._dropTanks(ch);
      }
    }
    // nearest first, chunks in view before those behind the camera
    want.sort((a, b) => (a.d * (a.vis ? 1 : 3)) - (b.d * (b.vis ? 1 : 3)));
    const free = this.workers.length * 2 - this.workers.filter(w => w.busy !== null).length - this.queue.length;
    for (let k = 0; k < Math.min(free, want.length); k++) {
      const ch = want[k];
      ch.state = 1;
      this._post({ id: this.chunks.indexOf(ch), url: new URL(`chunks/c_${ch.i}_${ch.j}.bin.gz`, this.base).href, texBase: ch.row0 * TEX_W });
    }
    // keep within the memory budget
    const loaded = this.chunks.filter(ch => ch.state === 2);
    if (loaded.length > this.q.budget) {
      loaded.sort((a, b) => b.d - a.d);
      for (let k = 0; k < loaded.length - this.q.budget; k++) this._unload(loaded[k]);
    }
    this.stats.pending = this.queue.length + this.workers.filter(w => w.busy !== null).length;
  }

  /** Fraction of the wanted chunks around the camera that are on screen (for a loading hint). */
  readiness() {
    const near = this.chunks.filter(ch => ch.d < this.q.radius * 0.6 && (ch.n > 0));
    if (!near.length) return 1;
    return near.filter(ch => ch.state === 2).length / near.length;
  }

  // ---------------------------------------------------------------- damage
  /** dr: damage ratio per NYC building (-1 no exposure), flags: bit 0 wet, bit 1 above first floor. */
  setDamage(dr, flags) {
    this.damage = { dr, flags };
    for (const ch of this.chunks) if (ch.state === 2 && ch.ids) this._fillDamage(ch.row0, ch.ids);
    if (this.tall) this._fillDamage(this.tall.row0, this.tall.ids);
  }

  _fillDamage(row0, ids) {
    const D = this.damage, o0 = row0 * TEX_W * 4, n = ids.length, d = this.dmg, N = this.nNYC;
    for (let k = 0; k < n; k++) {
      const id = ids[k], o = o0 + 4 * k;
      if (id >= N) { d[o] = 0; d[o + 1] = 0; d[o + 3] = 0; continue; }
      const dr = D ? D.dr[id] : -1, fl = D ? D.flags[id] : 0;
      d[o] = dr > 0 ? Math.max(1, Math.round(Math.min(1, dr) * 255)) : 0;
      d[o + 1] = fl & 1 ? 255 : 0;
      d[o + 2] = fl & 2 ? 255 : 0;
      d[o + 3] = 255;                                         // a NYC building (context buildings stay 0)
    }
    const rows = Math.ceil(n / TEX_W);
    for (let r = 0; r < rows; r++) this.dmgTex.addUpdateRange((row0 + r) * TEX_W * 4, TEX_W * 4);
    this.dmgTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- picking
  /** Building under a canvas pixel: { id (global), texel } or null. */
  pick(camera, cx, cy, w, h) {
    const r = this.renderer;
    if (!this._pickRT) { this._pickRT = new THREE.WebGLRenderTarget(1, 1); this._pickBuf = new Uint8Array(4); }
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    camera.setViewOffset(w, h, cx, cy, 1, 1);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this._pickRT); r.clear(true, true, false);
    r.render(this.pickScene, camera);
    camera.clearViewOffset();
    r.setClearColor(cc, ca);
    r.readRenderTargetPixels(this._pickRT, 0, 0, 1, 1, this._pickBuf);
    r.setRenderTarget(null);
    const b = this._pickBuf, v = b[0] + b[1] * 256 + b[2] * 65536 - 1;
    if (v < 0) return null;
    return { texel: v, id: this.texId[v] };
  }

  /** Static info of a building by texel: { cls, h, ground }. */
  infoAt(texel) {
    const o = texel * 4;
    return { cls: this.info[o], h: this.info[o + 1], ground: this.info[o + 2] };
  }

  dispose() {
    this.workers.forEach(w => w.terminate());
    for (const ch of this.chunks) if (ch.state === 2) this._unload(ch);
    this.infoTex.dispose(); this.dmgTex.dispose();
  }
}
