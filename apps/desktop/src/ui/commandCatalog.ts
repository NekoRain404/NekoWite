import { markRaw, type Component } from 'vue'
import {
  Bold,
  Boxes,
  Braces,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  MessageSquareQuote,
  Minus,
  Puzzle,
  Quote,
  Sigma,
  SquareCode,
  Strikethrough,
  Table,
} from 'lucide-vue-next'
import { t } from '../i18n'

export interface CatalogMeta {
  label: string
  icon: Component
  keywords?: string
}

/** id → localized label + icon. Builtins use the editor-core command ids; the
 * registry-only ids below are the first-party feature commands. Anything
 * unknown (a third-party plugin command) falls back to `Puzzle`. The label is
 * resolved through `t()` so the palette never renders hardcoded text; the
 * reactive display path uses `COMMAND_KEYS` instead (see CommandPalette). */
export const COMMAND_CATALOG: Record<string, CatalogMeta> = {
  'heading:h1': { label: t('command.heading:h1'), icon: markRaw(Heading1), keywords: 'heading h1' },
  'heading:h2': { label: t('command.heading:h2'), icon: markRaw(Heading2), keywords: 'heading h2' },
  'heading:h3': { label: t('command.heading:h3'), icon: markRaw(Heading3), keywords: 'heading h3' },
  'heading:h4': { label: t('command.heading:h4'), icon: markRaw(Heading4), keywords: 'heading h4' },
  'heading:h5': { label: t('command.heading:h5'), icon: markRaw(Heading5), keywords: 'heading h5' },
  'heading:h6': { label: t('command.heading:h6'), icon: markRaw(Heading6), keywords: 'heading h6' },
  bold: { label: t('command.bold'), icon: markRaw(Bold), keywords: 'bold b' },
  italic: { label: t('command.italic'), icon: markRaw(Italic), keywords: 'italic i' },
  strike: { label: t('command.strike'), icon: markRaw(Strikethrough), keywords: 'strike strikethrough' },
  'inline-code': { label: t('command.inline-code'), icon: markRaw(Code), keywords: 'code' },
  'list-unordered': { label: t('command.list-unordered'), icon: markRaw(List), keywords: 'bullet ul' },
  'list-ordered': { label: t('command.list-ordered'), icon: markRaw(ListOrdered), keywords: 'number ol' },
  'list-task': { label: t('command.list-task'), icon: markRaw(ListTodo), keywords: 'todo check' },
  quote: { label: t('command.quote'), icon: markRaw(Quote), keywords: 'blockquote' },
  link: { label: t('command.link'), icon: markRaw(Link), keywords: 'url href' },
  image: { label: t('command.image'), icon: markRaw(Image), keywords: 'img picture' },
  'code-block': { label: t('command.code-block'), icon: markRaw(SquareCode), keywords: 'fence code' },
  hr: { label: t('command.hr'), icon: markRaw(Minus), keywords: 'rule separator' },
  'insert-component': { label: t('command.insert-component'), icon: markRaw(Braces), keywords: 'mdx component' },
  'math.insert': { label: t('command.math.insert'), icon: markRaw(Sigma), keywords: 'math latex' },
  'table.insert': { label: t('command.table.insert'), icon: markRaw(Table), keywords: 'table grid' },
  'callout.insert': { label: t('command.callout.insert'), icon: markRaw(MessageSquareQuote), keywords: 'callout' },
  'floatbox.insert': { label: t('command.floatbox.insert'), icon: markRaw(Boxes), keywords: 'float box' },
}

export const FALLBACK_COMMAND_ICON: Component = markRaw(Puzzle)

/** id → i18n message key used by the command palette for localized labels. */
export const COMMAND_KEYS: Record<string, string> = {
  'heading:h1': 'command.heading:h1',
  'heading:h2': 'command.heading:h2',
  'heading:h3': 'command.heading:h3',
  'heading:h4': 'command.heading:h4',
  'heading:h5': 'command.heading:h5',
  'heading:h6': 'command.heading:h6',
  bold: 'command.bold',
  italic: 'command.italic',
  strike: 'command.strike',
  'inline-code': 'command.inline-code',
  'list-unordered': 'command.list-unordered',
  'list-ordered': 'command.list-ordered',
  'list-task': 'command.list-task',
  quote: 'command.quote',
  link: 'command.link',
  image: 'command.image',
  'code-block': 'command.code-block',
  hr: 'command.hr',
  'insert-component': 'command.insert-component',
  'math.insert': 'command.math.insert',
  'table.insert': 'command.table.insert',
  'callout.insert': 'command.callout.insert',
  'floatbox.insert': 'command.floatbox.insert',
}

export function catalogOf(id: string): CatalogMeta {
  return COMMAND_CATALOG[id] ?? { label: id, icon: FALLBACK_COMMAND_ICON }
}
