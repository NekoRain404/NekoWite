import type { Component } from 'vue'

export interface ToolbarItem { id: string; label: string; run: () => void }
export interface EditorCommand { id: string; run: () => void }
export interface RegistrationBatch {
  components?: Record<string, Component>
  toolbar?: ToolbarItem[]
  commands?: EditorCommand[]
}

export class DuplicateRegistrationError extends Error {}

/**
 * Who registered a toolbar item. `''` is the host's own namespace — the
 * editor's built-in features, which own their ids for the life of the process.
 * A plugin passes its plugin id, so its button is keyed (owner, id) rather than
 * by id alone.
 */
type ToolbarOwner = string

const HOST: ToolbarOwner = ''

const commands = new Map<string, EditorCommand>()
const components = new Map<string, Component>()
const toolbar: Array<{ owner: ToolbarOwner; item: ToolbarItem }> = []

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
/**
 * Register a toolbar item for `owner` (a plugin id; omitted for the editor's
 * own features and the host).
 *
 * The key is (owner, id), because the same id from a DIFFERENT owner is a
 * different button, not a replacement: an id-keyed registry let plugin B take
 * over plugin A's button in place, and then — `unregisterToolbar` being
 * id-keyed too — delete it on deactivate, so the loser's button vanished with
 * no error and nothing to show A. A foreign id now throws, the way a duplicate
 * command or component already does, and a plugin's teardown can only reach its
 * own items. The SAME owner re-registering its own id still overwrites in
 * place: the features re-run per editor and plugins re-register on activation,
 * so that path must stay an upsert and must keep the toolbar's order.
 */
export function registerToolbar(item: ToolbarItem, owner: ToolbarOwner = HOST): void {
  const index = toolbar.findIndex((entry) => entry.owner === owner && entry.item.id === item.id)
  if (index >= 0) {
    toolbar[index] = { owner, item }
    return
  }
  if (toolbar.some((entry) => entry.item.id === item.id)) {
    throw new DuplicateRegistrationError(`toolbar ${item.id} is already registered by its owner`)
  }
  toolbar.push({ owner, item })
}
export function getToolbar(): ToolbarItem[] {
  return toolbar.map((entry) => entry.item)
}
export function unregisterCommand(id: string): void {
  commands.delete(id)
}
export function unregisterComponent(name: string): void {
  components.delete(name)
}
/**
 * Remove `owner`'s item with this id. Another owner's item with the same id is
 * left alone — that is the point of the owner key (see `registerToolbar`).
 */
export function unregisterToolbar(id: string, owner: ToolbarOwner = HOST): void {
  const index = toolbar.findIndex((entry) => entry.owner === owner && entry.item.id === id)
  if (index >= 0) toolbar.splice(index, 1)
}
/** A command's Markdown-level equivalent, used when the text editor (rather
 *  than the rendered one) owns the document. */
export interface MarkdownInsert {
  text: string
  /** Caret offset inside `text` after insertion; defaults to the end. */
  caret?: number
}
export type MarkdownCommand = () => string | MarkdownInsert

const markdownCommands = new Map<string, MarkdownCommand>()

/**
 * Register how a command is expressed as Markdown text.
 *
 * A command that inserts a rich node (a math block, a table, an MDX component)
 * is only meaningful while the rendered editor owns the document. Source mode
 * has no such node, so the command publishes the Markdown it would have
 * produced and the host inserts that instead — otherwise the insert would land
 * in the hidden model and be lost.
 */
export function registerMarkdownCommand(id: string, produce: MarkdownCommand): void {
  markdownCommands.set(id, produce)
}
export function getMarkdownCommand(id: string): MarkdownCommand | undefined {
  return markdownCommands.get(id)
}
export function unregisterMarkdownCommand(id: string): void {
  markdownCommands.delete(id)
}

export function registerAll(batch: RegistrationBatch, owner?: ToolbarOwner): void {
  for (const [name, comp] of Object.entries(batch.components ?? {})) registerComponent(name, comp)
  for (const item of batch.toolbar ?? []) registerToolbar(item, owner)
  for (const cmd of batch.commands ?? []) registerCommand(cmd)
}