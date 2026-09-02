import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getGateways } from '../services/gateways/index'

export interface AIConfig {
  provider: string
  model: string
  base_url?: string
  api_key?: string
}

const LS_PROVIDER = 'nekowite.ai.provider'
const LS_MODEL = 'nekowite.ai.model'
const LS_BASE_URL = 'nekowite.ai.baseUrl'

function readLs(key: string, fallback: string): string {
  const v = localStorage.getItem(key)
  return v && v.length > 0 ? v : fallback
}

export const useSettingsStore = defineStore('settings', () => {
  // provider/model/baseUrl persist across sessions (only the API key lives in
  // the stronghold vault), so the configured model is not lost on relaunch.
  const provider = ref(readLs(LS_PROVIDER, 'local'))
  const model = ref(readLs(LS_MODEL, 'qwen2.5-coder:3b'))
  const baseUrl = ref(readLs(LS_BASE_URL, 'http://localhost:1234/v1'))
  const apiKey = ref('')

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

  return { provider, model, baseUrl, apiKey, saveKey, loadKey, config }
})
