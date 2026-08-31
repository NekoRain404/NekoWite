import type { Component } from 'vue'
import type { EditorCommand, RegistrationBatch, ToolbarItem } from '@nekowite/editor-core'

export interface PluginMeta {
  id: string
  name: string
  version: string
  main: string
}

export interface PluginContext {
  id: string
  name: string
  insertComponent: (name: string) => void
  editor?: unknown // populated by the app after onEditorReady
}

export interface PluginDefinition extends RegistrationBatch {
  name?: string
  components?: Record<string, Component>
  toolbar?: ToolbarItem[]
  commands?: EditorCommand[]
  onLoad?(ctx: PluginContext): void
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
