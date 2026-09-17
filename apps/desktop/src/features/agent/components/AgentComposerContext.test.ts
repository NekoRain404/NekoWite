/**
 * The composer's `+`: what the menu offers, and what choosing a row puts in the message.
 *
 * It mounts the *composer* rather than the control alone, because the two halves of this feature
 * are a menu that reads a folder and a field that receives a path, and every one of these cases is
 * about both: an entry the reader picked has to arrive in the draft, and a failure has to arrive
 * somewhere the reader is looking. The folder is the app's own gateway port (stubbed, as the
 * attachments panel's tests stub it); the session is the memory double, so the vault the listing is
 * asked for is the one the session was really opened with rather than one the test handed the
 * component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AgentComposer, { type AgentComposerLabels } from './AgentComposer.vue'
import {
  createMemoryAgentGateway,
  type MemoryAgentGateway,
} from '../../../platform/gateways/memory-agent'
import type { AgentSession } from '../../../platform/gateways/agent-contracts'
import type { FileEntry } from '../../../platform/gateways/contracts'
import { onNotify } from '../../../services/errors'
import { t } from '../../../i18n'
import { useAgentSessionStore } from '../stores/agent-session'
import { sessionKey } from '../services/agent-session-view'

const listMock = vi.hoisted(() => vi.fn())

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    list: listMock,
  },
}))

const VAULT = '/home/user/vault'

const LABELS: AgentComposerLabels = {
  placeholder: 'Ask the agent to do something in this folder',
  send: 'Send',
  stop: 'Stop',
  hint: 'Enter sends.',
  hintBusy: 'Enter cannot send while this turn is running.',
}

function entry(name: string, isDir = false): FileEntry {
  return {
    name,
    path: `${VAULT}/${name}`,
    is_dir: isDir,
    is_mdx: !isDir && name.endsWith('.md'),
  }
}

let pinia: Pinia
let gateway: MemoryAgentGateway
let session: AgentSession
let mounted: VueApp[] = []
let host: HTMLElement
let notices: string[]
let stopNotifying: () => void

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The whole settle these component tests use: `list` resolves in microtasks and the menu, the
 *  store and the draft commit in Vue's queue. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await nextTick()
    await flush()
  }
}

/** The rows of the list the control draws above itself. */
function rows(): Array<{ label: string; disabled: boolean }> {
  return [...document.querySelectorAll<HTMLButtonElement>('.agent-reference-row')].map((item) => ({
    label: item.textContent?.trim() ?? '',
    disabled: item.disabled,
  }))
}

async function clickRow(label: string): Promise<void> {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.agent-reference-row')].find(
    (candidate) => (candidate.textContent?.trim() ?? '') === label,
  )
  if (item === undefined) throw new Error(`the menu has no ${label} row: ${JSON.stringify(rows())}`)
  item.click()
  await settle()
}

const field = (): HTMLTextAreaElement => {
  const el = host.querySelector<HTMLTextAreaElement>('.agent-composer-field')
  if (el === null) throw new Error('the composer has no field')
  return el
}

