/* test-live-pit.mjs — prove liveCarXY() reads "cleared S1, then silent" as the
 * SECOND pit entry (the GP-to-Nordschleife transition, just past the S1 beacon)
 * rather than as a car crawling towards the S2 entrance.
 *
 *   node live/test-live-pit.mjs
 *
 * Lifts liveCarXY() straight out of index.html (same approach as the other two
 * suites) and stubs only what it reads. ptAlong is stubbed to return its own
 * arguments, so an assertion can name the exact point on track.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const grab = (re, label) => {
  const m = html.match(re);
  if (!m) { console.error(`FAIL — could not find ${label} in index.html`); process.exit(1); }
  return m[1];
};
const WINDOW = +grab(/const LIVE_RUNNING_WINDOW_S=(\d+);/, 'LIVE_RUNNING_WINDOW_S');
const PITX   = +grab(/const PIT_AFTER_S1_X=([\d.]+);/, 'PIT_AFTER_S1_X');
const a = html.indexOf('function liveCarXY(st,T){');
const endMark = '\n}';
const b = html.indexOf('\n  return{xy:ptAlong(li[1],1)', a);
if (a < 0 || b < 0) { console.error('FAIL — could not find liveCarXY()'); process.exit(1); }
const src = html.slice(a, html.indexOf(endMark, b) + endMark.length);

const S2REF = 75;           // this car's own S2 reference, seconds
function makeCarXY(lastSector, refDur = S2REF, c60 = []) {
  // one completed leg ending at t=1000: [lap, sector, start, end]
  const LEG = { 42: [[3, lastSector, 1000 - 80, 1000]] };
  return new Function('LEG', 'thr', 'LIVE_RUNNING_WINDOW_S', 'PIT_AFTER_S1_X', 'REF', '_c60', `
    function ptAlong(seg,frac){return {seg:seg,frac:+frac.toFixed(4)};}
    function liveRefDuration(){return REF;}
    ${src}
    return liveCarXY;`)(LEG, 0.5, WINDOW, PITX, refDur, c60);
}

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

console.log(`LIVE_RUNNING_WINDOW_S=${WINDOW}s  PIT_AFTER_S1_X=${PITX}  (S2 ref ${S2REF}s -> pit at ${PITX * S2REF}s)`);

/* a normal S2 in progress is still predicted, not sent to the pits */
{
  const f = makeCarXY(1);
  const r = f('42', 1000 + 40);          // 40s into a 75s S2
  check('mid-S2 car is predicted along S2', r.xy.seg === 2 && !r.parked, r);
  check('mid-S2 car carries no DELAY', r.overdue === false, r);
}

/* merely slow — past the DELAY threshold but not yet pit-like */
{
  const f = makeCarXY(1);
  const r = f('42', 1000 + 130);         // 1.7x the reference: slow, but real S2s reach 2.7x
  check('a slow S2 still shows on track', !r.parked, r);
  check('a slow S2 raises DELAY', r.overdue === true, r);
}

/* silent well past anything a real S2 has ever taken -> second pit entry */
{
  const f = makeCarXY(1);
  const r = f('42', 1000 + PITX * S2REF + 1);
  check('car silent past the bound is put in the pits', r.parked === true, r);
  check('...at the pit line, like every other parked car', r.xy.seg === 1 && r.xy.frac === 0, r);
  check('...and NOT badged DELAY — it is a stop, not a delay', r.overdue === false, r);
  check('...well before the generic park window would have caught it',
        PITX * S2REF < WINDOW, { pitAt: PITX * S2REF, window: WINDOW });
}

/* Code 60 in S2 is the one honest reason a sector blows out this far, so the
   pit inference stands down while one is flagged there */
{
  const f = makeCarXY(1, S2REF, [2]);
  const r = f('42', 1000 + PITX * S2REF + 1);
  check('Code 60 in S2 suppresses the pit inference', !r.parked && r.xy.seg === 2, r);
  check('...and the car is flagged DELAY instead', r.overdue === true, r);
  const g = makeCarXY(1, S2REF, [4]);          // Code 60 somewhere else does not
  check('Code 60 in another sector does not suppress it',
        g('42', 1000 + PITX * S2REF + 1).parked === true, g('42', 1000 + PITX * S2REF + 1));
}

/* the rule is S1-only: there is no pit entry mid-Nordschleife, so a car stopped
   in S3/S4/S5 is stranded ON TRACK and must keep saying so */
{
  // reference kept short enough that 3.5x still lands inside LIVE_RUNNING_WINDOW_S,
  // so this tests the S1-only rule and not the generic long-silence park below
  const REF = 80;
  for (const [sec, next] of [[2, 3], [3, 4], [4, 5]]) {
    const f = makeCarXY(sec, REF);
    const r = f('42', 1000 + 3.5 * REF);   // just as overdue, deeper in the lap
    check(`overdue after S${sec} stays on track (no pit entry there)`,
          !r.parked && r.xy.seg === next && r.overdue === true, r);
  }
}

/* the existing long-silence rule is untouched */
{
  const f = makeCarXY(3, 140);
  const r = f('42', 1000 + WINDOW + 1);
  check('a car silent past LIVE_RUNNING_WINDOW_S still parks', r.parked === true, r);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — cleared S1 then silent reads as the Nordschleife pit entry');
process.exit(failures ? 1 : 0);
