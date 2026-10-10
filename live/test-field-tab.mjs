/* test-field-tab.mjs — FIELD reel: class cars P1→Px, current-lap sectors.
 *
 *   node live/test-field-tab.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const nPanels = (html.match(/<div class="reelpanel"/g) || []).length;
const reeln = html.match(/const REELN=(\d+);/);
check('REELN matches the number of .reelpanel nodes', reeln && +reeln[1] === nPanels, { REELN: reeln && reeln[1], nPanels });
check('FIELD panel markup exists', html.includes('id="fieldtabwrap"'), true);
check('paintReel draws FIELD at index 23', html.includes('if(idx===23||all)renderFieldTab(T);'), true);
const names = html.match(/var NAMES=\[([^\]]+)\]/);
const list = names ? names[1].split(',').map(s => s.replace(/['"]/g, '').trim()) : [];
check('NAMES[23] is FIELD', list[23] === 'FIELD', list[23]);
check('REELLBL maps fieldtabwrap to FIELD', /fieldtabwrap:'FIELD'/.test(html), true);

const a = html.indexOf('function predFromPrev(cells,laps){');
const b = html.indexOf('\nfunction renderSecTab(T){', a);
if (a < 0 || b < 0) { console.error('FAIL — could not find fieldTabData'); process.exit(1); }
const src = html.slice(a, b);

function run(T, { cars, pos, legs, sectimes, bx }) {
  const DB = { cars, sectimes };
  const BX = bx;
  const maxN = 10;
  const livePos = () => pos;
  const activeLeg = (st) => legs[st] && legs[st].active;
  const lastStartedLeg = (st) => legs[st] && legs[st].last;
  const curDrv = (st) => ({ 667: 'Mulready', 670: 'Reinhard' }[st] || '');
  const fn = new Function('DB', 'BX', 'maxN', 'livePos', 'activeLeg', 'lastStartedLeg', 'curDrv',
    `${src}; return fieldTabData;`);
  return fn(DB, BX, maxN, livePos, activeLeg, lastStartedLeg, curDrv)(T);
}

const L3 = [76.8, 75.4, 155.8, 224.3, 57.0];
const L4part = [76.0, 73.5, 137.7, null, null];
function bxFor(L, n) {
  const m = {};
  for (let k = 1; k <= n; k++) m[(L - 1) * 5 + k] = 1000 + k;
  return m;
}

{
  const rows = run(2000, {
    cars: ['670', '667'],
    pos: { 667: 1, 670: 2 },
    legs: {
      667: { active: [4, 3, 0, 2000], last: [4, 3, 0, 2000] },
      670: { active: [4, 3, 0, 2000], last: [4, 3, 0, 2000] }
    },
    sectimes: {
      667: { 3: L3, 4: L4part },
      670: { 3: [88, 82, 164, 224, 57], 4: [76.6, 74.1, 161.4, null, null] }
    },
    bx: {
      667: Object.assign(bxFor(3, 5), bxFor(4, 3)),
      670: Object.assign(bxFor(3, 5), bxFor(4, 3))
    }
  });
  check('P1 is on top', rows[0].st === '667' && rows[0].pos === 1, rows.map(r => r.st + ' P' + r.pos));
  check('P2 is next', rows[1].st === '670' && rows[1].pos === 2, rows[1]);
  check('rows are the current lap (4), not the previous', rows[0].L === 4 && rows[1].L === 4, rows.map(r => r.L));
  check('S1–S3 of the current lap are filled', rows[0].vals[0] === 76.0 && rows[0].vals[2] === 137.7, rows[0].vals);
  check('S4/S5 of the current lap are still empty', rows[0].vals[3] == null && rows[0].vals[4] == null, rows[0].vals);
  check('predicted LAP uses previous-lap S4/S5', Math.abs(rows[0].totPred - (76+73.5+137.7+224.3+57)) < 0.05, rows[0].totPred);
  check('completed current lap would have no totPred — incomplete has totPred not tot', rows[0].tot == null && rows[0].totPred != null, { tot: rows[0].tot, totPred: rows[0].totPred });
}

{
  const rows = run(3000, {
    cars: ['667'],
    pos: { 667: 1 },
    legs: { 667: { active: [5, 1, 0, 3000], last: [5, 1, 0, 3000] } },
    sectimes: { 667: { 4: L3, 5: [70, null, null, null, null] } },
    bx: { 667: Object.assign(bxFor(4, 5), bxFor(5, 1)) }
  });
  check('starting the next lap refreshes the table onto that lap', rows[0].L === 5 && rows[0].vals[0] === 70 && rows[0].vals[1] == null, rows[0]);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — FIELD reel is P1→Px current-lap sector times');
process.exit(failures ? 1 : 0);
