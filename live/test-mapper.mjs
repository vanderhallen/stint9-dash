/* test-mapper.mjs — replay-harness unit test for the WIGE-message → row mapper.
 * ===========================================================================
 * The stint9 owner's review (2026-07-14) asked for a harness that pipes raw WIGE
 * snapshots through our mapper and asserts correct rows, so a parser regression
 * is caught off-line (the WIGE feed is dark outside race weekends).
 *
 * This exercises the ACTUAL mapSnapshot / acceptEvent / lapEndTod from
 * vds-relay.mjs (imported, not reimplemented) against synthetic snapshots that
 * reproduce the review's scenarios:
 *   1. normal lap with all sectors + root TOD  (P1-4)
 *   2. pit-in lap: empty S5 / '-' / missing fields  (parser robustness)
 *   3. wrong-series snapshot rejected by TRACKNAME gate  (P1-2)
 *   4. feed-driven sector count via NROFINTERMEDIATETIMES  (P2)
 *
 *   node live/test-mapper.mjs        (exit 0 = all pass)
 * ===========================================================================
 */
import { mapSnapshot, acceptEvent } from './vds-relay.mjs';

let pass = 0, fail = 0;
const approx = (a, b, eps = 0.01) => a != null && b != null && Math.abs(a - b) < eps;
function ok(name, cond, got) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, '— got', JSON.stringify(got)); } }

// root TOD = 12:00:00 as epoch-ms for today (mapper converts to seconds-of-day = 43200)
const noonMs = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const ED = '2026-07-14';

// --- Scenario 1 + 4: normal lap, all sectors, root TOD, feed sector count ------
console.log('scenario 1/4: normal lap + root TOD + NROFINTERMEDIATETIMES');
{
  const msg = {
    TRACKNAME: 'Nürburgring Nordschleife', SESSION: 'NLS', HEAT: 3, TOD: noonMs,
    NROFINTERMEDIATETIMES: 5,
    RESULT: [{ STNR: '941', CLASSNAME: 'SP9 PRO', NAME: 'Mustermann', CAR: 'Porsche 911 GT3 R',
               LAPS: 15, LASTLAPTIME: '8:12.345', S1TIME: '86.2', S2TIME: '90.1', S3TIME: '175.3', S4TIME: '120.4', S5TIME: '61.9' }] };
  const rows = mapSnapshot(msg, ED);
  const r = rows[0];
  ok('one row emitted', rows.length === 1, rows.length);
  ok('car/lap parsed', r.car === '941' && r.lap === 15, [r.car, r.lap]);
  ok('lap_end_tod from ROOT TOD (43200s), not receipt time', approx(r.lap_end_tod, 43200), r.lap_end_tod);
  ok('lap_time = LASTLAPTIME 8:12.345 = 492.345s', approx(r.lap_time, 492.345), r.lap_time);
  ok('sectors s1..s5 parsed', approx(r.s1, 86.2) && approx(r.s5, 61.9), [r.s1, r.s5]);
}

// --- Scenario 2: pit-in lap — empty/'-'/missing sector fields ------------------
console.log("scenario 2: pit-in lap (empty S5, '-' S4, missing S3)");
{
  const msg = {
    TRACKNAME: 'Nordschleife', TOD: noonMs, NROFINTERMEDIATETIMES: 5,
    RESULT: [{ STNR: '7', CLASSNAME: 'SP9', LAPS: 22, LASTLAPTIME: '',
               S1TIME: '85.0', S2TIME: '89.9', /* S3 missing */ S4TIME: '-', S5TIME: '' }] };
  const r = mapSnapshot(msg, ED)[0];
  ok('row still emitted (car placed on track)', !!r, r);
  ok('s1/s2 kept', approx(r.s1, 85.0) && approx(r.s2, 89.9), [r.s1, r.s2]);
  ok('missing S3 → null', r.s3 === null, r.s3);
  ok("'-' S4 → null", r.s4 === null, r.s4);
  ok('empty S5 → null', r.s5 === null, r.s5);
  ok('empty LASTLAPTIME → null lap_time', r.lap_time === null, r.lap_time);
  ok('lap_end_tod still from root TOD', approx(r.lap_end_tod, 43200), r.lap_end_tod);
}

// --- Scenario 3: P1-2 wrong-series gate ---------------------------------------
console.log('scenario 3: P1-2 TRACKNAME gate rejects a concurrent non-NLS series');
{
  ok('accepts Nürburgring', acceptEvent({ TRACKNAME: 'Nürburgring Nordschleife' }), true);
  ok('accepts Nordschleife', acceptEvent({ TRACKNAME: '24h Nordschleife' }), true);
  ok('rejects Hockenheim', !acceptEvent({ TRACKNAME: 'Hockenheimring' }), false);
  ok('rejects empty track', !acceptEvent({ TRACKNAME: '' }), false);
}

// --- Scenario 4b: feed says 3 sectors → S4/S5 not read even if present ---------
console.log('scenario 4b: NROFINTERMEDIATETIMES=3 caps sectors (ignore stray S4/S5)');
{
  const msg = {
    TRACKNAME: 'Nordschleife', TOD: noonMs, NROFINTERMEDIATETIMES: 3,
    RESULT: [{ STNR: '1', LAPS: 2, S1TIME: '40', S2TIME: '41', S3TIME: '42', S4TIME: '99', S5TIME: '99' }] };
  const r = mapSnapshot(msg, ED)[0];
  ok('s1..s3 read', approx(r.s1, 40) && approx(r.s3, 42), [r.s1, r.s3]);
  ok('s4 forced null (feed=3 sectors)', r.s4 === null, r.s4);
  ok('s5 forced null (feed=3 sectors)', r.s5 === null, r.s5);
}

// --- Scenario 5: TOD absent → falls back to receipt time (not null/crash) ------
console.log('scenario 5: root TOD absent → receipt-time fallback, no crash');
{
  const r = mapSnapshot({ TRACKNAME: 'Nordschleife', RESULT: [{ STNR: '5', LAPS: 1, S1TIME: '30' }] }, ED)[0];
  ok('lap_end_tod is a finite fallback (not null)', Number.isFinite(r.lap_end_tod), r.lap_end_tod);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} mapper test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
