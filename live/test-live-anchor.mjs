/* test-live-anchor.mjs — prove index.html's anchorLiveRows() puts a LIVE car at
 * the sector boundary it actually crossed, instead of at "now".
 *
 *   node live/test-live-anchor.mjs
 *
 * Like test-build-db.mjs this exercises the REAL shipped source: the function is
 * lifted straight out of index.html rather than copied here, so the test cannot
 * drift away from what the page runs. Fixtures are real rows observed in
 * public.stint9_live_timing during NLS Zeittraining on 2026-09-12.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

// lift `const ANCH={} … function anchorLiveRows(){…}` out of the LIVE IIFE
const start = html.indexOf('const ANCH={};');
const endMark = '\n    return raw;\n  }';
const end = html.indexOf(endMark, start);
if (start < 0 || end < 0) { console.error('FAIL — could not find anchorLiveRows() in index.html'); process.exit(1); }
const src = html.slice(start, end + endMark.length);
// the function reads this module-scope constant; lift the real value too
const win = html.match(/const LIVE_RUNNING_WINDOW_S=(\d+);/);
if (!win) { console.error('FAIL — could not find LIVE_RUNNING_WINDOW_S in index.html'); process.exit(1); }
const { anchorLiveRows, resetAnch } = new Function(
  `const LIVE_RUNNING_WINDOW_S=${win[1]};${src}; return { anchorLiveRows, resetAnch: () => { for (const k in ANCH) delete ANCH[k]; } };`)();

const buildLiveDB = (await import('./build-db.js')).default ??
                    (await import('./build-db.js'));

let failures = 0;
const check = (name, cond, got) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`);
};
const near = (a, b, tol = 0.05) => a != null && Math.abs(a - b) <= tol;
// a raw row as prepLiveRaw() hands it over
const row = (car, lap, s, tend, rt = null) => ({ car, lap, s: s.slice(), spd: [null,null,null,null,null],
  tend, rt, inpit: false, fast: false, drv: 'X', veh: 'Y', klass: 'BMW M240i' });

const NOW = 24076.2;                       // snapshot TOD of the poll under test

/* ---- 1. cold load, stale carry-over (#650: 23.4s into lap 2, row still holds
       lap 1's four splits — the field is not cleared at the line) ---- */
{
  resetAnch();
  const prev = row('650', 1, [75.779, 73.933, 135.591, 213.851, null], NOW - 23.4, 553.951);
  const cur  = row('650', 2, [75.779, 73.933, 135.591, 213.851, null], NOW, 553.951);
  anchorLiveRows([prev, cur], NOW);
  check('#650 anchors lap 2 at the previous lap row\'s frozen stamp', near(cur.t0, NOW - 23.4), cur.t0);
  check('#650 drops all four carried-over splits', cur.s.every(x => x === null), cur.s);
  check('#650 leaves the finished lap 1 row untouched', prev.t0 === undefined && prev.s[0] === 75.779, prev.s);
}

/* ---- 2. cold load, genuine progress (#17: 78.8s into lap 2, its own new S1
       has landed and is reachable) ---- */
{
  resetAnch();
  const prev = row('17', 1, [65.902, 62.77, 117.659, 185.291, null], NOW - 78.8, 480.358);
  const cur  = row('17', 2, [67.449, null, null, null, null], NOW, 480.358);
  anchorLiveRows([prev, cur], NOW);
  check('#17 anchors lap 2 at the crossing', near(cur.t0, NOW - 78.8), cur.t0);
  check('#17 keeps its real S1 (reachable by now)', cur.s[0] === 67.449, cur.s);
}

/* ---- 3. no previous lap: back-compute from a WITNESSED split. Poll 1 has no
       S1 for this out-lap, poll 2 does -> the crossing happened between them ---- */
{
  resetAnch();
  const p1 = row('494', 0, [null, null, null, null, null], NOW - 5);
  anchorLiveRows([p1], NOW - 5);
  check('first sight of a car latches nothing', p1.t0 === undefined, p1.t0);
  const p2 = row('494', 0, [78.553, null, null, null, null], NOW);
  anchorLiveRows([p2], NOW);
  check('#494 back-computes lap start from the witnessed S1', near(p2.t0, NOW - 78.553), p2.t0);
  check('#494 keeps the witnessed S1', p2.s[0] === 78.553, p2.s);
}

