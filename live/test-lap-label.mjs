/* test-lap-label.mjs — human lap labels start at 1 for both numbering schemes.
 *
 *   node live/test-lap-label.mjs
 *
 * NLS7–9 archives store WIGE LAPS as-is (first flying lap = 0). From NLS10
 * ingest adds +1 (first flying lap = 1). Display used to always show L+1, so
 * LIVE/NLS10 TIMES headers started at 2. lapLabel() picks the offset from
 * whether any car has a lap-0 row.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const a = html.indexOf('function lapLabel(L){');
const b = html.indexOf('\nfunction carStats(st,T){', a);
if (a < 0 || b < 0) { console.error('FAIL — could not find lapLabel() in index.html'); process.exit(1); }
const src = html.slice(a, b);

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

function labelsFor(sectimes, keys) {
  const window = { __lapOff: null };
  const DB = { sectimes };
  const lapLabel = new Function('window', 'DB', `${src}; return lapLabel;`)(window, DB);
  return keys.map(L => lapLabel(L));
}

{
  const got = labelsFor({ 670: { 1: [1], 2: [1] } }, [2, 1]);
  check('NLS10/LIVE (min lap 1): TIMES columns 2,1 display as 2,1', got[0] === 2 && got[1] === 1, got);
  check('…first flying lap is 1, not 2', labelsFor({ 670: { 1: [1] } }, [1])[0] === 1, labelsFor({ 670: { 1: [1] } }, [1]));
}

{
  const got = labelsFor({ 670: { 0: [1], 1: [1], 2: [1] } }, [2, 1, 0]);
  check('NLS9 archive (min lap 0): stored 2,1,0 display as 3,2,1', got[0] === 3 && got[1] === 2 && got[2] === 1, got);
}

{
  const nls10 = { 670: { 1: [76.8], 2: [88.1] } };
  const badge = L => labelsFor(nls10, [L])[0];
  check('carbadge on first stored lap (LIVE) is L1', badge(1) === 1, badge(1));
  check('carbadge on second stored lap (LIVE) is L2', badge(2) === 2, badge(2));
  const mLap = csL => Math.max(1, labelsFor(nls10, [csL + 1])[0]);
  check('LIVE mobile m_lap on first flying (cs.L=0) is L1', mLap(0) === 1, mLap(0));
  check('LIVE mobile m_lap on second flying (cs.L=1) is L2', mLap(1) === 2, mLap(1));
}

{
  const nls9 = { 665: { 0: [1], 1: [1] } };
  const mLap = csL => Math.max(1, labelsFor(nls9, [csL + 1])[0]);
  check('NLS9 mobile on first flying (cs.L=-1) is L1', mLap(-1) === 1, mLap(-1));
  check('NLS9 mobile on second flying (cs.L=0) is L2', mLap(0) === 2, mLap(0));
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — lap labels start at 1 for 0-based and 1-based data');
process.exit(failures ? 1 : 0);
