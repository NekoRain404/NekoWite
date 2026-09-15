/**
 * Which request the ghost writer's listeners belong to.
 *
 * The same question `ai-chat.test.ts` asks of the chat path, and the same
 * defect it found there: the stream registry is single-owner by design (every
 * trigger cancels what was running and bumps the generation), so a trigger that
 * fails after being replaced must not sweep it — the sweep takes the LIVE
 * trigger's listeners, and the suggestion the user is watching stops arriving.
 *
 * The two lifecycles share the registry, so they had to share the rule; these
 * are the tests that say the second one obeys it too. The event bus below
 * DETACHES when an unlisten runs, because that is the only form of "still
 * listening" that means anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const g = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!g.window) g.window = {}
  g.window.__TAURI_INTERNALS__ = {}
})

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
// The ghost writer reaches for the active editor when it is not handed one.
vi.mock('../../editor/session-manager', () => ({
  editorSessionManager: { getActiveEditor: () => null, getView: () => null },
}))
vi.mock('../../../services/errors', () => ({ notifyError: notifyErrorMock }))

import { aiService } from './ai-ghost'

const cfg = { provider: 'local', model: 'm' } as const

interface Payload {
  id: string
  text?: string
  full?: string
  message?: string
}

type Handler = (e: { payload: Payload }) => void

interface Registration {
  event: string
  detached: boolean
}

/** The event bus, with the one property that matters: unlistening detaches. */
function createBus() {
  const handlers = new Map<string, Handler>()
  const registrations: Registration[] = []
  listenMock.mockImplementation(((event: string, cb: Handler) => {
    const entry: Registration = { event, detached: false }
    handlers.set(event, cb)
    registrations.push(entry)
    return Promise.resolve(() => {
      entry.detached = true
      if (handlers.get(event) === cb) handlers.delete(event)
    })
  }) as never)

  return {
    registered: async (n: number): Promise<void> => {
      await vi.waitFor(() => expect(registrations.length).toBeGreaterThanOrEqual(n))
    },
    live: (): Registration[] => registrations.filter((r) => !r.detached),
    emit: (event: string, payload: Payload): void => {
      handlers.get(event)?.({ payload })
    },
  }
}

/** `ai_complete` promises the test settles by hand: an in-flight suggestion. */
function holdCompletions(): Array<{ reject: (e: unknown) => void }> {
  const pending: Array<{ reject: (e: unknown) => void }> = []
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd !== 'ai_complete') return Promise.resolve(undefined)
    return new Promise<void>((_resolve, reject) => pending.push({ reject }))
  })
  return pending
}

/** The id the service attached to its Nth `ai_complete` call. */
function completeId(index: number): string {
  const call = invokeMock.mock.calls.filter(([cmd]) => cmd === 'ai_complete')[index]
  const id = (call?.[1] as { id?: string } | undefined)?.id
  if (typeof id !== 'string') throw new Error('ai_complete was not called with an id')
  return id
}

/** The editor the suggestion is written into. `getView` returns nothing, which
 *  `readPrefix` already treats as "no prefix" (the prompt is not what these
 *  tests are about). */
function makeEditor() {
  return {
    getView: () => null,
    setSuggestion: vi.fn(),
    acceptSuggestion: vi.fn(() => 'x'),
    rejectSuggestion: vi.fn(),
    onSuggestionChange: vi.fn(() => () => {}),
  }
}

/** Let every queued microtask run: the lifecycle is a chain of them. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  notifyErrorMock.mockReset()
})

describe('a suggestion that fails after it was replaced', () => {
  it('leaves the live suggestion its listeners, and its text', async () => {
    const bus = createBus()
    const completions = holdCompletions()
    const editor = makeEditor()

    void aiService.triggerSuggestion(editor as never, { ...cfg })
    await bus.registered(4)

    // A second trigger is what replaces the first: it cancels the running
    // request and takes the registry.
    holdCompletions()
    void aiService.triggerSuggestion(editor as never, { ...cfg })
    await bus.registered(8)
    const idB = completeId(1)

    // The replaced one fails LATE - a transport error landing after the user
    // kept typing and the next suggestion was already on its way.
    completions[0].reject(new Error('boom'))
    await settle()

    // The live suggestion is still listening on all four events...
    expect(bus.live()).toHaveLength(4)
    // ...and it still reaches the editor, which is the whole point: this is the
    // text the user is watching appear.
    bus.emit('ai-chunk', { id: idB, text: 'still writing' })
    expect(editor.setSuggestion).toHaveBeenCalledWith('still writing')
    // The failure is still reported: it is the caller that decides what a
    // replaced request may touch (see `ai-chat`), not the registry.
    expect(notifyErrorMock).toHaveBeenCalled()
  })
})

describe('a suggestion that fails while it is still the live one', () => {
  it('withdraws its own listeners instead of leaving them on the bus', async () => {
    // The floor under the rule: the failure path must still tear this request's
    // listeners down when it IS the current one.
    const bus = createBus()
    const completions = holdCompletions()
    const editor = makeEditor()

    void aiService.triggerSuggestion(editor as never, { ...cfg })
    await bus.registered(4)
    expect(bus.live()).toHaveLength(4)

    completions[0].reject(new Error('boom'))
    await settle()

    expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    expect(bus.live()).toHaveLength(0)
  })
})