function mountComposer(selection?: () => { readonly text: string } | null): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentComposer, {
    running: false,
    canSend: true,
    labels: LABELS,
    ...(selection === undefined ? {} : { selection }),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

/** The session a live panel would have put on screen: attached, and the active record. */
async function withSession(): Promise<void> {
  const store = useAgentSessionStore()
  await store.attach(gateway, session)
  store.focus(sessionKey(session))
  await settle()
}

beforeEach(async () => {
  pinia = createPinia()
  setActivePinia(pinia)
  listMock.mockReset()
  notices = []
  stopNotifying = onNotify((message) => notices.push(message))
  gateway = createMemoryAgentGateway({ agentId: 'memory', profileId: 'test' })
  await gateway.start()
  session = await gateway.openSession({ vaultId: VAULT, cwd: VAULT })
})

afterEach(() => {
  stopNotifying()
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('before there is a folder', () => {
  it('offers nothing and says why, rather than opening an empty menu', async () => {
    mountComposer()
    await settle()
    const button = host.querySelector<HTMLButtonElement>('[data-action="context"]')
    expect(button?.disabled).toBe(true)
    // The catalogue's own sentence, in whatever locale the suite runs in.
    expect(button?.title).toBe(t('agent.panel.composer.context.noFolder'))
    button?.click()
    await settle()
    expect(listMock).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })
})

describe('with a session in a folder', () => {
  it('lists the folder and puts the chosen file into the message', async () => {
    listMock.mockResolvedValue([entry('notes', true), entry('welcome.md')])
    mountComposer()
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    // The vault the listing was asked for is the session's own, and the root is spelled ''.
    expect(listMock).toHaveBeenCalledWith(VAULT, '')
    expect(rows().map((row) => row.label)).toEqual(['notes', 'welcome.md'])

    await clickRow('welcome.md')
    expect(field().value).toBe('welcome.md ')
    // Chosen, so the menu is gone — a second pick cannot be made against a listing the reader has
    // already acted on.
    expect(rows()).toEqual([])
  })

  it('walks into a folder, and back up out of it', async () => {
    listMock.mockImplementation(async (_vault: string, dir: string) =>
      dir === '' ? [entry('notes', true)] : [entry('a.md')],
    )
    mountComposer()
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    // The root has nothing above it, so it has no row up.
    expect(rows().map((row) => row.label)).toEqual(['notes'])

    await clickRow('notes')
    expect(listMock).toHaveBeenLastCalledWith(VAULT, 'notes')
    expect(rows().map((row) => row.label)).toEqual([
      t('agent.panel.composer.context.up'),
      'a.md',
    ])

    await clickRow(t('agent.panel.composer.context.up'))
    expect(listMock).toHaveBeenLastCalledWith(VAULT, '')
    expect(rows().map((row) => row.label)).toEqual(['notes'])
  })

  it('says a folder is empty instead of showing a menu with nothing in it', async () => {
    listMock.mockResolvedValue([])
    mountComposer()
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    expect(rows()).toEqual([{ label: t('agent.panel.composer.context.empty'), disabled: true }])
  })

  it('reports a folder it could not read, in the backend’s own words', async () => {
    listMock.mockRejectedValue('the folder could not be listed')
    mountComposer()
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    expect(notices).toEqual([
      t('agent.panel.composer.context.unreadable', { detail: 'the folder could not be listed' }),
    ])
    // Nothing to pick from, so nothing is left open over the composer.
    expect(rows()).toEqual([])
  })

  it('drops a listing that arrives after the window moved to another folder', async () => {
    let release: (entries: FileEntry[]) => void = () => {}
    listMock.mockImplementation(
      () =>
        new Promise<FileEntry[]>((resolve) => {
          release = resolve
        }),
    )
    mountComposer()
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    // Another vault, opened and put on screen while this folder's reading is in flight — which is
    // what a vault switch does to the store (§6.2: a new vault is a new runtime).
    const other = await gateway.openSession({ vaultId: '/somewhere/else', cwd: '/somewhere/else' })
    const store = useAgentSessionStore()
    await store.attach(gateway, other)
    store.focus(sessionKey(other))
    release([entry('welcome.md')])
    await settle()

    // The path the answer named is a file of a folder this session cannot see, so it is not a row:
    // the one thing a stale answer must not become is a reference the engine cannot resolve.
    expect(rows().map((row) => row.label)).not.toContain('welcome.md')
  })

  it('closes on Escape and hands focus back to the control it came from', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer()
    await withSession()
    const button = host.querySelector<HTMLButtonElement>('[data-action="context"]')
    button?.click()
    await settle()
    expect(rows()).toHaveLength(1)

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await settle()

    expect(rows()).toEqual([])
    expect(document.activeElement).toBe(button)
  })

  it('goes away when Tab moves on, without pulling focus back', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer()
    await withSession()
    const button = host.querySelector<HTMLButtonElement>('[data-action="context"]')
    button?.click()
    await settle()
    const focused = document.activeElement as HTMLElement
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await settle()

    // Gone, and focus was not dragged back to the control: the reader asked to move on, and the
    // rows are not tabbable, so the browser's own next stop stands.
    expect(rows()).toEqual([])
    expect(document.activeElement).not.toBe(button)
  })

  it('closes when the reader clicks somewhere else in the app', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer()
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()
    expect(rows()).toHaveLength(1)

    // Anywhere outside the control and its list, which is what the panel around it is.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await settle()

    expect(rows()).toEqual([])
  })

  it('inserts at the caret rather than at the end of what was already typed', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer()
    await withSession()
    const target = field()
    target.value = 'summarise  please'
    target.dispatchEvent(new Event('input'))
    target.setSelectionRange(10, 10)
    await settle()

    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()
    await clickRow('welcome.md')

    expect(field().value).toBe('summarise welcome.md please')
    expect(field().selectionStart).toBe(20)
  })
})

