/* test-lap0-keys.mjs — prove boundary keys decompose correctly during lap 0.
 *
 *   node live/test-lap0-keys.mjs
 *
 * A boundary key = (lap-1)*5+sector is NEGATIVE or ZERO while a car is still
 * on lap 0 (WIGE's laps-completed convention: the first flying lap IS lap 0).
 * JS's `%` keeps the dividend's sign, so `(k-1)%5` on a negative k returns a
 * negative/wrong sector, not the real one — and three places seeded a
 * "highest boundary crossed" accumulator at 0 and only updated it on a value
 * `>0`, so a car whose only real keys are ≤0 (i.e. anyone still on lap 0)
 * never advanced it. Combined, this silently zeroed the racenotes overtake
 * feed for EVERY car still on its first lap — confirmed live 2026-09-12,
 * where it stayed silent well into the race because a mid-field caution held
 * much of the 98-car field on lap 0 for several minutes.
 *
 * Lifts keySec() and rnDetect() straight out of index.html.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const keySecSrc = html.slice(html.indexOf('function keySec(k){'), html.indexOf('\n', html.indexOf('function keySec(k){')) + 1);
const keySec = new Function(`${keySecSrc}; return keySec;`)();
const keyLap = k => Math.floor((k - 1) / 5) + 1;

/* ---- keySec: correct for every key a real lap 0 through lap N produces ---- */
{
  // lap 0: keys -4..0 for S1..S5
  const cases = [[-4, 0, 1], [-3, 0, 2], [-2, 0, 3], [-1, 0, 4], [0, 0, 5],
                 [1, 1, 1], [5, 1, 5], [6, 2, 1], [10, 2, 5]];
  for (const [k, lap, sec] of cases) {
    check(`key ${k} -> lap ${keyLap(k)} sector ${keySec(k)}`, keyLap(k) === lap && keySec(k) === sec, { keyLap: keyLap(k), keySec: keySec(k) });
  }
}

/* ---- end to end: overtake detection must fire WITHIN lap 0, not wait for lap 1 ----
   Real situation, 2026-09-12: two class rivals both still on lap 0, one ahead at
   S2 and the other ahead by S3 -- a real pass that happened entirely on lap 0. */
{
  const rnDetectSrc = html.slice(html.indexOf('function rnDetect(T){'), html.indexOf('\n}\n', html.indexOf('function rnDetect(T){')) + 2);
  // rnBX keys for lap 0: S2=-3, S3=-2 (S1 doesn't exist this race, matching real data)
  const rnBX = {
    670: { '-3': 100, '-2': 220 },   // #670: S2 ends t=100, S3 ends t=220
    999: { '-3': 105, '-2': 215 },   // #999: S2 ends t=105 (behind #670), S3 ends t=215 (AHEAD of #670 -> a pass)
  };
  const rnCars = ['670', '999'];
  const emitted = [];
  const env = new Function('rnBX', 'rnCars', 'keySec', 'rnRank', 'rnEmit', 'RN_GAP_THR', 'pitLapsOf', 'DB', 'rnFullLap', 'secRef', `
    let rnCar='670';
    ${rnDetectSrc}
    return rnDetect;`)(
      rnBX, rnCars, keySec,
      () => null,                                  // rnRank stub (not exercised by the overtake block)
      note => { emitted.push(note); return true; },  // rnEmit stub
      2, () => [], { sectimes: {}, pits: {} }, () => null, () => 0);
  env(1e9);
  const ot = emitted.filter(n => n.kind === 'overtake');
  check('an overtake WITHIN lap 0 is detected', ot.length === 1, ot);
  check('it is attributed to lap 0, sector 3', ot[0] && ot[0].lap === 0 && ot[0].sector === 3, ot[0]);
  check('#670 is recorded as the one who passed', ot[0] && ot[0].body.includes('passed #999') === false && ot[0].meta.gain === false, ot[0]);
  // #670 fell BEHIND #999 in S3 (was ahead at S2, behind at S3) -> #670 lost the place
  check('the direction is correct: #670 lost the place, not gained it', ot[0] && ot[0].meta.passed === '999' && ot[0].meta.gain === false, ot[0]);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — boundary keys decompose correctly through lap 0, overtakes detect within it');
process.exit(failures ? 1 : 0);
