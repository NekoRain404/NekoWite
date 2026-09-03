import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  const g = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!g.window) g.window = {}
  g.window.__TAURI_INTERNALS__ = {}
})

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn(() => Promise.resolve(() => {})))
const notifyErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('./errors', () => ({ notifyError: notifyErrorMock }))

import { aiService, buildAIPrompt, getCursorPrefix, startChatCompletion } from './ai'

interface Handlers {
  [event: string]: (e: { payload: { id: string; text?: string; full?: string; message?: string } }) => void
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
    handlers['ai-chunk']({ payload: { id: 'ai-1', text: 'Hello' } })
    handlers['ai-chunk']({ payload: { id: 'ai-1', text: ' world' } })
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
    handlers['ai-chunk']({ payload: { id: 'ai-2', text: 'x' } })
    invokeMock.mockClear()
    aiService.cancelStream()
    expect(invokeMock).toHaveBeenCalledWith('ai_cancel', { id: 'ai-2' })
  })

  it('does not clean up listeners when ai-done carries a stale id', async () => {
    const { handlers, offs } = captureListen()
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    handlers['ai-chunk']({ payload: { id: 'ai-6', text: 'Hello' } })
    handlers['ai-done']({ payload: { id: 'ai-61', full: 'Hello' } })
    expect(offs.every((o) => o.mock.calls.length === 0)).toBe(true)
    handlers['ai-done']({ payload: { id: 'ai-6', full: 'Hello' } })
    expect(offs.every((o) => o.mock.calls.length > 0)).toBe(true)
  })

  it('does not notify or clean up when ai-error carries a stale id', async () => {
    const { handlers, offs } = captureListen()
    const editor = makeEditor()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    handlers['ai-chunk']({ payload: { id: 'ai-7', text: 'x' } })
    handlers['ai-error']({ payload: { id: 'ai-71', message: 'boom' } })
    expect(notifyErrorMock).not.toHaveBeenCalled()
    expect(offs.every((o) => o.mock.calls.length === 0)).toBe(true)
  })

  it('notifies once when ai-error precedes the invoke rejection', async () => {
    let rejectInvoke: (e: Error) => void = () => undefined
    invokeMock.mockImplementation(
      () => new Promise<void>((_resolve, reject) => { rejectInvoke = reject }),
    )
    const { handlers } = captureListen()
    const editor = makeEditor()
    const pending = aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    handlers['ai-chunk']({ payload: { id: 'ai-8', text: 'x' } })
    handlers['ai-error']({ payload: { id: 'ai-8', message: 'boom' } })
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
    handlers['ai-done']({ payload: { id: 'ai-z3', full: '' } })
    expect(offs.every((o) => o.mock.calls.length > 0)).toBe(true)
  })

  it('does not reuse listeners of a cleaned zero-chunk stream in a following trigger', async () => {
    const editor = makeEditor()
    const t1 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    t1.handlers['ai-done']({ payload: { id: 'a-1', full: '' } })
    const t2 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    t2.handlers['ai-chunk']({ payload: { id: 'a-2', text: 'Hi' } })
    expect(editor.setSuggestion).toHaveBeenLastCalledWith('Hi')
    t1.handlers['ai-chunk']({ payload: { id: 'a-1', text: 'Stale' } })
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
    handlers['ai-error']({ payload: { id: 'ai-z4', message: 'boom' } })
    expect(notifyErrorMock).toHaveBeenCalledTimes(1)
  })

  it('does not tear down a newer stream when a cancelled old stream done arrives', async () => {
    const editor = makeEditor()
    const t1 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    t1.handlers['ai-chunk']({ payload: { id: 'a-1', text: 'old' } })
    const t2 = captureListen()
    await aiService.triggerSuggestion(editor as never, { provider: 'local', model: 'm' })
    // The cancelled old stream's late done arrives at the NEW stream's done
    // handler while activeId is still null; it must not be adopted.
    t2.handlers['ai-done']({ payload: { id: 'a-1', full: 'old' } })
    expect(t2.offs.every((o) => o.mock.calls.length === 0)).toBe(true)
    t2.handlers['ai-chunk']({ payload: { id: 'a-2', text: 'new' } })
    expect(editor.setSuggestion).toHaveBeenLastCalledWith('new')
  })
})

describe('startChatCompletion', () => {
  const cfg = { provider: 'local', model: 'm' } as const
  const noopHandlers = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }

  type Payload = { id: string; text?: string; full?: string; message?: string }

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
    handlers['ai-chunk']({ payload: { id: 'ai-1', text: 'Hello' } })
    handlers['ai-chunk']({ payload: { id: 'ai-1', text: ' world' } })
    expect(onChunk).toHaveBeenLastCalledWith('Hello world')
  })

  it('calls onDone with the accumulated full text', async () => {
    const { handlers } = captureStreamListen()
    const onDone = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
    handlers['ai-chunk']({ payload: { id: 'ai-2', text: 'Hi' } })
    handlers['ai-done']({ payload: { id: 'ai-2', full: 'Hello world' } })
    expect(onDone).toHaveBeenCalledWith('Hello world')
  })

  it('calls onError when ai-error fires for the active stream', async () => {
    const { handlers } = captureStreamListen()
    const onError = vi.fn()
    await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onError })
    handlers['ai-chunk']({ payload: { id: 'ai-3', text: 'Hi' } })
    handlers['ai-error']({ payload: { id: 'ai-3', message: 'boom' } })
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
    handlers['ai-chunk']({ payload: { id: 'ai-4', text: 'x' } })
    invokeMock.mockClear()
    stream.cancel()
    expect(invokeMock).toHaveBeenCalledWith('ai_cancel', { id: 'ai-4' })
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
    handlers['ai-done']({ payload: { id: 'ai-z1', full: 'final text' } })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('final text')
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
    handlers['ai-error']({ payload: { id: 'ai-z2', message: 'boom' } })
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('does not call onDone when a cancelled stream finally delivers ai-done', async () => {
    const { handlers } = captureStreamListen()
    const onDone = vi.fn()
    const stream = await startChatCompletion({ ...cfg }, 'look', [], { ...noopHandlers, onDone })
    handlers['ai-chunk']({ payload: { id: 'c-1', text: 'x' } })
    stream.cancel()
    handlers['ai-done']({ payload: { id: 'c-1', full: 'x' } })
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
    s1.handlers['ai-done']({ payload: { id: 's-1', full: 'a' } })
    expect(onDone1).not.toHaveBeenCalled()
    // The newer stream still finalizes normally.
    s2.handlers['ai-done']({ payload: { id: 's-2', full: 'b' } })
    expect(onDone2).toHaveBeenCalledWith('b')
  })
})
