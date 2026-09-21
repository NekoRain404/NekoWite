/** The runtime section: which program this app starts and which of its claims were checked. */
export const runtime = {
  en: {
    runtime: {
      section: {
        title: 'Runtime',
        hint: 'What this app knows about the engine it starts: which program, from where, and which of its claims have actually been checked.',
      },
      loading: 'Reading the runtime...',
      unreadable: 'The runtime could not be read from the backend.',
      facts: {
        agent: 'Engine',
        source: 'Source',
        program: 'Program',
        version: 'Reported version',
        versionUnknown: 'not reported yet',
        adapter: 'Adapter',
      },
      provenance: {
        bundled: 'Bundled with NekoWite',
        managed: 'Installed by NekoWite',
        external: 'Your own installation',
      },
      /* The two states a read of the instance slot can be taken in. `starting` and `failed`
         are deliberately absent: the slot is filled only after a start has returned, so a start
         in flight is not a state anything can be read in, and a failed start answers its caller
         rather than leaving a state behind. Copy for an arm nothing can produce is a field the
         page would be asserting, which is the defect this page was rebuilt to remove. */
      process: {
        label: 'Process',
        stopped: 'Not running',
        ready: 'Running',
      },
      /* §3.1.4's own clause, and it needs no data: it exists to stop the process line above it
         being read as "a model will answer". It used to sit under `authorization`, beside a
         state nothing could answer — the sentence was the true half of that pair. */
      notAModel: 'A running process is a running process. It is not a model: nothing here means a prompt would be answered.',
      /* Drawn only when the handshake answered, which is the only time either sentence is
         true. The old pair drew `Not negotiated in this runtime` from a readout that had no
         handshake in it at all — a claim about the engine made without asking one. */
      protocol: {
        label: 'Protocol',
        version: 'Version',
        negotiated: 'Negotiated with the engine in this runtime',
      },
      /* What stands in for the protocol line and the capability list when there is no
         handshake. Two sentences for the backend's two ids, because they send a user to
         different places — an app that has not started an engine, and an engine running before
         its first session — and because the page could not tell them apart on its own: both
         read `Running` on the process line above. */
      notNegotiated: {
        noEngine: 'No engine is running, so nothing has been negotiated with one. The protocol version and the list below are both read off the handshake, and starting an engine for a folder is what performs it.',
        notYet: 'This engine is running and has not been asked yet. This app performs the handshake when it opens a session, and no session has been opened in this runtime.',
      },
      /* The engine's own advertisement, reported and not acted on. ACP has no
         "is-authenticated" field, and this app never calls `authenticate` — so a page that drew
         an authorization *state* would be inventing one, and a page that drew these methods as
         buttons would be offering a login nothing here can perform. The note under the list is
         what keeps the second from happening. */
      authorization: {
        label: 'Authentication the engine advertises',
        none: 'This engine advertised no authentication method in its handshake.',
        reportedNotUsed: 'Reported by the engine, and not acted on: this app never authenticates with an engine. The ways it can be authenticated are the engine’s own, and a credential for it lives in its profile rather than here.',
      },
      engineReport: {
        label: 'The engine’s own report',
      },
      capabilities: {
        title: 'What this engine reported',
        hint: 'The install declaration is only a start-time hint. Each line below is what this runtime’s handshake reported, or that nothing has been measured - which is not the same answer as "not supported". Three of the eleven are facts about a session response, so a page with no session reads them as not measured rather than as absent.',
        advertised: 'Advertised by this engine version',
        notAdvertised: 'This engine version does not advertise it',
        unverified: 'Not measured for this engine',
        /* The same three arms as short clauses, for the sentence that names both halves at
           once: the full sentence for the finding is already drawn on the line above it. */
        finding: {
          advertised: 'advertising it',
          notAdvertised: 'not advertising it',
          unverified: 'not measured',
        },
        /* The report's other half: what this build has on file about the engine version it was
           measured against. It is drawn only where it disagrees with the finding above it, and
           `disagrees` is the sentence that says so — which is the only place these three labels
           are read. The subject is spelled out in it because the failure this whole page
           refuses is a reader taking the file's claim for the engine's answer. */
        declared: {
          advertised: 'advertising this feature',
          notAdvertised: 'not advertising this feature',
          unverified: 'never having measured it',
          disagrees: 'Two claims, and they disagree: the engine version this build was measured against is on file as {declared}, and this runtime reported {finding}.',
        },
        /* A report that arrives with no rows at all. Drawn in place of the list, because a
           heading over an empty list reads as an answer — and the answer it reads as is "this
           engine can do nothing", which nobody gave. */
        empty: 'The backend answered with no capability rows. That is not the same answer as an engine that can do nothing: it is nothing having been reported for any feature.',
        /* This app's own half, on the rows where the standing above it would otherwise be read
           as this app's ability. The subject is spelled out for the reason `disagrees` spells
           its own: the sentence above says what the *engine* reported, and a reader who took
           this one for a qualification of it would be reading it backwards. */
        hostNothing: 'This engine reports that it can do this, and nothing in this build can ask it to. There is no button, no command and no call for it here: the line above is about the engine, not about what you can do in this window.',
      },
      update: {
        label: 'Updates',
        hostManaged: 'This app may fetch and switch a new version of this program.',
        reportedOnly: 'NekoWite never replaces a program you installed. A newer version may be reported here, and nothing more.',
      },
    },
  },
  zh: {
    runtime: {
      section: {
        title: '运行时',
        hint: '本应用对它启动的引擎知道些什么：哪个程序、来自哪里，以及它自称的能力里哪些真的被实测过。',
      },
      loading: '正在读取运行时……',
      unreadable: '未能从后端读取运行时。',
      facts: {
        agent: '引擎',
        source: '来源',
        program: '程序',
        version: '报告版本',
        versionUnknown: '尚未收到',
        adapter: '适配器',
      },
      provenance: {
        bundled: '随 NekoWite 附带',
        managed: '由 NekoWite 安装',
        external: '你自己安装的程序',
      },
      process: {
        label: '进程',
        stopped: '未运行',
        ready: '运行中',
      },
      notAModel: '进程在跑就是进程在跑。它不等于模型可用：这里没有任何一条意味着提问会被回答。',
      protocol: {
        label: '协议',
        version: '版本',
        negotiated: '本次运行时已与引擎完成协商',
      },
      notNegotiated: {
        noEngine: '当前没有引擎在运行，因此还没有和任何引擎协商过。协议版本与下面这份列表都是从握手里读出来的，而为某个文件夹启动引擎正是做这次握手的地方。',
        notYet: '该引擎正在运行，但还没有被问过。本应用会在打开会话时做这次握手，而本次运行时还没有打开过会话。',
      },
      authorization: {
        label: '该引擎声明的认证方式',
        none: '该引擎在握手里没有声明任何认证方式。',
        reportedNotUsed: '这是引擎自己报告的，本应用不会据此做任何事：本应用从不与引擎做认证。能怎么认证是引擎自己的事，它的凭据在它的配置档里，而不在这里。',
      },
      engineReport: {
        label: '引擎自己的报告',
      },
      capabilities: {
        title: '该引擎报告了什么',
        hint: '安装声明只是启动前的提示。下面每一行都是本次运行时握手报告的结果，或者是「尚未实测」——后者和「不支持」不是同一个答案。十一项里有三项要等会话响应才能回答，所以没有会话的页面会把它们读作尚未实测，而不是读作没有。',
        advertised: '该引擎版本声明支持',
        notAdvertised: '该引擎版本未声明支持',
        unverified: '尚未对该引擎实测',
        /* 同三个分支的短说法，供同时点出两个主张的那句话使用：上面的整句已经画在它上面一行了。 */
        finding: {
          advertised: '声明支持',
          notAdvertised: '未声明支持',
          unverified: '尚未实测',
        },
        /* 这份报告的另一半：本构建对它实测过的那一个引擎版本，档案里记着什么。只有当它与上面的
           实测结果不一致时才会画出来，也就是说这三条短语只在那句「disagrees」里被读到。句子里
           把主语写全，因为这一整页要挡的失败正是读者把档案里的说法当成引擎的回答。 */
        declared: {
          advertised: '声明支持此功能',
          notAdvertised: '声明不支持此功能',
          unverified: '从未实测过它',
          disagrees: '这里有两个主张，而它们并不一致：本构建实测过的那一个引擎版本，档案里记的是「{declared}」，而本次运行时报告的是「{finding}」。',
        },
        /* 一行都没有的报告。画在列表的位置上，因为一个标题配一张空列表会被读成一个答复——而它
           被读成的那句是「这个引擎什么都做不了」，这句话没有人说过。 */
        empty: '后端返回的报告里一行都没有。这和「这个引擎什么都做不了」不是同一个答复：它只是任何一项都还没有被报告过。',
        /* 本应用自己这一半，画在那些不写出来就会被读成「你能用」的行上。句子里把主语写全，理由
           和上面那句 disagrees 一样：上一行说的是引擎报告了什么，把它读成对上一行的补充说明就
           正好读反了。 */
        hostNothing: '该引擎报告它能做这件事，而本构建没有任何办法请它做。这里没有按钮、没有命令、也没有调用：上面那一行说的是引擎，不是你在本窗口里能做的事。',
      },
      update: {
        label: '更新',
        hostManaged: '本应用可以下载并切换该程序的新版本。',
        reportedOnly: 'NekoWite 不会替换你自己安装的程序。这里最多只会报告存在更新的版本，仅此而已。',
      },
    },
  },
} as const
