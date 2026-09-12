/* test-live-ref.mjs — prove liveRefDuration() never hands the prediction a
 * sector time that was distorted by a pit stop.
 *
 *   node live/test-live-ref.mjs
 *
 * Lifts pitLapsOf() and liveRefDuration() straight out of index.html (same
 * approach as test-live-anchor.mjs — no copy of the logic to drift), stubs the
 * bits of DB they read, and drives them with the shape really seen on
 * 2026-09-12: the pit lane sits between start/finish and the S1 point, so the
 * lap AFTER a stop reports an S1 of several minutes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

function lift(startMark, endMark, label) {
  const a = html.indexOf(startMark);
  if (a < 0) { console.error(`FAIL — could not find ${label} in index.html`); process.exit(1); }
  const b = html.indexOf(endMark, a);
  if (b < 0) { console.error(`FAIL — could not find the end of ${label}`); process.exit(1); }
  return html.slice(a, b + endMark.length);
}
const pitSrc = lift('let _pitLapCache={};', '\n}', 'pitLapsOf');
const refSrc = lift('function liveRefDuration(car,sectorIdx){', '\n  return null;\n}', 'liveRefDuration');

let failures = 0;
const check = (name, cond, got) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`);
};

// --- the car: three clean laps, then a stop at the end of lap 2, so lap 3 is
// the out-lap and its S1 (399.566s) is mostly pit lane. Real values, #500. ---
const S1 = { 0: 79.585, 1: 79.612, 2: 78.9, 3: 399.566 };
const sectimes = {};
for (const L of [0, 1, 2, 3]) sectimes[String(L)] = [S1[L], 74 + +L, 140, 220, 55];
const legs = [];
for (const L of [0, 1, 2, 3]) { let t = L * 600; legs.push([L, 1, t, t + S1[L], null]); }

function makeEnv(pitsFromFeed) {
  const DB = { sectimes: { 500: sectimes }, legs: { 500: legs }, pits: { 500: pitsFromFeed },
               avgseg: [0, 80, 75, 140, 220, 55] };
  return new Function('DB', `${pitSrc};${refSrc};
    function liveArchiveRef(){return null;}
    return { pitLapsOf, liveRefDuration };`)(DB);
}

/* the feed flags nothing — the normal case, since wige-scrape's PITSTOPCOUNT
   diff has produced ~no inpit rows (README §18) */
{
  const { pitLapsOf, liveRefDuration } = makeEnv([]);
  check('pitLapsOf infers the stop at the end of lap 2 from the out-lap S1',
        pitLapsOf('500').join() === '2', pitLapsOf('500'));
  const r1 = liveRefDuration('500', 1);
  check('S1 reference is NOT the 399.6s out-lap', r1 !== 399.566, r1);
  check('S1 reference falls back to a clean lap', r1 === 79.612 || r1 === 79.585 || r1 === 78.9, r1);
  // the out-lap's OTHER sectors are ordinary racing sectors and stay usable
  const r2 = liveRefDuration('500', 2);
  check('S2 reference still uses the most recent lap', r2 === sectimes['3'][1], r2);
}

/* the rule is per-SECTOR, not per-lap: a stop sits at the end of S5, so on the
   in-lap only S5 is spoilt and its S1-S4 are ordinary racing data, while on the
   out-lap it is S1 that carries the stop. Feed-flagged or inferred, same rule. */
{
  const { liveRefDuration } = makeEnv([2]);       // feed flags lap 2 as the in-lap
  check('out-lap S1 (the 399.6s one) is excluded', liveRefDuration('500', 1) !== 399.566,
        liveRefDuration('500', 1));
  check('the in-lap\'s own S1 is ordinary racing data and IS used',
        liveRefDuration('500', 1) === 78.9, liveRefDuration('500', 1));
}

/* in-lap S5 is excluded — the car peels into the lane before the S5 beacon */
{
  const st = { 0: [80, 74, 140, 220, 55.1], 1: [79, 74, 140, 220, 55.2], 2: [78, 74, 140, 220, 99.9] };
  const lg = [0, 1, 2].map(L => [L, 1, L * 600, L * 600 + st[L][0], null]);
  const DB = { sectimes: { 7: st }, legs: { 7: lg }, pits: { 7: [2] },
               avgseg: [0, 80, 74, 140, 220, 55] };
  const { liveRefDuration } = new Function('DB', `${pitSrc};${refSrc};
    function liveArchiveRef(){return null;}
    return { liveRefDuration };`)(DB);
  check('in-lap S5 skipped in favour of the previous clean lap',
        liveRefDuration('7', 5) === 55.2, liveRefDuration('7', 5));
  check('the same in-lap\'s S3 is still used', liveRefDuration('7', 3) === 140,
        liveRefDuration('7', 3));
}

/* a car with no stop at all is unaffected: most recent lap wins, as before */
{
  const clean = {}; for (const L of [0, 1, 2]) clean[String(L)] = [80 - L, 75, 140, 220, 55];
  const cleanLegs = [0, 1, 2].map(L => [L, 1, L * 600, L * 600 + (80 - L), null]);
  const DB = { sectimes: { 9: clean }, legs: { 9: cleanLegs }, pits: {}, avgseg: [0, 80, 75, 140, 220, 55] };
  const { liveRefDuration, pitLapsOf } = new Function('DB', `${pitSrc};${refSrc};
    function liveArchiveRef(){return null;}
    return { pitLapsOf, liveRefDuration };`)(DB);
  check('clean car flags no pit laps', pitLapsOf('9').length === 0, pitLapsOf('9'));
  check('clean car still gets its most recent S1', liveRefDuration('9', 1) === 78, liveRefDuration('9', 1));
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — pit-distorted sectors stay out of the prediction reference');
process.exit(failures ? 1 : 0);
