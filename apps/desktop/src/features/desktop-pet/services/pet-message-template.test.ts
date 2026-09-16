/**
 * The words a task row shows: which line, whose line, and the two things a line may never do.
 *
 * The content here is the point as much as the assertions are. §5.2's 自定义词句 are written by the
 * user, which means they are as likely to be paragraphs of Chinese as they are to be "On it!" —
 * and a row that only ever met `Hello world` has not been tested against the content it will carry.
 * Several of the strings below are the length and density of a real note title or a real permission
 * prompt, in Chinese, with the mixed Latin (paths, ids, numbers) that actually appears inside one.
 *
 * The two prohibitions are §5.2's 「状态标签不可被自定义文案伪装成另一种结果」 and §6.1's plain-text rule.
 * The first is asserted as its own fact — the label is a function of the state and of nothing
 * else — and the second by requiring the phrase to come back byte for byte, so a future attempt to
 * "sanitise" it into `&lt;b&gt;` (which is what the upstream app's `innerHTML` habit would have
 * led to) fails here rather than silently double-escaping in a bubble.
 */
import { describe, expect, it } from 'vitest'
import { PET_TASK_STATES, type PetTaskState } from '../../../platform/gateways/pet-contracts'
import {
  PET_MESSAGE_PHRASES,
  petElapsed,
  petStateLabel,
  petTaskMessage,
  type PetMessagePhrases,
} from './pet-message-template'

/** A real working line: a note title, a plan and a duration, in Chinese. */
const WORKING_CN =
  '正在整理《分布式一致性协议》的中文笔记：先把第三章的引用段落重新编号，再校对术语表里「共识」与「法定人数」两处译法，稍候片刻。'
/** A real waiting line: this one names files, which is what the state actually blocks on. */
const WAITING_CN = '需要你确认：这条命令会覆写 12 个既有文件，其中 3 个还有未提交的改动。'