describe('the passage selected in the editor', () => {
  it('is the first row when the editor holds one, and goes into the message as its own words', async () => {
    listMock.mockResolvedValue([entry('notes', true), entry('welcome.md')])
    const read = (): { text: string } => ({ text: '\nthe quick brown fox\n' })
    mountComposer(read)
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    // Ahead of the folder, because the reader who has just highlighted a passage is the one who
    // pressed this control — and the listing is the second thing they might have wanted.
    expect(rows().map((row) => row.label)).toEqual([
      t('agent.panel.composer.context.selection'),
      'notes',
      'welcome.md',
    ])

    await clickRow(t('agent.panel.composer.context.selection'))
    // Trimmed at the ends: the newline a drag across two paragraphs picks up is not part of what
    // the reader meant to point at.
    expect(field().value).toBe('the quick brown fox ')
    expect(rows()).toEqual([])
  })

  it('is offered while the folder is still being read, since it does not come from the folder', async () => {
    let release: (entries: FileEntry[]) => void = () => {}
    listMock.mockImplementation(
      () =>
        new Promise<FileEntry[]>((resolve) => {
          release = resolve
        }),
    )
    mountComposer(() => ({ text: 'a passage' }))
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    // The listing has not answered yet, so the menu is showing its reading row — and the passage
    // is already pickable, because nothing about it was waiting on the folder.
    expect(rows().map((row) => row.label)).toEqual([
      t('agent.panel.composer.context.selection'),
      t('agent.panel.composer.context.reading'),
    ])

    await clickRow(t('agent.panel.composer.context.selection'))
    expect(field().value).toBe('a passage ')
    release([])
    await settle()
  })

  it('is not offered at all when the editor holds nothing, rather than shown unusable', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer(() => null)
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    // Not a disabled row: this menu's disabled rows are things the folder is doing (a listing on
    // its way, an empty folder), and a standing "you have nothing selected" would be a nag on
    // every opening for a reader who came here for a file.
    expect(rows().map((row) => row.label)).toEqual(['welcome.md'])
  })

  it('is read once, when the list opens, so the row and the message cannot disagree', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    let reads = 0
    // The second call is what a re-read at the pick would see: by then the reader has moved the
    // caret, which is exactly the silent failure §7.1 「发送前固定…选区」 exists to prevent.
    const read = (): { text: string } => {
      reads += 1
      return { text: reads === 1 ? 'the first passage' : 'somewhere else entirely' }
    }
    mountComposer(read)
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()
    await clickRow(t('agent.panel.composer.context.selection'))

    expect(reads).toBe(1)
    expect(field().value).toBe('the first passage ')
  })

  it('is not carried into the next opening: a closed list forgets what it had captured', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    let held: { text: string } | null = { text: 'a passage' }
    mountComposer(() => held)
    await withSession()

    const button = host.querySelector<HTMLButtonElement>('[data-action="context"]')
    button?.click()
    await settle()
    expect(rows().map((row) => row.label)).toContain(t('agent.panel.composer.context.selection'))

    // Dismissed, then the reader collapses the selection and comes back for a file.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await settle()
    held = null
    button?.click()
    await settle()

    expect(rows().map((row) => row.label)).toEqual(['welcome.md'])
  })
})
