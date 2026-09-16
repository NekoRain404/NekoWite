/**
 * The bubble: what it shows when there are tasks, what it shows when there are none, and what it
 * refuses to do on its own.
 *
 * The interesting assertions here are the absences. A bubble with no tasks must not be a bubble
 * with an empty box in it, a bubble that was not given a line must not invent one, and — the one
 * that matters most — a carousel must not advance by itself. Upstream pages a multi-session bubble
 * every three seconds on a timer (`windows/src/bubble.ts` 392-398), which is a surface that hides a
 * task the user has not answered yet, on a clock; §3.1.3 forbids exactly that, and a presentational
 * component that owns a timer is what §6.3 tells the port not to build (参数注入时钟测试，不写死到
 * 组件定时器). The timer test below is how "no self-advancing surface" stays true.
 *
 * The bubble is also where a right-click becomes a menu, so it is where the browser's own context
 * menu has to stop: a frameless pet window that opened the WebKit menu would have one menu for the
 * pet and one for the webview.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import type { PetTaskKey, PetTaskProjection, PetTaskState } from '../../../platform/gateways/pet-contracts'
import { PET_BUBBLE_MAX_WIDTH } from '../services/pet-bubble-layout'
import PetBubble from './PetBubble.vue'

const NOW = 1_700_000_000_000
const CHINESE = '正在整理《分布式一致性协议》的中文笔记：先把第三章的引用段落重新编号，再校对术语表。'
const IDLE_LINE = '今天没有正在运行的任务，要不要先写两行笔记？'

function task(state: PetTaskState, sessionId: string): PetTaskProjection {
  const key: PetTaskKey = {
    agentId: 'memory',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId: 'memoir://demo',
    sessionId,
    runId: `run-${sessionId}`,
  }
  return { key, state, permissionRequestId: null, updatedAt: NOW - 1_000 }
}

interface Harness {
  menus: { x: number; y: number }[]
  selected: PetTaskKey[]
}

const mounted: VueApp[] = []

function mount(props: Record<string, unknown> = {}): Harness {
  document.body.innerHTML = '<div id="host"></div>'
  const menus: { x: number; y: number }[] = []
  const selected: PetTaskKey[] = []
  const app = createApp({
    setup: () => () =>
      h(PetBubble, {
        tasks: [],
        now: NOW,
        ...props,
        onMenu: (position: { x: number; y: number }) => menus.push(position),
        onSelect: (picked: PetTaskProjection) => selected.push(picked.key),
      }),
  })
  mounted.push(app)
  app.mount(document.getElementById('host') as Element)
  return { menus, selected }
}

function bubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.pet-bubble')
}

function lines(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.pet-bubble__line')].map(
    (el) => el.textContent ?? '',
  )
}

afterEach(() => {
  vi.useRealTimers()
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
})

describe('what the bubble shows', () => {
  it('shows the list when there are tasks', () => {
    mount({
      tasks: [task('working', 'a')],
      phrases: { '*': { working: [CHINESE] } },
      layout: { grouping: 'flat' },
    })

    expect(bubble()?.dataset.mode).toBe('list')
    expect(document.querySelectorAll('.pet-task__row')).toHaveLength(1)
    expect(lines()).toEqual([])
  })

  it("shows the caller's line when there is nothing to list", () => {
    // The idle sentence is the caller's — the pet window carries no dictionary (§7.1) — and a
    // bubble with no line is a bubble with nothing to say, not a bubble that makes something up.
    mount({ line: IDLE_LINE })

    expect(bubble()?.dataset.mode).toBe('line')
    expect(lines()).toEqual([IDLE_LINE])
    expect(document.querySelectorAll('.pet-task__row')).toHaveLength(0)
  })

  it('draws nothing at all when it has neither tasks nor a line', () => {
    mount()

    expect(bubble()).toBeNull()
  })

  it('shows the list when the user asked for it, even before anything is running', () => {
    // The right-click menu's "Show tasks" is a real action with a real result: a surface that said
    // nothing at all would be a menu item with no effect (§7.2).
    mount({ forceList: true, line: IDLE_LINE })

    expect(bubble()?.dataset.mode).toBe('list')
    expect(document.querySelector('.pet-task__empty')).not.toBeNull()
  })

  it('says nothing about tasks a filter excludes, and falls back to its line', () => {
    mount({ tasks: [task('turn-finished', 'd')], line: IDLE_LINE, layout: { filter: 'working' } })

    expect(bubble()?.dataset.mode).toBe('line')
    expect(lines()).toEqual([IDLE_LINE])
  })
})

describe('what the bubble hands back', () => {
  it('passes a row click through with the task the row was showing', () => {
    const view = mount({
      tasks: [task('working', 'a'), task('waiting-input', 'b')],
      phrases: { '*': { working: [CHINESE], 'waiting-input': ['需要你确认这条命令。'] } },
      layout: { grouping: 'flat' },
    })

    const rows = [...document.querySelectorAll<HTMLElement>('.pet-task__row')]
    expect(rows).toHaveLength(2)
    // The waiting one is drawn first (§3.1.3), so the second row is the working task.
    rows[1]?.click()

    expect(view.selected.map((key) => key.sessionId)).toEqual(['a'])
  })

  it('turns a right-click into a menu position instead of the webview menu', () => {
    const view = mount({ line: IDLE_LINE })

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 42, clientY: 77 })
    bubble()?.dispatchEvent(event)

    expect(view.menus).toEqual([{ x: 42, y: 77 }])
    // The pet window is frameless: one menu is the pet's, and the other one belongs to a browser
    // this window is not.
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('long text in a small surface', () => {
  it('wraps the line it was given, on the element that carries it', () => {
    mount({ line: CHINESE })

    const line = document.querySelector<HTMLElement>('.pet-bubble__line')
    expect(line?.textContent).toBe(CHINESE)
    expect(line?.style.overflowWrap).toBe('anywhere')
    expect(line?.style.minWidth).toBe('0')
  })

  it('bounds itself so a long line cannot widen the window', () => {
    mount({ line: CHINESE })

    expect(bubble()?.style.maxWidth).toBe(`${PET_BUBBLE_MAX_WIDTH}px`)
    expect(bubble()?.style.boxSizing).toBe('border-box')
  })
})

describe('nothing moves on its own', () => {
  it('leaves the carousel where the user left it, however long the bubble is open', async () => {
    vi.useFakeTimers()
    const view = mount({
      tasks: [
        task('working', 'a'),
        task('working', 'b'),
        task('working', 'c'),
        task('waiting-input', 'needs-you'),
      ],
      phrases: { '*': { working: [CHINESE], 'waiting-input': ['需要你确认这条命令。'] } },
      layout: { mode: 'carousel', maxTasks: 2, grouping: 'flat' },
    })
    const before = lines().concat(
      [...document.querySelectorAll<HTMLElement>('.pet-task__row')].map((row) => row.dataset.state ?? ''),
    )

    vi.advanceTimersByTime(30_000)
    await nextTick()

    // Upstream would have run ten page turns by now, and the waiting task would be off screen.
    expect(
      lines().concat(
        [...document.querySelectorAll<HTMLElement>('.pet-task__row')].map(
          (row) => row.dataset.state ?? '',
        ),
      ),
    ).toEqual(before)
    expect(document.querySelector('.pet-task__page')?.getAttribute('aria-current')).toBe('true')
    expect(view.menus).toEqual([])
  })
})
