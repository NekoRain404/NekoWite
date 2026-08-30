import type { MilkdownPlugin } from '@milkdown/ctx'
import { Editor, editorViewCtx, parserCtx, rootCtx } from '@milkdown/core'
import { listenerCtx } from '@milkdown/plugin-listener'
import type { EditorView } from '@milkdown/prose/view'
import { getMarkdown } from '@milkdown/utils'

import { basicPlugins } from './plugins/basic'
import { roundTrip } from './serialize'
import {
  acceptSuggestion as acceptSuggestionFor,
  hasSuggestion as hasSuggestionFor,
  rejectSuggestion as rejectSuggestionFor,
  setSuggestion as setSuggestionFor,
  SUGGESTION_META,
} from './suggest'
import type { SuggestionStatus } from './suggest'

export { basicPlugins }

export interface NekoEditor {
  open(content: string): Promise<void>
  save(): Promise<string>
  getView(): EditorView
  onContentChange(cb: () => void): () => void
  setSuggestion(text: string | null): void
  acceptSuggestion(): string | null
  rejectSuggestion(): void
  hasSuggestion(): boolean
  onSuggestionChange(cb: (status: SuggestionStatus) => void): () => void
  destroy(): void
}

export function createEditor(
  target: HTMLElement,
  options: { plugins?: MilkdownPlugin[] } = {}
): NekoEditor {
  const plugins = options.plugins ?? basicPlugins
  const changeHandlers = new Set<() => void>()
  const suggestionHandlers = new Set<(status: SuggestionStatus) => void>()
  let view: EditorView | null = null

  const notifySuggestion = (status: SuggestionStatus): void => {
    suggestionHandlers.forEach((handler) => handler(status))
  }

  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, target)
    })
    .config((ctx) => {
      ctx.get(listenerCtx).markdownUpdated(() => {
        changeHandlers.forEach((handler) => handler())
      })
    })
    .use(plugins)
    .create()

  const ready = editor.then((created) => {
    view = created.action((ctx) => ctx.get(editorViewCtx))
    const v = view as EditorView
    const dispatch = v.dispatch.bind(v)
    v.dispatch = (tr) => {
      const prevDoc = v.state.doc
      const hadSuggestion = hasSuggestionFor(v)
      dispatch(tr)
      const hasNow = hasSuggestionFor(v)
      if (
        hadSuggestion &&
        !hasNow &&
        v.state.doc !== prevDoc &&
        tr.getMeta(SUGGESTION_META) === undefined
      ) {
        notifySuggestion('cleared')
      }
    }
    return created
  })

  return {
    async open(content: string) {
      await ready
      const created = await editor
      created.action((ctx) => {
        const v = ctx.get(editorViewCtx)
        const parser = ctx.get(parserCtx)
        const node = parser(content)
        v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, node))
      })
    },
    async save() {
      const created = await editor
      return created.action((ctx) => roundTrip(getMarkdown()(ctx)))
    },
    getView() {
      if (!view) {
        throw new Error('[NekoEditor] editor view is not available yet')
      }
      return view as EditorView
    },
    onContentChange(cb: () => void): () => void {
      changeHandlers.add(cb)
      return () => changeHandlers.delete(cb)
    },
    setSuggestion(text: string | null): void {
      const v = this.getView()
      const had = hasSuggestionFor(v)
      setSuggestionFor(text, v)
      if (text === null && had) notifySuggestion('cleared')
    },
    acceptSuggestion(): string | null {
      const inserted = acceptSuggestionFor(this.getView())
      if (inserted !== null) notifySuggestion('accepted')
      return inserted
    },
    rejectSuggestion(): void {
      const v = this.getView()
      if (!hasSuggestionFor(v)) return
      rejectSuggestionFor(v)
      notifySuggestion('rejected')
    },
    hasSuggestion(): boolean {
      return hasSuggestionFor(this.getView())
    },
    onSuggestionChange(cb: (status: SuggestionStatus) => void): () => void {
      suggestionHandlers.add(cb)
      return () => suggestionHandlers.delete(cb)
    },
    destroy() {
      changeHandlers.clear()
      suggestionHandlers.clear()
      void editor
        .then((created) => {
          if (created.status !== 'Destroyed') return created.destroy()
        })
        .catch(() => undefined)
    },
  }
}
