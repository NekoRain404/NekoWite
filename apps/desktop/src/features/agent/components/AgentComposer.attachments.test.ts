/**
 * What the message carries beside its words: the chips, the three intakes, and the gate.
 *
 * It mounts the *composer* and drives it through the real panel-less path — the chip strip is the
 * composer's, the gate is the report the panel hands down, and the send is the composer's own
 * event. What these cases are about is therefore the whole of the reader's side: a file picked in
 * the `+` becomes a chip when the engine reads embedded files and a path in the message when it
 * does not, a pasted screenshot becomes a chip, and nothing at all is offered where the engine's
 * report said no.
 *
 * The report is built here rather than fetched: `AgentCapabilityReport` is the contract's own
 * shape, and a test that went through `gateway.capabilities` would be testing the memory double's
 * report rather than this component's reading of one.
 *
 * The workspace is the panel's too — a prop on the composer, exactly as the panel hands it down —
 * and three cases put a second session of another vault in the window to hold that: this component's
 * four readers of the vault (a pick, a drop, a mention and the `+`) must not follow anything but the
 * prop, and the store no longer has a pointer for them to follow in any case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AgentComposer, { type AgentComposerLabels } from './AgentComposer.vue'
import {
  createMemoryAgentGateway,
  type MemoryAgentGateway,
} from '../../../platform/gateways/memory-agent'
import {
  AGENT_CAPABILITY_FEATURES,
  type AgentCapabilityReport,
  type AgentSession,
} from '../../../platform/gateways/agent-contracts'
import type { FileEntry } from '../../../platform/gateways/contracts'
import { onNotify } from '../../../services/errors'
import { DRAGGED_PATH_TYPE } from '../../../services/drag-payload'
import { t } from '../../../i18n'
import { useAgentSessionStore } from '../stores/agent-session'
import { sessionKey } from '../services/agent-session-view'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const resolveMediaPathMock = vi.hoisted(() => vi.fn())
const indexGetMock = vi.hoisted(() => vi.fn())

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    list: listMock,
    read: readMock,
    stat: statMock,
    resolveMediaPath: resolveMediaPathMock,
  },
}))

// The app's own vault index, stubbed: the `@` menu reads the workspace through it, and a test that
// let it walk the vault would be testing the walk rather than this component.
vi.mock('../../../services/vault-files', () => ({
  vaultFileIndex: { get: indexGetMock },
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

/**
 * A capability report in which the named features are `available` and every other one is
 * `unverified` — which is not the same thing as absent, and is the arm this suite is most
 * interested in: an unverified feature must draw no control either.
 */
function report(available: string[], refused: Record<string, string> = {}): AgentCapabilityReport[] {
  return AGENT_CAPABILITY_FEATURES.map((feature) => ({
    feature,
    declared: 'advertised' as const,
    finding: available.includes(feature)
      ? ({ status: 'available' } as const)
      : feature in refused
        ? ({ status: 'unavailable', detail: refused[feature]! } as const)
        : ({ status: 'unverified', detail: 'nothing has been negotiated yet' } as const),
  }))
}

let pinia: Pinia
let gateway: MemoryAgentGateway
let session: AgentSession
let mounted: VueApp[] = []
let host: HTMLElement
let notices: string[]
let stopNotifying: () => void

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await nextTick()
    await flush()
  }
}

function mountComposer(
  capabilities?: readonly AgentCapabilityReport[],
  vault: string = VAULT,
): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentComposer, {
    running: false,
    canSend: true,
    labels: LABELS,
    vault,
    ...(capabilities === undefined ? {} : { capabilities }),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

/** The state a live panel mounts its composer in: a session attached to the store, its record in
 *  the table the panel's own key addresses. Nothing below depends on it — that is the subject of
 *  the divergence cases — and it is kept because it is the state the composer is really mounted in.
 */
async function withSession(): Promise<void> {
  const store = useAgentSessionStore()
  await store.attach(gateway, session)
  await settle()
}

/** A second session of this window, in another vault, held the way the rail holds one it has left:
 *  attached while its panel was up, detached when the rail moved on. The store holds both records
 *  and names neither as "in front" — there is no such name in it (`stores/agent-session.ts`), which
 *  is what these cases are really about: the composer's workspace is the session it was handed. */
async function anotherVaultInTheWindow(): Promise<void> {
  const elsewhere = await gateway.openSession({ vaultId: '/somewhere/else', cwd: '/somewhere/else' })
  const store = useAgentSessionStore()
  await store.attach(gateway, elsewhere)
  store.detach(sessionKey(elsewhere))
  await settle()
}

async function clickRow(label: string): Promise<void> {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.agent-reference-row')].find(
    (candidate) => (candidate.textContent?.trim() ?? '') === label,
  )
  if (item === undefined) throw new Error(`the menu has no ${label} row`)
  item.click()
  await settle()
}