/* ---- 4. a witnessed lap tick beats the previous-lap stamp ---- */
{
  resetAnch();
  const a1 = row('999', 1, [83.623, 81.729, 145.651, 230.139, null], NOW - 30, 599.497);
  anchorLiveRows([a1], NOW - 30);
  const b0 = row('999', 1, [83.623, 81.729, 145.651, 230.139, null], NOW - 10, 599.497);
  const b1 = row('999', 2, [83.623, 81.729, 145.651, 230.139, null], NOW, 599.497);   // carry-over
  anchorLiveRows([b0, b1], NOW);
  check('#999 anchors lap 2 at the witnessed tick', near(b1.t0, NOW), b1.t0);
  check('#999 drops the carried-over splits', b1.s.every(x => x === null), b1.s);
}

/* ---- 4b. a crossing published as a VALUE CHANGE over carried-over splits is
       witnessed too — the field is never empty, so presence alone misses it ---- */
{
  resetAnch();
  const carried = [83.623, 81.729, 145.651, 230.139, null];        // still lap 1's splits
  anchorLiveRows([row('943', 2, carried, NOW - 60, 599.497)], NOW - 60);
  const cur = row('943', 2, [79.100, 81.729, 145.651, 230.139, null], NOW, 599.497);  // real new S1 lands
  anchorLiveRows([cur], NOW);
  check('#943 witnesses the S1 crossing as a value change', near(cur.t0, NOW - 79.1), cur.t0);
  check('#943 keeps its new S1, drops the splits still carried over',
        cur.s[0] === 79.1 && cur.s[1] === null, cur.s);
}

/* ---- 4c. a lap that contains a STOP: the line crossing is real but the splits
       did not start there, so it must not be used as the anchor. Real case,
       #22 on 2026-09-12: crossed to start lap 2 at 24433.6, stood in the box
       639s, then ran S1-S3. Anchored at the line it read as 903s silent and
       got parked on the pit line while it was circulating. ---- */
{
  resetAnch();
  const NOW22 = 25337, LINE = 24433.6, s = [69.2, 67.1, 128.0];
  const prev = row('22', 1, [66.2, 64.3, 115.9, 182.5, null], LINE, 428.9);
  // cold load: only the line crossing is available, and it is not credible
  const cold = row('22', 2, [s[0], s[1], null, null, null], NOW22, 428.9);
  anchorLiveRows([prev, cold], NOW22);
  check('#22 refuses an incredible line anchor rather than parking a running car',
        cold.t0 === undefined, cold.t0);
  // next poll publishes S3 -> witnessed, and that anchor is trusted
  const seen = row('22', 2, [s[0], s[1], s[2], null, null], NOW22 + 5, 428.9);
  anchorLiveRows([prev, seen], NOW22 + 5);
  check('#22 anchors on the witnessed S3, not on the line',
        near(seen.t0, NOW22 + 5 - (s[0] + s[1] + s[2])), seen.t0);
  check('#22 now reads as just past S3, not silent for 900s',
        NOW22 + 5 - (seen.t0 + s[0] + s[1] + s[2]) < 1, seen.t0);
}

/* ---- 4d. two cars whose splits land in the SAME poll must not collapse onto
       one point: once anchored, each is carried forward over its own published
       split durations, so their next boundary differs by real seconds. Real
       case, 2026-09-12: five cars all pinned to 26138.3 with S3 times spanning
       155-180s, drawn on top of each other. ---- */
{
  resetAnch();
  const t = 26000;
  // both witnessed S1 in the same poll (same anchor granularity)...
  anchorLiveRows([row('10', 3, [null, null, null, null, null], t - 5, 500),
                  row('447', 2, [null, null, null, null, null], t - 5, 500)], t - 5);
  anchorLiveRows([row('10', 3, [76, null, null, null, null], t, 500),
                  row('447', 2, [83, null, null, null, null], t, 500)], t);
  // ...then both publish S2 + S3 in one later poll, with different times
  const a = row('10',  3, [76, 77, 165, null, null], t + 250, 500);
  const b = row('447', 2, [83, 82, 180, null, null], t + 250, 500);
  anchorLiveRows([a, b], t + 250);
  const s3a = a.t0 + 76 + 77 + 165, s3b = b.t0 + 83 + 82 + 180;
  check('#10 and #447 do not share an S3 crossing', Math.abs(s3a - s3b) > 10, { s3a, s3b });
  // both S1 crossings are pinned to the one poll that witnessed them, so the two
  // cars diverge by exactly the splits run SINCE that shared anchor — S2 + S3
  check('their S3 crossings differ by the splits run since the shared anchor',
        near(s3b - s3a, (82 + 180) - (77 + 165), 0.5), s3b - s3a);
}

