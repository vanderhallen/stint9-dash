/* test-car-persist.mjs — prove the selected car survives a LIVE refresh.
 *
 *   node live/test-car-persist.mjs
 *
 * On refresh the sequence is: restore PREFS.car -> startLive() -> clearLiveDB()
 * -> buildClass() against an EMPTY car list (which blanks selCar) -> first poll
 * -> buildClass() with the real field. At that last step the old code found
 * selCar='' , matched nothing, and dropped to DB.cars[0] — the lowest car
 * number in the class. wantCar carries the intent across the empty step.
 *
 * Exercises the real fallback line lifted out of index.html, so the test cannot
 * drift from what buildClass actually does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const marker = '  if(!DB.cars.some(c=>String(c)===String(selCar))){';
const a = html.indexOf(marker);
const endMark = '\n  }';
const b = html.indexOf(endMark, a);
if (a < 0 || b < 0) { console.error("FAIL — could not find buildClass' car fallback"); process.exit(1); }
const fallback = html.slice(a, b + endMark.length);

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

// cars as buildClass holds them: sorted shortest-string-first, so DB.cars[0] is
// the lowest number — exactly what the bug jumped to.
const M240 = ['650', '651', '652', '653', '658', '661', '664', '665', '667', '670', '677'];

function step(cars, selCar, wantCar) {
  const DB = { cars };
  const fn = new Function('DB', 'selCar', 'wantCar', `${fallback}; return selCar;`);
  return fn(DB, selCar, wantCar);
}

/* the reported sequence, end to end */
{
  let selCar = '670', wantCar = '670';               // restored from PREFS on load
  selCar = step([], selCar, wantCar);                 // clearLiveDB(): empty list
  check('the empty rebuild blanks selCar (unchanged behaviour)', selCar === '', selCar);
  check('...but the intent is untouched', wantCar === '670', wantCar);
  selCar = step(M240, selCar, wantCar);               // first LIVE poll
  check('first poll restores #670, not the lowest number', selCar === '670', selCar);
  check('...and specifically is NOT #650', selCar !== '650', selCar);
}

/* switching to a class that does not contain the wanted car still works */
{
  const cup3 = ['941', '950', '970', '979'];
  check('a class without the wanted car falls back to its first entry',
        step(cup3, '', '670') === '941', step(cup3, '', '670'));
}

/* a car that is in the class is kept even when it is not the first */
{
  check('an already-valid selection is left alone', step(M240, '665', '670') === '665',
        step(M240, '665', '670'));
}

/* no intent recorded yet -> historical behaviour, first car */
{
  check('with no remembered car, the first car is chosen', step(M240, '', '') === '650',
        step(M240, '', ''));
}

/* an empty field selects nothing rather than throwing */
{
  check('an empty field yields no selection', step([], '', '670') === '', step([], '', '670'));
}

/* the second hole: savePrefs() firing while the DB is empty must not erase the
   stored preference, and a '' already on disk must not be treated as a choice */
{
  const prefCarSrc = html.slice(html.indexOf('function prefCar(){'),
                                html.indexOf('\n', html.indexOf('function prefCar(){')) + 1);
  const prefCar = (wantCar, selCar, PREFS) =>
    new Function('wantCar', 'selCar', 'PREFS', `${prefCarSrc}; return prefCar();`)(wantCar, selCar, PREFS);

  check('a blank moment keeps the car already on disk',
        prefCar('', '', { car: '670' }) === '670', prefCar('', '', { car: '670' }));
  check('the live intent still wins over disk',
        prefCar('665', '', { car: '670' }) === '665', prefCar('665', '', { car: '670' }));
  check('nothing anywhere yields blank', prefCar('', '', {}) === '', prefCar('', '', {}));

  const restore = html.includes("if(PREFS.car){selCar=PREFS.car;wantCar=String(PREFS.car);}");
  check("a stored '' is ignored on restore (truthy test, not !=null)", restore, restore);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — the selected car survives a refresh');
process.exit(failures ? 1 : 0);