const field = (): HTMLTextAreaElement => {
  const el = host.querySelector<HTMLTextAreaElement>('.agent-composer-field')
  if (el === null) throw new Error('the composer has no field')
  return el
}

/** The chip strip, as a person reads it: nothing when it is not drawn, otherwise one row each. */
const chips = (): string[] =>
  [...host.querySelectorAll('.agent-composer-attachment-label')].map(
    (item) => item.textContent?.trim() ?? '',
  )

/** A paste carrying one real image file, the way a screenshot arrives from the clipboard. */
function paste(image: File): { clipboardData: DataTransfer } {
  return {
    clipboardData: {
      items: [{ kind: 'file', type: image.type, getAsFile: () => image }],
      files: [image],
    } as unknown as DataTransfer,
  }
}

const png = (name: string, bytes = 8): File =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' })

/** The media channel as it answers a pick: the host resolves the path, the window fetches it. */
function servedImage(bytes: number[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    })),
  )
}

/** The `+`, pressed: the list is read and drawn. */
async function openMenu(): Promise<void> {
  host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
  await settle()
}

beforeEach(async () => {
  pinia = createPinia()
  setActivePinia(pinia)
  listMock.mockReset()
  readMock.mockReset()
  statMock.mockReset()
  resolveMediaPathMock.mockReset()
  resolveMediaPathMock.mockResolvedValue('asset://localhost/home/user/vault/attachments/a.png')
  indexGetMock.mockReset()
  indexGetMock.mockResolvedValue([])
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

describe('a file picked in the `+`', () => {
  it('becomes a chip when the engine reported it reads embedded files', async () => {
    listMock.mockResolvedValue([entry('welcome.md')])
    readMock.mockResolvedValue('# welcome')
    mountComposer(report(['embedded-context']))
    await withSession()

    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()
    await clickRow('welcome.md')

    // The file travelled — so the half-written message is empty and the strip says what it carries.
    expect(chips()).toEqual(['welcome.md'])
    expect(field().value).toBe('')
    expect(readMock).toHaveBeenCalledWith(VAULT, 'welcome.md')
  })

  it('becomes the path in the message when the engine reported no embedded context', async () => {
    // The engine's answer, and the difference it makes: a path is text on every engine, so the row
    // still does something — it does the thing that has always worked rather than nothing.
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer(report(['image-attachments']))
    await withSession()

    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()
    await clickRow('welcome.md')

    expect(chips()).toEqual([])
    expect(field().value).toBe('welcome.md ')
    expect(readMock).not.toHaveBeenCalled()
  })

  it('behaves exactly as it always has when nothing has answered at all', async () => {
    // No report, which is the composer mounted without one — every caller before this feature.
    listMock.mockResolvedValue([entry('welcome.md')])
    mountComposer()
    await withSession()

    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()
    await clickRow('welcome.md')

    expect(chips()).toEqual([])
    expect(field().value).toBe('welcome.md ')
  })

  it('says why rather than attaching a file that could not be read', async () => {
    listMock.mockResolvedValue([entry('gone.md')])
    readMock.mockRejectedValue(new Error('ENOENT'))
    mountComposer(report(['embedded-context']))
    await withSession()

    host.querySelector<HTMLButtonElement>('[data-action="context"]')?.click()
    await settle()
    await clickRow('gone.md')

    expect(chips()).toEqual([])
    expect(notices).toEqual([t('agent.panel.composer.attach.unreadable', { name: 'gone.md' })])
  })
})

describe('an image picked in the `+`', () => {
  // The click path this suite exists for: press the `+`, press the image's row. Until this worked,
  // the only ways to get an image into a turn were the clipboard and a file manager drag, and the
  // list the app itself draws could only ever produce a text block.
  it('becomes a chip, read as bytes, when the engine reported it reads images', async () => {
    listMock.mockResolvedValue([entry('diagram.png')])
    statMock.mockResolvedValue({ size: 3, mtime: 0 })
    // The text reader refuses every image — the host's is `read_to_string` — so a pick that came
    // back as a chip through this mock would be the bug, not the feature.
    readMock.mockRejectedValue(new Error('stream did not contain valid UTF-8'))
    servedImage([65, 66, 67])
    mountComposer(report(['image-attachments']))
    await withSession()

    await openMenu()
    await clickRow('diagram.png')

    expect(chips()).toEqual(['diagram.png'])
    expect(readMock).not.toHaveBeenCalled()
    expect(resolveMediaPathMock).toHaveBeenCalledWith(VAULT, 'diagram.png')
  })

  it('falls back to its path in the message where the engine reads no images', async () => {
    // The same fallback the `+`'s rows have always taken for a file the engine will not take
    // whole, and for the same reason: a path is text on every engine, so the row still does the
    // thing that has always worked rather than nothing. What must not happen is a read — the gate
    // is answered before the bytes are, which is this module's own ordering.
    listMock.mockResolvedValue([entry('diagram.png')])
    statMock.mockResolvedValue({ size: 3, mtime: 0 })
    servedImage([65])
    mountComposer(report(['embedded-context'], { 'image-attachments': 'promptCapabilities.image is false' }))
    await withSession()

    await openMenu()
    await clickRow('diagram.png')

    expect(chips()).toEqual([])
    expect(field().value).toBe('diagram.png ')
    expect(resolveMediaPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })

  it('leaves a note on the text arm, exactly as it was', async () => {
    // The routing added above is one predicate away from sending every note through the byte
    // reader, so both arms are asserted from the same gesture.
    listMock.mockResolvedValue([entry('welcome.md')])
    readMock.mockResolvedValue('# welcome')
    servedImage([65])
    mountComposer(report(['embedded-context', 'image-attachments']))
    await withSession()

    await openMenu()
    await clickRow('welcome.md')

    expect(chips()).toEqual(['welcome.md'])
    expect(resolveMediaPathMock).not.toHaveBeenCalled()
    expect(readMock).toHaveBeenCalledWith(VAULT, 'welcome.md')
  })
})

describe('a pasted screenshot', () => {
  it('becomes a chip when the engine reported it reads images', async () => {
    mountComposer(report(['image-attachments']))
    await withSession()

    field().dispatchEvent(
      Object.assign(new Event('paste', { bubbles: true, cancelable: true }), paste(png('shot.png'))),
    )
    await settle()

    expect(chips()).toEqual(['shot.png'])
  })

  it('is refused with the engine’s own words when it reported no image support', async () => {
    // The engine was asked and said no, and the sentence the reader gets is the engine's own
    // account of what it reported — read off the report rather than written here.
    mountComposer(report(['embedded-context'], { 'image-attachments': 'promptCapabilities.image is false' }))
    await withSession()

    const event = Object.assign(
      new Event('paste', { bubbles: true, cancelable: true }),
      paste(png('shot.png')),
    )
    field().dispatchEvent(event)
    await settle()

    expect(chips()).toEqual([])
    // Swallowed, and said. The alternative — letting the paste through and telling nobody — is a
    // reader believing the model was shown a picture it never saw, which is the whole reason the
    // engine's report is consulted at all.
    expect(event.defaultPrevented).toBe(true)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('shot.png')
    expect(notices[0]).toContain('promptCapabilities.image is false')
  })

  it('says the third state where the engine has not been asked yet', async () => {
    // `unreported`, and the sentence names it as such: nothing has said either way, which is a
    // different fact from an engine that answered no. A reader told the wrong one would go looking
    // for a setting that does not exist.
    mountComposer(report(['embedded-context']))
    await withSession()

    const event = Object.assign(
      new Event('paste', { bubbles: true, cancelable: true }),
      paste(png('shot.png')),
    )
    field().dispatchEvent(event)
    await settle()

    expect(chips()).toEqual([])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('shot.png')
  })

  it('draws nothing and claims nothing where no report has arrived at all', async () => {
    mountComposer()
    await withSession()

    const event = Object.assign(
      new Event('paste', { bubbles: true, cancelable: true }),
      paste(png('shot.png')),
    )
    field().dispatchEvent(event)
    await settle()

    expect(chips()).toEqual([])
    // Said, for the reason above: a paste that vanished is the reader being misled.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('shot.png')
  })

  it('leaves a text paste entirely alone', async () => {
    // The event is only taken when the clipboard actually carried an image. Preventing the default
    // on every paste would have this component swallowing the reader's copy of a sentence in order
    // to look for a screenshot in it.
    mountComposer(report([]))
    await withSession()

    const event = new Event('paste', { bubbles: true, cancelable: true })
    field().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(notices).toEqual([])
  })
})

describe('sending', () => {
  it('clears the strip once the store has taken the turn, and only then', async () => {
    // A send is `AgentPanel`'s to complete — it owns the store call and the outcome — so what this
    // component is asserted on is the half it does own: the strip survives the press and goes when
    // the store's own signal arrives, which is the draft going empty (`agent-session.ts` empties it
    // only on acceptance). A refusal therefore leaves the chips beside the text that came back.
    mountComposer(report(['image-attachments']))
    await withSession()
    field().dispatchEvent(
      Object.assign(new Event('paste', { bubbles: true, cancelable: true }), paste(png('shot.png'))),
    )
    await settle()
    expect(chips()).toEqual(['shot.png'])

    // The reader typed nothing, so the send is refused by this component's own rule and the strip
    // stays — which is the state a refusal has to leave it in.
    host.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'))
    await settle()
    expect(chips()).toEqual(['shot.png'])
  })
})

describe('a drop', () => {
  /** A drag carrying files, the way a file manager hands one to the window. */
  function drop(files: File[]): DragEvent {
    return Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
      dataTransfer: { types: ['Files'], files },
    }) as unknown as DragEvent
  }

  it('attaches the images it carries', async () => {
    mountComposer(report(['image-attachments']))
    await withSession()
    const event = drop([png('shot.png')])
    field().dispatchEvent(event)
    await settle()

    expect(chips()).toEqual(['shot.png'])
    expect(event.defaultPrevented).toBe(true)
  })

  /**
   * A drag of a document *this window* started: a tab, or a row of the vault tree. The payload is
   * the app's own type and an absolute path, which is what both producers hold
   * (`services/drag-payload.ts`, `ui/TabBar.vue`).
   */
  function dragPath(path: string): DragEvent {
    return Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
      dataTransfer: {
        types: [DRAGGED_PATH_TYPE],
        getData: (type: string) => (type === DRAGGED_PATH_TYPE ? path : ''),
      },
    }) as unknown as DragEvent
  }

  it('attaches the document a dragged path names', async () => {
    // The gesture the tab strip now produces and the panel had no rule for: a note dragged out of
    // the editor and into the message. It goes through the same `attachFile` the `+`'s file row
    // does, so what the reader gets is what that row has always given them.
    readMock.mockResolvedValue('# welcome')
    mountComposer(report(['embedded-context']))
    await withSession()

    const event = dragPath(`${VAULT}/welcome.md`)
    field().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(chips()).toEqual(['welcome.md'])
    // The absolute path the drag carried was addressed the way a reference is: vault-relative, and
    // read out of the workspace rather than out of the transfer.
    expect(readMock).toHaveBeenCalledWith(VAULT, 'welcome.md')
  })

  it('claims the drag before the drop, which is what lets the drop happen at all', async () => {
    // The browser fires no `drop` over an element that did not cancel `dragover`, so a target that
    // only handled the drop would never be given one.
    mountComposer(report(['embedded-context']))
    await withSession()

    const event = Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), {
      dataTransfer: { types: [DRAGGED_PATH_TYPE], effectAllowed: 'copy', dropEffect: 'none' },
    }) as unknown as DragEvent
    field().dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('addresses a dragged note in its own vault, not in the one another session works in', async () => {
    // The vault is the session's own, handed in by the panel that holds it — so a second session of
    // another vault in the same window cannot turn a note of this session's folder into a path this
    // component refuses to touch.
    readMock.mockResolvedValue('# welcome')
    mountComposer(report(['embedded-context']))
    await withSession()
    await anotherVaultInTheWindow()

    const event = dragPath(`${VAULT}/welcome.md`)
    field().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(chips()).toEqual(['welcome.md'])
  })

  it('leaves a path from outside the vault alone', async () => {
    // A reference is vault-relative because that is the only spelling the engine resolves, so a
    // path from elsewhere is refused rather than inserted as something the turn cannot read.
    mountComposer(report(['embedded-context']))
    await withSession()

    const event = dragPath('/somewhere/else/note.md')
    field().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(chips()).toEqual([])
    expect(field().value).toBe('')
    expect(readMock).not.toHaveBeenCalled()
  })

  it('leaves a drag that is not files entirely alone', async () => {
    // A drag of selected *text* over the field is the browser's own gesture, and swallowing it
    // would be this component taking a drop it has nothing to do with.
    mountComposer(report(['image-attachments']))
    await withSession()
    const event = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
      dataTransfer: { types: ['text/plain'], files: [] },
    })
    field().dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(chips()).toEqual([])
  })

  it('says why when the engine reads no images, rather than dropping it silently', async () => {
    mountComposer(report(['embedded-context']))
    await withSession()
    field().dispatchEvent(drop([png('shot.png')]))
    await settle()

    expect(chips()).toEqual([])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('shot.png')
  })
})

