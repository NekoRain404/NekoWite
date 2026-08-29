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
}

export interface PluginDefinition extends RegistrationBatch {
  name?: string
  components?: Record<string, Component>
  toolbar?: ToolbarItem[]
  commands?: EditorCommand[]
  onLoad?(ctx: PluginContext): void
  onUnload?(ctx: PluginContext): void
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def
}
