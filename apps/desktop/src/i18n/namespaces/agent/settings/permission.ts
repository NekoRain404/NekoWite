/** The permission page: the written rules, the engine’s options, and the revocable grants. */
export const permission = {
  en: {
    permission: {
      section: {
        title: 'Permissions',
        hint: 'What the engine asks about, where those settings come from, and what this app does not promise about them.',
      },
      loading: 'Reading the permission configuration...',
      unreadable: 'The permission configuration could not be read from the backend.',
      /* One per state of the consent default. The second and third are the ones a user most
         needs said out loud, because both are profiles where the list below is empty and the
         engine may ask anything — an empty list that reads as "nothing to see" is the one
         answer worse than no page. */
      states: {
        written: 'This app wrote the rules below into the engine’s own configuration, so the engine asks before it changes your files or runs a command.',
        engineOwn: 'The engine’s own configuration already carries permission rules, so this app wrote none and does not override them. What those rules ask about cannot be read from here; the document below is where they are.',
        notThisHost: 'This profile reuses your own engine installation, so this app wrote no permission rules for it and cannot say what the engine will ask.',
      },
      rules: {
        title: 'What the engine asks about',
        empty: 'This profile has no rules from this app to show. That is not the same as the engine asking nothing: for a profile reusing your own installation, or one whose configuration carries its own rules, what the engine asks is not this app’s to report.',
        tool: 'Tool',
        action: 'Action',
      },
      options: {
        title: 'What a request can answer',
        hint: 'These are the engine’s own option kinds, as they arrive with a request. Each request carries its own options, and the prompt renders those rather than a list kept here.',
        none: 'This page never lists them: the options arrive with each request, and the prompt renders what that request carried.',
        noInvention: 'This app adds no option of its own. If the engine does not offer a permanent allow, there is no permanent allow to give.',
      },
      limits: {
        title: 'What this does not mean',
        notASandbox: 'ACP is not a sandbox. The working directory, this app’s file allow-list and a prompt that says "only this library" do not constrain the engine’s own shell, plugins, MCP servers or network access. The honest description of this integration is an agent inside a workspace you trust.',
        noIsolation: 'No Linux sandbox has been built or verified for this integration, so nothing here is isolated. A page or a prompt claiming otherwise would be describing a feature that does not exist.',
        staleRequests: 'A request belongs to one runtime, library, session and run. Answering a request that has already been resolved, or that belongs to a session that has ended, is refused rather than applied to whatever is in front of the user now.',
        noSilentApproval: 'A dangerous request that is never answered is never approved. Waiting is not consent, and nothing here grants a permission because a prompt was left alone.',
      },
      /* The grants the user actually gave. `unsupported` and `notRunning` are separate
         sentences on purpose: either one drawn as an empty list would be this page claiming
         "you have granted nothing" from a question it never managed to ask. */
      grants: {
        title: 'Saved permission rules',
        hint: 'Only rules returned by the engine’s saved-permission API appear here. Bundled OpenCode ACP also keeps temporary “Always allow” grants in memory; this list cannot revoke those grants. Removing a saved rule does not guarantee another prompt while a temporary grant remains active.',
        loading: 'Reading the engine’s saved permissions...',
        unreadable: 'The engine was asked for its saved permissions and did not answer. Nothing is being claimed about them here — try again, or check that the agent is still running.',
        unsupported: 'This agent does not report the permissions it has written down, so this page cannot list or revoke them. That is not the same as having given none: nothing here has asked.',
        notRunning: 'No agent is running, so there is nothing to ask. Start a session and this list is read from the engine itself — a profile’s saved permissions live in the engine’s own database, not in this app.',
        empty: 'The engine reports no saved permission rules. This does not mean there are no active temporary grants.',
        project: 'Project',
        revoke: 'Revoke',
        revoking: 'Revoking...',
        failed: 'The engine did not remove it:',
      },
    },
  },
  zh: {
    permission: {
      section: {
        title: '权限',
        hint: '引擎会为什么询问、这些设置的来源，以及本应用对它们不作哪些承诺。',
      },
      loading: '正在读取权限配置……',
      unreadable: '未能从后端读取权限配置。',
      states: {
        written: '本应用把下面的规则写进了引擎自己的配置，因此引擎在改动你的文件或执行命令之前会先询问。',
        engineOwn: '引擎自己的配置里已经有权限规则，因此本应用没有写入，也不会覆盖它们。那些规则问了什么，这里读不到；它们就在下面这个文件里。',
        notThisHost: '该配置档案复用你自己的引擎安装，因此本应用没有为它写入任何权限规则，也无法说明引擎会问什么。',
      },
      rules: {
        title: '引擎会询问什么',
        empty: '这个配置档案里没有本应用写下的规则可显示。这不等于引擎什么都不问：对于复用你自己安装的配置档案，或者配置里已自带规则的配置档案，引擎会问什么是本应用报告不了的。',
        tool: '工具',
        action: '动作',
      },
      options: {
        title: '一次请求可以回答什么',
        hint: '这些是引擎自己的选项种类，随请求一起到达。每一次请求都带着它自己的选项，提示框渲染的是那些，而不是这里保留的一份列表。',
        none: '本页不列这些：选项随每次请求一起到达，提示框渲染的是那一次请求实际带来的选项。',
        noInvention: '本应用不添加自己的任何选项。如果引擎没有提供「永久允许」，那就没有永久允许可以给。',
      },
      limits: {
        title: '这不意味着什么',
        notASandbox: 'ACP 不是沙箱。工作目录、本应用的文件白名单，以及一句写着「只操作此库」的提示词，都约束不了引擎自己的 shell、插件、MCP 服务器或网络访问。对这套集成诚实的描述是：一个运行在你所信任的工作区里的智能体。',
        noIsolation: '这套集成没有构建也没有验证过任何 Linux 沙箱，因此这里没有任何东西是被隔离的。任何相反的说法，都是在描述一个并不存在的功能。',
        staleRequests: '一次请求属于某一个运行时、库、会话与任务。回答一个已经处理过的请求，或属于已经结束会话的请求，会被拒绝，而不是套用到用户眼前的东西上。',
        noSilentApproval: '危险请求如果始终无人回答，就永远不会被批准。等待不是同意，这里也不会因为提示被放着不管就授予权限。',
      },
      grants: {
        title: '已保存的权限规则',
        hint: '这里只显示引擎持久化授权接口返回的规则。内置 OpenCode ACP 还会在内存中保留「始终允许」临时授权，本列表无法撤销它们。临时授权仍有效时，删除持久化规则不保证下一次操作重新询问。',
        loading: '正在读取引擎保存的授权…',
        unreadable: '已向引擎询问它保存的授权，但没有得到回答。这里对它们不做任何断言——请重试，或确认智能体仍在运行。',
        unsupported: '这个智能体不上报它记录下来的授权，因此本页无法列出或撤销它们。这与「你什么都没给过」不是一回事：这里什么都没问到。',
        notRunning: '没有智能体在运行，无处可问。开始一次会话后，这份列表会从引擎本身读来——配置档案的授权保存在引擎自己的数据库里，不在本应用里。',
        empty: '引擎没有返回已保存的权限规则，但仍可能存在有效的内存临时授权。',
        project: '项目',
        revoke: '撤销',
        revoking: '正在撤销…',
        failed: '引擎没有删掉它：',
      },
    },
  },
} as const
