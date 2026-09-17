/**
 * The history list's own rendering, for the states no engine this build talks to produces.
 *
 * The double keeps every conversation and always names a session, so a row without a title, an
 * empty table and an engine that names a further page are answers only a real engine gives — the
 * pinned one lists in a single page, and `title`/`updatedAt` are optional in ACP, which is why the
 * contract keeps them `string | null`. They are asserted here rather than left as branches
 * nothing has ever run.
 *
 * Everything a reader *does* to this list — opening an engine's history, picking a row, freeing
 * one — is asserted through the panel that wires it (`AgentSessionHistory.test.ts`), because the
 * gestures are the panel's: this file mounts the list with the props the panel would pass and
 * checks what it draws.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import AgentSessionHistoryMenu from './AgentSessionHistoryMenu.vue'
import type { AgentSessionHistoryRow } from '../services/agent-session-history'
import { setLocale } from '../../../i18n'

const ROW: AgentSessionHistoryRow = {
  sessionId: 'session-9',
  title: 'New session - 2026-01-01T00:00:09Z',
  cwd: '/notes/vault',
  updatedAt: '2026-01-01T00:00:09Z',
  // Held by the host and not the session on screen: the shape the free action is offered for.
  held: true,
  current: false,
  elsewhere: false,
}

/** A second row the search can tell apart from the first: another folder, another stamp. */
const OTHER: AgentSessionHistoryRow = {
  sessionId: 'session-8',
  title: 'New session - 2026-01-01T00:00:08Z',
  cwd: '/notes/elsewhere',
  updatedAt: '2026-01-01T00:00:08Z',
  held: true,
  current: false,
  elsewhere: true,
}

let mounted: VueApp[] = []

beforeEach(() => {
  setLocale('en')
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountMenu(props: {
  view: 'loading' | 'rows' | 'empty' | 'unreadable'
  rows?: readonly AgentSessionHistoryRow[]
  more?: boolean
  reason?: string | null
  /** Whether the caller can open a new session on this runtime — the entry's own gate. */
  openable?: boolean
  onOpen?: () => void
  onActivate?: (sessionId: string) => void
}): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentSessionHistoryMenu, {
    view: props.view,
    rows: props.rows ?? [],
    more: props.more ?? false,
    reason: props.reason ?? null,
    // The free action's two inputs: no capability, and no question in the footer. What those draw
    // is the panel's cases (`AgentSessionHistory.test.ts`); they are named here because the props
    // are required.
    closeable: false,
    footer: null,
    confirming: null,
    now: Date.parse('2026-01-01T00:01:00Z'),
    listId: 'agent-history-test',
    left: 0,
    top: 0,
    minWidth: 220,
    drop: 'down',
    openable: props.openable ?? false,
    onOpen: props.onOpen ?? (() => {}),
    onActivate: props.onActivate ?? (() => {}),
  })
  app.mount(host)
  mounted.push(app)
}

/** What the list is drawing, as the engine's own titles. */
const titles = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option-title')).map(
    (node) => node.textContent?.trim() ?? '',
  )

/**
 * Type into the find box the way a reader does, and let the render settle.
 *
 * The value is set and an `input` event dispatched rather than a key simulated: the popup reads
 * the field's value, which is what the browser writes before that event — and what the cases below
 * are about is the filter, not the keystroke.
 */
