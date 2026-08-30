import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { listener } from '@milkdown/plugin-listener'
import type { MilkdownPlugin } from '@milkdown/ctx'

import { cite, citeNodeView, citeRemark } from '../cite'
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

export const basicPlugins: MilkdownPlugin[] = [
  ...mdxJsxRemark,
  mdxComponentNodeView,
  ...commonmark,
  ...gfm.flat(),
  ...citeRemark,
  cite,
  citeNodeView,
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
]