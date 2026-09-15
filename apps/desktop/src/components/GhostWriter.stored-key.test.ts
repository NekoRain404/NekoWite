import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const triggerMock = vi.hoisted(() => vi.fn())
const acceptMock = vi.hoisted(() => vi.fn())
const rejectMock = vi.hoisted(() => vi.fn())
const getEditorMock = vi.hoisted(() => vi.fn())
const getViewMock = vi.hoisted(() => vi.fn())
const loadAiKeyMock = vi.hoisted(() => vi.fn())
const storeAiKeyMock = vi.hoisted(() => vi.fn())

vi.mock('../features/ai', () => ({
  aiService: {
    triggerSuggestion: triggerMock,
    accept: acceptMock,
    reject: rejectMock,
  },
}))
vi.mock('../features/editor/session-manager', () => ({
  editorSessionManager: { getActiveEditor: getEditorMock, getView: getViewMock },
}))
vi.mock('../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    keys: { loadAiKey: loadAiKeyMock, storeAiKey: storeAiKeyMock },
    ai: { listModels: vi.fn(async (): Promise<string[]> => []) },
  }),
}))

// Deliberately NOT mocked: `../stores/settings`. The defect was in what the
// store hands this path, so a stub of it would be the very thing under test.
import { useSettingsStore } from '../stores/settings'
import GhostWriter from './GhostWriter.vue'

/**
 * The Tab shortcut against a real settings store, a real `loadKey()` and the
 * real `isAiConfigured`.
 *
 * A hosted provider, a key in the vault, and a launch (or a provider switch):
 * `loadKey()` answers with the mask, the store empties the field so the mask
 * can never be sent back as a credential, and the shortcut used to read "is a
 * key stored" off that now-empty field — so it went quiet for every configured
 * install, with no suggestion, no toast and nothing to explain the silence.
 *
 * The only provider call in here is stubbed (`aiService.triggerSuggestion`);
 * nothing below reaches the network, and nothing may.
 */

/** The frontend's copy of the Rust constant (`key_store::AI_KEY_MASKED`). */
const MASK = '••••••••'

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

describe('GhostWriter: the shortcut against a stored key', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    triggerMock.mockReset()
    acceptMock.mockReset()
    rejectMock.mockReset()
    getEditorMock.mockReset()
    getViewMock.mockReset()
    loadAiKeyMock.mockReset()
    storeAiKeyMock.mockReset()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('arms Tab on a key that is in the vault and not in the field', async () => {
    // Yesterday's session: the provider was chosen and the key saved. Both of
    // those survive a restart; nothing else does.
    localStorage.setItem('nekowite.ai.provider', 'openai')
    loadAiKeyMock.mockImplementation(async (): Promise<string | null> => MASK)
    const settings = useSettingsStore()

    await settings.loadKey() // what app-bootstrap.ts does at launch

    expect(settings.apiKey).toBe('')
    setupEditor(false, true)
    mountGhost()
    sendKey('Tab')
    // The suggestion is what the user came for; pressing Tab on a configured
    // install used to do nothing at all.
    expect(triggerMock).toHaveBeenCalledTimes(1)
  })

  it('stays silent on Tab when no key is stored and none is typed', async () => {
    localStorage.setItem('nekowite.ai.provider', 'openai')
    loadAiKeyMock.mockImplementation(async (): Promise<string | null> => null)
    const settings = useSettingsStore()

    await settings.loadKey()

    setupEditor(false, true)
    mountGhost()
    sendKey('Tab')
    expect(triggerMock).not.toHaveBeenCalled()
  })
})
