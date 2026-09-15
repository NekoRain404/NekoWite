/**
 * Does the image panel land next to the image it is editing in WebKitGTK?
 *
 * This is the question brief 99 exists for. The fix is `0e3775e` / `2478363`,
 * the module is `features/editor/model/image-panel-placement.ts`, and before it
 * the panel anchored to `.editor-container`'s top — the top of the DOCUMENT,
 * thousands of pixels above a scrolled-to image. Every one of those numbers was
 * taken in Chromium; this is the same measurement in the engine that ships.
 */
import { RECT_SRC, clickByText, scrollSoTopIs, scrollTo } from './probe-support.mjs'
import { until } from './webdriver.mjs'

/** The figure top the Chromium run measured, so the same frame is reproduced. */
const CHROMIUM_FIGURE_TOP = 268.234

const readPanel = (wd) =>
  wd.execute(
    `const rect = ${RECT_SRC};
     const pane = document.querySelector('.rendered-pane');
     const panel = document.querySelector('.neko-image-panel');
     const figure = document.querySelector('figure.neko-image');
     if (!panel || !figure) return { panel: rect('.neko-image-panel'), figure: rect('figure.neko-image') };
     const cs = getComputedStyle(panel);
     const pr = panel.getBoundingClientRect();
     const fr = figure.getBoundingClientRect();
     const paneR = pane ? pane.getBoundingClientRect() : null;
     const container = rect('.editor-container');
     return {
       panel: rect('.neko-image-panel'),
       figure: rect('figure.neko-image'),
       pane: paneR ? { top: paneR.top, left: paneR.left, right: paneR.right, bottom: paneR.bottom } : null,
       // The two numbers the Chromium measurement was stated as.
       topDelta: pr.top - fr.top,
       leftGap: pr.left - fr.right,
       position: cs.position,
       // The panel's own box, so a height difference between engines can be
       // told apart from a placement difference: a shorter panel that still
       // keeps its top level with the image is a metrics difference, a panel
       // whose content is CLIPPED is not, and a control that is not there is a
       // different finding again.
       panelBox: { clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight,
                   clipped: panel.scrollHeight > panel.clientHeight + 1 },
       panelLabels: Array.from(panel.querySelectorAll('label, [class*="row"]'))
         .map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 16),
       // Where the OLD anchor would have put it. Before commit 2478363 the panel
       // was position:absolute with top:0, which resolves against
       // .editor-container — the top of the document. Derived from the measured
       // container rather than re-run: reverting the fix would take the working
       // panel off the user's screen.
       oldAnchorTop: container ? container.top : null,
       insidePane: paneR
         ? { top: pr.top >= paneR.top - 0.01, bottom: pr.bottom <= paneR.bottom + 0.01,
             left: pr.left >= paneR.left - 0.01, right: pr.right <= paneR.right + 0.01 }
         : null,
       insideViewport: pr.top >= 0 && pr.left >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight,
       paneScrollTop: pane ? pane.scrollTop : null
     }`,
  )

export const panelProbe = {
  name: 'image-panel',
  async run(wd) {
    await until(
      () =>
        wd.execute(
          `return Boolean(document.querySelector('figure.neko-image .neko-image-error-msg'))`,
        ),
      { timeout: 20_000, what: 'the image node view and its failed-load overlay' },
    )
    // The overlay's message span is the one region of the figure that does not
    // arm a resize drag, so a real click there becomes a NodeSelection — which
    // is what opens the panel.
    await clickByText(wd, '.neko-image-error-msg', '')
    await until(
      () =>
        wd.execute(
          `const el = document.querySelector('.neko-image-panel');
           if (!el) return false;
           const r = el.getBoundingClientRect();
           return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0`,
        ),
      { timeout: 10_000, what: 'the image panel to render' },
    )

    const out = { atChromiumFrame: null, atOtherFrames: [], atPaneFloor: null, atPaneCeiling: null }

    // The Chromium frame, reproduced.
    out.atChromiumFrame = {
      scroll: await scrollSoTopIs(wd, '.rendered-pane', 'figure.neko-image', CHROMIUM_FIGURE_TOP),
      ...(await readPanel(wd)),
    }
    // The invariant is not a property of one offset, so it is read at several.
    for (const top of [160, 400, 560]) {
      out.atOtherFrames.push({
        scroll: await scrollSoTopIs(wd, '.rendered-pane', 'figure.neko-image', top),
        ...(await readPanel(wd)),
      })
    }
    // Near the pane's floor the panel cannot both keep the image's top and stay
    // inside the pane, so it clamps. The contract is "level with the image as
    // far as the pane allows", and this is where "as far as" is: the Chromium
    // run measured 407.02 here, which is pane.bottom - 8 - its own 349.98.
    out.atPaneFloor = {
      scroll: await scrollSoTopIs(wd, '.rendered-pane', 'figure.neko-image', 620),
      ...(await readPanel(wd)),
    }
    // The image scrolled ABOVE the pane's top: the panel must stop at the pane
    // rather than follow the picture out of the editing column. Anchored off the
    // figure's own content offset, not off a guessed number.
    out.atPaneCeiling = {
      scroll: await scrollTo(
        wd,
        '.rendered-pane',
        await wd.execute(
          `const pane = document.querySelector('.rendered-pane');
           const fig = document.querySelector('figure.neko-image');
           return pane.scrollTop + fig.getBoundingClientRect().top
                  - pane.getBoundingClientRect().top + 300`,
        ),
      ),
      ...(await readPanel(wd)),
    }
    return out
  },
}
