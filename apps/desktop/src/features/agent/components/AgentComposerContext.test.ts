/**
 * The composer's `+`: what the menu offers, and what choosing a row puts in the message.
 *
 * It mounts the *composer* rather than the control alone, because the two halves of this feature
 * are a menu that reads a folder and a field that receives a path, and every one of these cases is
 * about both: an entry the reader picked has to arrive in the draft, and a failure has to arrive
 * somewhere the reader is looking. The folder is the app's own gateway port (stubbed, as the
 * attachments panel's tests stub it); the workspace is the panel's — a prop, exactly as the panel
 * hands it down — and the store is set up as production has it (a session attached and in front),
 * which is what the case that points the store at *another* vault asserts this component does not
 * read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Ref } from 'vue'
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

/**
 * The composer, mounted the way the panel mounts it: the workspace arrives as a prop and nothing
 * here reaches the store for one. `null` is the no-folder arm — the state the panel is never in,
 * since a session always has a vault, and the state the control's disabled self is for.
 */
function mountComposer(
  selection?: () => { readonly text: string } | null,
  vault: string | null = VAULT,
): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentComposer, {
    running: false,
    canSend: true,
    labels: LABELS,
    vault,
    ...(selection === undefined ? {} : { selection }),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

/**
 * The composer with a *re-pointable* vault, which is a caller's own contract rather than the
 * panel's: the panel is mounted per session and never re-points one.
 *
 * It is mounted through a wrapper because a root props object is not reactive — `createApp`'s
 * second argument is copied into the vnode's props, so a `ref` handed there never reaches the
 * component. What the case below holds is the rule a re-point would otherwise break.
 */
function mountRepointable(vault: Ref<string | null>): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    setup: () => () =>
      h(AgentComposer, {
        running: false,
        canSend: true,
        labels: LABELS,
        vault: vault.value,
      }),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

/** The state a live panel mounts its composer in: a session attached to the store, under its own
 *  key. Nothing below depends on it — that is the subject of the divergence case — and it is kept
 *  because it is the state the composer is really mounted in. */
async function withSession(): Promise<void> {
  const store = useAgentSessionStore()
  await store.attach(gateway, session)
  await settle()
}

/**
 * A session in *another* vault, held by this window the way the rail holds one it has left.
 *
 * This used to be built by moving the store's pointer to it (`focus`) — the state a pet task click
 * left the window in — and the store no longer has one (`stores/agent-session.ts`). What is left is
 * the state these cases were always really about: the window holds another session, in another
 * vault, and the composer must still resolve everything against the session it was handed.
 */
async function anotherVaultInTheWindow(): Promise<void> {
  const elsewhere = await gateway.openSession({ vaultId: '/somewhere/else', cwd: '/somewhere/else' })
  const store = useAgentSessionStore()
  await store.attach(gateway, elsewhere)
  store.detach(sessionKey(elsewhere))
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
    // No workspace to address anything in: the caller handed the composer no vault. Under the
    // store seam this state was "no session on screen"; it is now the caller's own answer, which
    // is why the control is a value rather than a read.
    mountComposer(undefined, null)
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

  it('lists the session’s own vault, not the one another session in the window works in', async () => {
    // Correct by construction rather than by looking anything up: the folder listed is the one the
    // panel's session works in, so the two cannot disagree however the store's pointer moved.
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer()
    await withSession()
    await anotherVaultInTheWindow()

    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    expect(listMock).toHaveBeenCalledWith(VAULT, '')
    expect(rows().map((row) => row.label)).toEqual(['welcome.md'])
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

  it('drops a reading that arrives after the caller moved to another folder', async () => {
    let release: (entries: FileEntry[]) => void = () => {}
    listMock.mockImplementation(
      () =>
        new Promise<FileEntry[]>((resolve) => {
          release = resolve
        }),
    )
    // Re-pointed mid-flight, which is the only way this component's vault can move now that it is
    // a prop: a caller that re-points is a caller whose in-flight answer belongs to the vault that
    // asked, and the file it names is one the new folder cannot offer.
    const vault = ref<string | null>(VAULT)
    mountRepointable(vault)
    await withSession()
    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()

    vault.value = '/somewhere/else'
    await settle()
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