describe('the line one task shows', () => {
  it('has a line for every state, so no row is ever blank', () => {
    for (const state of PET_TASK_STATES) {
      const line = petTaskMessage({ state, agentId: 'memory', sessionId: 'session-1' })
      expect(line.trim(), state).not.toBe('')
      // A built-in line with a placeholder in it would render the braces to the user.
      expect(line, state).not.toMatch(/\{\w+\}/)
    }
  })

  it('gives the same task the same line every time it is rendered', () => {
    // Upstream freezes the phrase at event time because "the whimsical phrase doesn't re-roll on
    // every render tick" (`windows/src/state.ts` 1-4). A row that re-rolled would change its text
    // under the pointer between two clicks on the same task.
    const input = { state: 'working' as PetTaskState, agentId: 'memory', sessionId: 'session-7' }
    const first = petTaskMessage(input)

    expect(petTaskMessage(input)).toBe(first)
    expect(petTaskMessage({ ...input })).toBe(first)
  })

  it("prefers the agent's own line, then the line written for every agent, then the built-in one", () => {
    const phrases: PetMessagePhrases = {
      '*': { working: ['every agent sees this'] },
      memory: { working: [WORKING_CN] },
    }
    const at = (agentId: string, state: PetTaskState): string =>
      petTaskMessage({ state, agentId, sessionId: 'session-1', phrases })

    expect(at('memory', 'working')).toBe(WORKING_CN)
    expect(at('some-other-engine', 'working')).toBe('every agent sees this')
    // Nothing written for `waiting-input` at all: the built-in pool answers.
    expect(at('memory', 'waiting-input')).not.toBe('')
    expect(at('memory', 'waiting-input')).not.toBe(WORKING_CN)
  })

  it('ignores a custom line that is only whitespace instead of showing a blank row', () => {
    const phrases: PetMessagePhrases = { memory: { working: ['   ', '\n'] } }

    const line = petTaskMessage({ state: 'working', agentId: 'memory', sessionId: 's', phrases })

    expect(line.trim()).not.toBe('')
    expect(line).not.toBe('   ')
  })

  it('resolves {agent} and {session}, and leaves a placeholder it does not know visible', () => {
    const phrases: PetMessagePhrases = {
      memory: {
        'waiting-input': ['等待 {agent} 回答（会话 {session}）'],
        failed: ['已完成 {percent}%'],
        cancelled: [WAITING_CN],
      },
    }
    const at = (state: PetTaskState): string =>
      petTaskMessage({ state, agentId: 'memory', sessionId: 'session-42', phrases })

    expect(at('waiting-input')).toBe('等待 memory 回答（会话 session-42）')
    // Left alone rather than erased: a typo in a phrase the user typed is a thing they can see and
    // fix, while a silently vanished word is a phrase that reads as if it were written that way.
    expect(at('failed')).toBe('已完成 {percent}%')
    // A line the user wrote in Chinese with no placeholders at all comes back exactly as typed.
    expect(at('cancelled')).toBe(WAITING_CN)
  })

  it('hands the line back as text, markup and all, without escaping or stripping it', () => {
    // Not "the phrase may contain markup" — it may not, and the component never parses it. This is
    // the guard on the *service*: whatever the user typed comes back unchanged, so the plain-text
    // guarantee lives in exactly one place (the rendering) instead of two half-escapes that add up.
    const spicy = '正文里有 <b>加粗</b>、& 和 "引号" —— 都只是字符。'
    const line = petTaskMessage({
      state: 'working',
      agentId: 'memory',
      sessionId: 's',
      phrases: { memory: { working: [spicy] } },
    })

    expect(line).toBe(spicy)
  })

  it('names every state with a label of its own, and never reads one out of a phrase', () => {
    // §6.2: 成功/取消/失败/受限结束不能混淆. Four ways for a turn to end that a user must be able
    // to tell apart, so a single "Done" for all of them would be the bug this asserts against.
    const ending: PetTaskState[] = [
      'turn-finished',
      'stopped',
      'refused',
      'cancelled',
      'failed',
      'interrupted',
    ]
    const labels = ending.map((state) => petStateLabel(state))

    expect(new Set(labels).size).toBe(ending.length)
    for (const label of labels) expect(label.trim()).not.toBe('')

    // The label is a function of the state. A phrase — custom or built-in — cannot reach it, which
    // is what stops a written line from looking like a different outcome.
    const disguised = petTaskMessage({
      state: 'failed',
      agentId: 'memory',
      sessionId: 's',
      phrases: { '*': { failed: ['All done!'] } },
    })
    expect(disguised).toBe('All done!')
    expect(petStateLabel('failed')).not.toBe(petStateLabel('turn-finished'))
  })

  it('can be relabelled by the caller without the label becoming a function of the phrase', () => {
    // The i18n path: §10.1's pet namespace (the integrator's) supplies the words. An override is
    // still keyed by state, so it cannot be reached by any phrase either.
    expect(petStateLabel('waiting-input', { 'waiting-input': '等待确认' })).toBe('等待确认')
    expect(petStateLabel('working', { 'waiting-input': '等待确认' })).not.toBe('等待确认')
  })
})

describe('elapsed', () => {
  const at = (seconds: number): string => petElapsed(1_700_000_000_000, 1_700_000_000_000 + seconds * 1000)

  it('reads as seconds, then minutes, then hours and minutes', () => {
    expect(at(0)).toBe('0s')
    expect(at(59)).toBe('59s')
    expect(at(60)).toBe('1m')
    expect(at(3600)).toBe('1h 0m')
    expect(at(3900)).toBe('1h 5m')
  })

  it('never counts backwards from a clock that moved, and says nothing at all when it cannot know', () => {
    // `updatedAt` comes from the host's clock (§6.1) and `now` from the caller's: two clocks can
    // disagree by a second without anything being wrong, and a row reading "-1s" is a row the user
    // reads as a bug in the app rather than as skew between two clocks.
    expect(at(-30)).toBe('0s')
    expect(petElapsed(Number.NaN, 1_700_000_000_000)).toBe('')
    expect(petElapsed(1_700_000_000_000, Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('the built-in lines', () => {
  it('are a line per state and nothing else', () => {
    // The pool is keyed by the contract's own state union: a state added by `pet-contracts` leaves
    // this table failing to compile rather than a row that silently has no line.
    expect(Object.keys(PET_MESSAGE_PHRASES).sort()).toEqual([...PET_TASK_STATES].sort())
    for (const state of PET_TASK_STATES) expect(PET_MESSAGE_PHRASES[state].length).toBeGreaterThan(0)
  })
})
