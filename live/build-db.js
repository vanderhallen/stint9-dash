/* build-db.js — rebuild the stint9 dashboard DB object from raw per-lap rows.
 *
 * This is a 1:1 JS port of the derivation half of tools/gen_db.py. The SIM path
 * ships a pre-baked `const DB = {…}` generated offline by gen_db.py; the LIVE
 * path fetches raw per-lap rows from Supabase (public.stint9_live_timing) and
 * calls buildLiveDB() to derive the SAME structure in the browser, so LIVE and
 * SIM render through identical code.
 *
 * Works in Node (module.exports) and the browser (window.buildLiveDB).
 *
 * A "raw row" is exactly one row of public.stint9_live_timing:
 *   { car:"941", lap:15, klass:"SP9 PRO",
 *     s:[86.2, 90.1, 175.3, 260.4, 61.9],   // sector times (s); null allowed (pit-in S5)
 *     spd:[178.2, 165.4, null, 152.9, 61.0], // sector speed readings (km/h), same shape as s; feeds Code 60 (see index.html code60Sectors())
 *     tend:43525.47,   // TAGESZEIT as seconds-of-day = lap END boundary
 *     rt:673.9,        // RUNDENZEIT_IN_SEKUNDEN (may be null -> sum of known sectors)
 *     inpit:false, fast:false,
 *     drv:"Mustermann", veh:"Porsche 911 GT3 R" }
 *
 * geom = { W,H,poly,cx,cy,gps } — track geometry, race-independent. In the
 * browser reuse the existing DB's geom; in Node load tools/geom.json.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.buildLiveDB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PALETTE = ['#E6194B','#4363D8','#3CB44B','#911EB4','#42D4F4','#F032E6','#469990',
                   '#E60073','#2E8B57','#1F77B4','#6A0DAD','#17BECF','#C71585','#00A878',
                   '#2A5CFF','#7B2D8E'];

  const r2 = x => Math.round(x * 100) / 100;
  const r3 = x => Math.round(x * 1000) / 1000;
  const r4 = x => Math.round(x * 10000) / 10000;

  // bisect_right: index where t would insert to keep `arr` sorted (arr sorted asc).
  function bisectRight(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t < arr[mid]) hi = mid; else lo = mid + 1; }
    return lo;
  }

  // Car sort key used throughout gen_db.py: (len(str), str) — "9" < "12" < "666".
  const carCmp = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

  function buildLiveDB(rawRows, geom, eventMeta) {
    // ---- group per car, sort laps ----
    const bycar = {};
    for (const r of rawRows) (bycar[r.car] || (bycar[r.car] = [])).push(r);
    for (const c in bycar) bycar[c].sort((a, b) => a.lap - b.lap);

    const cars = Object.keys(bycar).sort(carCmp);

    // ---- per-car derived ----
    const legs = {}, sectimes = {}, pits = {}, name = {}, carclass = {},
          veh = {}, drvlap = {}, boundtimes = {};

    for (const c of cars) {
      const lg = [], st = {}, pit = [], bt = [], dl = {};
      for (const r of bycar[c]) {
        const L = r.lap, spd = r.spd;
        // Repair a single DROPPED interior sector (S1..S4). WIGE occasionally omits
        // one sector time from a snapshot; the cumulative walk below would otherwise
        // just `continue` past the hole, and — the real damage — every LATER sector
        // of that lap would then start early by the missing sector's length, sliding
        // the car and inflating gaps. If the lap time (rt) and all four other sectors
        // are known we can reconstruct the hole exactly (rt − sum(others)). A null S5
        // on a pit-in lap is legitimate (no crossing) and left alone; ambiguous
        // multi-hole laps are left as-is (rare).
        const s = r.s.slice();
        if (r.rt && s[4] != null) {
          const miss = [];
          for (let k = 0; k < 4; k++) if (s[k] == null) miss.push(k);
          if (miss.length === 1) {
            let sum = 0; for (let k = 0; k < 5; k++) if (s[k] != null) sum += s[k];
            const fill = r.rt - sum;
            if (fill > 0 && fill < 900) s[miss[0]] = r3(fill);  // plausible sector length
          }
        }
        let known = 0;
        for (const x of s) if (x != null) known += x;
        const rt = r.rt ? r.rt : known;
        const t0 = r.tend - rt;
        let cum = t0;
        for (let k = 0; k < 5; k++) {
          if (s[k] == null) continue;           // e.g. S5 on a pit-in lap: no boundary
          const a = cum; cum = cum + s[k];
          // 5th element = this sector's speed reading (km/h), or null if the row
          // has no spd/spd[k] (e.g. the baked SIM dataset, which has no speed
          // captured — Code 60 detection simply finds nothing there, by design).
          lg.push([L, k + 1, r2(a), r2(cum), (spd && spd[k] != null) ? r2(spd[k]) : null]);
          bt.push([r2(cum), L, k + 1]);
        }
        st[String(L)] = s.map(x => (x != null ? r3(x) : null));
        if (r.inpit) pit.push(L);
        dl[String(L)] = r.drv; carclass[c] = r.klass; veh[c] = r.veh;
      }
      legs[c] = lg; sectimes[c] = st; pits[c] = pit.slice().sort((a, b) => a - b); drvlap[c] = dl;
      name[c] = bycar[c].length ? bycar[c][0].drv : '';
      bt.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
      boundtimes[c] = bt;
    }

    // ---- classes ----
    const classesTmp = {};
    for (const c of cars) (classesTmp[carclass[c]] || (classesTmp[carclass[c]] = [])).push(c);
    const classes = {};
    for (const k of Object.keys(classesTmp)) classes[k] = classesTmp[k].slice().sort(carCmp);

    const classMaxN = {}, classAvg = {};
    for (const cls of Object.keys(classes)) {
      let mx = 1; const sums = [0, 0, 0, 0, 0], cnts = [0, 0, 0, 0, 0];
      for (const c of classes[cls]) {
        for (const r of bycar[c]) {
          mx = Math.max(mx, r.lap);
          // Per-SECTOR average, over present values only. The old code summed
          // (s[k]||0) but incremented one shared per-LAP counter, so a null sector —
          // S5 on a 4-sector class like M240i, or a pit sector capped to null
          // upstream — added 0 to the sum while still growing the divisor, dragging
          // the average far below the true sector time (M240i S4 came out 113s vs a
          // real 232s). That understated avgseg made the DELAY badge (leg > avg×1.5)
          // fire on almost every NORMAL sector. Skip nulls; still skip pit laps.
          if (!r.inpit) for (let k = 0; k < 5; k++) if (r.s[k] != null) { sums[k] += r.s[k]; cnts[k]++; }
        }
      }
      classMaxN[cls] = mx;
      classAvg[cls] = sums.map((v, k) => cnts[k] ? Math.round((v / cnts[k]) * 10) / 10 : 0);
    }

    // ---- carcol: palette cycled within each class ----
    const carcol = {};
    for (const cls of Object.keys(classes))
      classes[cls].forEach((c, i) => { carcol[c] = PALETTE[i % PALETTE.length]; });

    // ---- positions: within-class track position at each boundary ----
    const chart = {}, lappos = {};
    for (const cls of Object.keys(classes)) {
      const cl = classes[cls];
      const times = {};
      for (const c of cl) times[c] = boundtimes[c].map(b => b[0]);
      for (const c of cl) {
        const bt = boundtimes[c], ct = times[c];
        const ch = [], lp = {};
        for (let idx = 0; idx < bt.length; idx++) {
          const t = bt[idx][0], L = bt[idx][1], s = bt[idx][2];
          const k = idx + 1;                    // boundaries completed by c at time t
          let pos = 1;
          for (const d of cl) {
            if (d === c) continue;
            const bd = bisectRight(times[d], t);
            if (bd > k) pos++;
            else if (bd === k && bd > 0 && times[d][bd - 1] < t) pos++;
          }
          const prog = r4(((L - 1) * 5 + s) / 5);
          ch.push([prog, pos, t]);
          if (s === 5) lp[String(L)] = pos;
        }
        chart[c] = ch; lappos[c] = lp;
      }
    }

    // ---- assemble ----
    return {
      W: geom.W, H: geom.H, poly: geom.poly, cx: geom.cx, cy: geom.cy, gps: geom.gps,
      event: eventMeta || { name: '', date: '' },
      classes, classMaxN, classAvg,
      name, carcol, drvtable: {}, drvlap,
      legs, chart, sectimes, lappos, pits,
      cars,   // convenience for LIVE (SIM builds DB.cars separately in index.html)
    };
  }

  return buildLiveDB;
});
