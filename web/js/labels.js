// Labels drawn as HTML over the canvas: boroughs at city scale, neighbourhoods and
// waterways at district scale, landmarks, the four tide gauges with their live
// level, and high-water marks and subway stations close up. Sizes are measured
// once and cached, so placement each frame does not force a layout.
import * as THREE from 'three';

const WATERS = [
  ['Upper New York Bay', 18288, 21775], ['Lower New York Bay', 19898, 5917], ['Hudson River', 22294, 33699], ['East River', 25460, 30071],
  ['Harlem River', 28456, 40544], ['Jamaica Bay', 36458, 15776], ['Long Island Sound', 43971, 40639], ['Raritan Bay', 8073, 2245],
  ['Arthur Kill', 3512, 10196], ['Kill Van Kull', 12736, 19053], ['Newark Bay', 11005, 23032], ['Flushing Bay', 34619, 33516],
  ['Atlantic Ocean', 32583, 7732], ['Gravesend Bay', 21339, 13482], ['The Narrows', 18869, 14898],
];

export class Labels {
  constructor(host, viewer, data, terrain) {
    this.host = host; this.viewer = viewer;
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.W = W; this.H = H;
    const v3 = (x, y, z) => new THREE.Vector3(x - W / 2, z, H / 2 - y);
    const make = (cls, text, pos, o = {}) => {
      const e = document.createElement('div');
      e.className = `lbl ${cls}`;
      e.textContent = text;
      e.style.display = 'none';
      host.appendChild(e);
      return { e, cls, pos, w: 0, h: 0, shown: false, ...o };
    };
    const ev = data.events;
    this.items = [];
    for (const b of ev.labels.boroughs) this.items.push(make('boro', b.name, v3(b.x, b.y, 60), { min: 7000, max: 1e9, rank: 0 }));
    for (const w of WATERS) this.items.push(make('water', w[0], v3(w[1], w[2], 1), { min: 2500, max: 60000, rank: 1 }));
    for (const l of ev.labels.landmarks) this.items.push(make('landmark', l.name, v3(l.x, l.y, terrain.heightAt(l.x, l.y) + 30), { min: 0, max: 16000, rank: 2 }));
    for (const n of data.city.ntas) {
      if (/park-cemetery|cemetery|airport|^park/i.test(n.name)) continue;
      this.items.push(make('nta', n.name.replace(/\s*\(.*?\)\s*/g, ''), v3(n.x, n.y, terrain.heightAt(n.x, n.y) + 40), { min: 900, max: 7500, rank: 3 }));
    }
    this.gauges = ev.gauges.map(g => make('gauge', g.name, v3(g.x, g.y, 10), { min: 0, max: 1e9, rank: -1, always: true, name: g.name }));
    this.items.push(...this.gauges);
    this.hwm = ev.hwm.map(h => make('hwm', '', v3(h.x, h.y, h.elev_m), { min: 0, max: 2600, rank: -2, h }));
    this.items.push(...this.hwm);
    this.stations = ev.subway.map(s => make('station', s.name, v3(s.x, s.y, terrain.heightAt(s.x, s.y) + 8), { min: 0, max: 1800, rank: 4, st: s }));
    this.items.push(...this.stations);
    this.items.sort((a, b) => a.rank - b.rank);
    this.show = { places: true, hwm: true, subway: true };
    this.setHwmValues(null);
  }

  _text(it, html) { it.e.innerHTML = html; it.w = 0; }

  setHwmValues(sim) {
    this.hwm.forEach((it, k) => {
      const v = sim?.[k];
      this._text(it, `<b>${it.h.elev_m.toFixed(2)} m</b> observed${v != null ? ` <span class="sim">· ${v.toFixed(2)} model</span>` : ''}`);
      it.e.title = `USGS high-water mark ${it.h.id}, ${it.h.site} (${it.h.quality})`;
    });
  }

  setGaugeLevels(levels) {
    if (!levels) return;
    const key = levels.map(v => v.toFixed(2)).join('|');
    if (key === this._gk) return;
    this._gk = key;
    this.gauges.forEach((it, k) => this._text(it, `${it.name} <b>${levels[k].toFixed(2)} m</b>`));
  }

  setStations(states) {
    this.stations.forEach((it, k) => { it.e.classList.toggle('wet', (states?.[k]?.max ?? 0) > 0.15); });
  }

  /** markers: Markers instance (for live anchor heights). */
  update(markers) {
    const v = this.viewer, cam = v.camera, cw = v.canvas.clientWidth, ch = v.canvas.clientHeight;
    const camH = cam.position.y, dist = cam.position.distanceTo(v.controls.target);
    if (markers) {
      this.hwm.forEach((it, k) => { it.pos.y = markers.hwmWorld[k].y; });
      this.gauges.forEach((it, k) => { it.pos.y = markers.gaugeWorld[k].y; });
    }
    const placed = [];
    const overlaps = (x, y, w, h) => {
      for (const q of placed) if (x < q[0] + q[2] && x + w > q[0] && y < q[1] + q[3] && y + h > q[1]) return true;
      return false;
    };
    for (const it of this.items) {
      let on = true;
      const cls = it.cls;
      if (cls === 'hwm' && !this.show.hwm) on = false;
      else if (cls === 'station' && !this.show.subway) on = false;
      else if ((cls === 'boro' || cls === 'nta' || cls === 'landmark' || cls === 'water') && !this.show.places) on = false;
      const scale = cls === 'boro' || cls === 'water' || cls === 'nta' ? Math.max(dist, camH) : cam.position.distanceTo(it.pos);
      if (on && (scale < it.min || scale > it.max)) on = false;
      let s = null;
      if (on) {
        s = v.project(it.pos);
        if (!s || s.x < -60 || s.y < -30 || s.x > cw + 60 || s.y > ch + 30) on = false;
      }
      if (on) {
        if (!it.shown) { it.e.style.display = ''; it.shown = true; }
        if (!it.w) { it.w = it.e.offsetWidth || 80; it.h = it.e.offsetHeight || 16; }
        const x = s.x - it.w / 2, y = s.y - it.h;
        if (!it.always && overlaps(x - 4, y - 2, it.w + 8, it.h + 4)) on = false;
        else {
          placed.push([x - 4, y - 2, it.w + 8, it.h + 4]);
          it.e.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        }
      }
      if (!on && it.shown) { it.e.style.display = 'none'; it.shown = false; }
    }
  }
}