async function type(text: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>('[data-history-search]')
  if (field === null) throw new Error('no find box is drawn to type into')
  field.value = text
  field.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('the list’s own answers', () => {
  it('draws the engine’s missing title as a statement about the engine', () => {
    mountMenu({ view: 'rows', rows: [{ ...ROW, title: null }] })

    expect(document.querySelector('.agent-history-option-title')?.textContent?.trim()).toBe(
      'The engine sent no title for this session',
    )
    // The engine's own stamp is still read: the absence is a title, not a hole in the row.
    expect(document.querySelector('.agent-history-option-part')?.textContent?.trim()).toBe(
      'just now',
    )
  })

  it('distinguishes a page from the whole table', () => {
    // The pinned engine answers in one page, so this is the branch a paginating engine reaches —
    // and an incomplete list that read as complete would be the one answer worse than a short one.
    mountMenu({ view: 'rows', rows: [ROW], more: true })
    expect(document.querySelector('[data-history-more]')).not.toBeNull()

    document.body.innerHTML = ''
    mountMenu({ view: 'rows', rows: [ROW] })
    expect(document.querySelector('[data-history-more]')).toBeNull()
  })

  it('says which of the two empty answers it has, and never draws both', () => {
    mountMenu({ view: 'loading' })
    expect(document.querySelector('.agent-history-notice')?.textContent?.trim()).toBe(
      'Reading the sessions this engine holds...',
    )

    document.body.innerHTML = ''
    mountMenu({ view: 'empty' })
    expect(document.querySelector('.agent-history-notice')?.textContent?.trim()).toBe(
      'This engine holds no sessions.',
    )
    expect(document.querySelector('.agent-history-option')).toBeNull()
  })
})

/**
 * The find box, and what it is allowed to match.
 *
 * The rule it applies is `filterSessionRows`' own and is tested there; what is asserted here is
 * the half only a mounted list can show — that the box is drawn exactly where there is something
 * to search, that the list under it follows what was typed, and that a search which found nothing
 * says so rather than leaving a blank panel where the rows were.
 */
describe('the find box', () => {
  it('narrows the list to the rows the engine’s own facts match', async () => {
    mountMenu({ view: 'rows', rows: [ROW, OTHER] })
    expect(titles()).toHaveLength(2)

    await type('elsewhere')

    // One row left, and it is the engine's own folder that matched — the row still carries the
    // engine's title, unedited.
    expect(titles()).toEqual([OTHER.title])
  })

  it('says a search found nothing instead of drawing an empty list', async () => {
    mountMenu({ view: 'rows', rows: [ROW, OTHER] })

    await type('nothing says this')

    expect(document.querySelector('.agent-history-option')).toBeNull()
    // The sentence is the search's, not the engine's: "this engine holds no sessions" would be a
    // claim about the engine's table that this app has not checked.
    expect(document.querySelector('[data-history-nomatch]')?.textContent?.trim()).toBe(
      'No session matches',
    )
    // And it is not the engine's own empty answer: that sentence says the engine's table holds
    // nothing, which is a fact this app has not checked — it only knows what the box has left.
    expect(document.querySelector('[data-history-nomatch]')?.textContent).not.toContain(
      'This engine holds no sessions',
    )
  })

  it('keeps the page sentence beside a search that found nothing', async () => {
    // The engine named a further page, so "no session matches" is only true of what was sent —
    // and the sentence that says so is the one already drawn for a short list.
    mountMenu({ view: 'rows', rows: [ROW], more: true })

    await type('nothing says this')

    expect(document.querySelector('[data-history-nomatch]')).not.toBeNull()
    expect(document.querySelector('[data-history-more]')).not.toBeNull()
  })

  it('is not drawn for a list there is nothing to search', () => {
    // A box over an empty list is a control that cannot act: the answer is the engine's own "it
    // holds no sessions", not a field that would filter nothing.
    mountMenu({ view: 'empty' })
    expect(document.querySelector('[data-history-search]')).toBeNull()

    document.body.innerHTML = ''
    mountMenu({ view: 'loading' })
    expect(document.querySelector('[data-history-search]')).toBeNull()

    document.body.innerHTML = ''
    mountMenu({ view: 'unreadable', reason: 'the engine did not answer' })
    expect(document.querySelector('[data-history-search]')).toBeNull()

    document.body.innerHTML = ''
    mountMenu({ view: 'rows', rows: [ROW] })
    expect(document.querySelector('[data-history-search]')).not.toBeNull()
  })

  it('gives the whole list back when the search is cleared', async () => {
    mountMenu({ view: 'rows', rows: [ROW, OTHER] })
    await type('elsewhere')
    expect(titles()).toEqual([OTHER.title])

    // The clear control is drawn only while there is something to clear — and what it clears is
    // the query, never the engine's rows.
    const clear = document.querySelector<HTMLElement>('[data-history-clear]')
    expect(clear).not.toBeNull()
    clear!.click()
    await nextTick()

    expect(titles()).toEqual([ROW.title, OTHER.title])
    expect(document.querySelector<HTMLInputElement>('[data-history-search]')?.value).toBe('')
    expect(document.querySelector('[data-history-clear]')).toBeNull()
  })

  it('takes the row Enter would, from the box itself', async () => {
    // The reader never leaves the box: the arrows and Enter are the list's, which is the keyboard
    // model the config picker's own filter established for this app.
    const picked: string[] = []
    mountMenu({ view: 'rows', rows: [ROW, OTHER], onActivate: (sessionId) => picked.push(sessionId) })
    await type('elsewhere')

    const field = document.querySelector<HTMLInputElement>('[data-history-search]')!
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()

    expect(picked).toEqual([OTHER.sessionId])
  })
})

/**
 * The entry that opens a new session — the one gesture this list has that is not about a row.
 *
 * It is a *caller's* offer, not this component's decision (`openable`): opening a session is the
 * rail's move, and a list that drew the entry whenever it had rows would be offering something
 * nobody had said it could carry out. The button is drawn at the head of the list, beside the find
 * box, where Zed keeps its own (`agent_panel.rs:6153-6168`, the `+` beside the thread list).
 */
describe('the entry to a new session', () => {
  it('is not drawn for a caller that cannot open one', () => {
    mountMenu({ view: 'rows', rows: [ROW], openable: false })
    expect(document.querySelector('[data-history-new]')).toBeNull()
  })

  it('asks the caller to open one, and says what happens to the session that is open', async () => {
    const asked: number[] = []
    mountMenu({ view: 'rows', rows: [ROW], openable: true, onOpen: () => asked.push(1) })

    const entry = document.querySelector<HTMLElement>('[data-history-new]')
    expect(entry).not.toBeNull()
    // The name is the control's own, and the hover text is the consequence: the session on screen
    // is not taken away by this — it keeps running and stays in this list.
    expect(entry?.getAttribute('aria-label')).toBe('New session')
    expect(entry?.getAttribute('title')).toContain('keeps running and stays in this list')

    entry!.click()
    await nextTick()
    expect(asked).toEqual([1])
  })
})
