/** The agent settings tree, assembled from the leaves beside it. */
import { origin } from './settings/origin'
import { runtime } from './settings/runtime'
import { provider } from './settings/provider'
import { config } from './settings/config'
import { skills } from './settings/skills'
import { commands } from './settings/commands'
import { mcp } from './settings/mcp'
import { permission } from './settings/permission'
import { agents } from './settings/agents'

export const settings = {
  en: {
    /* The agent settings tree (T13), beside the panel's commandMenu/permission and the registry
       page's own keys. `origin` and `retry` are shared: they say "this app set it" and "try
       again", which are one fact each however many pages draw them. The sentences a page shows
       next to a *fact* — a path, a variable, an engine's own words — carry a slot name here and
       the page substitutes the value, because a path is data and does not go through a
       translator. */
    settings: {
      ...origin.en,
      ...runtime.en,
      ...provider.en,
      ...config.en,
      ...skills.en,
      ...commands.en,
      ...mcp.en,
      ...permission.en,
      ...agents.en,
    },
  },
  zh: {
    /* 智能体设置树（T13），与面板的 commandMenu/permission、注册表页自己的键并列。`origin` 与
       `retry` 是共用的——它们各自只表达一个事实，无论多少页面画出来。凡是紧挨着**事实**（一个路径、
       一个变量、引擎自己的话）的句子，槽位名留在这里、由页面填入值：路径是数据，数据不过翻译。 */
    settings: {
      ...origin.zh,
      ...runtime.zh,
      ...provider.zh,
      ...config.zh,
      ...skills.zh,
      ...commands.zh,
      ...mcp.zh,
      ...permission.zh,
      ...agents.zh,
    },
  },
} as const
