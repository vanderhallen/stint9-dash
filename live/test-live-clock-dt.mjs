/* test-live-clock-dt.mjs — LIVE map clock must keep 1x through iPad rAF hitches.
 *
 *   node live/test-live-clock-dt.mjs
 *
 * liveLoop used to `if(dt>0.5)dt=0`. On iPad that zeroes every coalesced frame
 * (~0.5–1.5s), so liveDispT never leaves the frontier, the dots freeze, and
 * liveTick still paints the LIVE clock + gap chart — the failure in the NLS10
 * iPad screenshot. Zero only after a real pause (>2s).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

check('liveLoop feeds dt through liveClockDt',
      /liveDispLast=ts;dt=liveClockDt\(dt\)/.test(html), true);
check('liveLoop no longer zeroes 0.5s hitches inline',
      !/liveDispLast=ts;if\(dt>0\.5\)dt=0/.test(html), true);

const src = html.match(/function liveClockDt\(dt\)\{[^}]+\}/);
if (!src) { console.error('FAIL — could not find liveClockDt()'); process.exit(1); }
const liveClockDt = new Function(`${src[0]}; return liveClockDt;`)();

check('a normal 60fps frame keeps its dt', liveClockDt(0.016) === 0.016, liveClockDt(0.016));
check('a 0.6s iPad hitch still advances the map (the old freeze)', liveClockDt(0.6) === 0.6, liveClockDt(0.6));
check('a 1.5s coalesced frame still advances 1x', liveClockDt(1.5) === 1.5, liveClockDt(1.5));
check('a 2s frame is still accepted (boundary)', liveClockDt(2) === 2, liveClockDt(2));
check('a tab-sleep gap is zeroed so cars do not skip forward', liveClockDt(2.5) === 0, liveClockDt(2.5));
check('zero / negative dt is zero', liveClockDt(0) === 0 && liveClockDt(-1) === 0, liveClockDt(-1));

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — LIVE map clock keeps 1x through iPad hitches');
process.exit(failures ? 1 : 0);
