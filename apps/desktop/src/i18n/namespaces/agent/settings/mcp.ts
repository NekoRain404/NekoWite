/** The MCP page: the configured servers, their transports and their declared capabilities. */
export const mcp = {
  en: {
    mcp: {
      section: {
        title: 'MCP servers',
        hint: 'Servers the engine connects to, where each one is configured, and what starting one would mean.',
      },
      loading: 'Reading the MCP configuration...',
      unreadable: 'The MCP configuration could not be read from the backend.',
      list: {
        empty: 'No MCP servers are configured for this profile.',
        name: 'Server',
        transport: 'Transport',
        state: 'State',
        on: 'On',
        off: 'Switched off in the configuration',
        command: 'Program',
      },
      transport: { local: 'Local program', http: 'HTTP', sse: 'Server-sent events' },
      credentials: {
        label: 'Credentials',
        none: 'none configured',
        namesOnly: 'Names only. A value is never sent to this page.',
      },
      diagnostic: { label: 'Last diagnostic', none: 'nothing reported' },
      capabilities: {
        title: 'What this engine advertised',
        hint: 'From the handshake, for this engine version. An unadvertised transport is named as such rather than hidden.',
        advertised: 'Advertised',
        notAdvertised: 'Not advertised by this engine version',
      },
      trust: 'Starting this server runs a program. The engine starts it; this app neither starts it nor sandboxes it, and a configured server is not a trusted one. Enable it only if you would run that command yourself.',
      doesNotStart: 'This page reports and writes nothing. Servers are started by the engine when it opens a session, so there is no control here to start one.',
    },
  },
  zh: {
    mcp: {
      section: {
        title: 'MCP 服务器',
        hint: '引擎会连接的服务器、每一个配置在哪里，以及启动一个意味着什么。',
      },
      loading: '正在读取 MCP 配置……',
      unreadable: '未能从后端读取 MCP 配置。',
      list: {
        empty: '该配置档没有配置任何 MCP 服务器。',
        name: '服务器',
        transport: '传输方式',
        state: '状态',
        on: '已启用',
        off: '在配置中已关闭',
        command: '程序',
      },
      transport: { local: '本地程序', http: 'HTTP', sse: '服务器发送事件' },
      credentials: {
        label: '凭据',
        none: '没有配置',
        namesOnly: '只有名字。值从不发送到本页面。',
      },
      diagnostic: { label: '最近一次诊断', none: '没有任何报告' },
      capabilities: {
        title: '该引擎声明了什么',
        hint: '来自握手，针对该引擎版本。未声明的传输方式会被如实说明，而不是藏起来。',
        advertised: '已声明',
        notAdvertised: '该引擎版本未声明',
      },
      trust: '启动这个服务器就是在运行一个程序。启动它的是引擎；本应用既不启动它，也不把它关进沙箱，而「配置过」不等于「可信」。只有当你自己愿意运行那条命令时，再启用它。',
      doesNotStart: '本页面只做报告，不写入任何东西。服务器由引擎在打开会话时启动，因此这里没有能启动它们的控件。',
    },
  },
} as const
