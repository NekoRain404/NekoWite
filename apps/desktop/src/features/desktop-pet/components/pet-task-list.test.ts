/**
 * The multi-task list: several tasks at once, in Chinese, as text, and clickable to the one you
 * meant.
 *
 * Three of the four acceptance clauses are here, and they are here together because they are the
 * same surface: 多任务 is a list where more than one row is live at a time, 长中文 is what those
 * rows carry, 纯文本 is what they may never interpret, and 点击准确路由 is what a row does when it
 * is clicked — including when the list has just reordered itself under the pointer.
 *
 * That last one is why the routing assertions click **every** row in DOM order and compare the
 * whole sequence rather than spot-checking one: an off-by-one is not a row that does nothing, it
 * is a row that opens its neighbour, and a test that clicks one row cannot see it. The same
 * mistake has a second shape — a row closing over an index instead of over the task — which is why
 * one test changes the list's order between two clicks and asks again.
 *
 * The text is deliberately long and Chinese rather than `Hello world`: these rows are 280px wide,
 * and a CJK sentence full of mixed Latin ids is the content that actually has to fit in them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import type { PetTaskKey, PetTaskProjection, PetTaskState } from '../../../platform/gateways/pet-contracts'
import { PET_BUBBLE_MAX_WIDTH } from '../services/pet-bubble-layout'
import type { PetMessagePhrases } from '../services/pet-message-template'
import PetTaskList from './PetTaskList.vue'

/** The host clock the tests read: elapsed times are assertions, not wall-clock readings. */
const NOW = 1_700_000_000_000

/** A working line about a real kind of note, at the length a note title actually has. */
const WORKING_CN =
  '正在整理《分布式一致性协议》的中文笔记：先把第三章的引用段落重新编号，再校对术语表里「共识」与「法定人数」两处译法，稍候片刻。'
/** A waiting line: this one names the files the permission is about, in Chinese. */
const WAITING_CN = '需要你确认：这条命令会覆写 12 个既有文件，其中 3 个还有未提交的改动。'

const PHRASES: PetMessagePhrases = {
  memory: {
    working: [WORKING_CN],
    'waiting-input': [WAITING_CN],
    failed: ['这一轮执行失败了，详情请看主面板。（任务 c）'],
    'turn-finished': ['本轮已经结束，工具输出与文件改动都不再变化。（任务 d）'],
  },
}

function task(
  state: PetTaskState,
  options: {
    agentId?: string
    sessionId?: string
    updatedAt?: number
    permissionRequestId?: string | null
  } = {},
): PetTaskProjection {
  const key: PetTaskKey = {
    agentId: options.agentId ?? 'memory',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId: 'memoir://demo',
    sessionId: options.sessionId ?? 'session-1',
    runId: `run-${options.sessionId ?? '1'}`,
  }
  return {
    key,
    state,
    permissionRequestId:
      options.permissionRequestId ?? (state === 'waiting-input' ? 'req-1' : null),
    updatedAt: options.updatedAt ?? NOW - 1_000,
  }
}

interface Harness {
  app: VueApp
  rows: () => HTMLElement[]
  texts: () => string[]
  selected: PetTaskKey[]
  set: (patch: Record<string, unknown>) => Promise<void>
}

const mounted: VueApp[] = []

/**
 * The list with live props, because two of the tests below are about what happens *between* two
 * renders — a click landing on a list that has just reordered itself.
 */
function mount(initial: Record<string, unknown> = {}): Harness {
  document.body.innerHTML = '<div id="host"></div>'
  const selected: PetTaskKey[] = []
  const props = ref<Record<string, unknown>>({
    tasks: [],
    now: NOW,
    phrases: PHRASES,
    ...initial,
  })

  const app = createApp({
    setup: () => () =>
      h(PetTaskList, {
        ...props.value,
        onSelect: (picked: PetTaskProjection) => selected.push(picked.key),
      }),
  })
  mounted.push(app)
  const host = document.getElementById('host') as HTMLElement
  app.mount(host)

  return {
    app,
    rows: () => [...host.querySelectorAll<HTMLElement>('.pet-task__row')],
    texts: () =>
      [...host.querySelectorAll<HTMLElement>('[data-token="message"]')].map(
        (el) => el.textContent ?? '',
      ),
    selected,
    set: async (patch) => {
      props.value = { ...props.value, ...patch }
      await nextTick()
    },
  }
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
})

