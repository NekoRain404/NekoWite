import type { Component } from 'vue'
import type { EditorCommand, RegistrationBatch, ToolbarItem } from '@nekowite/editor-core'

/** Sensitive capabilities a plugin may declare it needs. The host surfaces
 *  these to the user before activation; without a real sandbox, declaring them
 *  is how the plugin makes the boundary explicit so the user can judge risk. */
export type PluginPermission = 'ai' | 'fs' | 'network' | 'clipboard'

export interface PluginMeta {
  id: string
  name: string
  version: string
  main: string
  /** Optional manifest-declared capabilities (e.g. from `package.json`). */
  permissions?: PluginPermission[]
}

export interface PluginContext {
  id: string
  name: string
  insertComponent: (name: string) => void
  // Convenience: the app's active editor at emit time. Set by the host inside
  // emitLifecycle from getActiveEditor(); hooks that need the editor should
  // prefer the editor ARG (threaded into onEditorReady/onSave/onSaved).
  editor?: unknown
}

export interface PluginDefinition extends RegistrationBatch {
  name?: string
  /** Optional capabilities this plugin declares it needs. The host may gate
   *  activation of dangerous capabilities on user confirmation. */
  permissions?: PluginPermission[]
  components?: Record<string, Component>
  toolbar?: ToolbarItem[]
  commands?: EditorCommand[]
  onLoad?(ctx: PluginContext): void | (() => void)
  onUnload?(ctx: PluginContext): void
  onEditorReady?(ctx: PluginContext, editor: unknown): void | (() => void)
  onDocChange?(ctx: PluginContext, e: { doc: string }): void | (() => void)
  onSave?(ctx: PluginContext, editor: unknown, content: string): string | void | (() => void)
  onSaved?(ctx: PluginContext, editor: unknown, content: string): void | (() => void)
  onOpenDocument?(ctx: PluginContext, tab: unknown): void | (() => void)
  onCloseTab?(ctx: PluginContext, tab: unknown): void | (() => void)
  onViewModeChange?(ctx: PluginContext, mode: unknown): void | (() => void)
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def
}
