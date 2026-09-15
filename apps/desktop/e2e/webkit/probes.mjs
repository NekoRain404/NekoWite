/**
 * The registry: which probes run, and in what order.
 *
 * The probes themselves live one file each, by concern — the image panel's
 * placement, the split-mode tail space, a motion surface. The shared mechanics
 * they all use are in `probe-support.mjs`. Imports run one way only: this file
 * imports the probes and the support, the probes import the support, and
 * nothing imports this one.
 */
import { RECT_SRC } from './probe-support.mjs'
import { panelProbe } from './probe-panel.mjs'
import { motionProbe } from './probe-motion.mjs'
import { noteSwitchProbe } from './probe-note-switch.mjs'
import { tailProbe } from './probe-tail.mjs'

/** Dumps what is actually in the document, so the probes can address it. */
const inspect = {
  name: 'inspect',
  run: (wd) =>
    wd.execute(
      `const sels = ['.panes', '.pane', '.pane.rendered', '.pane.source', '.rendered-pane',
        '.editor-container', '.cm-scroller', '.cm-content', '.switch-option',
        '.neko-image-panel', 'figure.neko-image', '.neko-image-error-msg',
        '.toolbar-menu-wrap', '.toolbar-menu', '.toast-stack'];
       const out = {};
       for (const s of sels) out[s] = document.querySelectorAll(s).length;
       const rect = ${RECT_SRC};
       const panes = document.querySelector('.panes');
       return {
         counts: out,
         panesClass: panes ? panes.className : null,
         panesHeight: panes ? panes.clientHeight : null,
         switchLabels: Array.from(document.querySelectorAll('.switch-option')).map((e) => e.textContent.trim()),
         rects: { panes: rect('.panes'), editorContainer: rect('.editor-container'),
                  cmScroller: rect('.cm-scroller'), figure: rect('figure.neko-image') }
       }`,
    ),
}

/**
 * The order is the point, and it is why these share one page: each leaves the
 * document where the next expects it. `motion` needs the toolbar before an image
 * selection moves the caret into a node view, and `tail` switches the mode to
 * split, so it goes last and takes the panes with it.
 *
 * `note-switch` also goes last, and for a stronger reason: it changes which
 * document is open, so anything that needs the fixture's own note must have run
 * by then. It needs the two-note scenario (`--scenario two-notes`) and reports
 * itself skipped under any other, which is what keeps a plain run of everything
 * working.
 */
export const PROBES = [motionProbe, panelProbe, tailProbe, noteSwitchProbe]
export const ALL_PROBES = [inspect, ...PROBES]
