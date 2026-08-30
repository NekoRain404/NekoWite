import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { useSettingsStore } from './settings'

function clearLs(): void {
  localStorage.removeItem('nekowite.ai.provider')
  localStorage.removeItem('nekowite.ai.model')
  localStorage.removeItem('nekowite.ai.baseUrl')
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
})
