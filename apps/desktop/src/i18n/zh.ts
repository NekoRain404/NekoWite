// Compatibility surface. The catalogue was split into one module per
// namespace under ./namespaces/ — this file stays the public path so no
// consumer changes, and index.ts keeps importing `zh` from here.
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

export const zh = {
  ...shell.zh,
  ...common.zh,
  ...settings.zh,
  ...sidebar.zh,
  ...notes.zh,
  ...vault.zh,
  ...attachments.zh,
  ...graph.zh,
  ...editor.zh,
  ...palette.zh,
  ...ai.zh,
  ...documents.zh,
  ...references.zh,
  ...search.zh,
  ...chat.zh,
  ...history.zh,
  ...plugins.zh,
}
