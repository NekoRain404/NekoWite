import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getSharedGateways } from '../platform/runtime/gatewayRuntime'
import { persistence } from '../services/persistence'

export interface AIConfig {
  provider: string
  model: string
  base_url?: string
  api_key?: string
  temperature?: number
  max_tokens?: number
  system_prompt?: string
  // Allow a private/loopback base_url (e.g. a local model server). On by
  // default because the app is local-model-first (the default base_url is
  // localhost); disable it for strict SSRF protection when pointing at a
  // public endpoint.
  allow_private?: boolean
}

export type AutosaveInterval = 'off' | 5000 | 15000 | 30000 | 60000
export type ExportPdfPageSize = 'A4' | 'Letter'
export type ExportPdfOrientation = 'portrait' | 'landscape'

const LS_PROVIDER = 'nekowite.ai.provider'
const LS_MODEL = 'nekowite.ai.model'
const LS_BASE_URL = 'nekowite.ai.baseUrl'
const LS_TEMPERATURE = 'nekowite.ai.temperature'
const LS_MAX_TOKENS = 'nekowite.ai.maxTokens'
const LS_SYSTEM_PROMPT = 'nekowite.ai.systemPrompt'
const LS_SYSTEM_PROMPT_ON = 'nekowite.ai.systemPromptOn'
const LS_ALLOW_PRIVATE = 'nekowite.ai.allowPrivate'
// The Rust backend returns this fixed placeholder instead of the raw API key (the
// key never leaves the vault store to the window). Must match the Rust constant.
const AI_KEY_MASKED = '••••••••'
const LS_AUTOSAVE = 'nekowite.settings.autosaveInterval'
const LS_MAXHISTORY = 'nekowite.settings.maxHistory'
const LS_EXPORT_FRONTMATTER = 'nekowite.settings.exportFrontmatter'
const LS_EXPORT_PDF_PAGE = 'nekowite.settings.exportPageSize'
const LS_EXPORT_PDF_ORIENT = 'nekowite.settings.exportOrientation'

function readLs(key: string, fallback: string): string {
  const v = persistence.get(key)
  return v && v.length > 0 ? v : fallback
}

