/* test-pred-lap.mjs — in-progress TIMES column predicts remaining sectors
 * from the previous lap.
 *
 *   node live/test-pred-lap.mjs
 *
 * Lifts predFromPrev() out of index.html. The 2026-10-10 #670 case: L3 has
 * S1–S3, S4/S5 still dashes — those (and the LAP total) must come from L2
 * and be marked predicted, without touching L2's own actuals.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const a = html.indexOf('function predFromPrev(cells,laps){');
const b = html.indexOf('\nfunction renderSecTab(T){', a);
if (a < 0 || b < 0) { console.error('FAIL — could not find predFromPrev() in index.html'); process.exit(1); }
const predFromPrev = new Function(`${html.slice(a, b)}; return predFromPrev;`)();

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };
const near = (x, y) => x != null && Math.abs(x - y) < 0.05;

{
  const L2 = [88.1, 82.6, 164.0, 224.3, 57.0];           // 10:16.0
  const L3 = [76.8, 75.4, 155.8, null, null];
  const cells = {
    2: { vals: L2.slice(), tot: 616.0 },
    3: { vals: L3.slice() }
  };
  predFromPrev(cells, [2, 3]);
  check('S4 on L3 is L2\'s S4', near(cells[3].pred[3], 224.3), cells[3].pred[3]);
  check('S5 on L3 is L2\'s S5', near(cells[3].pred[4], 57.0), cells[3].pred[4]);
  check('S1–S3 stay actual (not predicted)', cells[3].pred[0]==null && cells[3].pred[1]==null && cells[3].pred[2]==null, cells[3].pred);
  check('predicted LAP = actual S1–S3 + L2 S4 + L2 S5', near(cells[3].totPred, 76.8+75.4+155.8+224.3+57.0), cells[3].totPred);
  check('L2 is unchanged (no pred, tot still 616)', cells[2].pred==null && near(cells[2].tot, 616), cells[2]);
}

{
  const cells = { 1: { vals: [80, 80, 160, null, null] } };
  predFromPrev(cells, [1]);
  check('first flying lap with no previous stays unpredicted', cells[1].pred==null && cells[1].totPred==null, cells[1]);
}

{
  const cells = {
    1: { vals: [80, 80, 160, 220, 50], tot: 590 },
    2: { vals: [78, 79, 158, 218, 49], tot: 582 }
  };
  predFromPrev(cells, [1, 2]);
  check('two complete laps get no predictions', cells[1].pred==null && cells[2].pred==null && cells[2].totPred==null, {1:cells[1].pred,2:cells[2].pred});
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — in-progress lap predicts remaining sectors from the previous lap');
process.exit(failures ? 1 : 0);
