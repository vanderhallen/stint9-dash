/* test-rn-s1.mjs — prove overtake detection only skips S1 for the CAR that
 * actually pitted, not for the whole sector on every lap.
 *
 *   node live/test-rn-s1.mjs
 *
 * S1 is unreliable ONLY on an out-lap — the pit box and exit both sit inside
 * S1, so an out-lap S1 runs far longer than a green one and its gap to every
 * rival flips regardless of any real on-track pass. The old code skipped S1
 * unconditionally, for every lap of every car, which also threw away every
 * GENUINE green-flag pass that happened to occur in S1. Confirmed live
 * 2026-09-12: #670 vs #653 swapped positions at lap 2's S1 — an entirely
 * ordinary lap for both, no pit stop involved — and the note never fired.
 *
 * Lifts rnDetect() straight out of index.html. Leg endpoints below are chosen
 * to produce a real gap-sign flip at idx=6 (lap2/S1) in every case, so a test
 * that "detects nothing" is actually proving the guard suppressed something,
 * not just that nothing was there to find.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const lift = (a, b) => { const i = html.indexOf(a); if (i < 0) return null; const j = html.indexOf(b, i); return j < 0 ? null : html.slice(i, j + b.length); };

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const keySecSrc = lift('function keySec(k){', '\n');
const pitLapsOfSrc = lift('let _pitLapCache={};', '\n}');
const rnDetectSrc = lift('function rnDetect(T){', '\n}\n');
for (const [name, src] of [['keySec', keySecSrc], ['pitLapsOf', pitLapsOfSrc], ['rnDetect', rnDetectSrc]])
  if (!src) { console.error(`FAIL — could not find ${name}() in index.html`); process.exit(1); }

function runFor(rnCar0, DB, rnCars, rnBX) {
  const emitted = [];
  const rnDetect = new Function('DB', 'rnCars', 'rnBX', 'rnEmit', 'rnCar0', `
    let rnCar=rnCar0;
    ${pitLapsOfSrc};${keySecSrc}
    function rnRank(){return null;}
    function secRef(){return 0;}
    function rnFullLap(){return null;}
    ${rnDetectSrc}
    return rnDetect;`)(DB, rnCars, rnBX, n => { emitted.push(n); return true; }, rnCar0);
  rnDetect(1e9);
  return emitted;
}

function scenario(legs670, legs653, pits670, pits653) {
  const DB = { pits: { 670: pits670, 653: pits653 }, legs: { 670: legs670, 653: legs653 }, sectimes: { 670: {}, 653: {} } };
  const rnCars = ['670', '653'];
  const rnBX = {};
  rnCars.forEach(c => { const m = {}; DB.legs[c].forEach(g => { m[(g[0] - 1) * 5 + g[1]] = g[3]; }); rnBX[c] = m; });
  return runFor('670', DB, rnCars, rnBX).filter(n => n.kind === 'overtake' && n.sector === 1);
}

/* ---- a genuine green-flag S1 swap, neither car anywhere near the pits.
   #670 is 2s behind at the end of lap 1 (g0=+2), but runs a 74s S1 against
   #653's 77s and comes out 1s ahead (g1=-1) -- a real pass, mid-sector. ---- */
{
  const ot = scenario(
    [[1, 5, 400, 460, null], [2, 1, 460, 534, null], [2, 2, 534, 608, null]],
    [[1, 5, 400, 458, null], [2, 1, 458, 535, null], [2, 2, 535, 609, null]],
    [], []);
  check('a genuine S1 pass (no pit stop involved) is detected', ot.length === 1, ot);
  check('...correctly attributed to #670 passing (gain), not losing', ot[0] && ot[0].meta.gain === true, ot[0]);
}

/* ---- OUR OWN out-lap: #670 is 2s AHEAD at the end of lap 1 (g0=-2), but its
   200s pit-box-and-exit S1 puts it 121s behind by the end of S1 (g1=+121) --
   a real gap-sign flip, exactly what the old blanket skip was FOR, and this
   guard must suppress it just as completely. ---- */
{
  const ot = scenario(
    [[1, 5, 400, 458, null], [2, 1, 458, 658, null], [2, 2, 658, 732, null]],
    [[1, 5, 400, 460, null], [2, 1, 460, 537, null], [2, 2, 537, 611, null]],
    [1], []);
  check('an out-lap S1 (real pit stop) is still suppressed, not a fabricated pass', ot.length === 0, ot);
}

/* ---- the RIVAL's out-lap (not ours) must equally suppress it -- otherwise
   #653 pitting would fabricate a "passed #653" note for #670 that has
   nothing to do with anything #670 actually did on track. ---- */
{
  const ot = scenario(
    [[1, 5, 400, 460, null], [2, 1, 460, 537, null], [2, 2, 537, 611, null]],
    [[1, 5, 400, 458, null], [2, 1, 458, 658, null], [2, 2, 658, 732, null]],
    [], [1]);
  check("the RIVAL's out-lap also suppresses the S1 comparison", ot.length === 0, ot);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — S1 overtakes detect on green-flag laps and stay suppressed only on a real out-lap');
process.exit(failures ? 1 : 0);
