/**
 * The settings dialog's content viewport, put back at the top when what it shows is swapped.
 *
 * The dialog has one scroll container — `.dialog-content`, `SettingsPanel.vue` — and two rails that
 * replace its contents: the dialog's own rail swaps the *section*, and the agents tree's rail
 * (`AgentSettingsSection.vue`) swaps the *page* inside one section. Neither swap touched the
 * offset, and a kept offset is not a neutral thing: the new content is usually shorter than the old
 * offset, so the engine clamps it, and the reader is put down at the **bottom** of a page whose top
 * they have never seen. Measured in Chromium at the 1280x800 window this programme's numbers are
 * taken at, the AI page scrolled to `1194/1230` and the `editor` row pressed: the reader arrived at
 * `186/186`. Measured the same way on the agents tree's rail — the `runtime` page at the bottom,
 * the next row pressed — `108px` down a page that had just opened.
 *
 * **Why this finds the box instead of being handed it.** The container is the panel's and the
 * second rail is two levels below it, in a component the panel does not know the page state of: the
 * sub-rail's selection is its own, and the panel's only job in the swap is that it happens inside
 * `.dialog-content`. So the one fact both ends have is the *element* — the swapped content sits in
 * the box — and the box is found from there. That also keeps the two features' markup out of each
 * other: a sub-rail that named `.dialog-content` would be a second place the panel's class is
 * spelled, and a rule the page's own file cannot state.
 *
 * **`auto` and `scroll` only.** `overflow: hidden` is programmatically scrollable, and
 * `.settings-dialog` — the rounded box *outside* `.dialog-content` — is exactly that. A walk that
 * accepted `hidden` would answer the wrong element the day a section wrapped itself in a clipping
 * box; the two values accepted are the two that mean "a box the reader scrolls".
 *
 * **`scrollTop` and not a smooth scroll.** §7.3's 正文稳定: the switch is the reader's own act, the
 * page they asked for is already at the top, and an animated travel to it would be a scroll nobody
 * asked for and nobody can interrupt. The reset is instant for the same reason the resize is not
 * animated (`use-dialog-size.ts`).
 */

/** The two `overflow-y` values that mean "a box the reader scrolls". */
const SCROLLABLE = new Set(['auto', 'scroll'])

/**
 * The nearest scroll container at or above `from`, or `null` when there is none.
 *
 * Starts at `from` itself so that a caller holding the container passes it straight through, and
 * walks outward so that a caller holding something *inside* it — a section, a page — need not know
 * what the container is.
 */
export function contentViewportOf(from: Element | null | undefined): HTMLElement | null {
  let node: Element | null = from ?? null
  while (node !== null) {
    if (node instanceof HTMLElement && SCROLLABLE.has(getComputedStyle(node).overflowY)) return node
    node = node.parentElement
  }
  return null
}

/**
 * Put the box the content sits in back at the top, wherever it was left.
 *
 * Silent when there is no box: a section mounted somewhere that is not this dialog — the component
 * tests mount the agents section on its own — has nothing to reset, and that is not an error.
 */
export function resetContentScroll(from: Element | null | undefined): void {
  const viewport = contentViewportOf(from)
  if (viewport !== null) viewport.scrollTop = 0
}
