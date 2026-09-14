import { computed, ref, watch, type ComputedRef, type WritableComputedRef } from 'vue'
import { t } from '../../../i18n'
import { notifyError } from '../../../services/errors'
import {
  CONTEXT_CHARS_MAX,
  CONTEXT_CHARS_MIN,
  DEFAULT_CONTEXT_CHARS,
  EFFORT_OPTIONS,
  useSettingsStore,
} from '../../../stores/settings'
import type { ReasoningEffort } from '../../../stores/settings'

export interface AiSettingsModel {
  providers: readonly string[]
  showBaseUrl: ComputedRef<boolean>
  provider: WritableComputedRef<string>
  model: WritableComputedRef<string>
  baseUrl: WritableComputedRef<string>
  modelsUrl: WritableComputedRef<string>
  apiKey: WritableComputedRef<string>
  allowPrivate: WritableComputedRef<boolean>
  systemPromptOn: WritableComputedRef<boolean>
  systemPrompt: WritableComputedRef<string>
  temperature: WritableComputedRef<number>
  maxTokens: WritableComputedRef<number>
  reasoningEffort: WritableComputedRef<ReasoningEffort>
  effortOptions: typeof EFFORT_OPTIONS
  contextChars: WritableComputedRef<number>
  contextCharsMin: number
  contextCharsMax: number
  contextCharsDefault: number
  modelOptions: ComputedRef<string[]>
  modelLoading: ComputedRef<boolean>
  refreshModels: () => Promise<void>
  saveAiKey: () => Promise<void>
}

const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok', 'deepseek', 'local', 'custom']

/**
 * The provider's failure reason, as the user must see it.
 *
 * `ai_list_models` rejects with the backend's `Err(String)` itself — a bare
 * string, not an `Error` — and that string is the whole diagnosis: the URL that
 * was asked and what came back instead of a model list. It is shown verbatim,
 * with nothing truncated or reworded past the prefix `getModelsFailed` adds.
 * The shape is still probed rather than assumed, because `String(e)` on a
 * structured rejection yields `[object Object]` and throws away the only
 * sentence that says what to change.
 */
function providerFailureMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  if (e && typeof e === 'object') {
    const message = (e as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return String(e)
}

/**
 * State and commands for the AI section's provider configuration.
 *
 * The permission policy and the audit trail are a separate capability with its
 * own composable (`useAiPermissionSettings`); this one is only the endpoint the
 * app talks to and the shape of the request it sends.
 */
export function useAiSettings(): AiSettingsModel {
  const settings = useSettingsStore()
  const modelLoading = ref(false)

  /**
   * Whether the endpoint fields are shown — for every provider, now.
   *
   * They were gated to `local`/`custom`/`deepseek`, which left the setup this
   * app is most often pointed at — an Anthropic-compatible proxy — with no
   * field to type its address into at all. The gate was not removable on its
   * own: it was drawn around a Base URL that every provider shared and whose
   * stored default is a localhost address only a local model server can mean,
   * so showing it under `anthropic` would have said the Anthropic key goes
   * there. The store keeps that field per provider now (see
   * `stores/settings.ts`), which is what makes the field honest everywhere.
   */
  const showBaseUrl = computed(() => true)

  const modelOptions = computed(() => {
    const list = settings.modelsCache
    const current = settings.model
    if (!current || list.includes(current)) return list
    return [current, ...list]
  })

  async function refreshModels(): Promise<void> {
    if (modelLoading.value) return
    modelLoading.value = true
    try {
      await settings.listModels()
    } catch (e) {
      notifyError(t('aiSettings.getModelsFailed', { msg: providerFailureMessage(e) }))
    } finally {
      modelLoading.value = false
    }
  }

  // Each provider has its own endpoint and credentials, so refetch (and clear the
  // stale cache) whenever the provider changes.
  watch(
    () => settings.provider,
    () => {
      settings.clearModelsCache()
      void refreshModels()
    },
  )

  async function saveAiKey(): Promise<void> {
    try {
      await settings.saveKey()
    } catch (e) {
      notifyError(t('settings.general.saveKeyFailed', { msg: providerFailureMessage(e) }))
    }
  }

  return {
    providers: AI_PROVIDERS,
    showBaseUrl,
    provider: computed({
      get: () => settings.provider,
      set: (v) => { settings.provider = v },
    }),
    model: computed({
      get: () => settings.model,
      set: (v) => { settings.model = v },
    }),
    baseUrl: computed({
      get: () => settings.baseUrl,
      set: (v) => { settings.baseUrl = v },
    }),
    // Scoped to the selected provider by the store, so the field shows that
    // provider's own override and a refresh acts on that same one.
    modelsUrl: computed({
      get: () => settings.modelsUrl,
      set: (v) => { settings.modelsUrl = v },
    }),
    apiKey: computed({
      get: () => settings.apiKey,
      set: (v) => { settings.apiKey = v },
    }),
    allowPrivate: computed({
      get: () => settings.allowPrivate,
      set: (v) => { settings.allowPrivate = v },
    }),
    systemPromptOn: computed({
      get: () => settings.systemPromptOn,
      set: (v) => { settings.systemPromptOn = v },
    }),
    systemPrompt: computed({
      get: () => settings.systemPrompt,
      set: (v) => { settings.systemPrompt = v },
    }),
    temperature: computed({
      get: () => settings.temperature,
      set: (v) => { settings.temperature = v },
    }),
    maxTokens: computed({
      get: () => settings.maxTokens,
      set: (v) => { settings.maxTokens = v },
    }),
    reasoningEffort: computed({
      get: () => settings.reasoningEffort,
      set: (v) => { settings.reasoningEffort = v },
    }),
    /**
     * Thinking-depth choices. `''` is "leave it to the provider": the field is then
     * omitted from the request entirely. `effortLabelKey` maps a rung to its i18n
     * key so the template never builds a key by concatenation.
     */
    effortOptions: EFFORT_OPTIONS,
    contextChars: computed({
      get: () => settings.contextChars,
      set: (v) => { settings.contextChars = v },
    }),
    contextCharsMin: CONTEXT_CHARS_MIN,
    contextCharsMax: CONTEXT_CHARS_MAX,
    contextCharsDefault: DEFAULT_CONTEXT_CHARS,
    modelOptions,
    modelLoading: computed(() => modelLoading.value),
    refreshModels,
    saveAiKey,
  }
}
