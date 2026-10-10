/* test-mob-viewers.mjs — iPhone header shows the eye + live viewer count.
 *
 *   node live/test-mob-viewers.mjs
 *
 * Desktop #viewerBadge sits in #statusbox, which #mobileview covers. Phone
 * SIM/LIVE had no copy of the eye, so the count disappeared on iPhone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const mob = html.slice(html.indexOf('<div id="mobileview">'), html.indexOf('data-slide="essentials"'));
check('phone header has the eye badge before SIM/LIVE',
      /id="m_viewers"[\s\S]*id="m_sim"/.test(mob), true);
check('phone badge uses the same eye SVG path as desktop',
      mob.includes('M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z')
      && mob.includes('id="m_viewerCount"'), true);
check('phone CSS sizes the badge to the 44px header controls',
      /\.mviewers\{[^}]*height:44px/.test(html), true);

check('heartbeat paints both viewerCount and m_viewerCount',
      html.includes("getElementById('m_viewerCount')")
      && html.includes('function paint(n)'), true);
check('renderMobile copies desktop count onto the phone badge',
      html.includes("getElementById('m_viewerCount')")
      && html.includes('mv.textContent=vc.textContent'), true);

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — iPhone header shows the eye + viewer count');
process.exit(failures ? 1 : 0);
