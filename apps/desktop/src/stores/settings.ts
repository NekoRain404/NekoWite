import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export interface AIConfig {
  provider: string
  model: string
  base_url?: string
  api_key?: string
}

export const useSettingsStore = defineStore('settings', () => {
  const provider = ref('local')
  const model = ref('qwen2.5-coder:3b')
  const baseUrl = ref('http://localhost:1234/v1')
  const apiKey = ref('')

  async function saveKey(): Promise<void> {
    await invoke('store_ai_key', { provider: provider.value, key: apiKey.value })
  }

  async function loadKey(): Promise<void> {
    const stored = await invoke<string | null>('load_ai_key', { provider: provider.value })
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