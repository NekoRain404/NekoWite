import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { listener } from '@milkdown/plugin-listener'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { $prose } from '@milkdown/utils'

import { cite, citeNodeView, citeOrderSyncPlugin, citeRemark } from '../cite'
import { footnoteReferenceNodeView } from '../footnote'
import {
  highlight,
  highlightRemark,
  highlightStringify,
} from '../highlight'
import {
  imageDimRemark,
  imageDimSchema,
  imageNodeView,
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
import { tableFeaturePlugin } from '../table/plugin'
import { suggestionPlugin } from '../suggest'
import { wikilink, wikilinkNodeView, wikilinkRemark } from '../wikilink'

export const basicPlugins: MilkdownPlugin[] = [
  ...mdxJsxRemark,
  mdxComponentNodeView,
  ...commonmark,
  ...imageDimSchema,
  ...imageDimRemark,
  imageNodeView,
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
  $prose(() => suggestionPlugin),
]