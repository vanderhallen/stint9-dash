/* test-mob-mode.mjs — iPhone SIM/LIVE must call setMode, not click a hidden desktop button.
 *
 *   node live/test-mob-mode.mjs
 *
 * Phone SIM used to do querySelector('.modebtn[data-mode=SIM]').click(). That
 * desktop toggle sits under #mobileview (z-index 9999); iOS Safari swallows
 * the synthetic click, so LIVE kept running. Laptop taps the real button.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

check('setMode is exported as window.setDataMode', html.includes('window.setDataMode=setMode'), true);
check('phone mode wiring exists', html.includes('function __wireMobMode()'), true);
check('renderMobile retries __wireMobMode like __wireMobNav', /__wireMobNav\(\);\s*__wireMobMode\(\);/.test(html), true);
check('phone SIM/LIVE call setDataMode directly', html.includes("window.setDataMode(mode)"), true);
check('phone no longer synthetic-clicks a bare .modebtn for SIM',
      !/querySelector\('\.modebtn\[data-mode="'\+mode\+'"\]'\)/.test(html), true);
check('fallback, if any, is scoped to #modetoggle',
      html.includes("#modetoggle .modebtn[data-mode=\"'+mode+'\"]"), true);
check('phone SIM/LIVE listen for pointerup (iOS tap)',
      html.includes("['pointerup','click'].forEach(ev=>{ms.addEventListener(ev,go('SIM'));ml.addEventListener(ev,go('LIVE'));})"), true);

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — phone SIM/LIVE calls setMode directly');
process.exit(failures ? 1 : 0);
