/* test-selstint.mjs — prove the selected-car stint bar overlay computes
 * driver segments correctly, scoped to one car only.
 *
 *   node live/test-selstint.mjs
 *
 * Same driver/lap-count segmentation as the STINT reel (renderStints), just
 * for one car and drawn as an HTML overlay (.selstint) inside the PACE reel
 * (#ltgraph) instead of that reel's own SVG. An earlier version placed this
 * on the main map instead — corrected 2026-09-12 per "the bar is placed on
 * the wrong position, I wanted the bar in the reel, not on the track map".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

check('.selstint overlay markup is present inside the PACE reel (#ltgraph), not the map',
      html.includes('<div class="reelpanel" style="position:relative"><svg id="ltgraph"></svg><div class="selstint" id="selstint" style="display:none"></div></div>'),
      'not found in the PACE reelpanel');
check('renderSelStint is called from renderLapTrace, not from the map\'s render() block',
      html.includes("function renderLapTrace(T){const svg=document.getElementById('ltgraph');if(!svg)return;svg.setAttribute('viewBox','0 0 1000 '+CH);\n  renderSelStint(T);"),
      'call site not found at the top of renderLapTrace');
check('renderSelStint is NOT still wired into the map\'s per-frame block',
      !html.includes("badge.style.display='flex';\n    renderSelStint(T);}"), 'old map call site still present');

const a = html.indexOf('function renderSelStint(T){');
const b = html.indexOf('\nfunction renderStints(T){', a);
if (a < 0 || b < 0) { console.error('FAIL — could not find renderSelStint() in index.html'); process.exit(1); }
const src = html.slice(a, b);

function makeDom(el) {
  global.document = { getElementById: id => id === 'selstint' ? el : null };
}
function makeEl() { return { style: {}, innerHTML: '' }; }

/* ---- no car selected: hidden, empty ---- */
{
  const el = makeEl();
  makeDom(el);
  const fn = new Function('selCar', 'activeLeg', 'BX', 'DB', 'driverColor', `${src}; return renderSelStint;`)(
    '', () => null, {}, { drvlap: {} }, () => '#000');
  fn(1e9);
  check('no car selected -> hidden and empty', el.style.display === 'none' && el.innerHTML === '', el);
}

/* ---- a car mid-way through its 3rd lap, one driver swap already known ----
   Real-shaped case: Smith drove laps 1-2, Jones took over for lap 3 (already
   known to WIGE, car is only partway through it) -- both segments should
   show, Jones' partial segment reflecting the car's actual fractional
   progress, not waiting for lap 3 to finish. */
{
  const el = makeEl();
  makeDom(el);
  const DB = { drvlap: { 42: { 1: 'Smith', 2: 'Smith', 3: 'Jones' } } };
  const activeLeg = () => [3, 2, 1000, 1075];   // lap 3, sector 2, mid-leg
  const BX = {};
  const colors = { Smith: '#2f5fd0', Jones: '#e0301e' };
  const fn = new Function('selCar', 'activeLeg', 'BX', 'DB', 'driverColor', `${src}; return renderSelStint;`)(
    '42', activeLeg, BX, DB, d => colors[d]);
  fn(1030);   // 30s into a 75s S2 leg -> 40% through sector 2 of lap 3
  check('two driver segments render', el.innerHTML.includes('Smith') && el.innerHTML.includes('Jones'), el.innerHTML);
  check('Smith\'s segment covers exactly 2 laps', /Smith.*2 laps/.test(el.innerHTML.replace(/\n/g, ' ')), el.innerHTML);
  check('Jones\' in-progress lap is included even though lap 3 has not finished',
        /Jones.*1 lap\b/.test(el.innerHTML.replace(/\n/g, ' ')), el.innerHTML);
  check('the bar is shown', el.style.display === 'flex', el.style.display);
}

/* ---- a single-driver car (no stint change at all) still renders one
   segment, not nothing ---- */
{
  const el = makeEl();
  makeDom(el);
  const DB = { drvlap: { 42: { 1: 'Solo', 2: 'Solo' } } };
  const activeLeg = () => [2, 5, 1000, 1050];
  const fn = new Function('selCar', 'activeLeg', 'BX', 'DB', 'driverColor', `${src}; return renderSelStint;`)(
    '42', activeLeg, {}, DB, () => '#123456');
  fn(1030);
  check('a single-driver stint still renders one segment', el.innerHTML.includes('Solo'), el.innerHTML);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — the selected-car stint bar segments correctly, including an in-progress driver change');
process.exit(failures ? 1 : 0);
