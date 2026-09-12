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

const wxn = html.match(/const WXN=(\d+);/);
check('WXN includes the new YOUTUBE panel (7 panels total)', wxn && wxn[1] === '7', wxn && wxn[1]);

// index 3, not the original 6: the YouTube panel was later moved to sit
// right after the timetable panel (a placement request, not a bug fix).
const gate = html.includes("if(wxReelIdx!==3&&typeof stopYtPlayer==='function')stopYtPlayer();");
check('scrolling away from the YouTube panel stops playback', gate, gate);

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — YouTube reel parses every common link shape and wires into the strip correctly');
process.exit(failures ? 1 : 0);