/* ---- 5. no evidence at all -> row left exactly as it was (old behaviour) ---- */
{
  resetAnch();
  const only = row('520', 0, [79.25, null, null, null, null], NOW);
  anchorLiveRows([only], NOW);
  check('lap-0 car on a cold load is left untouched', only.t0 === undefined && only.s[0] === 79.25, only);
}

/* ---- 6. end to end through buildLiveDB. The unanchored feed breaks the map in
       TWO different ways depending on whether the car has a lap time yet, and
       one anchor fixes both. T is the render clock, frontier - LIVE_BUFFER_S. ---- */
{
  const geom = JSON.parse(readFileSync(join(here, '..', 'tools', 'geom.json'), 'utf8'));
  const LIVE_BUFFER_S = 8, LIVE_RUNNING_WINDOW_S = 360;   // index.html:3714 / :892
  const T = NOW - LIVE_BUFFER_S;
  const build = rows => buildLiveDB(rows, geom, { name: 'T', date: '2026-09-12' });
  const lastEnd = db => { const l = db.legs['650']; return l[l.length - 1][3]; };

  /* mode A — out-lap, no lap time yet (rt null -> rt = sum of known sectors), so
     the walk lays the known sectors out to end exactly at the snapshot: the car
     is pinned ~LIVE_BUFFER_S short of the boundary and activeLeg always finds a
     leg covering T, so §15.4a's prediction never gets to run. */
  {
    resetAnch();
    const mk = () => [row('650', 0, [75.779, 73.933, null, null, null], NOW, null)];
    const bEnd = lastEnd(build(mk()));
    check('BEFORE (out-lap): last leg ends exactly at the snapshot time', near(bEnd, NOW, 0.2), bEnd);
    check('BEFORE (out-lap): T sits inside that leg, so the car never predicts', T < bEnd, { T, bEnd });
  }

  /* mode B — lap time known, so rt is the PREVIOUS lap's time and the walk
     assumes this lap started exactly one lap time ago. The known sectors land at
     the front of that window, leaving the car "overdue" by the remainder — past
     LIVE_RUNNING_WINDOW_S it is parked on the pit line and badged DELAY. */
  {
    resetAnch();
    const mk = () => [row('650', 1, [75.779, 73.933, 135.591, 213.851, 54.797], NOW - 200, 553.951),
                      row('650', 2, [75.779, 73.933, null, null, null], NOW, 553.951)];
    const bEnd = lastEnd(build(mk()));
    check('BEFORE (mid-race): last leg ends a whole lap-remainder in the past',
          near(bEnd, NOW - 553.951 + 149.712, 0.2), bEnd);
    check('BEFORE (mid-race): car reads as stopped, parked on the pit line',
          T - bEnd > LIVE_RUNNING_WINDOW_S, { overdueBy: T - bEnd });

    const rows = mk(); anchorLiveRows(rows, NOW);
    const aEnd = lastEnd(build(rows));
    // lap 2 started at NOW-200; S1 75.779 + S2 73.933 = 149.712 -> S2 exit at NOW-50.3
    check('AFTER: last leg ends at the real S2 crossing', near(aEnd, NOW - 200 + 149.712, 0.2), aEnd);
    check('AFTER: T is past the crossing by a plausible slice of S3, so it predicts',
          T > aEnd && T - aEnd < LIVE_RUNNING_WINDOW_S, { intoNextSector: T - aEnd });
  }
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — LIVE rows anchor to real crossings');
process.exit(failures ? 1 : 0);
