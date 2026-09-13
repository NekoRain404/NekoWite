import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => {
  const g = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!g.window) g.window = {}
  g.window.__TAURI_INTERNALS__ = {}
})

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn(() => Promise.resolve(() => {})))
const notifyErrorMock = vi.hoisted(() => vi.fn())
/** The editor the app-level service would reach for. `accept()`/`reject()` have
 *  no editor argument (the keyboard handler calls them bare), so the test has to
 *  stand in for the session manager rather than pass one in. */
const activeEditor = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('./errors', () => ({ notifyError: notifyErrorMock }))
vi.mock('../features/editor/sessionManager', () => ({
  editorSessionManager: {
    getActiveEditor: () => activeEditor.current,
    getView: () => null,
  },
}))

import {
  aiService,
  aiThinking,
  buildAIPrompt,
  getCursorPrefix,
  startChatCompletion,
  usageTotal,
  type AiTokenUsage,
} from './ai'
import { useAiPermissionStore } from '../stores/aiPermission'

interface Handlers {
  [event: string]: (e: {
    payload: { id: string; text?: string; full?: string; message?: string; usage?: unknown }
  }) => void
}

function captureListen(): { handlers: Handlers; offs: ReturnType<typeof vi.fn>[] } {
  const handlers: Handlers = {}
  const offs: ReturnType<typeof vi.fn>[] = []
  listenMock.mockImplementation(
    ((event: string, cb: never) => {
      handlers[event] = cb
      const off = vi.fn()
      offs.push(off)
      return Promise.resolve(off)
    }) as never,
  )
  return { handlers, offs }
}

/**
 * The id the service attached to its most recent `ai_complete` call. The
 * frontend now picks the request id before the request goes out (so Stop works
 * during a reasoning model's silent phase), which means a test must play events
 * under the id the service actually used instead of inventing one.
 */
function lastCompleteId(callIndex = -1): string {
  const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "ai_complete")
  const call = calls.at(callIndex)
  const id = (call?.[1] as { id?: string } | undefined)?.id
  if (typeof id !== "string" || !id) throw new Error("ai_complete was not called with an id")
  return id
}

const makeEditor = () => ({
  acceptSuggestion: vi.fn(() => 'x'),
  rejectSuggestion: vi.fn(),
  setSuggestion: vi.fn(),
  onSuggestionChange: vi.fn(() => () => {}),
})

