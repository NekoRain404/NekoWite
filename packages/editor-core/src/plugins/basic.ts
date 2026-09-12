import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { listener } from '@milkdown/plugin-listener'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { columnResizing } from '@milkdown/prose/tables'
import { $prose } from '@milkdown/utils'

import { cite, citeNodeView, citeOrderSyncPlugin, citeRemark } from '../cite'
import { codeBlockCopyNodeView } from '../codeblock'
import { footnoteReferenceNodeView } from '../footnote'
import { headingAnchorNodeView } from '../heading'
import {
  highlight,
  highlightRemark,
  highlightStringify,
} from '../highlight'
import {
  imageDimRemark,
  imageDimSchema,
  imageKeymapPlugin,
  imageNodeView,
  imageSelectionPlugin,
} from '../image'
import {
  mathDisplay,
  mathDisplayNodeView,
  mathFeaturePlugin,
  mathInline,
  mathInlineNodeView,
  mathRemark,
} from '../math'
import { linkOrderSchema } from '../link'
import { mdxComponent, mdxComponentNodeView, mdxJsxRemark } from '../mdx'
import { tableAutoRowKeymap, tableClipboardKeymap } from '../table/keymap'
import { tableCellHtmlEscapeStringify } from '../table/stringify'
import { tableFeaturePlugin } from '../table/plugin'
import { tableSelectionPlugin } from '../table/selection'
import { suggestionPlugin } from '../suggest'
import { taskCheckbox } from '../task/checkbox'
import { wikilink, wikilinkNodeView, wikilinkRemark } from '../wikilink'

export const basicPlugins: MilkdownPlugin[] = [
  // Runs before the GFM table keymap so Tab on the last cell can append a row.
  $prose(() => tableAutoRowKeymap),
  // Cell copy/cut/paste only fires on an active cell selection (or an in-table
  // caret for paste); Mod/Cmd+C/X/V outside a table fall through untouched.
  $prose(() => tableClipboardKeymap),
  ...mdxJsxRemark,
  mdxComponentNodeView,
  ...commonmark,
  // Must come after `commonmark` (which declares the base `link` mark) so this
  // later registration wins; see `linkOrderSchema` for why the priority matters.
  ...linkOrderSchema,
  ...imageDimSchema,
  ...imageDimRemark,
  imageNodeView,
  $prose(() => imageSelectionPlugin),
  $prose(() => imageKeymapPlugin),
  codeBlockCopyNodeView,
  headingAnchorNodeView,
  // Runs before the GFM `tableEditing` so the column-width drag handle gets a
  // turn before the broad cell-selection mouse handler. One drag = one undo
  // (prosemirror-tables commits the colwidth on pointer-up as a single step).
  $prose(() => columnResizing({})),
  ...gfm.flat(),
  // After the GFM preset: clicking a rendered task checkbox toggles `checked`.
  taskCheckbox,
  footnoteReferenceNodeView,
  ...citeRemark,
  cite,
  citeNodeView,
  citeOrderSyncPlugin,
  ...mathRemark,
  mathInline,
  mathDisplay,
  mathInlineNodeView,
  mathDisplayNodeView,
  mathFeaturePlugin,
  ...highlightRemark,
  highlight,
  highlightStringify,
  ...wikilinkRemark,
  wikilink,
  wikilinkNodeView,
  ...history.flat(),
  listener,
  mdxComponent,
  tableFeaturePlugin,
  tableCellHtmlEscapeStringify,
  $prose(() => tableSelectionPlugin),
  $prose(() => suggestionPlugin),
]
