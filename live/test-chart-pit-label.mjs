/* test-chart-pit-label.mjs — prove the POS chart's "PIT N" label uses the
 * trusted pitLapsOf() heuristic, not the raw (sparse) DB.pits feed flag.
 *
 *   node live/test-chart-pit-label.mjs
 *
 * WIGE's inpit flag is sparse (wige-scrape's PITSTOPCOUNT diff rarely fires —
 * README §18), so DB.pits alone silently under-reports. Confirmed live
 * 2026-09-12: 23 of 131 cars had genuinely pitted (an out-lap S1 several
 * times a normal one) yet showed no PIT label at all — #650's lap7 S1 was
 * 198.8s against a steady ~76s every other lap, DB.pits['650'] was [], and
 * pitLapsOf('650') correctly found [6].
 */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

check('the PIT label reads pitLapsOf(st), not raw DB.pits[st]',
      html.includes('const ptx=CPIT[st];if(ptx){const curL=(last[0]>=maxN-0.001)?maxN:Math.floor(last[0]);let np=0;const pa=pitLapsOf(st);'),
      'old DB.pits[st] source still present, or line changed unexpectedly');
check('the raw DB.pits[st] source is gone from this line',
      !html.includes("let np=0;const pa=DB.pits[st]||[];for(const l of pa)if(l<=curL)np++;"),
      'still reading the sparse raw feed source');

/* end to end: reproduce #650's real numbers -- pitLapsOf finds the stop from
   the out-lap S1, DB.pits (raw) does not, and the label logic must follow
   whichever pitLapsOf() reports. */
{
  const pitStart = html.indexOf('let _pitLapCache={};');
  const pitLapsOfSrc = html.slice(pitStart, html.indexOf('\n}', html.indexOf('return (_pitLapCache[st]', pitStart)) + 2);
  const secRefEndMark = '\n  return (av&&av[k-1])||0;}';
  const secRefSrc = html.slice(html.indexOf('function secRef(st,k){'), html.indexOf(secRefEndMark) + secRefEndMark.length);
  const legs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(L => {
    const s1 = L === 7 ? 198.8 : 76.0;   // #650's real shape: one inflated out-lap S1
    const t0 = (L - 1) * 560;
    return [L, 1, t0, t0 + s1, null];
  });
  const DB = { pits: { 650: [] }, legs: { 650: legs }, avgseg: [0, 76, 0, 0, 0, 0] };
  const pitLapsOf = new Function('DB', `${pitLapsOfSrc};${secRefSrc};return pitLapsOf;`)(DB);
  const heur = pitLapsOf('650');
  check("pitLapsOf finds #650's real stop (lap6, the in-lap before the inflated S1)",
        heur.length === 1 && heur[0] === 6, heur);
  check('raw DB.pits stays empty (this is exactly what silently produced no label)',
        (DB.pits['650'] || []).length === 0, DB.pits['650']);
  // reproduce the label line's own counting loop against curL=10 (all 10 laps driven)
  let np = 0; for (const l of pitLapsOf('650')) if (l <= 10) np++;
  check('the label the fixed code computes is "PIT 1", not blank', np === 1, np);
}

console.log(failures ? `\n❌ ${failures} FAILED` : "\n✅ PASS — the chart's PIT label reflects real stops, not just ones WIGE happened to flag");
process.exit(failures ? 1 : 0);