describe('aiService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    notifyErrorMock.mockReset()
  })

  it('builds prompt from cursor prefix, ending with a continuation newline', () => {
    const prompt = buildAIPrompt('The quick ')
    expect(prompt).toContain('The quick')
    expect(prompt).not.toContain('The quick ')
    expect(prompt.endsWith('The quick\n')).toBe(true)
  })

  it('reads cursor prefix from the view', () => {
    const view = {
      state: {
        selection: { head: 9 },
        doc: {
          textBetween: vi.fn((from: number, to: number) => 'The quick'.slice(from, to)),
        },
      },
    }
    expect(getCursorPrefix(view as never)).toBe('The quick')
    expect(view.state.doc.textBetween).toHaveBeenCalledWith(Math.max(0, 9 - 200), 9, '\n', ' ')
  })

  it('calls ai_complete with config on trigger', async () => {
    const editor = {
      acceptSuggestion: vi.fn(() => 'x'),
      rejectSuggestion: vi.fn(),
      setSuggestion: vi.fn(),
      onSuggestionChange: vi.fn(() => () => {}),
    } as never
    listenMock.mockImplementation(() => Promise.resolve(() => {}))
    await aiService.triggerSuggestion(editor as never, {
      provider: 'local',
      model: 'm',
      base_url: 'http://localhost:1234/v1',
    })
    expect(invokeMock).toHaveBeenCalledWith(
      'ai_complete',
      expect.objectContaining({ config: expect.objectContaining({ provider: 'local' }) }),
    )
  })

  it('accumulates ai-chunk events into editor.setSuggestion', async () => {
    const handlers: Record<string, (e: { payload: { id: string; text: string } }) => void> = {}
    listenMock.mockImplementation(
      ((event: string, cb: never) => {
        handlers[event] = cb
        return Promise.resolve(() => {})
      }) as never,
    )
    const editor = {
      acceptSuggestion: vi.fn(() => 'x'),
      rejectSuggestion: vi.fn(),
      setSuggestion: vi.fn(),
      onSuggestionChange: vi.fn(() => () => {}),
    }
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'Hello' } })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: ' world' } })
    expect(editor.setSuggestion).toHaveBeenLastCalledWith('Hello world')
  })

  it('cancels the active stream via ai_cancel', async () => {
    const handlers: Record<string, (e: { payload: { id: string; text: string } }) => void> = {}
    listenMock.mockImplementation(
      ((event: string, cb: never) => {
        handlers[event] = cb
        return Promise.resolve(() => {})
      }) as never,
    )
    const editor = {
      acceptSuggestion: vi.fn(() => 'x'),
      rejectSuggestion: vi.fn(),
      setSuggestion: vi.fn(),
      onSuggestionChange: vi.fn(() => () => {}),
    }
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'x' } })
    // Capture the id BEFORE clearing the invoke log: it is the id the service
    // chose for the request, and cancelling must target exactly that one.
    const requestId = lastCompleteId()
    invokeMock.mockClear()
    aiService.cancelStream()
    expect(invokeMock).toHaveBeenCalledWith('ai_cancel', { id: requestId })
  })

  it("cancels a request that has not emitted anything yet", async () => {
    // A reasoning model can stay silent for seconds. Before the frontend owned
    // the request id there was nothing to cancel during that window, so Stop did
    // nothing at all and the abandoned answer later turned up under the next
    // question.
    const { handlers } = captureListen()
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: "deepseek", model: "deepseek-flash" })
    const requestId = lastCompleteId()
    expect(handlers["ai-chunk"]).toBeTypeOf("function")
    invokeMock.mockClear()
    aiService.cancelStream()
    expect(invokeMock).toHaveBeenCalledWith("ai_cancel", { id: requestId })
    // The abandoned stream must not reach the editor afterwards.
    handlers["ai-chunk"]({ payload: { id: requestId, text: "late" } })
    expect(editor.setSuggestion).not.toHaveBeenCalled()
  })

  it("ignores a cancelled request's late chunks once the next one is running", async () => {
    const editor = makeEditor()
    // The first stream is superseded by the second below; its listeners are
    // captured so this test can play its late chunk at the live stream.
    captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: "local", model: "m" })
    const cancelledId = lastCompleteId()
    const second = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: "local", model: "m" })
    const liveId = lastCompleteId()
    expect(liveId).not.toBe(cancelledId)
    // The cancelled request's answer arrives after the new request started: it
    // must not be shown as the new request's answer.
    second.handlers["ai-chunk"]({ payload: { id: cancelledId, text: "OLD ANSWER" } })
    expect(editor.setSuggestion).not.toHaveBeenCalled()
    second.handlers["ai-chunk"]({ payload: { id: liveId, text: "NEW" } })
    expect(editor.setSuggestion).toHaveBeenLastCalledWith("NEW")
  })

  it('does not clean up listeners when ai-done carries a stale id', async () => {
    const { handlers, offs } = captureListen()
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'Hello' } })
    handlers['ai-done']({ payload: { id: 'foreign-id', full: 'Hello' } })
    expect(offs.every((o) => o.mock.calls.length === 0)).toBe(true)
    handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'Hello' } })
    expect(offs.every((o) => o.mock.calls.length > 0)).toBe(true)
  })

  it('does not notify or clean up when ai-error carries a stale id', async () => {
    const { handlers, offs } = captureListen()
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'x' } })
    handlers['ai-error']({ payload: { id: 'foreign-id', message: 'boom' } })
    expect(notifyErrorMock).not.toHaveBeenCalled()
    expect(offs.every((o) => o.mock.calls.length === 0)).toBe(true)
  })

  it('notifies once when ai-error precedes the invoke rejection', async () => {
    // Only hold the COMPLETION open; every other command (ai_cancel) settles,
    // so nothing else can leave a promise dangling.
    let rejectInvoke: (e: Error) => void = () => undefined
    let completionArmed = false
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== 'ai_complete') return Promise.resolve(undefined)
      completionArmed = true
      return new Promise<void>((_resolve, reject) => { rejectInvoke = reject })
    })
    const { handlers } = captureListen()
    const editor = makeEditor()
    const pending = aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    // Wait for the request to be genuinely in flight. Counting microtask ticks
    // was fragile two ways: the listener list grows whenever an event joins the
    // protocol (ai-reasoning did), and rejecting before the completion was
    // issued left `rejectInvoke` as its no-op default — the awaited promise then
    // never settled and the failure surfaced as a bare "test timed out" with no
    // hint about the cause.
    await vi.waitFor(() => expect(completionArmed).toBe(true))
    await vi.waitFor(() => expect(handlers['ai-error']).toBeTypeOf('function'))
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'x' } })
    handlers['ai-error']({ payload: { id: lastCompleteId(), message: 'boom' } })
    expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    rejectInvoke(new Error('boom'))
    await pending
    expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    expect(notifyErrorMock).toHaveBeenCalledWith('AI 生成失败：boom')
  })

  it('notifies once when the invoke rejects without an ai-error event', async () => {
    invokeMock.mockRejectedValueOnce(new Error('raw boom'))
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    expect(notifyErrorMock).toHaveBeenCalledWith('raw boom')
  })

  it('cleans listeners on a zero-chunk (no ai-chunk) ai-done', async () => {
    const { handlers, offs } = captureListen()
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    expect(offs.every((o) => o.mock.calls.length === 0)).toBe(true)
    handlers['ai-done']({ payload: { id: lastCompleteId(), full: '' } })
    expect(offs.every((o) => o.mock.calls.length > 0)).toBe(true)
  })

  it('does not reuse listeners of a cleaned zero-chunk stream in a following trigger', async () => {
    const editor = makeEditor()
    const t1 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    t1.handlers['ai-done']({ payload: { id: lastCompleteId(0), full: '' } })
    const t2 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    t2.handlers['ai-chunk']({ payload: { id: lastCompleteId(-1), text: 'Hi' } })
    expect(editor.setSuggestion).toHaveBeenLastCalledWith('Hi')
    t1.handlers['ai-chunk']({ payload: { id: lastCompleteId(0), text: 'Stale' } })
    expect(editor.setSuggestion).toHaveBeenLastCalledWith('Hi')
  })

  it('notifies once for a zero-chunk ai-error even when the invoke later rejects', async () => {
    const { handlers } = captureListen()
    const editor = makeEditor()
    // Reject only ai_complete (the initial cancelStream may issue ai_cancel
    // depending on leaked module state, which must not eat this rejection).
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'ai_complete') throw new Error('boom')
      return undefined
    })
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    // The rejection landed first (zero-chunk, no event adoption): the catch
    // toasted once and marked the error as notified.
    expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    // A late ai-error event must not toast a second time.
    handlers['ai-error']({ payload: { id: lastCompleteId(), message: 'boom' } })
    expect(notifyErrorMock).toHaveBeenCalledTimes(1)
  })

  it('does not tear down a newer stream when a cancelled old stream done arrives', async () => {
    const editor = makeEditor()
    const t1 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    t1.handlers['ai-chunk']({ payload: { id: lastCompleteId(0), text: 'old' } })
    const t2 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    // The cancelled old stream's late done arrives at the NEW stream's done
    // handler while activeId is still null; it must not be adopted.
    t2.handlers['ai-done']({ payload: { id: lastCompleteId(0), full: 'old' } })
    expect(t2.offs.every((o) => o.mock.calls.length === 0)).toBe(true)
    t2.handlers['ai-chunk']({ payload: { id: lastCompleteId(-1), text: 'new' } })
    expect(editor.setSuggestion).toHaveBeenLastCalledWith('new')
  })
})

