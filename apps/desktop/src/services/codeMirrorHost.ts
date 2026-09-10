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
   */
  setText(text: string): void
  destroy(): void
}

export function createCodeMirrorHost(options: CodeMirrorHostOptions): CodeMirrorHostHandle {
  const debounceMs = options.debounceMs ?? SOURCE_SNAPSHOT_DEBOUNCE_MS
  const compartment = new Compartment()
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
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: [ExternalChange.of(true), Transaction.addToHistory.of(false)],
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
    destroy,
  }
}
