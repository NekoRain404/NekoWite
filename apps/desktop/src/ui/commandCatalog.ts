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

export interface CatalogMeta {
  label: string
  icon: Component
  keywords?: string
}

/** id → 中文标签 + 图标. Builtins use the editor-core command ids; the
 * registry-only ids below are the first-party feature commands. Anything
 * unknown (a third-party plugin command) falls back to `Puzzle`. */
export const COMMAND_CATALOG: Record<string, CatalogMeta> = {
  'heading:h1': { label: '标题 1', icon: markRaw(Heading1), keywords: 'heading h1' },
  'heading:h2': { label: '标题 2', icon: markRaw(Heading2), keywords: 'heading h2' },
  'heading:h3': { label: '标题 3', icon: markRaw(Heading3), keywords: 'heading h3' },
  'heading:h4': { label: '标题 4', icon: markRaw(Heading4), keywords: 'heading h4' },
  'heading:h5': { label: '标题 5', icon: markRaw(Heading5), keywords: 'heading h5' },
  'heading:h6': { label: '标题 6', icon: markRaw(Heading6), keywords: 'heading h6' },
  bold: { label: '加粗', icon: markRaw(Bold), keywords: 'bold b' },
  italic: { label: '斜体', icon: markRaw(Italic), keywords: 'italic i' },
  strike: { label: '删除线', icon: markRaw(Strikethrough), keywords: 'strike strikethrough' },
  'inline-code': { label: '行内代码', icon: markRaw(Code), keywords: 'code' },
  'list-unordered': { label: '无序列表', icon: markRaw(List), keywords: 'bullet ul' },
  'list-ordered': { label: '有序列表', icon: markRaw(ListOrdered), keywords: 'number ol' },
  'list-task': { label: '任务列表', icon: markRaw(ListTodo), keywords: 'todo check' },
  quote: { label: '引用', icon: markRaw(Quote), keywords: 'blockquote' },
  link: { label: '链接', icon: markRaw(Link), keywords: 'url href' },
  image: { label: '图片', icon: markRaw(Image), keywords: 'img picture' },
  'code-block': { label: '代码块', icon: markRaw(SquareCode), keywords: 'fence code' },
  hr: { label: '分隔线', icon: markRaw(Minus), keywords: 'rule separator' },
  'insert-component': { label: '插入 MDX 组件', icon: markRaw(Braces), keywords: 'mdx component' },
  'math.insert': { label: '插入数学公式', icon: markRaw(Sigma), keywords: 'math latex' },
  'table.insert': { label: '插入表格', icon: markRaw(Table), keywords: 'table grid' },
  'callout.insert': { label: '插入 Callout', icon: markRaw(MessageSquareQuote), keywords: 'callout' },
  'floatbox.insert': { label: '插入 FloatBox', icon: markRaw(Boxes), keywords: 'float box' },
}

export const FALLBACK_COMMAND_ICON: Component = markRaw(Puzzle)

export function catalogOf(id: string): CatalogMeta {
  return COMMAND_CATALOG[id] ?? { label: id, icon: FALLBACK_COMMAND_ICON }
}
