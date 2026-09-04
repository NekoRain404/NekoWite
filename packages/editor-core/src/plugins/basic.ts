import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { listener } from '@milkdown/plugin-listener'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
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
import { mdxComponent, mdxComponentNodeView, mdxJsxRemark } from '../mdx'
import { tableAutoRowKeymap } from '../table/keymap'
import { tableFeaturePlugin } from '../table/plugin'
import { tableSelectionPlugin } from '../table/selection'
import { suggestionPlugin } from '../suggest'
import { wikilink, wikilinkNodeView, wikilinkRemark } from '../wikilink'

// Issue: Chromium sometimes places the DOM caret OUTSIDE a nodeView's
// `contentDOM`. That happens when the click lands on a node's non-content
// region — most visibly a heading whose trailing "#" anchor button (or the empty
// space right of short text) is at the click point. The browser then inserts the
// typed characters as *stray* DOM text in the nodeView `dom` (a sibling of the
// content span). Such mutations never reach the heading nodeView's contentDOM,
// so its `ignoreMutation` skips them and ProseMirror's MutationObserver never
// synthesises a transaction: the screen text changes but the model stays frozen,
// so onContentChange / onDocChange never fire.
//
// This plugin routes the native text-insertion path through `view.dispatch`
// (equivalent to ProseMirror's own default for plain text entry) after
// cancelling the browser's default mutation, so the model stays correct no
// matter where the DOM caret landed. Other input types (Enter, Backspace/Delete,
// paste, IME composition) are left to ProseMirror's normal pipeline; those only
// mis-dispatch in the same stray-caret case, which plain typing exercises here.
const nativeInputPlugin = new Plugin({
  props: {
    handleDOMEvents: {
      beforeinput(view: EditorView, event: Event) {
        const input = event as InputEvent
        if (input.inputType !== 'insertText' && input.inputType !== 'insertReplacementText') {
          return false
        }
        const text = input.data ?? ''
        if (!text) return false
        input.preventDefault()
        view.dispatch(view.state.tr.insertText(text).scrollIntoView())
        return true
      },
    },
  },
})

export const basicPlugins: MilkdownPlugin[] = [
  // Runs before the GFM table keymap so Tab on the last cell can append a row.
  $prose(() => tableAutoRowKeymap),
  ...mdxJsxRemark,
  mdxComponentNodeView,
  ...commonmark,
  ...imageDimSchema,
  ...imageDimRemark,
  imageNodeView,
  $prose(() => imageSelectionPlugin),
  $prose(() => imageKeymapPlugin),
  codeBlockCopyNodeView,
  headingAnchorNodeView,
  ...gfm.flat(),
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
  $prose(() => tableSelectionPlugin),
  $prose(() => suggestionPlugin),
  $prose(() => nativeInputPlugin),
]