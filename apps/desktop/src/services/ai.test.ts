import { describe, expect, it, vi, beforeEach } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn(() => Promise.resolve(() => {})))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { aiService, buildAIPrompt, getCursorPrefix } from './ai'

describe('aiService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it('builds prompt from cursor prefix', () => {
    expect(buildAIPrompt('The quick').endsWith('The quick')).toBe(true)
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
})
