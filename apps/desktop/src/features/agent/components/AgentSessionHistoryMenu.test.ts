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
import { createApp, type App as VueApp } from 'vue'
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
  })
  app.mount(host)
  mounted.push(app)
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
