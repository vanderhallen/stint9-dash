/* test-car-stats.mjs — prove carStats() counts lap 0.
 *
 *   node live/test-car-stats.mjs
 *
 * WIGE's LAPS field is laps COMPLETED, so a car's first flying lap is lap 0 and
 * it is fully timed. The baked SIM CSV numbers laps from 1, and carStats' loop
 * was written against that, so every LIVE car's lap 0 was dropped from FASTEST
 * and LAST LAP. On 2026-09-12 that had #665 showing 10:21.2 for a 9:43.6 best
 * and #652 10:13.4 for a 9:47.2 — lap 0 is often the quickest, because the track
 * is clear before the field bunches.
 *
 * Lifts the real carStats() out of index.html, same approach as the other suites.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const a = html.indexOf('function carStats(st,T){');
const endMark = '\n  return {L,last,fast,liveSecs};}';
const b = html.indexOf(endMark, a);
if (a < 0 || b < 0) { console.error('FAIL — could not find carStats() in index.html'); process.exit(1); }
const src = html.slice(a, b + endMark.length);

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };
const near = (x, y) => x != null && Math.abs(x - y) < 0.01;

// #665's real quali laps: lap 0 is the quickest at 583.6s, then 621.2, 643.9 …
const L0 = [80.5, 78.4, 143.6, 232.5, 48.6];            // 583.6
const L1 = [84.0, 80.0, 150.0, 258.6, 48.6];            // 621.2
const L2 = [86.0, 82.0, 155.0, 272.3, 48.6];            // 643.9
const sum = s => s.reduce((x, y) => x + y, 0);

function statsFor(sectimes, activeLap) {
  const DB = { sectimes: { 665: sectimes } };
  // activeLeg returns the leg the car is on; carStats derives L = lap-1 from it
  const activeLeg = () => (activeLap == null ? null : [activeLap, 1, 0, 1]);
  return new Function('DB', 'BX', 'activeLeg', `${src}; return carStats;`)(DB, {}, activeLeg)('665', 1e9);
}

/* the reported case: three completed laps, car out on lap 3 */
{
  const r = statsFor({ 0: L0, 1: L1, 2: L2 }, 3);
  check('FASTEST is lap 0, the quickest lap', near(r.fast, sum(L0)), r.fast);
  check('...not lap 1, which is what skipping lap 0 gave', !near(r.fast, sum(L1)), r.fast);
  check('LAST LAP is the most recent completed lap', near(r.last, sum(L2)), r.last);
}

/* a car on only its second lap: lap 0 is its one completed lap, so it is both
   the fastest and the last — previously it had neither */
{
  const r = statsFor({ 0: L0 }, 1);
  check('a car on lap 1 has lap 0 as its fastest', near(r.fast, sum(L0)), r.fast);
  check('a car on lap 1 has lap 0 as its last lap', near(r.last, sum(L0)), r.last);
}

/* still nothing to report while the very first lap is in progress */
{
  const r = statsFor({}, 0);
  check('no completed lap yet -> no fastest, no last', r.fast === null && r.last === null, r);
}

/* SIM shape (laps numbered from 1, no lap 0) is unchanged */
{
  const r = statsFor({ 1: L1, 2: L2 }, 3);
  check('SIM-style data without a lap 0 still works', near(r.fast, sum(L1)), r.fast);
}

/* a lap missing its S5 is not a complete lap and must not win FASTEST */
{
  const partial = [70.0, 70.0, 130.0, 200.0, null];
  const r = statsFor({ 0: partial, 1: L1 }, 2);
  check('an incomplete lap 0 is ignored', near(r.fast, sum(L1)), r.fast);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — lap 0 counts toward FASTEST and LAST LAP');
process.exit(failures ? 1 : 0);
