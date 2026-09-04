/**
 * A tiny aria-live announcer for the editor chrome.
 *
 * Screen readers only announce changes to a live region that already exists in
 * the DOM and whose text *changes*. This module keeps a single hidden
 * `role="status"` region, politely asserts status transitions (save state, word
 * goal, search result count, history restore), and forces a fresh announcement
 * even when the text repeats (reset then set on a later tick).
 *
 * It is intentionally DOM-side (no Vue): call from a store, a controller or a
 * component the same way. `resetAnnouncer()` detaches the region and clears the
 * duplicate-guard — call it in teardown/tests so nothing leaks between mounts.
 */

const REGION_CLASS = 'nw-aria-live'
const SILENT_STYLE =
  'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;'

let region: HTMLElement | null = null
let lastText: string | null = null
let seq = 0

function ensureRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  if (region && region.isConnected) return region
  region = document.createElement('div')
  region.setAttribute('role', 'status')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'true')
  region.className = REGION_CLASS
  region.setAttribute('style', SILENT_STYLE)
  document.body.appendChild(region)
  return region
}

export interface AnnounceOptions {
  /** Use `aria-live="assertive"` for urgent, immediate interruptions. Defaults
   *  to polite, so status changes queue behind the current speech. */
  assertive?: boolean
}

/** Announce `message` to assistive technology via the shared live region. */
export function announce(message: string, options: AnnounceOptions = {}): void {
  if (!message) return
  const el = ensureRegion()
  if (!el) return
  el.setAttribute('aria-live', options.assertive ? 'assertive' : 'polite')
  const id = ++seq
  // A repeated identical string would otherwise be skipped by the live region;
  // clear now and set on the next macrotask so the change is observable.
  if (message === lastText) el.textContent = ''
  lastText = message
  setTimeout(() => {
    if (id === seq) el.textContent = message
  }, 0)
}

/** Detach the live region and reset the duplicate-guard. */
export function resetAnnouncer(): void {
  if (region) {
    region.remove()
    region = null
  }
  lastText = null
  seq = 0
}
