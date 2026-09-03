import type { Component } from 'vue'

export interface ToolbarItem { id: string; label: string; run: () => void }
export interface EditorCommand { id: string; run: () => void }
export interface RegistrationBatch {
  components?: Record<string, Component>
  toolbar?: ToolbarItem[]
  commands?: EditorCommand[]
}

export class DuplicateRegistrationError extends Error {}

const commands = new Map<string, EditorCommand>()
const components = new Map<string, Component>()
const toolbar: ToolbarItem[] = []

export function registerCommand(cmd: EditorCommand): void {
  if (commands.has(cmd.id)) throw new DuplicateRegistrationError(`command ${cmd.id} already registered`)
  commands.set(cmd.id, cmd)
}
export function getCommand(id: string): EditorCommand | undefined {
  return commands.get(id)
}
export function listCommands(): EditorCommand[] {
  return [...commands.values()]
}
export function registerComponent(name: string, component: Component): void {
  if (components.has(name)) throw new DuplicateRegistrationError(`component ${name} already registered`)
  components.set(name, component)
}
export function getComponent(name: string): Component | undefined {
  return components.get(name)
}
export function registerToolbar(item: ToolbarItem): void {
  toolbar.push(item)
}
export function getToolbar(): ToolbarItem[] {
  return [...toolbar]
}
export function unregisterCommand(id: string): void {
  commands.delete(id)
}
export function unregisterComponent(name: string): void {
  components.delete(name)
}
export function unregisterToolbar(id: string): void {
  const index = toolbar.findIndex((item) => item.id === id)
  if (index >= 0) toolbar.splice(index, 1)
}
export function registerAll(batch: RegistrationBatch): void {
  for (const [name, comp] of Object.entries(batch.components ?? {})) registerComponent(name, comp)
  for (const item of batch.toolbar ?? []) registerToolbar(item)
  for (const cmd of batch.commands ?? []) registerCommand(cmd)
}