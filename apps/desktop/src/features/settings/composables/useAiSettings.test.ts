/**
 * The AI provider block's model.
 *
 * What matters here is the refetch rule: each provider has its own endpoint and
 * credentials, so the model list must not survive a provider switch. The panel
 * test only walks the rendered controls; the watch that does the clearing and
 * refetching is reachable from here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useAiSettings, type AiSettingsModel } from './useAiSettings'
import { useSettingsStore } from '../../../stores/settings'
import { onNotify } from '../../../services/errors'

const mocks = vi.hoisted(() => ({ listModels: vi.fn() }))

vi.mock('../../../platform/runtime/gatewayRuntime', () => ({
  getSharedGateways: () => ({
    ai: { listModels: mocks.listModels },
    keys: { storeAiKey: vi.fn(), loadAiKey: vi.fn().mockResolvedValue(null) },
    fs: {},
  }),
}))

let pinia: Pinia
let mounted: VueApp[] = []

function mountModel(): AiSettingsModel {
  let created: AiSettingsModel | null = null
  const app = createApp({
    setup() {
      created = useAiSettings()
      return () => null
    },
  })
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  return created!
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  mocks.listModels.mockReset().mockResolvedValue(undefined)
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

describe('useAiSettings', () => {
  it('offers the Base URL only where a gateway makes sense', () => {
    const m = mountModel()
    const settings = useSettingsStore()

    settings.provider = 'openai'
    expect(m.showBaseUrl.value).toBe(false)

    // DeepSeek speaks the OpenAI wire format and is routinely fronted by a
    // gateway, so its Base URL is editable rather than pinned.
    settings.provider = 'deepseek'
    expect(m.showBaseUrl.value).toBe(true)

    settings.provider = 'custom'
    expect(m.showBaseUrl.value).toBe(true)
  })

  it('drops the stale model list and refetches when the provider changes', async () => {
    mountModel()
    const settings = useSettingsStore()
    settings.modelsCache = ['old-provider-model']
    mocks.listModels.mockResolvedValue(['fresh-model'])

    settings.provider = 'openai'
    await flush()

    // The switch is what matters: a cached list from the previous endpoint
    // would offer models this provider does not serve.
    expect(settings.modelsCache).toEqual(['fresh-model'])
    expect(mocks.listModels).toHaveBeenCalledTimes(1)
  })

  it('keeps the configured model selectable even when the provider does not list it', () => {
    const m = mountModel()
    const settings = useSettingsStore()
    settings.modelsCache = ['a', 'b']
    settings.model = 'hand-typed'

    expect(m.modelOptions.value).toEqual(['hand-typed', 'a', 'b'])

    settings.model = 'a'
    expect(m.modelOptions.value).toEqual(['a', 'b'])
  })

  it('reports a failed model list instead of leaving the button spinning', async () => {
    const m = mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.listModels.mockRejectedValue(new Error('connection refused'))

    await m.refreshModels()
    off()

    expect(messages).toHaveLength(1)
    expect(m.modelLoading.value).toBe(false)
  })

  it('hands the provider failure to the toast verbatim', async () => {
    // `ai_list_models` rejects with the Rust `Err(String)` itself — a plain
    // string, not an `Error` — and that string IS the diagnosis: the URL that
    // was asked, and what came back. Dropping or re-wrapping it puts the user
    // back where this report started, reading a serde offset ("expected value
    // at line 1 column 1") that names neither the URL nor the body.
    const m = mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    const detail =
      '模型列表响应解析失败：https://tokenflux.dev/anthropic/v1/models 返回了网页而不是 JSON' +
      '（HTTP 200，text/html）。响应开头：<!doctype html><html lang="en">'
    mocks.listModels.mockRejectedValue(detail)

    await m.refreshModels()
    off()

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(detail)
    expect(messages[0]).toContain('tokenflux.dev/anthropic/v1/models')
    expect(messages[0]).toContain('<!doctype html>')
    expect(messages[0]).not.toContain('[object Object]')
  })

  it('takes the reason out of a structured rejection instead of stringifying it', async () => {
    // A structured `Err` (a shape with a `message`) is what a `String(e)` would
    // flatten to `[object Object]`, erasing the only sentence that says what to
    // change.
    const m = mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.listModels.mockRejectedValue({
      message: '缺少 API Key：https://tokenflux.dev/v1/models 返回 401',
    })

    await m.refreshModels()
    off()

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('https://tokenflux.dev/v1/models')
    expect(messages[0]).not.toContain('[object Object]')
  })

  it('ignores a second refresh while one is in flight', async () => {
    const m = mountModel()
    let release: () => void = () => undefined
    mocks.listModels.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))

    const first = m.refreshModels()
    const second = m.refreshModels()
    release()
    await first
    await second

    expect(mocks.listModels).toHaveBeenCalledTimes(1)
  })

  it('writes provider settings through to the store', () => {
    const m = mountModel()
    const settings = useSettingsStore()

    m.provider.value = 'anthropic'
    m.model.value = 'claude'
    m.apiKey.value = 'sk-test'
    m.contextChars.value = 9000

    expect(settings.provider).toBe('anthropic')
    expect(settings.model).toBe('claude')
    expect(settings.apiKey).toBe('sk-test')
    expect(settings.contextChars).toBe(9000)
  })

  it('shows the models-URL override of the provider on screen, and writes it back', () => {
    const m = mountModel()
    const settings = useSettingsStore()

    settings.provider = 'custom'
    m.modelsUrl.value = 'http://localhost:1234/v1/models'
    expect(settings.modelsUrl).toBe('http://localhost:1234/v1/models')

    // The field follows the provider: switching away shows that provider's own
    // (empty) override rather than the one just typed.
    settings.provider = 'deepseek'
    expect(m.modelsUrl.value).toBe('')
    settings.provider = 'custom'
    expect(m.modelsUrl.value).toBe('http://localhost:1234/v1/models')
  })
})
