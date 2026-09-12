/* test-rn-persist.mjs — prove a new sector crossing for the racenote car does
 * NOT wipe already-detected auto-notes (overtakes, fastest, gap, pit).
 *
 *   node live/test-rn-persist.mjs
 *
 * rnEnsure's cache key used to be one token including the car's OWN leg
 * count, so it changed on every single sector this car crossed (every
 * ~70-220s). Each change wiped rnNotes/rnSeen and relied on an async
 * DB-notes fetch + rnDetect to regenerate everything — but a fresh reset
 * supersedes an in-flight one before its callback resolves, so under the
 * steady drip of new sectors the callback's own render() call was routinely
 * stale and skipped. Confirmed live 2026-09-12: an early overtake (#670
 * passed #652 on lap 0) showed once, then vanished as #670 kept lapping,
 * while a brand-new overtake minutes later appeared fine.
 *
 * Fix: split into an identity token (car+event — this alone should wipe and
 * reload) and a data token (+ leg/class counts — this should only rebuild
 * rnBX/rnLegs). This test drives rnEnsure itself, twice, with the SAME car
 * and event but a grown DB.legs — the second call must leave rnNotes alone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const a = html.indexOf('function rnEnsure(){');
const endMark = "if(!rnLive()){rnLoaded=true;rnRenderFeed();return;}   // SIM: ephemeral, don't load from DB\n";
const b = html.indexOf(endMark, a);
if (a < 0 || b < 0) { console.error('FAIL — could not find rnEnsure() in index.html'); process.exit(1); }
const src = html.slice(a, b + endMark.length) + '}\n';   // close the function here; the LIVE-only fetch tail is irrelevant to this test (rnLive()=false path)

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

function makeEnv(DB) {
  let rnClass = null, rnCars = [], rnBX = {}, rnLegs = {}, rnTok = null, rnIdentTok = null, rnCar = null;
  let rnNotes = ['SENTINEL_EARLIER_OVERTAKE'], rnSeen = new Set(['ot|0|3|652|g']), rnPosted = new Set();
  let rnLoaded = false, renderCalls = 0;
  const withPitS5 = (car, legs) => legs;   // stub: not exercised by this test
  const rnLive = () => false;              // SIM path: skips the async DB fetch entirely, which is fine —
                                            // this test is about whether the WIPE happens, not the refetch
  const rnRenderFeed = () => {};
  const fn = new Function('DB', 'selCar', 'withPitS5', 'rnLive', 'rnRenderFeed', 'render', `
    let rnClass, rnCars, rnBX, rnLegs, rnTok, rnIdentTok, rnCar, rnNotes, rnSeen, rnPosted, rnLoaded;
    return function(state){
      ({rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded}=state);
      ${src}
      rnEnsure();
      return {rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded};
    };`)(DB, null, withPitS5, rnLive, rnRenderFeed, () => { renderCalls++; });
  return { fn, state: () => ({ rnClass, rnCars, rnBX, rnLegs, rnTok, rnIdentTok, rnCar, rnNotes, rnSeen, rnPosted, rnLoaded }),
           getRenderCalls: () => renderCalls };
}

/* ---- same car/event, DB.legs grows (a new sector crossed) -> notes survive ---- */
{
  let selCarRef = '670';
  const DB = { event: { date: '2026-09-12' }, classes: { M240i: ['650', '670'] },
               legs: { 670: [[0, 2, 0, 77]] } };
  const env = makeEnv(DB);
  // simulate the module-scope `selCar` the real rnEnsure reads
  global.selCar = selCarRef;
  let state = { rnNotes: ['SENTINEL_EARLIER_OVERTAKE'], rnSeen: new Set(['ot|0|3|652|g']), rnPosted: new Set(),
                rnTok: null, rnIdentTok: null, rnLoaded: false, rnClass: null, rnCars: [], rnBX: {}, rnLegs: {} };
  // first call: establishes identity, would normally fetch from the DB (rnLive()=false short-circuits that)
  const fn1 = new Function('DB', 'selCar', 'withPitS5', 'rnLive', 'rnRenderFeed', 'render', `
    let rnClass, rnCars, rnBX, rnLegs, rnTok, rnIdentTok, rnCar, rnNotes, rnSeen, rnPosted, rnLoaded;
    ({rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded}=arguments[6]);
    ${src}
    rnEnsure();
    return {rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded};`);
  state = fn1(DB, selCarRef, (c, legs) => legs, () => false, () => {}, () => {}, state);
  check('first call (new identity) resets notes, as before', state.rnNotes.length === 0, state.rnNotes);

  // seed as if rnDetect had since found the earlier overtake
  state.rnNotes = ['EARLIER_OVERTAKE_NOTE'];
  state.rnSeen = new Set(['ot|0|3|652|g']);

  // a NEW sector lands for #670 — DB.legs[670] grows, identity (car+event) unchanged
  DB.legs['670'].push([0, 3, 77, 220]);
  const fn2 = new Function('DB', 'selCar', 'withPitS5', 'rnLive', 'rnRenderFeed', 'render', `
    let rnClass, rnCars, rnBX, rnLegs, rnTok, rnIdentTok, rnCar, rnNotes, rnSeen, rnPosted, rnLoaded;
    ({rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded}=arguments[6]);
    ${src}
    rnEnsure();
    return {rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded};`);
  state = fn2(DB, selCarRef, (c, legs) => legs, () => false, () => {}, () => {}, state);

  check('a new leg for the SAME car/event does NOT wipe rnNotes',
        state.rnNotes.length === 1 && state.rnNotes[0] === 'EARLIER_OVERTAKE_NOTE', state.rnNotes);
  check('rnSeen (display dedup) is likewise untouched',
        state.rnSeen.has('ot|0|3|652|g'), [...state.rnSeen]);
  check('rnLegs was still rebuilt to include the new leg',
        (state.rnLegs['670'] || []).length === 2, state.rnLegs['670']);

  // a DIFFERENT car is selected -> identity changes -> full reset IS expected
  const fn3 = new Function('DB', 'selCar', 'withPitS5', 'rnLive', 'rnRenderFeed', 'render', `
    let rnClass, rnCars, rnBX, rnLegs, rnTok, rnIdentTok, rnCar, rnNotes, rnSeen, rnPosted, rnLoaded;
    ({rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded}=arguments[6]);
    ${src}
    rnEnsure();
    return {rnClass,rnCars,rnBX,rnLegs,rnTok,rnIdentTok,rnCar,rnNotes,rnSeen,rnPosted,rnLoaded};`);
  DB.legs['650'] = [[0, 1, 0, 80]];
  state = fn3(DB, '650', (c, legs) => legs, () => false, () => {}, () => {}, state);
  check('switching to a DIFFERENT car DOES reset notes', state.rnNotes.length === 0, state.rnNotes);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — new sector data never wipes already-detected racenotes for the same car/event');
process.exit(failures ? 1 : 0);
