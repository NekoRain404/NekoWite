// Compatibility surface. The catalogue was split into one module per
// namespace under ./namespaces/ — this file stays the public path so no
// consumer changes, and index.ts keeps importing `en` from here.
import { shell } from './namespaces/shell'
import { common } from './namespaces/common'
import { settings } from './namespaces/settings'
import { sidebar } from './namespaces/sidebar'
import { notes } from './namespaces/notes'
import { vault } from './namespaces/vault'
import { attachments } from './namespaces/attachments'
import { graph } from './namespaces/graph'
import { editor } from './namespaces/editor'
import { palette } from './namespaces/palette'
import { ai } from './namespaces/ai'
import { documents } from './namespaces/documents'
import { references } from './namespaces/references'
import { search } from './namespaces/search'
import { chat } from './namespaces/chat'
import { history } from './namespaces/history'
import { plugins } from './namespaces/plugins'
import { agent } from './namespaces/agent'

export const en = {
  ...shell.en,
  ...common.en,
  ...settings.en,
  ...sidebar.en,
  ...notes.en,
  ...vault.en,
  ...attachments.en,
  ...graph.en,
  ...editor.en,
  ...palette.en,
  ...ai.en,
  ...documents.en,
  ...references.en,
  ...search.en,
  ...chat.en,
  ...history.en,
  ...plugins.en,
  ...agent.en,
}
