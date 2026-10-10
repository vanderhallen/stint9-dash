/* test-yt-reel.mjs — prove the YouTube reel's URL parser handles every common
 * link shape, and that WXN was bumped to include the new panel.
 *
 *   node live/test-yt-reel.mjs
 *
 * Lifts ytId() straight out of index.html's initYtReel IIFE.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const a = html.indexOf('function ytId(v){');
const b = html.indexOf('\n  }', a);
if (a < 0 || b < 0) { console.error('FAIL — could not find ytId() in index.html'); process.exit(1); }
const ytId = new Function(`${html.slice(a, b + 4)}; return ytId;`)();

const ID = 'dQw4w9WgXcQ';   // 11 chars, matches YouTube's real id length/charset
const cases = [
  ['https://www.youtube.com/watch?v=' + ID, ID],
  ['https://youtube.com/watch?v=' + ID + '&t=42s', ID],
  ['https://m.youtube.com/watch?v=' + ID, ID],
  ['https://youtu.be/' + ID, ID],
  ['https://youtu.be/' + ID + '?t=42', ID],
  ['https://www.youtube.com/embed/' + ID, ID],
  ['https://www.youtube-nocookie.com/embed/' + ID, ID],
  ['https://www.youtube.com/shorts/' + ID, ID],
  ['https://www.youtube.com/live/' + ID, ID],
  ['  ' + ID + '  ', ID],                                   // bare id, whitespace tolerated
  ['not a url at all', null],
  ['', null],
  ['https://vimeo.com/123456', null],                       // a different platform must not match
];
for (const [input, expected] of cases) check(`ytId(${JSON.stringify(input)}) -> ${expected}`, ytId(input) === expected, ytId(input));

check('right strip uses the same REELN as the left (YOUTUBE is in that list)', /const WXN=REELN/.test(html), (html.match(/const WXN=\w+/)||[])[0]);

const names = html.match(/var NAMES=\[([^\]]+)\]/);
const list = names ? names[1].split(',').map(s => s.replace(/['"]/g, '').trim()) : [];
check('YOUTUBE is reel 17 (reelShown\'s stop index)', list[17] === 'YOUTUBE', list[17]);

check('reelShown stops only this block\'s YouTube player',
  /if\(i!==17\)\{const f=SIDEFN\[side\]&&SIDEFN\[side\]\.stopYt;if\(f\)f\(\);\}/.test(html), true);
check('reelShown does not call the global stopYtPlayer (that would kill the other block)',
  !/if\(i!==17&&typeof stopYtPlayer/.test(html), true);
check('initRightBlock assigns onto SIDEFN instead of replacing it (keeps stopYt)',
  /SIDEFN\[''\]\.syncWx=window\.__syncWx/.test(html) && !/SIDEFN\[''\]=\{syncWx:/.test(html), true);

// Changing the LEFT reel (TIMES, idx 2) must not stop the RIGHT player.
{
  const stopped = { left: 0, right: 0 };
  const SIDEFN = { '': { stopYt: () => stopped.left++ }, _r: { stopYt: () => stopped.right++ } };
  const hide = (i, side) => { if (i !== 17) { const f = SIDEFN[side] && SIDEFN[side].stopYt; if (f) f(); } };
  hide(2, '');     // left TIMES
  hide(17, '_r');  // right stays on YOUTUBE
  check('left TIMES switch does not stop the right YouTube player', stopped.right === 0 && stopped.left === 1, stopped);
  hide(16, '_r');  // right leaves YOUTUBE
  check('leaving YOUTUBE on the right does stop the right player', stopped.right === 1 && stopped.left === 1, stopped);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — YouTube reel parses every common link shape and wires into the strip correctly');
process.exit(failures ? 1 : 0);
