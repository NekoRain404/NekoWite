/**
 * Which editor pane owns the document right now.
 *
 * The app has two editors over one document: the rendered ProseMirror pane and
 * the CodeMirror source pane. Both directions of the sync have to agree on
 * which one is authoritative, or one pane's derived output overwrites what the
 * user is typing in the other:
 *
 *   - the rendered pane reopens its model from `tab.content`, and
 *   - the source pane mirrors `tab.content` wholesale, moving its caret.
 *
 * Source mode is unambiguous. Split mode is not — both panes are live — so it
 * follows keyboard focus: the pane the user is typing into is the author.
 */

import { useViewStore } from '../stores/view'
import { sourceViewHasFocus } from './sourceView'

/** The active view mode, or null when there is no Pinia instance. Callers
 *  outside the app (a plugin, a unit test) then get the rendered behaviour,
 *  which is what they had before this module existed. */
function currentMode(): string | null {
  try {
    return useViewStore().mode
  } catch {
    return null
  }
}

/** True when the CodeMirror pane is the one the user is typing into. */
/**
 * Which pane the user was last working in.
 *
 * Split mode cannot ask the DOM at command time: a command is often invoked
 * from a surface that has just taken focus itself (the command palette's input,
 * a toolbar button), so `document.activeElement` describes the *button*, not
 * the pane the user meant. Remembering the last editor pane that held focus
 * keeps the intent across those hops.
 */
export type EditorPane = 'source' | 'rendered'

let lastFocusedPane: EditorPane | null = null

/** Record which editor pane last received focus. */
export function noteFocusedPane(pane: EditorPane): void {
  lastFocusedPane = pane
}

/** The last pane focus landed in, or null before the user has touched either. */
export function getFocusedPane(): EditorPane | null {
  return lastFocusedPane
}

/** Drop the recorded pane (teardown / no document). */
export function resetFocusedPane(): void {
  lastFocusedPane = null
}

export function sourcePaneOwnsInput(): boolean {
  const mode = currentMode()
  if (mode === 'source') return true
  if (mode === 'split') {
    // Prefer the remembered pane; fall back to the live DOM before the user
    // has focused either one.
    if (lastFocusedPane === 'source') return true
    if (lastFocusedPane === 'rendered') return false
    return sourceViewHasFocus()
  }
  return false
}

/**
 * True when the rendered pane may write `tab.content` (and reopen its model
 * from it).
 *
 * Deliberately the exact complement of {@link sourcePaneOwnsInput}: when it is
 * false the rendered model is stale, so its serializer output must not be
 * pushed into the tab, and a serialization still in flight from before a mode
 * switch must not land either.
 */
export function renderedPaneOwnsText(): boolean {
  return !sourcePaneOwnsInput()
}

/**
 * The raw Markdown the source pane last wrote into the tab.
 *
 * `tab.content` is shared, so "the model's serialization is newer than the
 * tab" is not enough to decide whether the rendered pane may write it: while
 * the user types in the source pane the model is stale, but right after an edit
 * in the rendered pane it is authoritative. Comparing against the text the
 * source pane actually authored tells the two apart.
 */
let sourceAuthored: string | null = null

/** Record the raw Markdown the source pane just published to the tab. */
export function markSourceAuthored(text: string): void {
  sourceAuthored = text
}

/**
 * The rendered pane has authored the text again (the user edited it, or a
 * document was loaded), so any source-authored marker is obsolete.
 */
export function clearSourceAuthored(): void {
  sourceAuthored = null
}

/**
 * True when `content` is text the source pane authored and the rendered model
 * has not superseded. Writing the model's serialization over it would replace
 * the raw Markdown under the user's caret.
 */
export function isSourceAuthored(content: string | null | undefined): boolean {
  return content != null && sourceAuthored !== null && content === sourceAuthored
}
