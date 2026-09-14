import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App } from 'vue'

const triggerMock = vi.hoisted(() => vi.fn())
const acceptMock = vi.hoisted(() => vi.fn())
const rejectMock = vi.hoisted(() => vi.fn())
const getEditorMock = vi.hoisted(() => vi.fn())
const getViewMock = vi.hoisted(() => vi.fn())
const settingsMock = vi.hoisted(() => vi.fn())

vi.mock('../services/ai', () => ({
  aiService: {
    triggerSuggestion: triggerMock,
    accept: acceptMock,
    reject: rejectMock,
  },
}))
vi.mock('../features/editor/session-manager', () => ({
  editorSessionManager: { getActiveEditor: getEditorMock, getView: getViewMock },
}))
vi.mock('../stores/settings', () => ({ useSettingsStore: settingsMock }))

import GhostWriter from './GhostWriter.vue'

/** Minimal stand-in for the settings store: GhostWriter only asks whether the
 *  AI is configured before it fires a completion request. */
function setAiConfig(provider: string, baseUrl = 'http://localhost:1234/v1', apiKey = ''): void {
  settingsMock.mockReturnValue({ provider, baseUrl, apiKey })
}

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
  // happy-dom's KeyboardEvent constructor drops the `isComposing` init option,
  // so stamp the (read-only) property to simulate a real IME event.
  if (init.isComposing) {
    Object.defineProperty(ev, 'isComposing', { value: true, configurable: true })
  }
  document.dispatchEvent(ev)
  return ev
}

describe('GhostWriter keydown wiring', () => {
  beforeEach(() => {
    triggerMock.mockReset()
    acceptMock.mockReset()
    rejectMock.mockReset()
    getEditorMock.mockReset()
    getViewMock.mockReset()
    settingsMock.mockReset()
    setAiConfig('local')
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
    expect(ev.defaultPrevented).toBe(false)
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

  it('rejects on Escape even when the editor already consumed the key', () => {
    // Measured on the packaged build: a native Escape never reached the
    // bubble-phase handler, because ProseMirror's own keymap binds Escape and
    // calls preventDefault first. Escape therefore has to be handled in the
    // capture phase, or the documented "Escape discards the suggestion" is dead
    // code and ghost text can only be escaped by typing over it.
    setupEditor(true, true)
    mountGhost()
    // Stand in for the editor keymap: claims the key on the way down.
    const claim = (e: KeyboardEvent): void => e.preventDefault()
    document.addEventListener('keydown', claim, true)
    const ev = sendKey('Escape')
    try {
      expect(rejectMock).toHaveBeenCalledTimes(1)
      expect(ev.defaultPrevented).toBe(true)
    } finally {
      document.removeEventListener('keydown', claim, true)
    }
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
  it('does not re-handle a Tab that ProseMirror already consumed (table cell move)', () => {
    // Inside a table ProseMirror handles Tab itself (next cell / insert row)
    // and calls preventDefault. This handler sits on document, in the bubble
    // phase, so without a defaultPrevented check the table both moved the
    // cursor and fired an AI completion from the same keypress.
    setupEditor(false, true)
    mountGhost()
    // Stand in for ProseMirror: it handles Tab while the event is still on its
    // way down to the editor, i.e. in the capture phase, which is why its
    // preventDefault is visible to the app-wide bubble listener.
    const claim = (e: KeyboardEvent): void => e.preventDefault()
    document.addEventListener('keydown', claim, true)
    try {
      sendKey('Tab')
    } finally {
      document.removeEventListener('keydown', claim, true)
    }
    expect(triggerMock).not.toHaveBeenCalled()
    expect(acceptMock).not.toHaveBeenCalled()
  })

  it('leaves Tab alone when no suggestion is pending, so focus can leave the editor', () => {
    // A keyboard-only user must be able to Tab out of the editor into the
    // toolbar/tab bar. Swallowing every Tab trapped them in the document.
    setupEditor(false, true)
    mountGhost()
    const ev = sendKey('Tab')
    expect(triggerMock).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('stays silent on Tab when the AI is not configured', () => {
    // Pressing Tab used to fire a request that failed with a toast even though
    // the user never asked for AI; a fresh install showed "AI generation
    // failed" on every Tab press.
    setAiConfig('openai')
    setupEditor(false, true)
    mountGhost()
    const ev = sendKey('Tab')
    expect(triggerMock).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })
})
