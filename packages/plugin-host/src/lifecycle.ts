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
  let next: string | undefined
  for (const entry of hooks.get(event) ?? []) {
    try {
      const r = entry.fn(entry.ctx, ...args)
      if (event === 'onSave' && typeof r === 'string') next = r
    } catch {
      /* isolation: one plugin's failure never blocks others */
    }
  }
  return next
}
