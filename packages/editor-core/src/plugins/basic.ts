import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { listener } from '@milkdown/plugin-listener'
import type { MilkdownPlugin } from '@milkdown/ctx'
import type { Node as ProseNode, NodeType } from '@milkdown/prose/model'
import { InputRule } from '@milkdown/prose/inputrules'
import { columnResizing } from '@milkdown/prose/tables'
import { $inputRule, $prose } from '@milkdown/utils'

import { cite, citeNodeView, citeOrderSyncPlugin, citeRemark } from '../cite'
import { codeBlockCopyNodeView, codeBlockPastePlugin } from '../codeblock'
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
import { mdxComponent, mdxComponentNodeView, mdxJsxRemark, mdxTextStringify } from '../mdx'
import { tableAutoRowKeymap, tableClipboardKeymap } from '../table/keymap'
import { tableCellHtmlEscapeStringify } from '../table/stringify'
import { tableFeaturePlugin } from '../table/plugin'
import { tableSelectionPlugin } from '../table/selection'
import { suggestionPlugin } from '../suggest'
import { taskCheckbox } from '../task/checkbox'
import { wikilink, wikilinkNodeView, wikilinkRemark } from '../wikilink'


/**
 * The inspector metadata the preset gives its thematic-break input rule.
 *
 * The preset's copy is identified by this display name and filtered out of
 * `basicPlugins` below; our guarded copy carries the same metadata so the plugin
 * list stays self-describing.
 */
const HR_INPUT_RULE_META = {
  package: '@milkdown/preset-commonmark',
  displayName: 'InputRule<insertHrInputRule>',
  group: 'Hr',
}

/**
 * Whether an hr can take the place of `length` characters starting at `$from`.
 *
 * This is what \`doc.canReplaceWith\` does with the type, applied to the innermost node
 * instead of the document: the document-level call walks the whole document, and
 * inside a cell the span it is asked about runs past the END of the paragraph (the
 * paragraph is the cell's last child), which makes ProseMirror read a child that is
 * not there and throw. Same answer, no throw.
 */
function canFit(
  $from: { parent: ProseNode; parentOffset: number },
  hr: NodeType,
  length: number,
): boolean {
  const parent = $from.parent
  if (parent.type.name === 'code_block') return false
  const from = $from.parentOffset
  const to = Math.min(from + length, parent.content.size)
  if (to < from + length) return false
  return parent.canReplaceWith(from, to, hr)
}

/**
 * The \`---\` / \`___ \` / \`*** \` thematic-break input rule, with a schema guard.
 *
 * Milkdown's stock rule calls \`tr.replaceWith(start - 1, end, hr)\` with no check,
 * and inside a table cell that range IS the cell's paragraph. An \`hr\` cannot live
 * in a cell, so the fitter lifts it out and SPLITS the table in two — from typing
 * three dashes, with no button press, and with \`doc.check()\` still passing so
 * nothing warns the user before the split is saved. The preset's own rule is
 * filtered out of the plugin list (see \`basicPlugins\`) because input rules run in
 * registration order and the first match wins, so a later rule could never veto it.
 *
 * The guard asks the schema whether the hr fits where the match begins. When it
 * does not (the cell paragraph), an empty transaction is returned rather than
 * \`null\`: \`null\` makes prosemirror-inputrules report the keystroke as unhandled
 * and the browser's own input is then not applied either, so the third dash would
 * be swallowed.
 */
export const insertHrInputRule: MilkdownPlugin = $inputRule(
  () =>
    new InputRule(/^(?:---|___\s|\*\*\*\s)$/, (state, match, start) => {
      const hr = state.schema.nodes.hr
      if (!hr) return state.tr
      const from = start - 1
      const to = start - 1 + match[0].length
      // Out-of-range or cross-block spans would make \`canReplaceWith\` itself
      // throw; either way the rule must not rewrite anything.
      if (from < 0 || to > state.doc.content.size) return state.tr
      const target = state.doc.resolve(from)
      if (!canFit(target, hr, to - from)) return state.tr
      return state.tr.replaceWith(from, to, hr.create())
    })
)

;(insertHrInputRule as unknown as { meta: unknown }).meta = HR_INPUT_RULE_META

export const basicPlugins: MilkdownPlugin[] = [
  // Runs before the GFM table keymap so Tab on the last cell can append a row.
  $prose(() => tableAutoRowKeymap),
  // Cell copy/cut/paste only fires on an active cell selection (or an in-table
  // caret for paste); Mod/Cmd+C/X/V outside a table fall through untouched.
  $prose(() => tableClipboardKeymap),
  ...mdxJsxRemark,
  mdxComponentNodeView,
  // Both stringifiers must agree on how an MDX run is written back; this one
  // installs the handler for the editor's own serializer (its parse-time twin is
  // `mdxJsxRemark` above, and `serialize.ts` uses the same handler for the
  // re-parse every save runs).
  mdxTextStringify,
  // The preset's thematic-break rule is dropped and replaced below. Input rules
  // run in registration order and the first one that matches wins, so a later rule
  // cannot veto the preset's — inside a cell the preset's rule fired first and
  // split the table before the guarded copy was ever reached. The preset's copy is
  // the one whose inspector meta carries this displayName.
  ...commonmark.filter(
    (plugin) =>
      (plugin as unknown as { meta?: { displayName?: string } } | undefined)?.meta
        ?.displayName !== HR_INPUT_RULE_META.displayName,
  ),
  // Same regex, but it checks the schema before replacing the paragraph.
  insertHrInputRule,
  // Must come after `commonmark` (which declares the base `link` mark) so this
  // later registration wins; see `linkOrderSchema` for why the priority matters.
  ...linkOrderSchema,
  ...imageDimSchema,
  ...imageDimRemark,
  imageNodeView,
  $prose(() => imageSelectionPlugin),
  $prose(() => imageKeymapPlugin),
  codeBlockCopyNodeView,
  // A paste into a code block must stay plain text (see codeblock/paste.ts).
  codeBlockPastePlugin,
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