function readNumber(key: string, fallback: number): number {
  const v = persistence.get(key)
  if (!v || v.length === 0) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readAutosaveInterval(fallback: AutosaveInterval): AutosaveInterval {
  const v = persistence.get(LS_AUTOSAVE)
  if (v === 'off') return 'off'
  const n = Number(v)
  return n === 5000 || n === 15000 || n === 30000 || n === 60000
    ? (n as AutosaveInterval)
    : fallback
}

function readBool(key: string, fallback: boolean): boolean {
  const v = persistence.get(key)
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

function readEnum<T extends string>(key: string, values: readonly T[], fallback: T): T {
  const v = persistence.get(key)
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fallback
}

export const useSettingsStore = defineStore('settings', () => {
  // provider/model/baseUrl persist across sessions (only the API key lives in
  // the stronghold vault), so the configured model is not lost on relaunch.
  const provider = ref(readLs(LS_PROVIDER, 'local'))
  const model = ref(readLs(LS_MODEL, 'qwen2.5-coder:3b'))
  const baseUrl = ref(readLs(LS_BASE_URL, 'http://localhost:1234/v1'))
  const apiKey = ref('')
  const autosaveInterval = ref<AutosaveInterval>(readAutosaveInterval(15000))
  const maxHistory = ref<number>(readNumber(LS_MAXHISTORY, 10))
  const modelsCache = ref<string[]>([])
  // AI tuning knobs persist per-session like provider/model/baseUrl. The
  // system prompt is empty by default so existing installs see no behaviour
  // change until they opt in.
  const temperature = ref<number>(readNumber(LS_TEMPERATURE, 0.7))
  const maxTokens = ref<number>(readNumber(LS_MAX_TOKENS, 256))
  const systemPrompt = ref(readLs(LS_SYSTEM_PROMPT, ''))
  const systemPromptOn = ref(persistence.get(LS_SYSTEM_PROMPT_ON) === 'true')
  const allowPrivate = ref<boolean>(readBool(LS_ALLOW_PRIVATE, true))
  const exportIncludeFrontmatter = ref<boolean>(readBool(LS_EXPORT_FRONTMATTER, true))
  const exportPdfPageSize = ref<ExportPdfPageSize>(readEnum(LS_EXPORT_PDF_PAGE, ['A4', 'Letter'], 'A4'))
  const exportPdfOrientation = ref<ExportPdfOrientation>(readEnum(LS_EXPORT_PDF_ORIENT, ['portrait', 'landscape'], 'portrait'))

  watch(provider, (p) => {
    persistence.set(LS_PROVIDER, p)
    // The key is stored per provider; reload it whenever the provider changes
    // so the next completion uses the right credential.
    void loadKey().catch(() => {
      // vault init errors surface via the settings panel; a reload on switch
      // should not reject the watcher
    })
  })
  watch(model, (m) => persistence.set(LS_MODEL, m))
  watch(baseUrl, (b) => persistence.set(LS_BASE_URL, b))
  watch(temperature, (v) => persistence.set(LS_TEMPERATURE, String(v)))
  watch(maxTokens, (v) => persistence.set(LS_MAX_TOKENS, String(v)))
  watch(systemPrompt, (v) => persistence.set(LS_SYSTEM_PROMPT, v))
  watch(systemPromptOn, (v) => persistence.set(LS_SYSTEM_PROMPT_ON, String(v)))
  watch(allowPrivate, (v) => persistence.set(LS_ALLOW_PRIVATE, String(v)))
  watch(autosaveInterval, (v) => persistence.set(LS_AUTOSAVE, String(v)))
  watch(maxHistory, (v) => persistence.set(LS_MAXHISTORY, String(v)))
  watch(exportIncludeFrontmatter, (v) => persistence.set(LS_EXPORT_FRONTMATTER, String(v)))
  watch(exportPdfPageSize, (v) => persistence.set(LS_EXPORT_PDF_PAGE, v))
  watch(exportPdfOrientation, (v) => persistence.set(LS_EXPORT_PDF_ORIENT, v))

  async function saveKey(): Promise<void> {
    await getSharedGateways().keys.storeAiKey(provider.value, apiKey.value)
  }

  async function loadKey(): Promise<void> {
    const stored = await getSharedGateways().keys.loadAiKey(provider.value)
    // The backend never returns the raw key to the window — only a fixed mask
    // when a key is configured (and null when not). Never treat the mask as a
    // real key: feed an empty value into the live state so config() does not
    // send it back, and so the settings field stays empty until the user types
    // a new key. The Rust side backfills the real key from the vault for AI calls.
    apiKey.value = stored && stored !== AI_KEY_MASKED ? stored : ''
  }

  function config(): AIConfig {
    const cfg: AIConfig = { provider: provider.value, model: model.value }
    if (provider.value === 'local' || provider.value === 'custom') {
      cfg.base_url = baseUrl.value
    }
    if (apiKey.value) cfg.api_key = apiKey.value
    cfg.temperature = temperature.value
    cfg.max_tokens = maxTokens.value
    if (systemPromptOn.value && systemPrompt.value.trim()) {
      cfg.system_prompt = systemPrompt.value.trim()
    }
    cfg.allow_private = allowPrivate.value
    return cfg
  }

  async function listModels(): Promise<void> {
    modelsCache.value = await getSharedGateways().ai.listModels(config())
  }

  function clearModelsCache(): void {
    modelsCache.value = []
  }

  return { provider, model, baseUrl, apiKey, temperature, maxTokens, systemPrompt, systemPromptOn, allowPrivate, autosaveInterval, maxHistory, modelsCache, exportIncludeFrontmatter, exportPdfPageSize, exportPdfOrientation, saveKey, loadKey, config, listModels, clearModelsCache }
})
