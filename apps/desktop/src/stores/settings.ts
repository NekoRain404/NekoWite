import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getGateways } from '../services/gateways/index'

export interface AIConfig {
  provider: string
  model: string
  base_url?: string
  api_key?: string
}

export type AutosaveInterval = 'off' | 5000 | 15000 | 30000 | 60000

const LS_PROVIDER = 'nekowite.ai.provider'
const LS_MODEL = 'nekowite.ai.model'
const LS_BASE_URL = 'nekowite.ai.baseUrl'
const LS_AUTOSAVE = 'nekowite.settings.autosaveInterval'
const LS_MAXHISTORY = 'nekowite.settings.maxHistory'

function readLs(key: string, fallback: string): string {
  const v = localStorage.getItem(key)
  return v && v.length > 0 ? v : fallback
}

function readNumber(key: string, fallback: number): number {
  const v = localStorage.getItem(key)
  if (!v || v.length === 0) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readAutosaveInterval(fallback: AutosaveInterval): AutosaveInterval {
  const v = localStorage.getItem(LS_AUTOSAVE)
  if (v === 'off') return 'off'
  const n = Number(v)
  return n === 5000 || n === 15000 || n === 30000 || n === 60000
    ? (n as AutosaveInterval)
    : fallback
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

  watch(provider, (p) => {
    localStorage.setItem(LS_PROVIDER, p)
    // The key is stored per provider; reload it whenever the provider changes
    // so the next completion uses the right credential.
    void loadKey().catch(() => {
      // vault init errors surface via the settings panel; a reload on switch
      // should not reject the watcher
    })
  })
  watch(model, (m) => localStorage.setItem(LS_MODEL, m))
  watch(baseUrl, (b) => localStorage.setItem(LS_BASE_URL, b))
  watch(autosaveInterval, (v) => localStorage.setItem(LS_AUTOSAVE, String(v)))
  watch(maxHistory, (v) => localStorage.setItem(LS_MAXHISTORY, String(v)))

  async function saveKey(): Promise<void> {
    await getGateways().keys.storeAiKey(provider.value, apiKey.value)
  }

  async function loadKey(): Promise<void> {
    const stored = await getGateways().keys.loadAiKey(provider.value)
    apiKey.value = stored ?? ''
  }

  function config(): AIConfig {
    const cfg: AIConfig = { provider: provider.value, model: model.value }
    if (provider.value === 'local' || provider.value === 'custom') {
      cfg.base_url = baseUrl.value
    }
    if (apiKey.value) cfg.api_key = apiKey.value
    return cfg
  }

  async function listModels(): Promise<void> {
    modelsCache.value = await getGateways().ai.listModels(config())
  }

  function clearModelsCache(): void {
    modelsCache.value = []
  }

  return { provider, model, baseUrl, apiKey, autosaveInterval, maxHistory, modelsCache, saveKey, loadKey, config, listModels, clearModelsCache }
})
