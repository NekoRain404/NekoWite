/**
 * Where a detached popup has to be rendered so that it draws *the user's* appearance.
 *
 * **The defect this file names, in one sentence.** A surface that resolves the user's appearance
 * from somewhere other than the element that carries it draws the wrong palette. `AppShell.vue`
 * puts `data-theme`, `data-color-scheme`, `data-accent`, `data-contrast` and the eight inline
 * `--app-*` properties on `.shell` and nowhere else in the page, so anything rendered under `body`
 * resolves `palettes.css`'s `:root` block instead — the light palette, the default accent, the
 * default face — inside a window the user has told to draw a dark forest in Source Serif 4.
 *
 * **Why a lookup and not `to=".shell"`.** A `<Teleport>` whose selector matches nothing renders
 * *nothing*: `resolveTarget` returns null and `TeleportImpl` never mounts the slot's nodes, so a
 * static selector would trade a wrong-looking popup for an invisible one on any page without a
 * shell. A page that publishes on the document element — the pet window's own page
 * (`pet-page-appearance.ts`) — is that page, and `body`, which is where these surfaces used to
 * teleport to, is already inside its scope. So `body` is a fallback and not a second declaration:
 * it repeats no value.
 *
 * **Two questions, not one, and that is the whole shape of this module.** A surface that hangs off
 * a control can be asked the question the right way round — *which* element does this popup belong
 * to? — and the answer is that element's own nearest carrier, walked from the control the user
 * actually pressed. A surface that hangs off nothing (a menu at a pointer, a palette raised by a
 * keystroke) has no ancestry to walk, and its answer is the page's own carrier. Forcing one
 * function to answer both would either make the anchored case depend on a document-wide search it
 * does not need, or make the anchorless case invent an anchor it does not have.
 *
 * Nothing here decides *whether* a popup is teleported. That is each surface's own measurement:
 * `SelectMenu.vue` and `ComboBox.vue` keep the teleport because `place()` turns a viewport
 * rectangle into `left`/`top` (only an answer while the containing block is the viewport) and
 * because 21 of the app's 22 selects wrap their trigger in a `<label for>` that would swallow a
 * press inside the list; `CommandPalette.vue` drops its teleport altogether because an
 * `inset: 0` overlay's containing block is the box it is meant to cover and `.shell` *is* the
 * window. What this module owns is the one fact all of them need: the name of the carrier.
 */

/** The element that carries the user's appearance. `AppShell.vue:285` is the only writer. */
const SHELL = '.shell'

/**
 * The carrier to render a popup into, walked from the control it hangs off.
 *
 * `anchor` is the element the user pressed — a select's trigger, a resize handle, a menu's own
 * button — and the answer is its nearest `.shell` ancestor. `body` when there is none, which is
 * both what these surfaces did before and what a page that publishes on its document element
 * wants.
 */
export function popupHostOf(anchor: Element | null | undefined): Element | string {
  return anchor?.closest(SHELL) ?? 'body'
}

/**
 * The carrier to render a popup into, for a surface that hangs off no element at all.
 *
 * A context menu is placed at a *point* and a command palette is raised by a keystroke: neither
 * has an element whose ancestry could be walked, and the only thing left to ask is the page. The
 * whole of the app's window is inside `.shell` (`AppShell.vue:285`, 100vw x 100vh), so the page's
 * answer is also the answer for every point on it.
 */
export function pagePopupHost(): Element | string {
  return document.querySelector(SHELL) ?? 'body'
}