describe('startChatCompletion', () => {
  const cfg = { provider: 'local', model: 'm' } as const
  const noopHandlers = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }

  type Payload = { id: string; text?: string; full?: string; message?: string; usage?: unknown }

  function captureStreamListen(): {
    handlers: Record<string, (e: { payload: Payload }) => void>
    offs: ReturnType<typeof vi.fn>[]
  } {
    const handlers: Record<string, (e: { payload: Payload }) => void> = {}
    const offs: ReturnType<typeof vi.fn>[] = []
    listenMock.mockImplementation(
      ((event: string, cb: never) => {
        handlers[event] = cb
        const off = vi.fn()
        offs.push(off)
        return Promise.resolve(off)
      }) as never,
    )
    return { handlers, offs }
  }

  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it('passes images through to ai_complete', async () => {
    listenMock.mockImplementation(() => Promise.resolve(() => {}))
    const images = ['data:image/png;base64,AAA']
    await startChatCompletion({ ...cfg }, 'look', images, noopHandlers)
    const call = invokeMock.mock.calls.find((c) => c[0] === 'ai_complete')
    expect(call).toBeDefined()
    expect(call![1]).toMatchObject({ images })
  })

  it('sends empty images array when none provided', async () => {
    listenMock.mockImplementation(() => Promise.resolve(() => {}))
    await startChatCompletion({ ...cfg }, 'look', [], noopHandlers)
    const call = invokeMock.mock.calls.find((c) => c[0] === 'ai_complete')
    expect(call).toBeDefined()
    expect(call![1]).toMatchObject({ images: [] })
  })

  it('accumulates ai-chunk text into onChunk', async () => {
    const { handlers } = captureStreamListen()
    const onChunk = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onChunk })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'Hello' } })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: ' world' } })
    expect(onChunk).toHaveBeenLastCalledWith('Hello world')
  })

  it('calls onDone with the accumulated full text', async () => {
    const { handlers } = captureStreamListen()
    const onDone = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(-1), text: 'Hi' } })
    handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'Hello world' } })
    expect(onDone).toHaveBeenCalledWith('Hello world', null)
  })

  it('calls onError when ai-error fires for the active stream', async () => {
    const { handlers } = captureStreamListen()
    const onError = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onError })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(-1), text: 'Hi' } })
    handlers['ai-error']({ payload: { id: lastCompleteId(), message: 'boom' } })
    expect(onError).toHaveBeenCalledWith('boom')
  })

  it('calls onError when ai_complete rejects without an ai-error event', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'))
    listenMock.mockImplementation(() => Promise.resolve(() => {}))
    const onError = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onError })
    expect(onError).toHaveBeenCalledWith('boom')
  })

  it('cancel() calls ai_cancel for the adopted stream', async () => {
    const { handlers } = captureStreamListen()
    const stream = await startChatCompletion({ ...cfg }, 'look', [], noopHandlers)
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'x' } })
    const requestId = lastCompleteId()
    invokeMock.mockClear()
    stream.cancel()
    expect(invokeMock).toHaveBeenCalledWith('ai_cancel', { id: requestId })
  })

  it("cancel() targets the request id chosen before any event arrived", async () => {
    const { handlers } = captureStreamListen()
    const onChunk = vi.fn()
    const stream = await startChatCompletion({ ...cfg }, "look", [], { ...noopHandlers, onChunk })
    const requestId = lastCompleteId()
    invokeMock.mockClear()
    stream.cancel()
    expect(invokeMock).toHaveBeenCalledWith("ai_cancel", { id: requestId })
    handlers["ai-chunk"]({ payload: { id: requestId, text: "late" } })
    expect(onChunk).not.toHaveBeenCalled()
  })

  it('cancel() on a superseded stream does not cancel the newer stream', async () => {
    listenMock.mockImplementation(() => Promise.resolve(() => {}))
    const s1 = await startChatCompletion({ ...cfg }, 'a', [], noopHandlers)
    await startChatCompletion({ ...cfg }, 'b', [], noopHandlers)
    invokeMock.mockClear()
    s1.cancel()
    expect(invokeMock).not.toHaveBeenCalledWith('ai_cancel', expect.anything())
  })

  it('calls onDone once and cleans listeners for a zero-chunk completion', async () => {
    const { handlers, offs } = captureStreamListen()
    const onDone = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
    handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'final text' } })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('final text', null)
    expect(offs.every((o) => o.mock.calls.length > 0)).toBe(true)
  })

  it('calls onError once when the invoke rejection precedes the ai-error event', async () => {
    const { handlers } = captureStreamListen()
    const onError = vi.fn()
    // Reject only ai_complete so a leaked ai_cancel in cancelStream cannot
    // steal the rejection, keeping this test order-independent.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'ai_complete') throw new Error('boom')
      return undefined
    })
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onError })
    expect(onError).toHaveBeenCalledTimes(1)
    // A late ai-error event (already-marked) must not double-call onError.
    handlers['ai-error']({ payload: { id: lastCompleteId(), message: 'boom' } })
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('does not call onDone when a cancelled stream finally delivers ai-done', async () => {
    const { handlers } = captureStreamListen()
    const onDone = vi.fn()
    const stream = await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'x' } })
    stream.cancel()
    handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'x' } })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('does not adopt a zero-chunk done from a superseded stream', async () => {
    const s1 = captureStreamListen()
    const onDone1 = vi.fn()
    await startChatCompletion({ ...cfg }, 'a', [], { ...noopHandlers, onDone: onDone1 })
    const s2 = captureStreamListen()
    const onDone2 = vi.fn()
    await startChatCompletion({ ...cfg }, 'b', [], { ...noopHandlers, onDone: onDone2 })
    // First (superseded) stream's zero-chunk done arrives late.
    s1.handlers['ai-done']({ payload: { id: lastCompleteId(0), full: 'a' } })
    expect(onDone1).not.toHaveBeenCalled()
    // The newer stream still finalizes normally.
    s2.handlers['ai-done']({ payload: { id: lastCompleteId(-1), full: 'b' } })
    expect(onDone2).toHaveBeenCalledWith('b', null)
  })

  it('passes the provider token usage to onDone', async () => {
    const { handlers } = captureStreamListen()
    const onDone = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
    handlers['ai-done']({
      payload: {
        id: lastCompleteId(),
        full: 'Answer',
        usage: { prompt_tokens: 40, completion_tokens: 17 },
      },
    })
    // Anthropic reports no total, so it stays null instead of being invented
    // here; a caller that wants one adds the parts up with usageTotal.
    expect(onDone).toHaveBeenCalledWith('Answer', {
      promptTokens: 40,
      completionTokens: 17,
      totalTokens: null,
    })
  })

  it('reports null usage when the stream never reported any', async () => {
    const { handlers } = captureStreamListen()
    const onDone = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
    handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'Answer' } })
    // A provider that omits usage must not produce counts: "unknown" has to
    // survive to the caller as null, not as 0.
    expect(onDone).toHaveBeenCalledWith('Answer', null)
  })

  it('ignores malformed usage instead of turning it into counts', async () => {
    for (const usage of [
      'lots',
      { prompt_tokens: '12' },
      { completion_tokens: -3 },
      { total_tokens: Number.NaN },
      { total_tokens: { total: 5 } },
      {},
      null,
    ]) {
      const { handlers } = captureStreamListen()
      const onDone = vi.fn()
      await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
      handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'Answer', usage } })
      expect(onDone).toHaveBeenCalledWith('Answer', null)
    }
  })
})