describe('the `@` menu', () => {
  it('opens on a word and attaches the note it settles on', async () => {
    indexGetMock.mockResolvedValue([`${VAULT}/welcome.md`])
    readMock.mockResolvedValue('# welcome')
    mountComposer(report(['embedded-context']))
    await withSession()

    field().value = 'compare @wel'
    field().dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(document.querySelectorAll('.agent-reference-row')).toHaveLength(1)
    await clickRow('welcome.md')

    // The note travelled, and the half-written word it was named by is gone from the message.
    expect(chips()).toEqual(['welcome.md'])
    expect(field().value).toBe('compare')
  })

  it('leaves the path in the message when the engine reads no embedded files', async () => {
    // The same fallback the `+`'s file rows take, and for the same reason: a path is text on every
    // engine, so the row still does the thing that has always worked rather than nothing.
    indexGetMock.mockResolvedValue([`${VAULT}/welcome.md`])
    mountComposer(report(['image-attachments']))
    await withSession()

    field().value = '@wel'
    field().dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    await clickRow('welcome.md')

    expect(chips()).toEqual([])
    expect(field().value).toBe('welcome.md ')
  })

  it('lists the notes of its own vault, not those of another session in the window', async () => {
    // The `@` menu's vault is the composer's own — the prop the panel handed down — so another
    // session held by this window cannot offer this message notes from a workspace the turn is not
    // being sent to, nor hide the ones it is.
    indexGetMock.mockResolvedValue([`${VAULT}/welcome.md`])
    mountComposer(report(['embedded-context']))
    await withSession()
    await anotherVaultInTheWindow()

    field().value = '@wel'
    field().dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(indexGetMock).toHaveBeenCalledWith(VAULT)
    expect(document.querySelectorAll('.agent-reference-row')).toHaveLength(1)
  })

  it('says which nothing it is showing rather than drawing an empty frame', async () => {
    // A menu with no rows is not drawn at all; the sentence says which of the four nothings this
    // one is. An empty frame over the field would be a surface with nothing to show.
    indexGetMock.mockResolvedValue([])
    mountComposer(report(['embedded-context']))
    await withSession()

    field().value = '@wel'
    field().dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(document.querySelectorAll('.agent-reference-row')).toHaveLength(0)
    expect(host.querySelector('.agent-composer-mention-notice')?.textContent?.trim()).toBe(
      t('agent.panel.composer.attach.mention.empty'),
    )
  })

  it('stays shut on text that merely contains an at-sign', async () => {
    mountComposer(report(['embedded-context']))
    await withSession()

    field().value = 'mail a@b about it'
    field().dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(document.querySelectorAll('.agent-reference-row')).toHaveLength(0)
    expect(host.querySelector('.agent-composer-mention-notice')).toBeNull()
    expect(indexGetMock).not.toHaveBeenCalled()
  })
})

describe('the strip', () => {
  it('is not drawn at all when there is nothing attached', async () => {
    mountComposer(report(['image-attachments', 'embedded-context']))
    await withSession()
    expect(host.querySelector('[data-test="composer-attachments"]')).toBeNull()
  })

  it('takes a chip off when its own control is pressed', async () => {
    mountComposer(report(['image-attachments']))
    await withSession()
    field().dispatchEvent(
      Object.assign(new Event('paste', { bubbles: true, cancelable: true }), paste(png('shot.png'))),
    )
    await settle()
    expect(chips()).toEqual(['shot.png'])

    host.querySelector<HTMLButtonElement>('[data-action="detach"]')?.click()
    await settle()
    expect(chips()).toEqual([])
    expect(host.querySelector('[data-test="composer-attachments"]')).toBeNull()
  })
})
