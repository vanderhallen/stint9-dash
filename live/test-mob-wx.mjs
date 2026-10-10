/* test-mob-wx.mjs — iPhone WEATHER/TEMP must be woken after the reel card moves.
 *
 *   node live/test-mob-wx.mjs
 *
 * Leaflet inits on the desktop strip behind #mobileview. Moving #reelcard into
 * the phone slide leaves the map at 0×0 unless invalidateSize/drawTemp run
 * after the slide is on. setReel is a no-op when the reel was already selected,
 * so the phone path must wake WEATHER/TEMP itself.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

check('TEMP reel wakes drawTemp in reelShown', /if\(i===14\)\{const f=SIDEFN\[side\]&&SIDEFN\[side\]\.drawTemp/.test(html), true);
check('drawTemp is exported from initWeather', html.includes('window.__drawTemp=renderTempOverlay'), true);
check('right-block fans drawTemp like syncWx', html.includes("window.__drawTemp=fan('drawTemp')"), true);
check('phone setMob still wakes WEATHER/TEMP when setReel is a no-op',
      html.includes("if(same)try{reelShown(def.reel,'');}catch(e){}"), true);
check('phone setMob invalidateSize after the slide is laid out',
      html.includes('def.reel===13&&typeof window.__syncWx') && html.includes('def.reel===14&&typeof window.__drawTemp'), true);
check('phone CSS gives the weather map a real box',
      html.includes('.mslide #weather') && html.includes('min-height:220px'), true);

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — iPhone WEATHER/TEMP are woken after the slide move');
process.exit(failures ? 1 : 0);
