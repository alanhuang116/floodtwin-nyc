// Event definitions: water level at the four boundary gauges (m NAVD88) and
// rainfall (mm/h) as functions of simulation time t (s since the scenario start).
// Gauge order: The Battery, Kings Point, Rockaway Inlet, Jamaica Bay at Inwood.

const HOUR = 3600;

export const PRESETS = [
  { id: 'sandy', name: 'Hurricane Sandy, 2012', tag: 'Replay',
    note: '29 to 30 October 2012. Observed water levels at four gauges around the city; The Battery peaked at 3.44 m NAVD88 at 21:24 EDT.',
    p: { mode: 'replay', slr: 0, rain: 0, rainDur: 1, rainStart: 0, drainage: 44, infiltration: 10 } },
  { id: 'sandy-2050s', name: 'Sandy With 2050s Sea Level Rise', tag: 'Climate',
    note: 'The Sandy record raised by 0.5 m, the upper end of the NPCC 2019 middle range for the 2050s.',
    p: { mode: 'replay', slr: 0.5, rain: 0, rainDur: 1, rainStart: 0, drainage: 44, infiltration: 10 } },
  { id: 'sandy-2100s', name: 'Sandy With 2100s Sea Level Rise', tag: 'Climate',
    note: 'The Sandy record raised by 1.0 m, inside the NPCC 2019 middle range for the 2100s (0.56 to 1.27 m).',
    p: { mode: 'replay', slr: 1.0, rain: 0, rainDur: 1, rainStart: 0, drainage: 44, infiltration: 10 } },
  { id: 'noreaster', name: 'Long Nor\'easter Surge', tag: 'Design',
    note: 'A broad surge lasting a day and a half, peaking at 2.4 m NAVD88 at The Battery on a high tide.',
    p: { mode: 'surge', peak: 2.4, duration: 36, timing: 'high', slr: 0, rain: 0, rainDur: 1, rainStart: 0, drainage: 44, infiltration: 10 } },
  { id: 'dep-moderate', name: 'NYC DEP Moderate Stormwater', tag: 'Planning',
    note: '2.13 inches (54 mm) of rain in one hour, the moderate scenario of the NYC Stormwater Flood Maps (about 1 in 20 years at Central Park), on today\'s tides.',
    p: { mode: 'tide', slr: 0, rain: 54, rainDur: 1, rainStart: 0.5, drainage: 44, infiltration: 10 } },
  { id: 'dep-extreme', name: 'NYC DEP Extreme Stormwater', tag: 'Planning',
    note: '3.66 inches (93 mm) of rain in one hour, the extreme scenario of the NYC Stormwater Flood Maps: about a 1-in-500-year hour at Central Park in NOAA Atlas 14.',
    p: { mode: 'tide', slr: 0, rain: 93, rainDur: 1, rainStart: 0.5, drainage: 44, infiltration: 10 } },
  { id: 'ida', name: 'Hurricane Ida, 2021', tag: 'Historical analogue',
    note: 'Ida\'s rainfall at Central Park on 1 September 2021: 180 mm in five hours, 80 mm of it in a single hour, spread evenly across the city.',
    p: { mode: 'tide', slr: 0, hyeto: [20, 30, 80, 35, 15], rain: 80, rainDur: 5, rainStart: 0.5, drainage: 44, infiltration: 10 } },
  { id: 'compound', name: 'Compound Surge and Rain', tag: 'Design',
    note: 'A 2.6 m surge at The Battery with 40 mm/h of rain for three hours across its peak.',
    p: { mode: 'surge', peak: 2.6, duration: 18, timing: 'high', slr: 0, rain: 40, rainDur: 3, rainStart: 4.5, drainage: 44, infiltration: 10 } },
];

export function presetById(id) { return PRESETS.find(p => p.id === id) || PRESETS[0]; }

/** Astronomical tide at a gauge, hours since the events epoch (28 October 2012). */
function tideAt(gauge, speeds, hours) {
  let z = gauge.tide.z0;
  for (const [name, c] of Object.entries(gauge.tide.constituents)) {
    z += c.amp * Math.cos(((speeds[name] * hours - c.phase_deg) * Math.PI) / 180);
  }
  return z;
}

