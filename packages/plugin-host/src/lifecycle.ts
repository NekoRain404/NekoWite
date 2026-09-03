import type { PluginContext } from './types'

export type LifecycleEvent =
  | 'onEditorReady'
  | 'onDocChange'
  | 'onSave'
  | 'onSaved'
  | 'onOpenDocument'
  | 'onCloseTab'
  | 'onViewModeChange'

export interface LifecycleEventArgMap {
  onEditorReady: [editor: unknown]
  onDocChange: [e: { doc: string }]
  onSave: [editor: unknown, content: string]
  onSaved: [editor: unknown, content: string]
  onOpenDocument: [tab: unknown]
  onCloseTab: [tab: unknown]
  onViewModeChange: [mode: unknown]
}

interface HookEntry {
  id: string
  fn: (...args: unknown[]) => unknown
  ctx: PluginContext
}

const hooks = new Map<LifecycleEvent, HookEntry[]>()

let activeEditor: unknown = null

export function setActiveEditor(editor: unknown): void {
  activeEditor = editor
}

export function getActiveEditor(): unknown {
  return activeEditor
}

export function registerLifecycleHook(
  id: string,
  event: LifecycleEvent,
  fn: (...args: unknown[]) => unknown,
  ctx: PluginContext,
): () => void {
  const entry: HookEntry = { id, fn, ctx }
  const list = hooks.get(event) ?? []
  list.push(entry)
  hooks.set(event, list)
  return () => {
    const cur = hooks.get(event) ?? []
    const i = cur.indexOf(entry)
    if (i >= 0) cur.splice(i, 1)
  }
}

export function hasLifecycleListeners(event: LifecycleEvent): boolean {
  return (hooks.get(event)?.length ?? 0) > 0
}

export function emitLifecycle(event: LifecycleEvent, ...args: unknown[]): string | void {
  const isSave = event === 'onSave'
  // onSave transforms chain: once a hook returns a string, that string becomes
  // the content argument for the following hooks; a non-string return passes
  // the running value through unchanged. Other events fan out with the
  // original args.
  let next: string | undefined
  // Iterate a snapshot of the hook list: a hook that unregisters another hook
  // mid-emit must not shift indices and skip the hook after it. Hooks
  // registered during this emit are picked up on the next emit.
  for (const entry of [...(hooks.get(event) ?? [])]) {
    try {
      // Keep ctx.editor truthful: it always reflects the active editor at emit
      // time, so hooks that opt into ctx (rather than the editor ARG) see the
      // right instance.
      entry.ctx.editor = activeEditor
      const hookArgs = isSave && next !== undefined ? [args[0], next] : args
      const r = entry.fn(entry.ctx, ...hookArgs)
      if (isSave && typeof r === 'string') next = r
    } catch {
      /* isolation: one plugin's failure never blocks others */
    }
  }
  return next
}
