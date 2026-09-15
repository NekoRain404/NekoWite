/**
 * Which request the chat completion's listeners belong to.
 *
 * The stream registry (`ai-stream`) is single-owner by design: every lifecycle
 * starts by cancelling what was running and bumping the generation, so at any
 * moment its listener list is the CURRENT request's and only that request may
 * sweep it. One that failed after it had already been replaced swept it anyway
 * — and the sweep took the live request's listeners with it, which is how the
 * reader's answer stopped arriving with no error and no explanation.
 *
 * These run the real module against a stand-in for the event bus that REMOVES a
 * handler when its unlisten runs: "the listeners are still attached" is the
 * only form of the claim that means anything to the reader, and a mock that
 * counts calls without detaching would pass either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const g = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!g.window) g.window = {}
  g.window.__TAURI_INTERNALS__ = {}
})

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { startChatCompletion, type ChatStreamHandlers } from './ai-chat'

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

/**
 * The event bus, with the one property that matters here: unlistening detaches,
 * and a detached listener is one an event no longer reaches.
 *
 * `holdCall(n)` makes the nth `listen` return a promise the test settles by
 * hand, so a registration can be left in flight while another request takes
 * over — the window the failure path had to survive.
 */
function createBus() {
  const handlers = new Map<string, Handler>()
  const registrations: Registration[] = []
  const held: Array<{ release: () => void; fail: (e: unknown) => void }> = []
  const heldCalls = new Set<number>()
  let calls = 0

  listenMock.mockImplementation(((event: string, cb: Handler) => {
    calls += 1
    const entry: Registration = { event, detached: false }
    const unlisten = (): void => {
      entry.detached = true
      if (handlers.get(event) === cb) handlers.delete(event)
    }
    const register = (): (() => void) => {
      handlers.set(event, cb)
      registrations.push(entry)
      return unlisten
    }
    if (heldCalls.delete(calls)) {
      return new Promise<() => void>((resolve, reject) => {
        held.push({ release: () => resolve(register()), fail: (e) => reject(e) })
      })
    }
    return Promise.resolve(register())
  }) as never)

  return {
    /** Wait until `n` registrations have actually landed. */
    registered: async (n: number): Promise<void> => {
      await vi.waitFor(() => expect(registrations.length).toBeGreaterThanOrEqual(n))
    },
    /** The listeners still attached: what the current request runs on. */
    live: (): Registration[] => registrations.filter((r) => !r.detached),
    holdCall: (n: number): void => {
      heldCalls.add(n)
    },
    held,
    emit: (event: string, payload: Payload): void => {
      handlers.get(event)?.({ payload })
    },
  }
}

/** `ai_complete` promises the test settles by hand: the renderer's call resolves
 *  when the whole stream is over, so holding one open IS an in-flight request. */
function holdCompletions(): Array<{ resolve: () => void; reject: (e: unknown) => void }> {
  const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd !== 'ai_complete') return Promise.resolve(undefined)
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
  })
  return pending
}

/** The id the renderer attached to its Nth `ai_complete` call. */
function completeId(index: number): string {
  const call = invokeMock.mock.calls.filter(([cmd]) => cmd === 'ai_complete')[index]
  const id = (call?.[1] as { id?: string } | undefined)?.id
  if (typeof id !== 'string') throw new Error('ai_complete was not called with an id')
  return id
}

function chatHandlers(): ChatStreamHandlers {
  return { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
}

/** Let every queued microtask run: the lifecycle is a chain of them. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a request that fails after it was replaced', () => {
  it('leaves the live request its listeners, and its answer', async () => {
    const bus = createBus()
    const completions = holdCompletions()
    const first = chatHandlers()
    const second = chatHandlers()

    const a = startChatCompletion({ ...cfg }, 'a', [], first)
    await bus.registered(4)

    // B is what replaced A: starting one cancels the running request and bumps
    // the generation.
    holdCompletions()
    const b = startChatCompletion({ ...cfg }, 'b', [], second)
    await bus.registered(8)
    const idB = completeId(1)

    // A fails LATE — a transport error landing after the user moved on.
    completions[0].reject(new Error('boom'))
    await settle()

    // The live request is still listening on all four events...
    expect(bus.live()).toHaveLength(4)
    // ...and its answer still arrives, which is the whole point: this is the
    // reader's live reply, not a counter.
    bus.emit('ai-chunk', { id: idB, text: 'still arriving' })
    expect(second.onChunk).toHaveBeenCalledWith('still arriving')
    bus.emit('ai-done', { id: idB, full: 'still arriving' })
    expect(second.onDone).toHaveBeenCalledWith('still arriving', null)

    // A's own caller is still told that A failed: this module cannot know
    // whether another caller still cares, and it is the caller that decides
    // what a replaced request may touch (see `use-chat-commands`). What A must
    // not do is reach into the registry, which is what the assertions above
    // hold it to.
    expect(first.onError).toHaveBeenCalledWith('boom')
    await a
    void b
  })

  it('does not sweep the live listeners when its own registration fails', async () => {
    const bus = createBus()
    const first = chatHandlers()
    const second = chatHandlers()
    // A's fourth registration — `ai-reasoning`, the last one — is held in
    // flight, so A is mid-registration when B takes over.
    bus.holdCall(4)

    const a = startChatCompletion({ ...cfg }, 'a', [], first)
    await bus.registered(3)

    holdCompletions()
    const b = startChatCompletion({ ...cfg }, 'b', [], second)
    await bus.registered(7)
    const idB = completeId(0)

    // The held registration now rejects, while B is listening.
    bus.held[0].fail(new Error('no event system'))
    await settle()

    expect(first.onError).toHaveBeenCalled()
    bus.emit('ai-chunk', { id: idB, text: 'live' })
    expect(second.onChunk).toHaveBeenCalledWith('live')
    expect(bus.live()).toHaveLength(4)
    await a
    void b
  })
})

describe('a request that fails while it is still the live one', () => {
  it('withdraws its own listeners instead of leaving them on the bus', async () => {
    // The floor under the fix: the failure path must still tear this request's
    // listeners down when it IS the current one, or the guard above would have
    // bought the live answer at the price of a leaked set of handlers.
    const bus = createBus()
    const completions = holdCompletions()
    const only = chatHandlers()

    const request = startChatCompletion({ ...cfg }, 'only', [], only)
    await bus.registered(4)
    expect(bus.live()).toHaveLength(4)

    completions[0].reject(new Error('boom'))
    await settle()

    expect(only.onError).toHaveBeenCalledWith('boom')
    expect(bus.live()).toHaveLength(0)
    await request
  })
})
