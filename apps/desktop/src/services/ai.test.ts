import { describe, expect, it, vi, beforeEach } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn(() => Promise.resolve(() => {})))
const notifyErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('./errors', () => ({ notifyError: notifyErrorMock }))

import { aiService, buildAIPrompt, getCursorPrefix } from './ai'

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
})
