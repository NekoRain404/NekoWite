import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.hoisted(() => {
  const g = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!g.window) g.window = {}
  g.window.__TAURI_INTERNALS__ = {}
})

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { useSettingsStore } from './settings'

function clearLs(): void {
  localStorage.removeItem('nekowite.ai.provider')
  localStorage.removeItem('nekowite.ai.model')
  localStorage.removeItem('nekowite.ai.baseUrl')
  localStorage.removeItem('nekowite.ai.temperature')
  localStorage.removeItem('nekowite.ai.maxTokens')
  localStorage.removeItem('nekowite.ai.systemPrompt')
  localStorage.removeItem('nekowite.ai.systemPromptOn')
  localStorage.removeItem('nekowite.settings.autosaveInterval')
  localStorage.removeItem('nekowite.settings.maxHistory')
  localStorage.removeItem('nekowite.settings.exportFrontmatter')
  localStorage.removeItem('nekowite.settings.exportPageSize')
  localStorage.removeItem('nekowite.settings.exportOrientation')
}

describe('useSettingsStore', () => {
  beforeEach(() => {
    clearLs()
    invokeMock.mockReset()
    setActivePinia(createPinia())
  })

  it('defaults to local/qwen2.5-coder:3b', () => {
    const s = useSettingsStore()
    expect(s.provider).toBe('local')
    expect(s.model).toBe('qwen2.5-coder:3b')
    expect(s.baseUrl).toBe('http://localhost:1234/v1')
  })

  it('reads persisted provider/model/baseUrl from localStorage', () => {
    localStorage.setItem('nekowite.ai.provider', 'anthropic')
    localStorage.setItem('nekowite.ai.model', 'claude-sonnet-4-5')
    localStorage.setItem('nekowite.ai.baseUrl', 'https://api.anthropic.com')
    const s = useSettingsStore()
    expect(s.provider).toBe('anthropic')
    expect(s.model).toBe('claude-sonnet-4-5')
    expect(s.baseUrl).toBe('https://api.anthropic.com')
  })

  it('persists provider/model/baseUrl changes to localStorage (I5)', async () => {
    const s = useSettingsStore()
    s.provider = 'gemini'
    s.model = 'gemini-2.5-pro'
    s.baseUrl = 'https://generativelanguage.googleapis.com'
    await nextTick()
    expect(localStorage.getItem('nekowite.ai.provider')).toBe('gemini')
    expect(localStorage.getItem('nekowite.ai.model')).toBe('gemini-2.5-pro')
    expect(localStorage.getItem('nekowite.ai.baseUrl')).toBe('https://generativelanguage.googleapis.com')
  })

  it('reloads the key for the new provider on provider change (I5)', async () => {
    invokeMock.mockResolvedValue('sk-gemini')
    const s = useSettingsStore()
    expect(invokeMock).not.toHaveBeenCalled()
    s.provider = 'gemini'
    await nextTick()
    await nextTick()
    expect(invokeMock).toHaveBeenCalledWith('load_ai_key', { provider: 'gemini' })
    expect(s.apiKey).toBe('sk-gemini')
  })

  it('treats the fixed mask as presence only, never as a real key (no raw key can surface)', async () => {
    // The Rust backend returns this fixed placeholder (AI_KEY_MASKED) instead of
    // the raw key. The store must feed an EMPTY value into live state so
    // config() never sends the mask as a real key, and the settings field stays
    // empty until the user types a new one.
    invokeMock.mockResolvedValue('••••••••')
    const s = useSettingsStore()
    await s.loadKey()
    expect(s.apiKey).toBe('')
    expect(s.config().api_key).toBeUndefined()
  })

  it('returns an empty key when the backend reports no key configured', async () => {
    invokeMock.mockResolvedValue(null)
    const s = useSettingsStore()
    await s.loadKey()
    expect(s.apiKey).toBe('')
    expect(s.config().api_key).toBeUndefined()
  })

  it('only a user-typed key ever flows into config()', async () => {
    const s = useSettingsStore()
    s.apiKey = 'sk-realkey'
    expect(s.config().api_key).toBe('sk-realkey')
  })

  it('saves the key for the current provider', async () => {
    invokeMock.mockResolvedValue(undefined)
    const s = useSettingsStore()
    s.apiKey = 'sk-1'
    await s.saveKey()
    expect(invokeMock).toHaveBeenCalledWith('store_ai_key', { provider: 'local', key: 'sk-1' })
  })

  it('includes base_url only for local/custom in config', () => {
    const s = useSettingsStore()
    s.provider = 'openai'
    const cfg = s.config()
    expect(cfg.provider).toBe('openai')
    expect(cfg.base_url).toBeUndefined()
    s.provider = 'local'
    expect(s.config().base_url).toBe('http://localhost:1234/v1')
  })

  it('defaults autosaveInterval to 15000 and maxHistory to 10', () => {
    const s = useSettingsStore()
    expect(s.autosaveInterval).toBe(15000)
    expect(s.maxHistory).toBe(10)
  })

  it('defaults AI tuning knobs and carries them in config', () => {
    const s = useSettingsStore()
    expect(s.temperature).toBe(0.7)
    expect(s.maxTokens).toBe(256)
    expect(s.systemPrompt).toBe('')
    const cfg = s.config()
    expect(cfg.temperature).toBe(0.7)
    expect(cfg.max_tokens).toBe(256)
    expect(cfg.system_prompt).toBeUndefined()
  })

  it('persists AI tuning knobs and includes them in config when set', async () => {
    const s = useSettingsStore()
    s.temperature = 1.2
    s.maxTokens = 1024
    s.systemPromptOn = true
    s.systemPrompt = 'Be concise.'
    await nextTick()
    expect(localStorage.getItem('nekowite.ai.temperature')).toBe('1.2')
    expect(localStorage.getItem('nekowite.ai.maxTokens')).toBe('1024')
    expect(localStorage.getItem('nekowite.ai.systemPrompt')).toBe('Be concise.')
    expect(localStorage.getItem('nekowite.ai.systemPromptOn')).toBe('true')
    const cfg = s.config()
    expect(cfg.temperature).toBe(1.2)
    expect(cfg.max_tokens).toBe(1024)
    expect(cfg.system_prompt).toBe('Be concise.')
  })

  it('omits the system prompt when the toggle is off', async () => {
    const s = useSettingsStore()
    s.systemPromptOn = false
    s.systemPrompt = 'Be concise.'
    await nextTick()
    expect(s.config().system_prompt).toBeUndefined()
  })

  it('omits a whitespace-only system prompt from config', async () => {
    const s = useSettingsStore()
    s.systemPrompt = '   '
    await nextTick()
    expect(s.config().system_prompt).toBeUndefined()
  })

  it('persists autosaveInterval and maxHistory changes to localStorage', async () => {
    const s = useSettingsStore()
    s.autosaveInterval = 'off'
    s.maxHistory = 20
    await nextTick()
    expect(localStorage.getItem('nekowite.settings.autosaveInterval')).toBe('off')
    expect(localStorage.getItem('nekowite.settings.maxHistory')).toBe('20')
  })

  it('fetches and caches the model list via ai_list_models', async () => {
    invokeMock.mockResolvedValue(['model-a', 'model-b'])
    const s = useSettingsStore()
    await s.listModels()
    expect(invokeMock).toHaveBeenCalledWith(
      'ai_list_models',
      expect.objectContaining({ config: expect.objectContaining({ provider: 'local' }) }),
    )
    expect(s.modelsCache).toEqual(['model-a', 'model-b'])
  })

  it('clears the model cache', () => {
    const s = useSettingsStore()
    s.modelsCache = ['a', 'b']
    s.clearModelsCache()
    expect(s.modelsCache).toEqual([])
  })

  it('defaults export params to include frontmatter on A4 portrait', () => {
    const s = useSettingsStore()
    expect(s.exportIncludeFrontmatter).toBe(true)
    expect(s.exportPdfPageSize).toBe('A4')
    expect(s.exportPdfOrientation).toBe('portrait')
  })

  it('reads persisted export params from localStorage', () => {
    localStorage.setItem('nekowite.settings.exportFrontmatter', 'false')
    localStorage.setItem('nekowite.settings.exportPageSize', 'Letter')
    localStorage.setItem('nekowite.settings.exportOrientation', 'landscape')
    const s = useSettingsStore()
    expect(s.exportIncludeFrontmatter).toBe(false)
    expect(s.exportPdfPageSize).toBe('Letter')
    expect(s.exportPdfOrientation).toBe('landscape')
  })

  it('persists export param changes to localStorage', async () => {
    const s = useSettingsStore()
    s.exportIncludeFrontmatter = false
    s.exportPdfPageSize = 'Letter'
    s.exportPdfOrientation = 'landscape'
    await nextTick()
    expect(localStorage.getItem('nekowite.settings.exportFrontmatter')).toBe('false')
    expect(localStorage.getItem('nekowite.settings.exportPageSize')).toBe('Letter')
    expect(localStorage.getItem('nekowite.settings.exportOrientation')).toBe('landscape')
  })

  it('falls back to defaults for invalid export params', () => {
    localStorage.setItem('nekowite.settings.exportFrontmatter', 'yes')
    localStorage.setItem('nekowite.settings.exportPageSize', 'Tabloid')
    localStorage.setItem('nekowite.settings.exportOrientation', 'sideways')
    const s = useSettingsStore()
    expect(s.exportIncludeFrontmatter).toBe(true)
    expect(s.exportPdfPageSize).toBe('A4')
    expect(s.exportPdfOrientation).toBe('portrait')
  })
})
