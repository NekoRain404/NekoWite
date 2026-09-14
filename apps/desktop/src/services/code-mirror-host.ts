// Vue host for a CodeMirror 6 editor instance (modeled after Memoir's
// code-mirror-host). Owns the create/mount/destroy lifecycle, hot-reconfigures
// extensions through a Compartment, debounces local edits toward onChange, and
// mirrors external content back into the doc with an ExternalChange annotation
// so the two directions never echo-loop (same lastLocal/gen discipline the
// tabs/RenderedPane sync uses).
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state'
import { history, isolateHistory } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'

/** Marks transactions that mirror external content (store → editor). */
export const ExternalChange = Annotation.define<boolean>()

export const SOURCE_SNAPSHOT_DEBOUNCE_MS = 50

export interface CodeMirrorHostOptions {
  /** Initial document text (the active tab's content at mount). */
  doc: string
  extensions: Extension[]
  debounceMs?: number
  /** Called with the full doc text after a debounced local edit burst. */
  onChange: (value: string) => void
  onCreateEditor?: (view: EditorView) => void
}

export interface CodeMirrorHostHandle {
  mount(parent: HTMLElement): void
  getView(): EditorView | null
  /** Emit any pending debounced edit immediately; returns the doc text. */
  flush(): string
  /** True while a local edit is still waiting for its debounce window. */
  hasPendingEdit(): boolean
  /** Hot-swap the extension set (props changes) via the Compartment. */
  reconfigure(extensions: Extension[]): void
  /**
   * Mirror external text into the doc: full setValue tagged with the
   * ExternalChange annotation (no onChange echo) and addToHistory=false so
   * hot reloads / conflict rewrites do not pollute the undo stack.
   *
   * When the text differs this is a DOCUMENT SWAP, so the previous document's
   * undo stack is dropped first (see {@link CodeMirrorHostHandle.resetHistory}).
   */
  setText(text: string): void
  /**
   * Drop the undo/redo stack. The caller must call this when the SAME view
   * starts mirroring a different document through a path `setText` cannot see
   * as a swap (identical text for two different notes).
   */
  resetHistory(): void
  destroy(): void
}

export function createCodeMirrorHost(options: CodeMirrorHostOptions): CodeMirrorHostHandle {
  const debounceMs = options.debounceMs ?? SOURCE_SNAPSHOT_DEBOUNCE_MS
  const compartment = new Compartment()
  // The undo history gets its OWN compartment: a document swap has to be able to
  // rebuild the whole stack, and a compartment can only be reconfigured as a
  // unit — the caller's hot-swapped layout extensions must not be disturbed.
  const historyCompartment = new Compartment()
  let extensions = options.extensions
  let view: EditorView | null = null
  // Markdown last emitted to (or applied from) the store — the echo guard.
  let lastEmitted = options.doc
  let timer: ReturnType<typeof setTimeout> | null = null

  function emitDoc(): string {
    const text = view ? view.state.doc.toString() : lastEmitted
    if (text !== lastEmitted) {
      lastEmitted = text
      options.onChange(text)
    }
    return text
  }

  function mount(parent: HTMLElement): void {
    if (view) return
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: options.doc,
        extensions: [
          historyCompartment.of(history()),
          compartment.of(extensions),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (update.transactions.some((tr) => tr.annotation(ExternalChange))) return
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(() => {
              timer = null
              emitDoc()
            }, debounceMs)
          }),
        ],
      }),
    })
    lastEmitted = view.state.doc.toString()
    options.onCreateEditor?.(view)
  }

  function flush(): string {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    return emitDoc()
  }

  function reconfigure(next: Extension[]): void {
    extensions = next
    view?.dispatch({ effects: compartment.reconfigure(next) })
  }

  /**
   * Drop the undo/redo stack.
   *
   * This view is reused across documents — the source pane mirrors the newly
   * opened tab into the SAME CodeMirror instance — while the history field keeps
   * its value across that mirroring. `Transaction.addToHistory.of(false)` does
   * NOT clear it: CodeMirror just folds the whole-document replacement into the
   * existing entries as a position mapping (`historyField.update` calls
   * `state.addMapping`), so the previous note's entries stay executable. Only
   * its INSERTIONS collapse to no-ops; a deletion survives as a live inverse and
   * Ctrl+Z in the new note re-inserts the text deleted in the OLD one, which the
   * debounced snapshot publishes into the new tab and autosave then writes to
   * the new note's file (silent data corruption).
   *
   * Reconfiguring the compartment empty and then back to `history()` rebuilds the
   * field from its fresh `create()` value (empty stack). A single reconfigure
   * straight to `history()` is not enough — the field keeps its stored state.
   */
  function resetHistory(): void {
    if (!view) return
    view.dispatch({ effects: historyCompartment.reconfigure([]) })
    view.dispatch({ effects: historyCompartment.reconfigure(history()) })
  }

  function setText(text: string): void {
    if (!view || text === lastEmitted) return
    // A pending local burst that fired after this write would clobber the
    // external content with stale text: drop it — the external write is
    // authoritative (reload / restore / plugin rewrite).
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (view.state.doc.toString() === text) {
      lastEmitted = text
      return
    }
    // A different document is being mirrored in: the previous one's undo
    // entries must not be reachable from here (see resetHistory).
    resetHistory()
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: [
        ExternalChange.of(true),
        Transaction.addToHistory.of(false),
        // Belt and braces: even if a stale entry somehow survived, the
        // replacement is an isolation point undo cannot cross.
        isolateHistory.of('full'),
      ],
    })
    lastEmitted = text
  }

  function destroy(): void {
    flush()
    view?.destroy()
    view = null
  }

  return {
    mount,
    getView: () => view,
    flush,
    hasPendingEdit: () => timer !== null,
    reconfigure,
    setText,
    resetHistory,
    destroy,
  }
}