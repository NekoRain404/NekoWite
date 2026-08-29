import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { listener } from '@milkdown/plugin-listener'
import type { MilkdownPlugin } from '@milkdown/ctx'

import { mdxComponent } from '../mdx'
import { tableFeaturePlugin } from '../table/plugin'

export const basicPlugins: MilkdownPlugin[] = [
  ...commonmark,
  ...gfm.flat(),
  ...history.flat(),
  listener,
  mdxComponent,
  tableFeaturePlugin,
]