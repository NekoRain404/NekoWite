import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => {
  const g = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!g.window) g.window = {}
  g.window.__TAURI_INTERNALS__ = {}
})

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { useSettingsStore } from './settings'
import { DEFAULT_CONTEXT_CHARS } from './settings'

function clearLs(): void {
  localStorage.removeItem('nekowite.ai.provider')
  localStorage.removeItem('nekowite.ai.model')
  localStorage.removeItem('nekowite.ai.baseUrl')
  localStorage.removeItem('nekowite.ai.baseUrls')
  localStorage.removeItem('nekowite.ai.modelsUrls')
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
    // The Base URL is stored per provider now, but the scalar an older install
    // wrote is still read: it can only have been typed under the provider that
    // was selected when it was written, so that is the entry it becomes.
    localStorage.setItem('nekowite.ai.provider', 'anthropic')
    localStorage.setItem('nekowite.ai.model', 'claude-sonnet-4-5')
    localStorage.setItem('nekowite.ai.baseUrl', 'https://api.anthropic.com')
    const s = useSettingsStore()
    expect(s.provider).toBe('anthropic')
    expect(s.model).toBe('claude-sonnet-4-5')
    expect(s.baseUrl).toBe('https://api.anthropic.com')
  })

  it('persists provider/model and the Base URL under the provider it was typed for (I5)', async () => {
    const s = useSettingsStore()
    s.provider = 'gemini'
    s.model = 'gemini-2.5-pro'
    s.baseUrl = 'https://generativelanguage.googleapis.com'
    await nextTick()
    expect(localStorage.getItem('nekowite.ai.provider')).toBe('gemini')
    expect(localStorage.getItem('nekowite.ai.model')).toBe('gemini-2.5-pro')
    // Keyed by provider, so one provider's address cannot come back as
    // another's — which is what the single `nekowite.ai.baseUrl` scalar did.
    // `local` is in the map because the field's own localhost default is its
    // entry and nothing else's, not because anything was typed for it.
    expect(JSON.parse(localStorage.getItem('nekowite.ai.baseUrls') ?? '{}')).toEqual({
      local: 'http://localhost:1234/v1',
      gemini: 'https://generativelanguage.googleapis.com',
    })
  })

  it('keeps one provider’s Base URL out of every other provider', () => {
    // Reusing the address of a provider the user configured elsewhere is how
    // the shared scalar told an `anthropic` user their key goes to a local
    // model server, and how a `custom` address ended up on a hosted request.
    const s = useSettingsStore()
    s.provider = 'custom'
    s.baseUrl = 'https://gateway.example.com/v1'

    s.provider = 'anthropic'
    expect(s.baseUrl).toBe('')
    expect(s.config().base_url).toBeUndefined()

    s.provider = 'custom'
    expect(s.baseUrl).toBe('https://gateway.example.com/v1')
    expect(s.config().base_url).toBe('https://gateway.example.com/v1')
  })

  it('sends exactly the address the field holds for the provider on screen', () => {
    // config() used to drop the address for providers the field was not
    // rendered for, so the panel and the request disagreed about what was
    // configured. One rule now: whatever this provider's entry holds is what
    // this provider's request carries.
    const s = useSettingsStore()
    for (const provider of ['anthropic', 'openai', 'gemini', 'grok', 'deepseek', 'local', 'custom']) {
      s.provider = provider
      s.baseUrl = `https://proxy.example.com/${provider}`
      expect(s.config().base_url, `${provider} must carry the address on screen`).toBe(
        `https://proxy.example.com/${provider}`,
      )
    }
  })

  it('lets the Base URL be cleared, and derives the endpoint again', () => {
    const s = useSettingsStore()
    s.provider = 'local'
    expect(s.config().base_url).toBe('http://localhost:1234/v1')
    s.baseUrl = ''
    expect(s.baseUrl).toBe('')
    expect(s.config().base_url).toBeUndefined()
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

  it('saves a long provider key in full, without truncating', async () => {
    invokeMock.mockResolvedValue(undefined)
    const s = useSettingsStore()
    const longKey = `sk-proj-${'a'.repeat(4096)}`
    s.apiKey = longKey
    await s.saveKey()
    expect(invokeMock).toHaveBeenCalledWith('store_ai_key', { provider: 'local', key: longKey })
    expect(s.config().api_key).toBe(longKey)
    expect(s.config().api_key?.length).toBe(longKey.length)
  })

  it('omits base_url for a provider nothing was typed for, and keeps local’s default', () => {
    const s = useSettingsStore()
    s.provider = 'openai'
    const cfg = s.config()
    expect(cfg.provider).toBe('openai')
    // Absent, not blank: the backend then applies `default_base_url` for this
    // provider rather than being handed an address that means nothing.
    expect(cfg.base_url).toBeUndefined()
    s.provider = 'local'
    expect(s.config().base_url).toBe('http://localhost:1234/v1')
  })

  it('carries a typed Base URL to every provider, not only the local ones', () => {
    // Reported from use: entering an API address and a key, then refreshing,
    // returned no models. The settings UI renders the Base URL field for every
    // provider, but config() forwarded it only for local/custom/deepseek — so an
    // Anthropic-compatible proxy was silently dropped and the request went to
    // api.anthropic.com carrying the *proxy's* key, which is a 401 every time.
    // The Rust side already defaults per provider when `base_url` is absent
    // (`default_base_url`), so forwarding it is the whole fix.
    const s = useSettingsStore()
    for (const provider of ['anthropic', 'gemini', 'openai', 'grok'] as const) {
      s.provider = provider
      s.baseUrl = `https://proxy.example.com/${provider}`
      expect(s.config().base_url, `${provider} must carry its Base URL`).toBe(
        `https://proxy.example.com/${provider}`,
      )
    }
  })

  it('never hands a hosted provider the local model server’s address', () => {
    // The Base URL used to be ONE value every provider shared, and its stored
    // default is a localhost address that only `local`/`custom` can mean
    // anything by. An address reaching a hosted provider has to be one the user
    // typed under that provider: the default is `local`'s own entry now, so a
    // hosted provider starts empty and is left to Rust's `default_base_url`.
    localStorage.setItem('nekowite.ai.baseUrl', 'http://localhost:1234/v1')
    const s = useSettingsStore()

    s.provider = 'anthropic'
    expect(s.baseUrl).toBe('')
    expect(s.config().base_url).toBeUndefined()

    s.provider = 'local'
    expect(s.baseUrl).toBe('http://localhost:1234/v1')
    expect(s.config().base_url).toBe('http://localhost:1234/v1')
  })

  it('carries the models-URL override through config for the provider that set it', () => {
    // Reported from use: refreshing the list against a provider whose models
    // live somewhere other than `{base}/models` could not be made to work at
    // all — the app derived the path and offered no way to override it. The
    // override is sent verbatim; Rust uses it in place of the derived endpoint.
    const s = useSettingsStore()
    s.provider = 'custom'
    s.modelsUrl = 'https://tokenflux.dev/v1/models'
    expect(s.config().models_url).toBe('https://tokenflux.dev/v1/models')
  })

  it('never sends one provider the models URL another one set', () => {
    // The field sits beside a Base URL that every provider shares, but a models
    // URL names ONE provider's exact endpoint: a value typed while `custom` was
    // selected would aim `deepseek`'s refresh at a host serving a different
    // list, or nothing at all. The trap the Base URL's stored default already
    // taught (see LOCAL_BASE_URL_DEFAULT), in a field where a default is not
    // even needed — the override is kept per provider instead.
    const s = useSettingsStore()
    s.provider = 'custom'
    s.modelsUrl = 'http://localhost:1234/v1/models'

    s.provider = 'deepseek'
    expect(s.config().models_url).toBeUndefined()

    s.provider = 'custom'
    expect(s.config().models_url).toBe('http://localhost:1234/v1/models')
  })

  it('omits an empty or whitespace-only models URL so the backend derives the path', () => {
    const s = useSettingsStore()
    s.provider = 'custom'
    s.modelsUrl = '   '
    expect(s.config().models_url).toBeUndefined()
    s.modelsUrl = 'https://tokenflux.dev/v1/models'
    s.modelsUrl = ''
    expect(s.config().models_url).toBeUndefined()
  })

  it('persists the models URL per provider and reads it back', async () => {
    const first = useSettingsStore()
    first.provider = 'custom'
    first.modelsUrl = 'https://tokenflux.dev/v1/models'
    await nextTick()
    expect(JSON.parse(localStorage.getItem('nekowite.ai.modelsUrls') ?? '{}')).toEqual({
      custom: 'https://tokenflux.dev/v1/models',
    })

    setActivePinia(createPinia())
    const second = useSettingsStore()
    second.provider = 'custom'
    expect(second.modelsUrl).toBe('https://tokenflux.dev/v1/models')
    // The other provider starts clean: only the provider that set it inherited it.
    second.provider = 'deepseek'
    expect(second.modelsUrl).toBe('')
  })

  it('falls back to no override when the stored models-URL map is corrupt', () => {
    // A hand-edited or half-written value must not take the settings page down.
    localStorage.setItem('nekowite.ai.modelsUrls', 'not json at all')
    const s = useSettingsStore()
    expect(s.modelsUrl).toBe('')
    expect(s.config().models_url).toBeUndefined()
  })

  it('defaults autosaveInterval to 15000 and maxHistory to 10', () => {
    const s = useSettingsStore()
    expect(s.autosaveInterval).toBe(15000)
    expect(s.maxHistory).toBe(10)
  })

  it('defaults AI tuning knobs and carries them in config', () => {
    const s = useSettingsStore()
    expect(s.temperature).toBe(0.7)
    // 1024, not 256: a reasoning model can spend the entire budget on its
    // thinking and return no answer at all (measured against deepseek-flash),
    // so the shipped default has to leave room for the actual text.
    expect(s.maxTokens).toBe(1024)
    expect(s.systemPrompt).toBe('')
    const cfg = s.config()
    expect(cfg.temperature).toBe(0.7)
    expect(cfg.max_tokens).toBe(1024)
    expect(cfg.system_prompt).toBeUndefined()
  })

  it('persists AI tuning knobs and includes them in config when set', async () => {
    const s = useSettingsStore()
    s.temperature = 1.2
    // Deliberately NOT the default (1024): the point of this case is that a
    // changed value is persisted, and a value equal to the default would not
    // fire the store's watcher at all.
    s.maxTokens = 2048
    s.systemPromptOn = true
    s.systemPrompt = 'Be concise.'
    await nextTick()
    expect(localStorage.getItem('nekowite.ai.temperature')).toBe('1.2')
    expect(localStorage.getItem('nekowite.ai.maxTokens')).toBe('2048')
    expect(localStorage.getItem('nekowite.ai.systemPrompt')).toBe('Be concise.')
    expect(localStorage.getItem('nekowite.ai.systemPromptOn')).toBe('true')
    const cfg = s.config()
    expect(cfg.temperature).toBe(1.2)
    expect(cfg.max_tokens).toBe(2048)
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

describe('chat context budget', () => {
  it('defaults to a budget that fits a real section of a long note', () => {
    // It used to be a hardcoded 2000 with no way to change it: on a long note
    // the model saw the opening pages and answered confidently about the wrong
    // part of the document, and the user had no lever to fix it.
    setActivePinia(createPinia())
    localStorage.clear()
    const settings = useSettingsStore()
    expect(settings.contextChars).toBe(DEFAULT_CONTEXT_CHARS)
    expect(DEFAULT_CONTEXT_CHARS).toBeGreaterThan(2000)
  })

  it('persists a changed budget and reads it back', async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    const first = useSettingsStore()
    first.contextChars = 9000
    // The store persists through a watcher, which Vue flushes on the next tick.
    await nextTick()

    setActivePinia(createPinia())
    const second = useSettingsStore()
    expect(second.contextChars).toBe(9000)
  })
})
