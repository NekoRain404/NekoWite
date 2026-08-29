import type { MilkdownPlugin } from '@milkdown/ctx'
import { Editor, editorViewCtx, parserCtx, rootCtx } from '@milkdown/core'
import { listenerCtx } from '@milkdown/plugin-listener'
import type { EditorView } from '@milkdown/prose/view'
import { getMarkdown } from '@milkdown/utils'

import { basicPlugins } from './plugins/basic'

export { basicPlugins }

export interface NekoEditor {
  open(content: string): Promise<void>
  save(): Promise<string>
  getView(): EditorView
  onContentChange(cb: () => void): () => void
}

export function createEditor(
  target: HTMLElement,
  options: { plugins?: MilkdownPlugin[] } = {}
): NekoEditor {
  const plugins = options.plugins ?? basicPlugins
  const changeHandlers = new Set<() => void>()
  let view: EditorView | null = null

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
      return created.action((ctx) => getMarkdown()(ctx))
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
  }
}