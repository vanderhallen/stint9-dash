/* test-pos-zoom.mjs — prove a zoomed per-car chart (POS/FLOW/STINT/PACE/…)
 * sizes itself to its own viewBox instead of the flat TYRE-board ratio every
 * zoomed reel used to share.
 *
 *   node live/test-pos-zoom.mjs
 *
 * Every reel used the SAME fixed aspect (ZOOM_RATIO = 700/1340) when zoomed,
 * borrowed from the TYRE board. A per-car chart draws one row per car into a
 * `0 0 1000 CH` viewBox, so for anything past a handful of cars its own
 * natural aspect is taller than that borrowed ratio — the excess got hidden
 * behind .reelpanel.tall's scrollbar instead of shown. Reported 2026-09-12:
 * POS zoomed in, not all class cars visible without scrolling.
 *
 * Lifts reelHeightRatio()/reelFitHeight() straight out of index.html, with a
 * minimal DOM stub — just enough surface for these two functions to run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const lift = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); return html.slice(i, j + b.length); };

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

const ratioSrc = lift('function reelHeightRatio(){', '\n}');
const heightSrc = lift('function reelFitHeight(w){', '\n}');
const zoomRatio = 700 / 1340;

// panels[i] mimics `#reelstrip>.reelpanel` in strip order (0 FUEL .. 8 PACE
// after today's STINT-after-POS reorder); only the ones exercised need a real
// svg. `null` stands for a panel with no direct <svg> child (an iframe/div).
function makePanel(viewBoxHeight, dataFit) {
  return { querySelector: () => ({
    dataset: dataFit ? { fit: '' } : {},
    getAttribute: () => `0 0 1000 ${viewBoxHeight}`,
  }) };
}
function makeDom({ reelIdx, panels, zoomed, innerHeight = 1000, fit = 1, ch = 400 }) {
  const g = new Function('reelIdx', 'CH', 'ZOOM_RATIO', `
    ${ratioSrc}
    ${heightSrc}
    return { reelHeightRatio, reelFitHeight };`);
  global.document = {
    getElementById: id => id === 'reelcard' ? { classList: { contains: c => c === 'zoomed' && zoomed } } : null,
    querySelectorAll: sel => sel === '#reelstrip>.reelpanel' ? panels : [],
  };
  global.window = { innerHeight };
  global.__fit = fit;
  return g(reelIdx, ch, zoomRatio);
}

/* ---- a small field (e.g. 10 cars, CH~462 via renderChart's own yT=18,
   rowH=44 formula) is already shorter than the flat TYRE ratio -- correctly
   keeps the standard ratio, no artificial shrink below the tuned minimum ---- */
{
  const CH = 18 + Math.max(10, 4) * 44 + 4;   // renderChart's own formula, a 10-car class
  const { reelHeightRatio } = makeDom({ reelIdx: 4, panels: [null, null, null, null, makePanel(CH, false)], zoomed: true, ch: CH });
  check('a small field keeps the standard zoom ratio (its own is shorter)',
        reelHeightRatio() === zoomRatio, { got: reelHeightRatio(), ownRatio: CH / 1000, zoomRatio });
}

/* ---- a bigger class (e.g. CUP3, 22 cars, CH~990) genuinely needs more
   height than the flat TYRE ratio gives -- this is the real reported case:
   the field is small enough to comfortably fit a taller zoom window, but was
   still forced into the SAME short ratio every other reel type shares ---- */
{
  const CH = 18 + Math.max(22, 4) * 44 + 4;   // a 22-car class
  // A big enough viewport that the 85vh cap isn't what's being tested here —
  // that cap has its own dedicated case above ("a huge field...").
  const { reelHeightRatio, reelFitHeight } = makeDom({ reelIdx: 4, panels: [null, null, null, null, makePanel(CH, false)], zoomed: true, ch: CH, innerHeight: 2000 });
  const ratio = reelHeightRatio();
  check('a taller-than-usual class uses its OWN viewBox ratio when zoomed',
        Math.abs(ratio - CH / 1000) < 1e-9, ratio);
  check('...which is taller than the flat TYRE-board ratio it replaces',
        ratio > zoomRatio, { ratio, zoomRatio });
  const w = 1340;
  const h = reelFitHeight(w);
  check('the reel actually GETS that taller height (not re-clamped back down)',
        Math.abs(h - w * (CH / 1000)) < 1, h);
}

/* ---- a data-fit panel (e.g. SECT) must keep the flat ratio regardless ---- */
{
  const { reelHeightRatio } = makeDom({ reelIdx: 6, panels: Array(7).fill(null).map((_, i) => i === 6 ? makePanel(2000, true) : null), zoomed: true });
  check('a data-fit (fixed-size) panel is NOT stretched by this change', reelHeightRatio() === zoomRatio, reelHeightRatio());
}

/* ---- a genuinely huge field (e.g. ALL CLASSES, 131 cars) must still be
   capped by the viewport -- reelFitHeight's own cap, not reelHeightRatio,
   is what keeps this from growing off-screen; it should still exceed the
   panel and correctly fall back to .tall/scroll for that extreme case ---- */
{
  const CH = 131 * 44 + 22;   // renderChart's own per-row formula, all-classes field
  const { reelFitHeight } = makeDom({ reelIdx: 4, panels: [null, null, null, null, makePanel(CH, false)], zoomed: true, innerHeight: 1000, ch: CH });
  const h = reelFitHeight(1340);
  check('a huge field is capped well under the viewport, not left to grow off-screen',
        h <= 1000 * 0.85 + 1, h);
}

/* ---- not zoomed: unaffected, still the inline CH/1000 ratio ---- */
{
  const { reelHeightRatio } = makeDom({ reelIdx: 4, panels: [], zoomed: false, ch: 777 });
  check('inline (not zoomed) ratio is untouched: CH/1000', reelHeightRatio() === 777 / 1000, reelHeightRatio());
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — a zoomed per-car chart fits every car without needing to scroll');
process.exit(failures ? 1 : 0);
