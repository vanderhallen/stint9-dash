/* test-mob-stand.mjs — iPhone ESSENTIALS standings show last lap above gap.
 *
 *   node live/test-mob-stand.mjs
 *
 * Page 1/31 standings used to be P | car+driver | gap. Latest lap time now
 * stacks above the gap in the same .g cell. Both lines always render so every
 * row is the same height, and CSS keeps that height ≈ the old single-line row.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const stand = html.slice(html.indexOf('var order=Object.keys(lp)'), html.indexOf("var sb=document.getElementById('m_stand')"));
check('standings loop still in renderMobile', stand.includes('commonGap(st,leader,T)'), true);
check('last lap comes from carStats().last (same as m_last)', /carStats\(st,T\)\.last/.test(stand), true);
check('last lap is formatted with fmt()', /fmt\(last\)/.test(stand), true);
check('last lap sits in .lt above gap in .gt',
      stand.includes('<span class="lt">\'+lt+\'</span><span class="gt">\'+gt+\'</span>'), true);
check('gap cell is no longer a single unwrapped value',
      !/class="g">'\+gt\+'<\/td>/.test(stand), true);

const cssStart = html.indexOf('.mstand{');
const css = html.slice(cssStart, html.indexOf('.mstand tr.sel .lt') + 80);
check('compact td padding keeps the two-line row at the old height',
      /\.mstand td\{padding:5px 4px/.test(css), true);
check('.lt and .gt are stacked block lines at line-height 1',
      css.includes('.mstand .lt{display:block') && css.includes('.mstand .gt{display:block')
      && css.includes('line-height:1'), true);
check('last-lap type is 12px, gap 11px',
      css.includes('font-size:12px') && css.includes('.mstand .gt{display:block;font-size:11px'), true);

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — iPhone standings stack last lap above gap');
process.exit(failures ? 1 : 0);
