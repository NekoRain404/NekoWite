/** The panel’s own menu entries. */
export const menu = {
  en: {
    /* The panel's options menu: the control in the bar and the box it opens, which carry the
       same name because they are one thing. `label` is the accessible name of both — the
       trigger's (`AgentSessionBar`) and the menu's (`AgentPanelMenu`) — so there is one place
       to write it and no way for the two to disagree.

       `settings` is the door the panel had none of: it is the only way to the agents tree
       that starts from the session whose engine is wrong. It is not `agent.settings....`'s
       section title reused, because what the row says is where the press goes, and the
       section's own title is what the page is called once you are there. */
    menu: {
      label: 'Agent options',
      settings: 'Agent settings',
    },
  },
  zh: {
    /* 面板的选项菜单：状态栏里的控件和它打开的盒子，两者同名，因为它们是同一件事。`label`
       同时是两者的无障碍名称——触发器（`AgentSessionBar`）和菜单（`AgentPanelMenu`）——
       所以这句话只有一个地方可写，也不会互相对不上。

       `settings` 是面板以前没有的那扇门：它是唯一一条从「引擎配置不对的那次会话」出发、
       通往智能体设置树的路径。它没有复用 `agent.settings....` 的节标题，因为这行说的是
       按下去会去哪里，而节标题是到了那里之后那一页叫什么。 */
    menu: {
      label: '智能体选项',
      settings: '智能体设置',
    },
  },
} as const
