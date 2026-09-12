/* test-rn-boundary-gap.mjs — prove overtake detection walks back to the most
 * recent real boundary when the immediate one doesn't exist.
 *
 *   node live/test-rn-boundary-gap.mjs
 *
 * This race never has lap 0's S5: WIGE sends no S1 for lap 0, and the S5
 * backfill needs all of S1-S4 to run, so it can't either. That silently made
 * idx=1 (lap1's S1) uncomparable for EVERY car, for the WHOLE race, because
 * its "previous" slot (idx=0, lap0's S5) never exists. Confirmed live
 * 2026-09-12: the POS chart showed 5 real position changes for #670, the
 * overtake feed only 2. Of the missing 3, two were pit-stop artifacts
 * (correctly excluded by the existing S1 pit guard), but the third — #670 vs
 * #653, lap1/S1, a genuine green-flag pass — was silently dropped by this gap.
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

/* ---- real 2026-09-12 leg times for #670 vs #653: lap0 has S2-S4 only (no
   S1, no S5 — the exact gap under test), lap1 has all five. #670 is 2.3s
   behind at lap0's S4 (the last real boundary either car has), and comes out
   0.5s AHEAD by lap1's S1 -- a genuine pass, mid-boundary. ---- */
{
  const legs670 = [
    [0, 2, 36101.0, 36178.3, null], [0, 3, 36178.3, 36255.3, null], [0, 4, 36255.3, 36395.7, null],
    [1, 1, 36759.3, 36836.5, null], [1, 2, 36836.5, 36911.1, null],
  ];
  const legs653 = [
    [0, 2, 36102.3, 36179.6, null], [0, 3, 36179.6, 36257.4, null], [0, 4, 36257.4, 36398.0, null],
    [1, 1, 36758.1, 36836.0, null], [1, 2, 36836.0, 36910.2, null],
  ];
  const DB = { pits: { 670: [], 653: [] }, legs: { 670: legs670, 653: legs653 }, sectimes: { 670: {}, 653: {} } };
  const rnCars = ['670', '653'];
  const rnBX = {};
  rnCars.forEach(c => { const m = {}; DB.legs[c].forEach(g => { m[(g[0] - 1) * 5 + g[1]] = g[3]; }); rnBX[c] = m; });
  check('neither car has a lap0/S5 boundary (the real gap under test)',
        rnBX['670'][0] === undefined && rnBX['653'][0] === undefined, [rnBX['670'][0], rnBX['653'][0]]);

  const emitted = runFor('670', DB, rnCars, rnBX);
  const ot = emitted.filter(n => n.kind === 'overtake' && n.lap === 1 && n.sector === 1);
  check('the lap1/S1 swap is detected despite the missing lap0/S5 boundary', ot.length === 1, ot);
  // #670 is 2.3s AHEAD of #653 at lap0's S4 (g0<0), 0.5s BEHIND by lap1's S1
  // (g1>0) -- the real data has #670 dropping from P3 to P4 here, a loss.
  check('...correctly attributed as #670 losing the place to #653 (not a gain)',
        ot[0] && ot[0].meta.gain === false && ot[0].meta.passed === '653', ot[0]);
}

/* ---- the walk-back must not bridge an unreasonably large gap: if a car has
   genuinely posted nothing for many boundaries in a row, that stays "no
   comparison", not a comparison against ancient data. ---- */
{
  // #670 has NOTHING before lap1/S1 (idx=1) at all -- the walk-back searches
  // down to idx=1-5=-4 and finds no boundary anywhere in that range, so it
  // must give up rather than search indefinitely into laps that don't exist.
  const legs670 = [[1, 1, 36759.3, 36836.5, null]];
  const legs653 = [[0, 2, 36102.3, 36179.6, null], [0, 3, 36179.6, 36257.4, null],
                    [0, 4, 36257.4, 36398.0, null], [1, 1, 36758.1, 36836.0, null]];
  const DB = { pits: { 670: [], 653: [] }, legs: { 670: legs670, 653: legs653 }, sectimes: { 670: {}, 653: {} } };
  const rnCars = ['670', '653'];
  const rnBX = {};
  rnCars.forEach(c => { const m = {}; DB.legs[c].forEach(g => { m[(g[0] - 1) * 5 + g[1]] = g[3]; }); rnBX[c] = m; });
  const emitted = runFor('670', DB, rnCars, rnBX);
  const ot = emitted.filter(n => n.kind === 'overtake' && n.lap === 1 && n.sector === 1);
  check('a gap too large to bridge (5+ missing slots) is correctly left uncompared', ot.length === 0, ot);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — overtake detection survives the missing lap0/S5 boundary field-wide');
process.exit(failures ? 1 : 0);
