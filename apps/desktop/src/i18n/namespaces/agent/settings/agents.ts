/** The agents page: profiles, their pages and the gaps this version cannot fill. */
export const agents = {
  en: {
    /* The tree's own page (T16): the one control that reaches the shell — which panel the
       right rail shows — and the statements for the parts of this tree that have no host
       half yet. Every absence below is named with what it is and what it would take,
       because a page that drew a control it cannot carry out would be the one claim this
       feature must not make (§13's rule the registry and pet-integration pages follow). */
    agents: {
      section: {
        title: 'Agents',
        hint: 'Which panel the right rail shows, the engines this app may start and the profile of the one it starts, and what this build cannot do with an engine yet.',
      },
      panel: {
        label: 'Show the agent panel in the right rail',
        hint: 'Off, the rail keeps the chat panel it has always had. On, the rail shows the agent panel for the folder this app has open instead — the chat panel is unmounted, so a reply still streaming is cancelled, and switching this off is how you get it back.',
      },
      /* The sub-navigation's own name, for the `role="tablist"` that carries the seven pages.
         One page is on screen at a time; a page this build has no client for is not offered
         here at all, and is stated in the absence list below instead. */
      pages: 'Agent settings pages',
      /* The pair the mounted pages are about, stated on the page: the registry readout is the
         only thing that pairs a profile with an engine, so when it cannot be read the profile
         page is not drawn — and that absence is said here rather than left as a gap. */
      profile: {
        showing: 'The pages below are about {agent} and its profile {profile}.',
        unknown: 'The engine registry could not be read, so the profile of the engine this app starts is not shown here. The registry above says why.',
      },
      /* One sentence per section that is not mounted: the section derives these from
         `AGENT_SETTINGS_SECTIONS`, so a page whose client lands and stops being absent takes
         its sentence out of this block rather than leaving a claim that went stale. `other` is
         what a newly listed section says before it has a sentence of its own — the row is never
         blank, and the key is never unreachable. */
      gaps: {
        title: 'Not connected in this build',
        intro: 'Each of these would be a page of its own. The half it needs is missing, and a control that can only fail is not drawn:',
        /* `runtime` and `capabilities` were rows here, and both were removed by the same
           change that mounted §3.1.4's page. They said the state of a running engine was
           answered nowhere and that a capability report needed a session — and both halves
           stopped being true when `agent_runtime_read` landed: ACP makes `initialize` a
           connection's first request, so the negotiated half belongs to the incarnation, and a
           settings dialog has the incarnation without ever having a session. A gap sentence has
           a shelf life of about one commit; these two reached it. */
        commands: 'Commands — the list an engine publishes for a session. It reaches the agent panel as it arrives and belongs to that one session, and there is no read of it a settings page can make.',
        mcp: 'MCP servers — the list, the configuration and the transports. Nothing was built for MCP in this build at all.',
        engine: 'Choosing the engine a new session starts on. Engines can be added and switched off above, but a session always starts on the default one: the backend’s start call takes a folder and nothing else, so nothing in this window opens a session on another engine yet.',
        other: 'This section needs a host half this build does not have.',
      },
    },
  },
  zh: {
    agents: {
      section: {
        title: '智能体',
        hint: '右侧栏显示哪个面板、本应用可以启动哪些引擎以及所启动引擎的配置档案，还有当前构建在引擎上还做不到什么。',
      },
      panel: {
        label: '在右侧栏显示智能体面板',
        hint: '关闭时，右栏保留原来的聊天面板。打开后，右栏改为显示智能体面板，在本应用已打开的文件夹内工作——聊天面板会被卸载，正在流式返回的回复会被取消；关掉这个开关就能把它找回来。',
      },
      pages: '智能体设置页',
      profile: {
        showing: '下面各页讲的是 {agent} 及其配置档案 {profile}。',
        unknown: '未能读取引擎注册表，因此本应用所启动引擎的配置档案不在这里显示。上面的注册表页说明了原因。',
      },
      gaps: {
        title: '当前构建尚未接通的部分',
        intro: '下面每一条本来都会是独立的一页设置。它们需要的那一半还不存在，而一个只能失败的控件不会被画出来：',
        commands: '命令——引擎为某个会话发布的列表。它随发布到达智能体面板，且只属于那一个会话，设置页没有可以调用的读取。',
        mcp: 'MCP 服务器——列表、配置与传输方式。当前构建里完全没有为 MCP 实现任何东西。',
        engine: '选择新会话使用哪个引擎。上面已经可以添加引擎、停用引擎，但会话总是启动在默认引擎上：后端的启动调用只接收一个文件夹，因此这个窗口目前无法在另一个引擎上打开会话。',
        other: '这一节需要的后端一半，当前构建还没有。',
      },
    },
  },
} as const