/** Build a runnable scenario from a parameter set. events = events.json */
export function makeScenario(p, events) {
  const s = { params: { ...p } };
  const G = events.gauges, speeds = events.tide_speeds_deg_per_h;
  const slr = p.slr || 0;
  const t0 = Date.parse(events.t0);
  if (p.mode === 'replay') {
    const sd = events.sandy;
    s.start = Date.parse(sd.window.start);
    s.duration = 12 * HOUR;
    const startMin = (s.start - t0) / 60000;
    const series = G.map(g => sd.levels[g.id]);
    const at = (arr, t) => {
      const x = (startMin + t / 60 - sd.start_min) / sd.step_min;
      const k = Math.max(0, Math.min(arr.length - 2, Math.floor(x))), w = Math.min(1, Math.max(0, x - k));
      return arr[k] * (1 - w) + arr[k + 1] * w;
    };
    s.gauges = t => series.map(arr => at(arr, t) + slr);
    s.tides = t => G.map(g => tideAt(g, speeds, startMin / 60 + t / HOUR) + slr);
    s.clock = 'absolute';
    s.observed = true;
  } else {
    const timing = { high: 0, mid: 0.25, low: 0.5 }[p.timing || 'high'] * 12.42;
    s.start = Date.UTC(2030, 0, 1, 0, 0);
    if (p.mode === 'surge') {
      s.duration = Math.round(Math.min(24, Math.max(12, (p.duration || 12) * 0.75))) * HOUR;
    } else {
      s.duration = Math.max(4, (p.rainStart || 0) + (p.rainDur || 1) + 3) * HOUR;
    }
    const tPeak = p.mode === 'surge' ? s.duration / 2 : 0;
    // choose the tide phase: Battery high water at the surge peak (or low water at the start of a rain event)
    const bat = G[0];
    let best = 0, bestZ = p.mode === 'surge' ? -99 : 99;
    for (let h = 0; h < 25; h += 0.05) {
      const z = tideAt(bat, speeds, 24 * 7 + h);
      if (p.mode === 'surge' ? z > bestZ : z < bestZ) { bestZ = z; best = 24 * 7 + h; }
    }
    const ref = best - tPeak / HOUR + (p.mode === 'surge' ? timing : 0) - (p.mode === 'surge' ? 0 : 0.6);
    const tide = t => G.map(g => tideAt(g, speeds, ref + t / HOUR));
    s.tides = t => tide(t).map(z => z + slr);
    if (p.mode === 'surge') {
      const sigma = ((p.duration || 12) * HOUR) / 4;
      const pulse = t => Math.exp(-(((t - tPeak) / sigma) ** 2));
      let S = p.peak - tide(tPeak)[0];
      for (let it = 0; it < 3; it++) {                       // make the Battery maximum equal the requested peak
        let mx = -99;
        for (let t = 0; t <= s.duration; t += 300) mx = Math.max(mx, tide(t)[0] + S * pulse(t));
        S += p.peak - mx;
      }
      S = Math.max(0, S);
      s.gauges = t => { const td = tide(t), u = S * pulse(t); return td.map(z => z + u + slr); };
    } else {
      s.gauges = t => tide(t).map(z => z + slr);
    }
    s.clock = 'relative';
    s.observed = false;
  }
  s.stage = t => s.gauges(t)[0];
  s.tideOnly = t => s.tides(t)[0];
  const r0 = (p.rainStart || 0) * HOUR, r1 = r0 + (p.rainDur || 0) * HOUR;
  if (p.hyeto) {
    s.rain = t => { if (t < r0 || t >= r1) return 0; const k = Math.floor((t - r0) / HOUR); return p.hyeto[k] ?? 0; };
  } else {
    s.rain = t => (p.rain > 0 && t >= r0 && t < r1 ? p.rain : 0);
  }
  s.rainWindow = [r0, r1];
  s.peakStage = (() => { let m = -9; for (let t = 0; t <= s.duration; t += 300) m = Math.max(m, s.stage(t)); return m; })();
  return s;
}

const pad = v => String(v).padStart(2, '0');
/** Clock label for simulation time t (s). Sandy is shown in local time (EDT, UTC-4). */
export function clockLabel(s, t) {
  if (s.clock === 'absolute') {
    const d = new Date(s.start + t * 1000 - 4 * HOUR * 1000);
    const day = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `${day}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} EDT`;
  }
  const a = Math.abs(t);
  return `Hour ${t < 0 ? '-' : ''}${Math.floor(a / HOUR)}:${pad(Math.floor((a % HOUR) / 60))}`;
}

export function shortClock(s, t) {
  if (s.clock === 'absolute') {
    const d = new Date(s.start + t * 1000 - 4 * HOUR * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return `${Math.floor(t / HOUR)}:${pad(Math.floor((t % HOUR) / 60))}`;
}

export const GAUGE_NAMES = ['The Battery', 'Kings Point', 'Rockaway Inlet', 'Jamaica Bay at Inwood'];