describe('usageTotal', () => {
  const usage = (
    promptTokens: number | null,
    completionTokens: number | null,
    totalTokens: number | null,
  ): AiTokenUsage => ({ promptTokens, completionTokens, totalTokens })

  it('prefers the provider total, falls back to the reported parts, else null', () => {
    // Gemini / OpenAI-compatible: the endpoint sent the total itself.
    expect(usageTotal(usage(40, 17, 57))).toBe(57)
    // Anthropic: input/output only.
    expect(usageTotal(usage(40, 17, null))).toBe(57)
    expect(usageTotal(usage(40, null, null))).toBe(40)
    // Nothing reported is not "0 tokens".
    expect(usageTotal(usage(null, null, null))).toBeNull()
    expect(usageTotal(null)).toBeNull()
    expect(usageTotal(undefined)).toBeNull()
  })
})


describe('reasoning progress', () => {
  beforeEach(() => {
    aiThinking.value = false
  })

  it('flags thinking while a reasoning model streams, and keeps it out of the suggestion', async () => {
    // Measured against the tokenflux `deepseek-flash` endpoint: 27 reasoning
    // deltas (with `content: null`) arrive before the first answer delta. The
    // monologue must never be shown as ghost text — it would be typed into the
    // document — but the UI has to say something, or the editor looks frozen.
    let resolveInvoke: () => void = () => undefined
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'ai_complete' ? new Promise<void>((resolve) => { resolveInvoke = resolve }) : Promise.resolve(undefined),
    )
    const { handlers } = captureListen()
    const editor = makeEditor()
    const pending = aiService.triggerSuggestion(editor as never, { provider: 'deepseek', model: 'deepseek-flash' })
    await vi.waitFor(() => expect(handlers['ai-reasoning']).toBeTypeOf('function'))

    handlers['ai-reasoning']({ payload: { id: lastCompleteId(), text: 'We need' } })
    expect(aiThinking.value).toBe(true)
    expect(editor.setSuggestion).not.toHaveBeenCalled()

    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'Hello' } })
    expect(aiThinking.value).toBe(false)
    expect(editor.setSuggestion).toHaveBeenCalledWith('Hello')

    handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'Hello' } })
    expect(aiThinking.value).toBe(false)
    resolveInvoke()
    await pending
  })

  it('clears the thinking flag when the request fails', async () => {
    let rejectInvoke: (e: Error) => void = () => undefined
    let armed = false
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== 'ai_complete') return Promise.resolve(undefined)
      armed = true
      return new Promise<void>((_r, reject) => { rejectInvoke = reject })
    })
    const { handlers } = captureListen()
    const editor = makeEditor()
    const pending = aiService.triggerSuggestion(editor as never, { provider: 'deepseek', model: 'deepseek-flash' })
    await vi.waitFor(() => expect(armed).toBe(true))
    await vi.waitFor(() => expect(handlers['ai-error']).toBeTypeOf('function'))

    handlers['ai-reasoning']({ payload: { id: lastCompleteId(), text: 'hmm' } })
    expect(aiThinking.value).toBe(true)
    handlers['ai-error']({ payload: { id: lastCompleteId(), message: 'boom' } })
    expect(aiThinking.value).toBe(false)

    rejectInvoke(new Error('boom'))
    await pending
  })

  it('routes reasoning to the chat handler without adding it to the answer', async () => {
    // The completion settles; the listeners stay registered until a terminal
    // event arrives, which is what the chat relies on.
    invokeMock.mockResolvedValue(undefined)
    const { handlers } = captureListen()
    const onChunk = vi.fn()
    const onDone = vi.fn()
    const onReasoning = vi.fn()
    const stream = await startChatCompletion(
      { provider: 'deepseek', model: 'deepseek-flash' },
      'hi',
      [],
      { onChunk, onDone, onError: vi.fn(), onReasoning },
    )
    await vi.waitFor(() => expect(handlers['ai-reasoning']).toBeTypeOf('function'))

    handlers['ai-reasoning']({ payload: { id: lastCompleteId(), text: 'thinking' } })
    expect(onReasoning).toHaveBeenCalledWith('thinking')
    expect(onChunk).not.toHaveBeenCalled()

    handlers['ai-chunk']({ payload: { id: lastCompleteId(), text: 'Answer' } })
    expect(onChunk).toHaveBeenCalledWith('Answer')
    expect(onDone).not.toHaveBeenCalled()

    handlers['ai-done']({ payload: { id: lastCompleteId(), full: 'Answer' } })
    expect(onDone).toHaveBeenCalledWith('Answer', null)
    stream.cancel()
  })
})


