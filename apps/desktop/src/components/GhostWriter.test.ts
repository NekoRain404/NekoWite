import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App } from 'vue'

const triggerMock = vi.hoisted(() => vi.fn())
const acceptMock = vi.hoisted(() => vi.fn())
const rejectMock = vi.hoisted(() => vi.fn())
const getEditorMock = vi.hoisted(() => vi.fn())
const getViewMock = vi.hoisted(() => vi.fn())

vi.mock('../services/ai', () => ({
  aiService: {
    triggerSuggestion: triggerMock,
    accept: acceptMock,
    reject: rejectMock,
  },
}))
vi.mock('../features/editor/sessionManager', () => ({
  editorSessionManager: { getActiveEditor: getEditorMock, getView: getViewMock },
}))

import GhostWriter from './GhostWriter.vue'

function setupEditor(hasSuggestion: boolean, focused: boolean): HTMLElement {
  const editorDom = document.createElement('div')
  editorDom.setAttribute('tabindex', '-1')
  document.body.appendChild(editorDom)
  if (focused) editorDom.focus()
  getEditorMock.mockReturnValue({ hasSuggestion: () => hasSuggestion })
  getViewMock.mockReturnValue({ dom: editorDom })
  return editorDom
}

let mounted: App[] = []

function mountGhost(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(GhostWriter)
  app.mount(host)
  mounted.push(app)
}

function sendKey(key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, cancelable: true })
  document.dispatchEvent(ev)
  return ev
}

function sendKeyInit(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { cancelable: true, ...init })
  document.dispatchEvent(ev)
  return ev
}

describe('GhostWriter keydown wiring (C1)', () => {
  beforeEach(() => {
    triggerMock.mockReset()
    acceptMock.mockReset()
    rejectMock.mockReset()
    getEditorMock.mockReset()
    getViewMock.mockReset()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('triggers a suggestion on first Tab when no suggestion is active', () => {
    setupEditor(false, true)
    mountGhost()
    const ev = sendKey('Tab')
    expect(triggerMock).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
    expect(acceptMock).not.toHaveBeenCalled()
  })

  it('accepts on Tab when a suggestion is active (second Tab)', () => {
    setupEditor(true, true)
    mountGhost()
    const ev = sendKey('Tab')
    expect(acceptMock).toHaveBeenCalledTimes(1)
    expect(triggerMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
  })

  it('rejects on Escape when a suggestion is active', () => {
    setupEditor(true, true)
    mountGhost()
    const ev = sendKey('Escape')
    expect(rejectMock).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('does nothing when focus is outside the editor (M9)', () => {
    setupEditor(true, false)
    mountGhost()
    const ev = sendKey('Tab')
    expect(acceptMock).not.toHaveBeenCalled()
    expect(triggerMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does not reject on Escape with no suggestion', () => {
    setupEditor(false, true)
    mountGhost()
    const ev = sendKey('Escape')
    expect(rejectMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('ignores Tab while an IME is composing (isComposing)', () => {
    setupEditor(true, true)
    mountGhost()
    const ev = sendKeyInit({ key: 'Tab', isComposing: true })
    expect(triggerMock).not.toHaveBeenCalled()
    expect(acceptMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('ignores Escape while an IME is composing (legacy keyCode 229)', () => {
    setupEditor(true, true)
    mountGhost()
    const ev = sendKeyInit({ key: 'Escape', keyCode: 229 })
    expect(rejectMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('ignores Tab when the IME reports key="Process"', () => {
    setupEditor(true, true)
    mountGhost()
    const ev = sendKeyInit({ key: 'Process' })
    expect(triggerMock).not.toHaveBeenCalled()
    expect(acceptMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })
})
