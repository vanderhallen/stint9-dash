/* test-quali-grid.mjs — prove nls-driver-scrape's parseQuali() turns an
 * "Ergebnis Zeittraining" PDF into a correct starting grid, the same way
 * test-build-db.mjs proves build-db.js. Run locally before deploy:
 *
 *   deno run --allow-read --node-modules-dir=auto --allow-net --allow-env \
 *     live/test-quali-grid.mjs /tmp/2026-08-01t.pdf /tmp/2026-06-20t.pdf
 *
 * Imports parseQuali straight from the deployed source so the test exercises
 * the real parser (index.ts guards its Deno.serve behind import.meta.main).
 */
import { getDocumentProxy, extractText } from 'npm:unpdf';
import { readFileSync } from 'node:fs';
import { parseQuali } from './nls-driver-scrape/index.ts';

async function pdfText(path) {
  const buf = new Uint8Array(readFileSync(path));
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

let failures = 0;
function check(name, cond, got) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`);
}

const [p01 = '/tmp/2026-08-01t.pdf', p0620 = '/tmp/2026-06-20t.pdf'] = Deno.args;

// ---- 2026-08-01 (6h Ruhr-Pokal) ----
const g = parseQuali(await pdfText(p01), '2026-08-01');
const byCar = Object.fromEntries(g.map((r) => [r.car_no, r]));
console.log(`\n2026-08-01: ${g.length} cars parsed`);
console.log('  top 5:', g.slice(0, 5).map((r) => `P${r.pos_overall} #${r.car_no} ${r.class} (cls ${r.pos_class})`).join(' | '));
check('P1 is car 80 SP9 PRO', g[0].car_no === 80 && g[0].pos_overall === 1 && /SP9 PRO/.test(g[0].class), g[0]);
check('car 80 best lap ~7:51.506 (471506ms)', byCar[80]?.best_lap_ms === 471506, byCar[80]?.best_lap_ms);
check('car 64 is P2', byCar[64]?.pos_overall === 2, byCar[64]);
check('car 5 SP9 AM is P10 overall', byCar[5]?.pos_overall === 10, byCar[5]);
check('car 5 is SP9 AM class-pos 1', /SP9 AM/.test(byCar[5]?.class) && byCar[5]?.pos_class === 1, byCar[5]);
// #35 is P6 = SP9 PRO's 3rd car (behind #80 P1 and #64 P2).
check('car 35 SP9 PRO class-pos 3 (P6 overall)', byCar[35]?.pos_overall === 6 && byCar[35]?.pos_class === 3, byCar[35]);
// stragglers HDR misses must still land (exotic marque / period in model):
check('car 380 (BITTER Corsa) present', !!byCar[380], byCar[380]);
check('car 495 (VW Golf 8.5) present', !!byCar[495], byCar[495]);
check('classified count ~131 (Gewertet)', g.length >= 125 && g.length <= 132, g.length);
check('positions unique & contiguous from 1', g.every((r, i) => r.pos_overall === i + 1), g.slice(0, 3));

// ---- 2026-06-20 regression vs the old REAL_QUALI head ----
const g2 = parseQuali(await pdfText(p0620), '2026-06-20');
const b2 = Object.fromEntries(g2.map((r) => [r.car_no, r]));
console.log(`\n2026-06-20: ${g2.length} cars parsed`);
console.log('  top 5:', g2.slice(0, 5).map((r) => `P${r.pos_overall} #${r.car_no} ${r.class} (cls ${r.pos_class})`).join(' | '));
// REAL_QUALI head: [1,35,'SP9 PRO',1],[2,47,'SP9 PRO',2],[3,44,'SP9 PRO',3],[4,26,'SP9 PRO-AM',1],[9,5,'SP9 AM',1],[13,6,'SP9 AM',2]
check('06-20 P1 car 35 SP9 PRO cls1', b2[35]?.pos_overall === 1 && b2[35]?.pos_class === 1, b2[35]);
check('06-20 car 47 P2', b2[47]?.pos_overall === 2, b2[47]);
check('06-20 car 26 SP9 PRO-AM cls1 (P4)', b2[26]?.pos_overall === 4 && b2[26]?.pos_class === 1 && /PRO-AM/.test(b2[26]?.class), b2[26]);
check('06-20 car 5 SP9 AM cls1 (P9)', b2[5]?.pos_overall === 9 && b2[5]?.pos_class === 1, b2[5]);
check('06-20 car 6 SP9 AM cls2 (P13)', b2[6]?.pos_overall === 13 && b2[6]?.pos_class === 2, b2[6]);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASS'}`);
Deno.exit(failures ? 1 : 0);
