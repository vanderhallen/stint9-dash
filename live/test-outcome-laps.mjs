/* test-outcome-laps.mjs — prove the agent's "outcome/finish" reply estimates
 * laps-to-go from time remaining, not from how far the field has driven.
 *
 *   node live/test-outcome-laps.mjs
 *
 * rem used to be maxN - curLapOf(selCar). maxN is "the highest lap ANY car in
 * the class has reached so far" -- rebuilt every LIVE poll from current
 * progress, not a declared race distance. For a car near the front it tracks
 * that SAME car's own lap almost exactly, so the reply read "~0 laps to go"
 * with two hours still on the clock (reported live, 2026-09-12) regardless of
 * how much of a fixed-TIME (not fixed-lap) enduro remained.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

check('rem no longer derives from maxN', !html.includes('const rem=Math.max(0,maxN-curLapOf(selCar))'), 'old formula still present');
check('rem derives from raceEndTod() and this car\'s own pace',
      html.includes('const rem=myPace>0?Math.max(0,Math.round((raceEndTod()-T)/myPace)):null;'), 'new formula not found');

/* the arithmetic itself: 2h left (7200s) at a 9:00 (540s) pace -> ~13 laps,
   nowhere near the "~0" the old maxN-tracks-the-leader formula produced for a
   car running at or near the front. */
{
  const T = 0, raceEnd = 7200, pace = 540;
  const rem = pace > 0 ? Math.max(0, Math.round((raceEnd - T) / pace)) : null;
  check('2h remaining at a 9:00 pace gives a real double-digit estimate, not ~0',
        rem === 13, rem);
}

/* a car with no completed lap yet (myPace null) must not print "~null" */
{
  check("null pace produces the 'not enough laps yet' fallback text, not '~null'",
        html.includes("const remTxt=rem!=null?('~'+rem+' laps to go'):'not enough laps yet to estimate laps to go';"),
        'fallback text not found');
}

/* curLapOf's own seed-at-0 bug (same class of fix as the map/racenotes ones
   earlier today): a car with only negative/zero boundary keys is on lap 0,
   not lap 1. */
{
  const a = html.indexOf('const curLapOf=st=>{');
  const b = html.indexOf('\n', a);   // this whole definition is one line
  const src = html.slice(a, b);
  const curLapOf = new Function('activeLeg', 'BX', 'T', `${src}; return curLapOf;`)(
    () => null,                              // no active leg -> exercises the fallback scan
    { 42: { '-3': 100, '-2': 220 } },         // car still on lap 0 (S2, S3 crossed; S1 never exists this race)
    1e9);
  check("curLapOf reads lap 0 correctly when only negative/zero keys exist", curLapOf('42') === 0, curLapOf('42'));
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — laps-to-go comes from time remaining, not from field progress');
process.exit(failures ? 1 : 0);