/**
 * The user's AI permission settings gate the two features that reach a provider,
 * not only the writes. These run with a live pinia (the earlier tests in this
 * file deliberately run without one, which is the "cannot tell, so keep
 * working" path).
 */
describe('AI permission settings stop the requests themselves', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    notifyErrorMock.mockReset()
    listenMock.mockImplementation(() => Promise.resolve(() => {}))
  })

  const completeCalls = (): unknown[] =>
    invokeMock.mock.calls.filter(([cmd]) => cmd === 'ai_complete')

  afterEach(() => {
    activeEditor.current = null
  })

  it('sends nothing for a suggestion while AI is switched off', async () => {
    useAiPermissionStore().setEnabled(false)
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    expect(completeCalls()).toHaveLength(0)
    expect(editor.setSuggestion).not.toHaveBeenCalled()
    expect(notifyErrorMock).toHaveBeenCalled()
  })

  it('does not fetch a suggestion the policy would forbid writing', async () => {
    // The suggestion exists only to be accepted into the document, and asking
    // for one ships the text around the cursor to the provider. Under "never
    // write" there is nothing to offer, so the request is not made at all.
    useAiPermissionStore().setPolicy('readonly')
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    expect(completeCalls()).toHaveLength(0)
    expect(editor.setSuggestion).not.toHaveBeenCalled()
  })

  it('discards a live suggestion instead of accepting it while AI is off', () => {
    activeEditor.current = null
    // Found on a real run: a suggestion fetched while AI was on could still be
    // accepted by the next Tab after the switch was turned off, and the autosave
    // put the text on disk. Accepting inserts text, so it obeys the same gate.
    const permissions = useAiPermissionStore()
    const editor = makeEditor()
    editor.acceptSuggestion.mockClear()
    activeEditor.current = editor
    permissions.setEnabled(false)

    aiService.accept()
    expect(editor.acceptSuggestion).not.toHaveBeenCalled()
    expect(editor.rejectSuggestion).toHaveBeenCalled()
  })

  it('discards a live suggestion instead of accepting it under "never write"', () => {
    const permissions = useAiPermissionStore()
    const editor = makeEditor()
    editor.acceptSuggestion.mockClear()
    activeEditor.current = editor
    permissions.setPolicy('readonly')

    aiService.accept()
    expect(editor.acceptSuggestion).not.toHaveBeenCalled()
    expect(editor.rejectSuggestion).toHaveBeenCalled()
  })

  it('accepts the suggestion under a policy that allows writes', () => {
    const permissions = useAiPermissionStore()
    const editor = makeEditor()
    editor.acceptSuggestion.mockClear()
    editor.rejectSuggestion.mockClear()
    activeEditor.current = editor
    permissions.setPolicy('ask')

    aiService.accept()
    expect(editor.acceptSuggestion).toHaveBeenCalledTimes(1)
    expect(editor.rejectSuggestion).not.toHaveBeenCalled()
  })

  it('still runs the suggestion under the default policy', async () => {
    // The guard must not be an off switch by accident.
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    expect(completeCalls()).toHaveLength(1)
  })

  it('answers a chat-shaped request with the switch-off message, not a request', async () => {
    useAiPermissionStore().setEnabled(false)
    const onError = vi.fn()
    await startChatCompletion({ provider: 'local', model: 'm' }, 'hi', [], {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError,
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0][0])).not.toHaveLength(0)
    expect(completeCalls()).toHaveLength(0)
  })

  it('leaves the chat path alone when the switch is on', async () => {
    const onError = vi.fn()
    await startChatCompletion({ provider: 'local', model: 'm' }, 'hi', [], {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError,
    })
    expect(completeCalls()).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
  })
})
