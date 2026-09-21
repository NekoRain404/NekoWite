/** The session strip: title, engine state, stop reason, usage counters and elapsed time. */
export const bar = {
  en: {
    bar: {
      /* The title until the engine names the session. `{engine}` is the registration's own
         `displayName`, or the agent id when the registry has not answered: the engine's name
         is a fact the backend owns, so this sentence carries it rather than a constant. */
      untitled: 'New {engine} session',
      state: {
        idle: 'Idle',
        starting: 'Starting',
        ready: 'Ready',
        running: 'Working',
        waitingPermission: 'Waiting for you',
        completed: 'Finished',
        cancelled: 'Stopped',
        failed: 'Failed',
      },
      result: {
        endTurn: 'Answered',
        maxTokens: 'Stopped at the engine’s token ceiling',
        maxTurnRequests: 'Stopped at the engine’s request ceiling',
        refusal: 'The engine declined to continue',
        cancelled: 'Stopped before it finished',
        unrecognised: 'Ended for a reason this version does not know',
      },
      /* The one control §5.3 puts in this strip beyond the title. It is drawn only when the
         engine's own report says it answers `session/list` — see `AgentPanel` — so the words
         answer "what does pressing this show", not "what could it show in principle". */
      history: 'Sessions this engine holds',
      /* What the engine reported spending on the turn it last finished. Every counter is
         optional on the wire (P0 §6.3 measured the field set changing between two identical
         turns), so each sentence is drawn only for a number the engine actually sent: `total`
         when it sent one, `input`/`output` when it sent those instead, and nothing at all
         when it sent no usage. None of them is ever computed from the others — the engine's
         own total is not the sum of its parts. `detail` is the hover text, where the counters
         are named and exact rather than the rounded headline the strip has room for. */
      usage: {
        total: '{n} tokens',
        input: '{n} in',
        output: '{n} out',
        detail: {
          input: 'input {n}',
          output: 'output {n}',
          total: 'total {n}',
          thought: 'reasoning {n}',
          cachedRead: 'cache read {n}',
          cachedWrite: 'cache write {n}',
        },
      },
      /* The other half of the turn's stats: how long the turn took, as this window's own
         stopwatch measured it (`services/agent-turn-stats.ts` — the wire carries no
         duration). One arm per rung of Zed's own formatter (`duration_alt_display`,
         `crates/util/src/time.rs:3-15`), and the arm is chosen by which rungs are above
         zero, so `45s`, `2m 3s` and `1h 2m 3s` are three sentences rather than one with two
         empty slots. Nothing here rounds up: a wall clock that claimed a tenth of a second
         would be claiming a precision it does not have. */
      elapsed: {
        hours: '{h}h {m}m {s}s',
        minutes: '{m}m {s}s',
        seconds: '{s}s',
      },
    },
  },
  zh: {
    bar: {
      untitled: '新建 {engine} 会话',
      state: {
        idle: '空闲',
        starting: '正在启动',
        ready: '就绪',
        running: '进行中',
        waitingPermission: '等待你的授权',
        completed: '已结束',
        cancelled: '已停止',
        failed: '失败',
      },
      result: {
        endTurn: '已回答',
        maxTokens: '达到引擎的 token 上限而停止',
        maxTurnRequests: '达到引擎的请求次数上限而停止',
        refusal: '引擎拒绝继续',
        cancelled: '未完成即被停止',
        unrecognised: '以本版本未知的原因结束',
      },
      history: '该引擎保存的会话',
      /* 引擎就上一轮说了它花了多少。线上的每个计数器都是可选的（P0 §6.3 实测：同样的两次
         运行，字段集合并不相同），所以每条句子只在引擎真的送来了那个数字时才画出来：送了合计
         就用 `total`，只送了输入输出就用那两个，什么都没送就什么都不画。任何一个数都不会由
         其他数算出来——引擎自己的合计并不等于各部分之和。`detail` 是悬停文字，那里的计数器
         有名字、是精确值，而横条上只有放得下的约数。 */
      usage: {
        total: '{n} tokens',
        input: '输入 {n}',
        output: '输出 {n}',
        detail: {
          input: '输入 {n}',
          output: '输出 {n}',
          total: '合计 {n}',
          thought: '推理 {n}',
          cachedRead: '缓存读取 {n}',
          cachedWrite: '缓存写入 {n}',
        },
      },
      /* 轮次统计的另一半：这一轮花了多久，由本窗口自己的秒表量出（`services/agent-turn-stats.ts`
         ——线上没有任何时长字段）。按 Zed 自己的格式化器的三档各写一句
         （`duration_alt_display`，`crates/util/src/time.rs:3-15`），由哪几档大于零决定用哪一句，
         所以 `45s`、`2m 3s`、`1h 2m 3s` 是三句话，而不是一句带两个空槽的话。这里一律不进位：
         秒表声称有十分之一秒的精度，就是声称了它没有的精度。 */
      elapsed: {
        hours: '{h}小时{m}分{s}秒',
        minutes: '{m}分{s}秒',
        seconds: '{s}秒',
      },
    },
  },
} as const
