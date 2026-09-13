/* test-quali-rank.mjs — prove the leaderboard ranks a qualifying session by
 * FASTEST LAP (laps completed irrelevant) and a race by DISTANCE COVERED.
 *
 *   node live/test-quali-rank.mjs
 *
 * On 2026-09-12 the whole BMW M240i class finished quali on lap 6 with every
 * sector in, so they tied on progress and the race tiebreak — earliest to reach
 * that boundary — silently set the order: #670 sat P6 holding the best lap on
 * screen. Lifts sessionKind/qualiPos/livePos out of index.html.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const a = html.indexOf('function currentWindowLabel(){');
const endMark = '\n  a.sort((x,y)=>y[0]-x[0]||x[1]-y[1]);const m={};a.forEach((e,i)=>m[e[2]]=i+1);return m;}';
const b = html.indexOf(endMark, a);
if (a < 0 || b < 0) { console.error('FAIL — could not find the ranking block'); process.exit(1); }
const src = html.slice(a, b + endMark.length);

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

// four cars, all tied on progress (same lap, same sector) — the quali situation.
// fast = best lap, p = progress. Deliberately ordered so the two rankings differ.
const CARS = {
  665: { fast: 583.6, p: 31, t: 100 },   // earliest to the boundary -> P1 under race logic
  652: { fast: 587.2, p: 31, t: 101 },
  661: { fast: 578.6, p: 31, t: 102 },
  670: { fast: 568.5, p: 31, t: 103 },   // fastest lap -> P1 under quali logic
};
function rank(label, mode) {
  const DB = { cars: Object.keys(CARS) };
  const env = new Function('DB', 'SCHEDULE', 'window', 'carStats', 'carProgress', `
    ${src}
    return {livePos, sessionKind};`)(
      DB,
      { rows: [{ label, start: new Date(Date.now() - 6e4), end: new Date(Date.now() + 6e4) }] },
      { dataMode: mode },
      st => ({ fast: CARS[st].fast }),
      st => ({ p: CARS[st].p, t: CARS[st].t }));
  return env;
}
const order = lp => Object.keys(lp).sort((x, y) => lp[x] - lp[y]);

/* qualifying — fastest lap wins, progress ignored */
{
  const e = rank('quali', 'LIVE');
  check('a quali window is detected as a time sheet', e.sessionKind() === 'quali', e.sessionKind());
  const o = order(e.livePos(1e9));
  check('P1 is the fastest lap (#670), not the earliest to the line',
        o[0] === '670', o);
  check('full order follows lap time', o.join() === '670,661,665,652', o);
}

/* the race window keeps the historical distance ranking */
{
  const e = rank('race', 'LIVE');
  check('a race window is not a time sheet', e.sessionKind() === 'race', e.sessionKind());
  const o = order(e.livePos(1e9));
  check('P1 is the car that reached the boundary first (#665)', o[0] === '665', o);
}

/* anything unrecognised must fall through to race ranking, never to quali */
{
  for (const lbl of ['pitwalk', 'startaufstellung', 'lineup', 'end', '']) {
    const e = rank(lbl, 'LIVE');
    check(`"${lbl || '(blank)'}" falls through to race ranking`, e.sessionKind() === 'race', e.sessionKind());
  }
}

/* practice is a time sheet too */
{
  check('practice ranks as a time sheet', rank('practice', 'LIVE').sessionKind() === 'quali');
}

/* 2026-09-13: a session overrunning its scheduled slot must not be silently
 * race-ranked in the gap before the next scheduled row starts — NLS9's quali
 * (06:30-08:00) was still running (WIGE's own heat: "Zeittraining") at 08:09,
 * with the next row (pitwalk) not due until 08:20; #665 held the fastest lap
 * on screen but showed P6 because currentWindowLabel() found no row
 * containing "now" and fell straight to race ranking. */
{
  const DB = { cars: Object.keys(CARS) };
  const now = Date.now(), min = 60e3;
  const gapRows = { rows: [
    { label: 'quali', start: new Date(now - 90 * min), end: new Date(now - 9 * min) },
    { label: 'pitwalk', start: new Date(now + 11 * min), end: new Date(now + 40 * min) },
  ] };
  const mkGap = () => new Function('DB', 'SCHEDULE', 'window', 'carStats', 'carProgress', `
    ${src}
    return {livePos, sessionKind};`)(
      DB, gapRows, { dataMode: 'LIVE' },
      st => ({ fast: CARS[st].fast }), st => ({ p: CARS[st].p, t: CARS[st].t }));
  const gap = mkGap();
  check('a gap after quali\'s end (before the next row starts) still ranks as a time sheet',
        gap.sessionKind() === 'quali', gap.sessionKind());
  check('P1 in that gap is still the fastest lap (#670), not race-tiebroken',
        order(gap.livePos(1e9))[0] === '670', order(gap.livePos(1e9)));

  // once pitwalk's OWN start time arrives, it must pre-empt the carried-forward
  // quali label immediately — a race window can never be blocked by this.
  const mkPitwalk = () => new Function('DB', 'SCHEDULE', 'window', 'carStats', 'carProgress', `
    ${src}
    return {livePos, sessionKind};`)(
      DB, { rows: [
        { label: 'quali', start: new Date(now - 90 * min), end: new Date(now - 9 * min) },
        { label: 'pitwalk', start: new Date(now - 1 * min), end: new Date(now + 30 * min) },
      ] }, { dataMode: 'LIVE' },
      st => ({ fast: CARS[st].fast }), st => ({ p: CARS[st].p, t: CARS[st].t }));
  check('once pitwalk\'s own window starts it pre-empts the carried-forward quali label',
        mkPitwalk().sessionKind() === 'race', mkPitwalk().sessionKind());
}

/* SIM replay uses the archived bundle's label, not the wall clock */
{
  const DB = { cars: Object.keys(CARS) };
  const mk = evLabel => new Function('DB', 'SCHEDULE', 'window', 'carStats', 'carProgress', `
    ${src}
    return {livePos, sessionKind};`)(
      DB, { rows: [{ label: 'race', start: new Date(0), end: new Date(8.64e15) }] },
      { dataMode: 'SIM', __eventLabel: evLabel },
      st => ({ fast: CARS[st].fast }), st => ({ p: CARS[st].p, t: CARS[st].t }));
  check('SIM replay of a quali bundle ranks by lap time, ignoring the live window',
        mk('quali').sessionKind() === 'quali' && order(mk('quali').livePos(1e9))[0] === '670');
  check('SIM replay of a race bundle ranks by distance', mk('race').sessionKind() === 'race');
  check('SIM replay with no label ranks as a race', mk(null).sessionKind() === 'race');
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — quali ranks by fastest lap, race by distance');
process.exit(failures ? 1 : 0);
