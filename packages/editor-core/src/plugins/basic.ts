import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { listener } from '@milkdown/plugin-listener'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { $prose } from '@milkdown/utils'

import { cite, citeNodeView, citeOrderSyncPlugin, citeRemark } from '../cite'
import { imageNodeView } from '../image'
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

export const basicPlugins: MilkdownPlugin[] = [
  ...mdxJsxRemark,
  mdxComponentNodeView,
  ...commonmark,
  imageNodeView,
  ...gfm.flat(),
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
  ...history.flat(),
  listener,
  mdxComponent,
  tableFeaturePlugin,
  $prose(() => suggestionPlugin),
]