describe('several tasks at once', () => {
  it('gives every task a row of its own, most urgent first', () => {
    const view = mount({
      tasks: [
        task('working', { sessionId: 'a', updatedAt: NOW - 1_000 }),
        task('waiting-input', { sessionId: 'b', updatedAt: NOW - 2_000 }),
        task('failed', { sessionId: 'c', updatedAt: NOW - 3_000 }),
        task('turn-finished', { sessionId: 'd', updatedAt: NOW - 4_000 }),
      ],
    })

    // The waiting task is the oldest event and still heads the list: §3.1.3 is a rule about what
    // the user is being asked for, not about recency.
    expect(view.texts()).toEqual([
      WAITING_CN,
      '这一轮执行失败了，详情请看主面板。（任务 c）',
      WORKING_CN,
      '本轮已经结束，工具输出与文件改动都不再变化。（任务 d）',
    ])
    expect(view.rows()).toHaveLength(4)
  })

  it('keeps two engines that share a session id apart, in the text and in the route', () => {
    // §3.1.1: upstream keys its store on `${agent}:${session}` and finds rows by a suffix match, so
    // two agents whose sessions share a name are one entry. Here they are two rows, and clicking
    // each one names the agent it belongs to.
    const view = mount({
      tasks: [
        task('working', { agentId: 'memory', sessionId: 'shared' }),
        task('waiting-input', { agentId: 'opencode', sessionId: 'shared' }),
      ],
      layout: { grouping: 'flat' },
    })

    const rows = view.rows()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.dataset.agent)).toEqual(['opencode', 'memory'])

    for (const row of rows) row.click()

    expect(view.selected.map((key) => key.agentId)).toEqual(['opencode', 'memory'])
    expect(view.selected.every((key) => key.sessionId === 'shared')).toBe(true)
  })

  it('heads each engine’s rows with the engine, and never folds two tasks into one row', () => {
    const view = mount({
      tasks: [
        task('working', { agentId: 'memory', sessionId: 'm1' }),
        task('working', { agentId: 'memory', sessionId: 'm2' }),
        task('failed', { agentId: 'opencode', sessionId: 'o1' }),
      ],
      agentLabels: { memory: 'Memoir', opencode: 'OpenCode' },
    })

    const heads = [...document.querySelectorAll<HTMLElement>('.pet-task__group-head')]
    expect(heads.map((head) => head.textContent?.trim())).toEqual(['OpenCode 1', 'Memoir 2'])
    // §6.3's 多任务列表持续显示每个任务: a heading counts rows, it does not replace them.
    expect(view.rows()).toHaveLength(3)
  })

  it('says how many rows the cap left out instead of ending the list quietly', () => {
    const view = mount({
      tasks: [
        task('working', { sessionId: 'a', updatedAt: NOW - 4_000 }),
        task('working', { sessionId: 'b', updatedAt: NOW - 3_000 }),
        task('working', { sessionId: 'c', updatedAt: NOW - 2_000 }),
        task('working', { sessionId: 'd', updatedAt: NOW - 1_000 }),
      ],
      layout: { maxTasks: 2, grouping: 'flat' },
    })

    expect(view.rows()).toHaveLength(2)
    expect(document.querySelector('.pet-task__more')?.textContent?.trim()).toBe('+2 more')
    expect(view.texts()).toEqual([WORKING_CN, WORKING_CN])
  })

  it('keeps a task that needs the user on the first page of a carousel', async () => {
    const view = mount({
      layout: { mode: 'carousel', maxTasks: 2, grouping: 'flat' },
      tasks: [
        task('working', { sessionId: 'w1', updatedAt: NOW - 5_000 }),
        task('working', { sessionId: 'w2', updatedAt: NOW - 4_000 }),
        task('working', { sessionId: 'w3', updatedAt: NOW - 3_000 }),
        task('waiting-input', { sessionId: 'needs-you', updatedAt: NOW - 1_000 }),
      ],
    })

    expect(view.texts()).toEqual([WAITING_CN, WORKING_CN])

    // The dots are the way to the rest, and a dot is a click target like any other: page two of
    // this list holds two other tasks, and the row on it routes to the one it shows.
    const dots = [...document.querySelectorAll<HTMLElement>('.pet-task__page')]
    expect(dots).toHaveLength(2)
    dots[1]?.click()
    await nextTick()

    expect(view.texts()).toEqual([WORKING_CN, WORKING_CN])
    view.rows()[0]?.click()
    expect(view.selected.map((key) => key.sessionId)).toEqual(['w2'])
  })

  it('previews two rows in compact mode and opens the fold to the cap', async () => {
    const view = mount({
      layout: { mode: 'compact', maxTasks: 4, grouping: 'flat' },
      tasks: [
        task('working', { sessionId: 'a', updatedAt: NOW - 4_000 }),
        task('working', { sessionId: 'b', updatedAt: NOW - 3_000 }),
        task('working', { sessionId: 'c', updatedAt: NOW - 2_000 }),
        task('working', { sessionId: 'd', updatedAt: NOW - 1_000 }),
      ],
    })

    expect(view.rows()).toHaveLength(2)
    expect(document.querySelector('.pet-task__summary')?.textContent?.trim()).toBe('4 running')

    document.querySelector<HTMLElement>('.pet-task__fold')?.click()
    await nextTick()

    expect(view.rows()).toHaveLength(4)
    expect(document.querySelector<HTMLElement>('.pet-task__fold')?.textContent?.trim()).toBe(
      'Show fewer',
    )
  })
})

