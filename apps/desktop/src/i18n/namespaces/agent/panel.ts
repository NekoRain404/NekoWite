/** The agent panel’s own copy, assembled from the leaves beside it. */
import { notice } from './panel/notice'
import { bar } from './panel/bar'
import { menu } from './panel/menu'
import { history } from './panel/history'
import { empty } from './panel/empty'
import { timeline } from './panel/timeline'
import { composer } from './panel/composer'

export const panel = {
  en: {
    /* The panel's own copy (T16), beside the command menu's and the permission prompt's. The
       panel carries no sentence of its own, so every word it draws is read from here by the
       caller that mounts it (`src/app/AgentRailBody.vue`). `state`, `result` and `status` are
       keyed by the contract's own unions, so a state, a stop reason or a tool status added to
       `agent-contracts` without a sentence here is a typecheck failure rather than a blank. */
    panel: {
      ...notice.en,
      ...bar.en,
      ...menu.en,
      ...history.en,
      ...empty.en,
      ...timeline.en,
      ...composer.en,
    },
  },
  zh: {
    panel: {
      ...notice.zh,
      ...bar.zh,
      ...menu.zh,
      ...history.zh,
      ...empty.zh,
      ...timeline.zh,
      ...composer.zh,
    },
  },
} as const
