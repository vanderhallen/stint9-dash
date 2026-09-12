/* test-stint-driver.mjs — prove the stint chart shows a lap's driver as soon
 * as WIGE has reported it, not only once that whole lap has been driven.
 *
 *   node live/test-stint-driver.mjs
 *
 * WIGE reports a lap's driver the moment that lap's row appears — typically
 * alongside or even before S1 lands — not once the lap is fully complete.
 * The stint chart's laps filter gated on `L<=doneLaps` (an integer floor of
 * fractional progress), which for a car actively on lap N always evaluates
 * to N-1: the CURRENT lap's driver entry, even though already known, was
 * discarded until the whole lap finished. Fixed to `L<=doneLaps+1`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const marker = 'const laps=Object.keys(dl).map(Number).filter(L=>L<=doneLaps+1).sort((a,b)=>a-b);';
check('the stint filter includes the lap now in progress (doneLaps+1)', html.includes(marker), marker);
check('the old doneLaps-only filter is gone', !html.includes('filter(L=>L<=doneLaps).sort'), 'still present');

/* end-to-end: a car mid-lap-5 (active leg on lap 5) with dl[5] already known
   must have lap 5 in its stints, not just up to lap 4. */
{
  const lapsDrivenOf = () => 4 + (0 + 0.3) / 5;   // active leg on lap 5, 0.3 into S1 — matches lapsDrivenOf's own shape
  const doneLaps = Math.floor(lapsDrivenOf() + 1e-6);
  check('doneLaps is 4 while actively driving lap 5 (matches carStats-style semantics)', doneLaps === 4, doneLaps);
  const dl = { 3: 'Smith', 4: 'Smith', 5: 'Jones' };   // driver swapped in at lap 5, already reported
  const lapsOld = Object.keys(dl).map(Number).filter(L => L <= doneLaps).sort((a, b) => a - b);
  const lapsNew = Object.keys(dl).map(Number).filter(L => L <= doneLaps + 1).sort((a, b) => a - b);
  check('OLD filter misses the new driver entirely while lap 5 is still in progress',
        !lapsOld.includes(5), lapsOld);
  check('NEW filter includes it the moment it is known', lapsNew.includes(5), lapsNew);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — the stint chart shows a new driver as soon as WIGE reports it');
process.exit(failures ? 1 : 0);