describe('a click lands on the task it points at', () => {
  function four(): PetTaskProjection[] {
    return [
      task('working', { sessionId: 'a', updatedAt: NOW - 1_000 }),
      task('waiting-input', { sessionId: 'b', updatedAt: NOW - 2_000 }),
      task('failed', { sessionId: 'c', updatedAt: NOW - 3_000 }),
      task('turn-finished', { sessionId: 'd', updatedAt: NOW - 4_000 }),
    ]
  }

  it('routes every row of the list to its own task, in the order the rows are drawn', () => {
    const view = mount({ tasks: four(), layout: { grouping: 'flat' } })

    // The order the ranking promises, and the order the DOM has to agree with it.
    expect(view.texts()).toEqual([
      WAITING_CN,
      '这一轮执行失败了，详情请看主面板。（任务 c）',
      WORKING_CN,
      '本轮已经结束，工具输出与文件改动都不再变化。（任务 d）',
    ])

    for (const row of view.rows()) row.click()

    expect(view.selected.map((key) => key.sessionId)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('routes a click on the message text, which is the part of the row a user aims at', () => {
    const view = mount({ tasks: four(), layout: { grouping: 'flat' } })

    const messages = [...document.querySelectorAll<HTMLElement>('[data-token="message"]')]
    messages[1]?.click()

    expect(view.selected.map((key) => key.sessionId)).toEqual(['c'])
  })

  it('routes nothing from a heading, which is not a task', () => {
    const view = mount({ tasks: four() })

    for (const head of document.querySelectorAll<HTMLElement>('.pet-task__group-head')) head.click()

    expect(view.selected).toEqual([])
  })

  it('follows the list when it reorders under the pointer', async () => {
    // The off-by-one that a screenshot cannot show: a row that closed over its index rather than
    // over its task keeps pointing at the row's *old* occupant. The waiting task is the one that
    // moves — when it stops waiting, the working task takes the top row.
    const view = mount({
      tasks: [
        task('working', { sessionId: 'a', updatedAt: NOW - 1_000 }),
        task('waiting-input', { sessionId: 'b', updatedAt: NOW - 2_000 }),
      ],
      layout: { grouping: 'flat' },
    })
    expect(view.texts()).toEqual([WAITING_CN, WORKING_CN])

    await view.set({
      tasks: [
        task('working', { sessionId: 'a', updatedAt: NOW - 1_000 }),
        task('cancelled', { sessionId: 'b', updatedAt: NOW - 2_000 }),
      ],
    })

    view.rows()[0]?.click()
    expect(view.selected.map((key) => key.sessionId)).toEqual(['a'])
  })

  it('carries the permission request with the row that is waiting, and only that row', () => {
    // §6.2: a click on a waiting task goes to the host's permission UI, which is addressed by the
    // request id — so the row has to bring it, and a row that is not waiting has to not.
    const view = mount({ tasks: four(), layout: { grouping: 'flat' } })

    for (const row of view.rows()) row.click()

    expect(view.selected.map((key) => key.sessionId === 'b')).toEqual([true, false, false, false])
    const waiting = document.querySelector<HTMLElement>('.pet-task__row[data-state="waiting-input"]')
    expect(waiting?.dataset.permission).toBe('req-1')
  })
})

describe('long Chinese in a 280px row', () => {
  it('shows the whole sentence, with nothing truncated and no ellipsis of its own', () => {
    mount({ tasks: [task('working', { sessionId: 'a' })], layout: { grouping: 'flat' } })

    const message = document.querySelector<HTMLElement>('[data-token="message"]')
    expect(message?.textContent?.trim()).toBe(WORKING_CN)
  })

  it('hands the wrapping rules to the element that carries the text', () => {
    mount({ tasks: [task('working', { sessionId: 'a' })], layout: { grouping: 'flat' } })

    const message = document.querySelector<HTMLElement>('[data-token="message"]')
    // Chinese has no spaces and a path has no break opportunity at all; `anywhere` is what lets
    // both of them wrap instead of widening the row.
    expect(message?.style.overflowWrap).toBe('anywhere')
    expect(message?.style.wordBreak).toBe('break-word')
    // And the flex item may shrink below its content, or the row grows instead of the text.
    // Parsed rather than string-compared: happy-dom keeps the declaration as written, and `0` and
    // `0px` are the same rule.
    expect(Number.parseFloat(message?.style.minWidth || 'NaN')).toBe(0)
    expect(message?.style.whiteSpace).not.toBe('nowrap')
    // The short fields keep their size, so the message is what gives way.
    expect(document.querySelector<HTMLElement>('[data-token="agent"]')?.style.flex).toBe('0 0 auto')
  })

  it('bounds the surface and lets the rows wrap inside it', () => {
    mount({ tasks: [task('working', { sessionId: 'a' })], layout: { grouping: 'flat' } })

    const surface = document.querySelector<HTMLElement>('.pet-task')
    expect(surface?.style.maxWidth).toBe(`${PET_BUBBLE_MAX_WIDTH}px`)
    expect(surface?.style.boxSizing).toBe('border-box')
    expect(document.querySelector<HTMLElement>('.pet-task__row')?.style.flexWrap).toBe('wrap')
  })
})

describe('plain text', () => {
  it('renders markup as characters rather than as elements', () => {
    // The upstream habit this replaces: `slot.innerHTML = …` (`bubble.ts:595-604`). A phrase is
    // text a user typed, and `<b>` in it is a `<b>` the user typed.
    const spicy =
      '正文里有 <b>加粗</b> 与 <img src=x onerror="boom()">，还有 <script>alert(1)</script> 一段。'
    mount({
      tasks: [task('working', { sessionId: 'a' })],
      layout: { grouping: 'flat' },
      phrases: { '*': { working: [spicy] } },
    })

    const row = document.querySelector<HTMLElement>('.pet-task__row')
    expect(document.querySelector('[data-token="message"]')?.textContent).toBe(spicy)
    expect(row?.querySelector('b')).toBeNull()
    expect(row?.querySelector('img')).toBeNull()
    expect(row?.querySelector('script')).toBeNull()
    expect(document.querySelectorAll('script')).toHaveLength(0)
  })

  it('says a task is what it is, whatever a written line says about it', () => {
    // §5.2's 「状态标签不可被自定义文案伪装成另一种结果」, as a fact about the DOM: the default layout
    // hides the state field, and the row is still named for the state it is in — a row whose only
    // sign of "needs you" was a colour would be a row a screen reader calls "Working".
    mount({
      tasks: [task('waiting-input', { sessionId: 'b' })],
      layout: { grouping: 'flat' },
      phrases: { '*': { working: ['All done!'], 'waiting-input': [WAITING_CN] } },
    })

    const row = document.querySelector<HTMLElement>('.pet-task__row')
    expect(document.querySelector('[data-token="stateLabel"]')).toBeNull()
    expect(row?.getAttribute('aria-label')).toContain('Needs you')
    expect(row?.getAttribute('aria-label')).toContain(WAITING_CN)
    expect(row?.dataset.state).toBe('waiting-input')
  })
})

describe('what the list says when there is nothing to list', () => {
  it('states that nothing matches rather than showing an empty box', () => {
    mount({
      tasks: [task('turn-finished', { sessionId: 'd' })],
      layout: { filter: 'working', grouping: 'flat' },
    })

    expect(document.querySelectorAll('.pet-task__row')).toHaveLength(0)
    expect(document.querySelector('.pet-task__empty')?.textContent?.trim()).toBe(
      'Nothing running right now.',
    )
  })

  it('takes its wording from the caller', () => {
    mount({
      tasks: [
        task('working', { sessionId: 'a', updatedAt: NOW - 2_000 }),
        task('working', { sessionId: 'b', updatedAt: NOW - 1_000 }),
      ],
      layout: { maxTasks: 1, grouping: 'flat' },
      labels: { more: '还有 {count} 个任务' },
    })

    expect(document.querySelector('.pet-task__more')?.textContent?.trim()).toBe('还有 1 个任务')
  })

  it('formats elapsed from the clock it was given, not from the wall clock', () => {
    mount({
      tasks: [task('working', { sessionId: 'a', updatedAt: NOW - 95_000 })],
      now: NOW,
      layout: { grouping: 'flat', tokens: [{ token: 'message', visible: true }, { token: 'elapsed', visible: true }] },
    })

    expect(document.querySelector('[data-token="elapsed"]')?.textContent?.trim()).toBe('1m')
  })
})
