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
import { dialogProbe } from './probe-dialog.mjs'
import { noteSwitchProbe } from './probe-note-switch.mjs'
import { tailProbe } from './probe-tail.mjs'
import { tableProbe } from './probe-table.mjs'
import { agentScrollProbe } from './probe-agent-scroll.mjs'
import { chatScrollProbe } from './probe-chat-scroll.mjs'
import { focusRingProbe } from './probe-focus-ring.mjs'
import { listRoomProbe } from './probe-list-room.mjs'

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
 *
 * `table-cell` goes before `tail` and `note-switch`, and it is the only probe
 * that needs the `table` scenario. It edits the document (it inserts a table) and
 * raises an overlay, so it belongs before the probes that move the pane into
 * split mode or change which note is open — and it returns a `skipped` under any
 * other scenario, the way `note-switch` does, so a plain run of everything still
 * runs on the document the others expect.
 *
 * `motion-dialog` is last of all, and it is the only probe that opens an overlay
 * over the whole window and takes focus into it. Everything above wants the
 * editor addressable, so the probe that covers the window goes after all of
 * them; it closes the dialog again before it returns either way.
 *
 * `agent-scroll` goes after even that one, and it is the only probe that needs a
 * page the harness was asked to prepare (`--agent`): it opens the right rail and
 * leaves the agent panel mounted in it, which is a page no probe after it could
 * be measured on. Under a run that did not ask for the agent it reports itself
 * skipped, the way `note-switch` does under a scenario with one note.
 *
 * `chat-scroll` is last and is the mirror image of the one before it: it needs the
 * rail showing the CHAT panel, which is what `?chat=1` seeds and what `--agent`
 * takes away. Neither can run on the other's page, so each reports itself skipped
 * under the other's flag — and a run that asked for one and got a skip is the
 * failure `measure.mjs` records `results.agent` / `results.chat` to make visible.
 *
 * `list-room` goes straight after `motion-dialog`, and for the same reason the two of them are
 * adjacent: both open the settings dialog, and it is closed again by the time either returns. It is
 * also the one probe that moves the window — the product's own minimum is where the room under a
 * control is smallest, and the claim it reads is about that window — so it puts the viewport back
 * to 1280x800 before it returns, and everything after it (the rail's two probes) measures the window
 * it always did.
 *
 * `focus-ring` goes last of all because it is the only probe that puts NEW DOM into
 * the page: it mounts four components nothing in the application hosts yet, in fixed
 * overlays over the top-left corner. A probe after it would be measuring a page with
 * four foreign panels on it, so nothing goes after it. The surfaces it reads on the
 * product's own page are read before it mounts anything.
 */
export const PROBES = [motionProbe, panelProbe, tableProbe, tailProbe, noteSwitchProbe, dialogProbe, listRoomProbe, agentScrollProbe, chatScrollProbe, focusRingProbe]
export const ALL_PROBES = [inspect, ...PROBES]
