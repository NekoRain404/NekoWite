/** The commands page: what the session published and where commands come from. */
export const commands = {
  en: {
    commands: {
      section: {
        title: 'Commands',
        hint: 'Where every command comes from. This app publishes none of the engine’s commands and re-implements none of them.',
      },
      loading: 'Reading the command list...',
      unreadable: 'The command list could not be read from the backend.',
      session: {
        title: 'From this session',
        none: 'This session has not published a command list yet. It arrives as a notification after a session starts, not with the session itself.',
        session: 'Session',
        published: 'published by the engine',
        description: 'Description',
      },
      sources: {
        title: 'Read by the engine, from files',
        hint: 'The engine discovers these itself. This app shows what it found and does not interpret a template or re-run a command.',
        empty: 'No command files were found.',
        commands: 'Commands',
      },
      app: {
        title: 'This app’s own commands',
        hint: 'Insert selection, open changes and the rest live in their own panel and never take the engine’s slash namespace, so a command name cannot collide with the engine’s.',
      },
      limits: {
        title: 'What is not available',
        undoRedo: 'Undo and redo are not part of ACP and this engine does not offer them over it. This app does not simulate them by deleting its own transcripts.',
        unpublished: 'A command the engine has not published is not offered here. Running one through a native terminal entry point shows the engine’s own error rather than a success this app invented.',
        parameters: 'A command is called by sending its name and arguments as a prompt. There is no form for a command’s arguments here, because the protocol does not describe one.',
        unnamed: 'A command with no description is listed by name only. This app does not write one for it.',
      },
    },
  },
  zh: {
    commands: {
      section: {
        title: '命令',
        hint: '每一条命令来自哪里。本应用不发布引擎的命令，也不重新实现其中任何一条。',
      },
      loading: '正在读取命令列表……',
      unreadable: '未能从后端读取命令列表。',
      session: {
        title: '来自本会话',
        none: '本会话还没有发布命令列表。它是在会话开始之后以通知形式到达的，而不是随会话本身一起返回。',
        session: '会话',
        published: '由引擎发布',
        description: '描述',
      },
      sources: {
        title: '由引擎从文件读取',
        hint: '这些由引擎自己发现。本应用只显示找到了什么，不解释模板，也不代为执行命令。',
        empty: '没有找到任何命令文件。',
        commands: '命令数',
      },
      app: {
        title: '本应用自己的命令',
        hint: '「插入选区」「打开变更」等等位于它们自己的面板中，永远不占用引擎的斜杠命名空间，因此命令名不会和引擎的撞车。',
      },
      limits: {
        title: '不可用的部分',
        undoRedo: '撤销与重做不属于 ACP，该引擎也不通过它提供。本应用不会靠删除自己的聊天记录来假装实现。',
        unpublished: '引擎没有发布的命令这里不提供。通过原生终端入口执行它会显示引擎自己的报错，而不是本应用编出来的成功。',
        parameters: '调用命令的方式是把命令名和参数作为提示发送。这里没有参数表单，因为协议并没有描述这样一种东西。',
        unnamed: '没有描述的命令只显示名字。本应用不会替它写一条。',
      },
    },
  },
} as const
