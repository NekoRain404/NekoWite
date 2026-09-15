/**
 * The AI subject of the settings store: which provider is being talked to, the
 * endpoint and credential for it, and the shape of the request `config()`
 * builds from them.
 *
 * This slice owns all of it end to end — the `LS_*` keys and their defaults, the
 * readers, the reactive state, the watchers that persist it, and the request
 * itself. Nothing here reads another slice's settings, and no other slice reads
 * these. The chat's content policy (the note-context budget, the prompt shelf)
 * is deliberately *not* here: `config()` reads neither, and they are what
 * `stores/settings-chat.ts` exists for.
 *
 * `createAiSettings()` is invoked by the store in `stores/settings.ts`, which is
 * the public API; import this module only to reach a constant or a type.
 */

import { ref, watch } from 'vue'
import { getSharedGateways } from '../platform/runtime/gateway-runtime'
import { persistence } from '../services/persistence'
import {
  readBaseUrls,
  readModelsUrls,
  scopedUrl,
  writeBaseUrls,
  writeModelsUrls,
} from './provider-urls'
import { readBool, readEnum, readLs, readNumber } from './settings-persist'

export interface AIConfig {
  provider: string
  model: string
  base_url?: string
  /**
   * The exact URL the model list is fetched from, used verbatim when set.
   *
   * Absent, the endpoint is derived from `base_url` by the provider's own
   * convention (Rust's `models_endpoint`: `/v1/models` for anthropic,
   * `/v1beta/models` for gemini, `/models` otherwise). A provider serving its
   * list anywhere else — a gateway whose derived path answers 200 with a web
   * page — was otherwise unreachable from this UI.
   */
  models_url?: string
  api_key?: string
  temperature?: number
  max_tokens?: number
  system_prompt?: string
  /**
   * How much the model may think before answering. The ladder is the one the
   * OpenAI-compatible reasoning endpoints accept; the server rejects anything
   * else with a 400 (verified against the live endpoint: "ultra" and an
   * uppercase "HIGH" both fail), so an unknown value is dropped here rather
   * than forwarded.
   */
  reasoning_effort?: string
  // Allow a private/loopback base_url (e.g. a local model server). On by
  // default because the app is local-model-first (the default base_url is
  // localhost); disable it for strict SSRF protection when pointing at a
  // public endpoint.
  allow_private?: boolean
}

const LS_PROVIDER = 'nekowite.ai.provider'
const LS_MODEL = 'nekowite.ai.model'
const LS_TEMPERATURE = 'nekowite.ai.temperature'
const LS_MAX_TOKENS = 'nekowite.ai.maxTokens'
const LS_SYSTEM_PROMPT = 'nekowite.ai.systemPrompt'
const LS_SYSTEM_PROMPT_ON = 'nekowite.ai.systemPromptOn'
const LS_ALLOW_PRIVATE = 'nekowite.ai.allowPrivate'
const LS_REASONING_EFFORT = 'nekowite.ai.reasoningEffort'
// The Rust backend returns this fixed placeholder instead of the raw API key (the
// key never leaves the vault store to the window). Must match the Rust constant.
const AI_KEY_MASKED = '••••••••'

/**
 * The thinking-depth ladder, shared by the store and the settings panel.
 *
 * Measured against the live endpoint with a reasoning-heavy prompt: 'none'
 * produced no reasoning at all, 'minimal' a short trace, and the higher rungs
 * progressively more. '' means "do not send the field", which leaves the
 * provider's own default in place.
 */
export const REASONING_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * The same ladder with the i18n key for each rung.
 *
 * Shared by the settings panel and the chat panel's quick control, so the two
 * cannot drift apart - the labels live here as keys only, because the store must
 * not depend on the translation layer.
 */
export const EFFORT_OPTIONS: readonly { value: ReasoningEffort; labelKey: string }[] = [
  { value: '', labelKey: 'aiSettings.effortDefault' },
  { value: 'none', labelKey: 'aiSettings.effortNone' },
  { value: 'minimal', labelKey: 'aiSettings.effortMinimal' },
  { value: 'low', labelKey: 'aiSettings.effortLow' },
  { value: 'medium', labelKey: 'aiSettings.effortMedium' },
  { value: 'high', labelKey: 'aiSettings.effortHigh' },
  { value: 'xhigh', labelKey: 'aiSettings.effortXhigh' },
]

export function createAiSettings() {
  // provider/model persist across sessions (only the API key lives in the
  // stronghold vault), so the configured model is not lost on relaunch.
  const provider = ref(readLs(LS_PROVIDER, 'local'))
  const model = ref(readLs(LS_MODEL, 'qwen2.5-coder:3b'))
  // The endpoint fields are stored per provider. `readBaseUrls` also folds the
  // legacy single scalar into the provider it could have meant; the two maps
  // are written back by the watchers below.
  const baseUrls = ref<Record<string, string>>(readBaseUrls(provider.value))
  const baseUrl = scopedUrl(baseUrls, provider)
  const modelsUrls = ref<Record<string, string>>(readModelsUrls())
  const apiKey = ref('')
  const modelsCache = ref<string[]>([])
  // AI tuning knobs persist per-session like provider/model/baseUrl. The
  // system prompt is empty by default so existing installs see no behaviour
  // change until they opt in.
  const temperature = ref<number>(readNumber(LS_TEMPERATURE, 0.7))
  const maxTokens = ref<number>(readNumber(LS_MAX_TOKENS, 1024))
  const systemPrompt = ref(readLs(LS_SYSTEM_PROMPT, ''))
  const systemPromptOn = ref(persistence.get(LS_SYSTEM_PROMPT_ON) === 'true')
  const allowPrivate = ref<boolean>(readBool(LS_ALLOW_PRIVATE, true))
  // Empty by default: an existing install keeps sending exactly the request it
  // sent before, and only an explicit choice changes the payload.
  const reasoningEffort = ref<ReasoningEffort>(
    readEnum(LS_REASONING_EFFORT, REASONING_EFFORTS, ''),
  )
  /** The models-URL override of the provider selected RIGHT NOW — a view onto
   *  `modelsUrls`, so the field is a plain two-way binding while the value
   *  stays scoped to one provider. */
  const modelsUrl = scopedUrl(modelsUrls, provider)

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
  watch(baseUrls, (urls) => writeBaseUrls(urls), { deep: true })
  watch(modelsUrls, (urls) => writeModelsUrls(urls), { deep: true })
  watch(temperature, (v) => persistence.set(LS_TEMPERATURE, String(v)))
  watch(maxTokens, (v) => persistence.set(LS_MAX_TOKENS, String(v)))
  watch(systemPrompt, (v) => persistence.set(LS_SYSTEM_PROMPT, v))
  watch(systemPromptOn, (v) => persistence.set(LS_SYSTEM_PROMPT_ON, String(v)))
  watch(allowPrivate, (v) => persistence.set(LS_ALLOW_PRIVATE, String(v)))
  watch(reasoningEffort, (v) => persistence.set(LS_REASONING_EFFORT, v))

  async function saveKey(): Promise<void> {
    await getSharedGateways().keys.storeAiKey(provider.value, apiKey.value)
  }

  async function loadKey(): Promise<void> {
    // The answer is evidence about the question that was asked, and two things
    // can have moved on by the time it lands: the provider (a switch starts its
    // own load, and the one the user left can resolve last) and the field
    // itself (the user is typing a key into it, via `v-model`). Writing on
    // arrival alone therefore cleared the field the user was filling in — and a
    // cleared field is also what `saveKey()` would then store.
    const askedFor = provider.value
    const before = apiKey.value
    const stored = await getSharedGateways().keys.loadAiKey(askedFor)
    if (provider.value !== askedFor || apiKey.value !== before) return
    // The backend never returns the raw key to the window — only a fixed mask
    // when a key is configured (and null when not). Never treat the mask as a
    // real key: feed an empty value into the live state so config() does not
    // send it back, and so the settings field stays empty until the user types
    // a new key. The Rust side backfills the real key from the vault for AI calls.
    apiKey.value = stored && stored !== AI_KEY_MASKED ? stored : ''
  }

  function config(): AIConfig {
    const cfg: AIConfig = { provider: provider.value, model: model.value }
    // A typed Base URL reaches EVERY provider, not only the local ones. It used
    // to be forwarded for `local`/`custom`/`deepseek` alone, which silently
    // dropped the address for `anthropic`, `gemini` and `openai`: the settings
    // page renders the field for all of them, so the visible effect was an
    // Anthropic-compatible proxy being ignored and the request going to
    // api.anthropic.com carrying the proxy's key — a 401, and no model list.
    // The Rust side defaults per provider when `base_url` is absent
    // (`default_base_url`), so passing it through is the whole fix.
    //
    // No gate here any more: the field is stored per provider, so what it
    // holds for this provider is what this provider's request carries. The
    // exception for the field's own default existed only while that default was
    // shared, and keeping it would put the panel and the request back in
    // disagreement — the field showing an address the request dropped.
    const typed = baseUrl.value.trim()
    if (typed) cfg.base_url = typed
    // The override is the one endpoint field that is NOT shared: it is looked
    // up under the current provider, so another provider's models URL cannot
    // ride along on a request that was never meant for it. Empty omits the
    // field, leaving the backend to derive the endpoint.
    const modelsOverride = (modelsUrls.value[provider.value] ?? '').trim()
    if (modelsOverride) cfg.models_url = modelsOverride
    if (apiKey.value) cfg.api_key = apiKey.value
    cfg.temperature = temperature.value
    cfg.max_tokens = maxTokens.value
    if (systemPromptOn.value && systemPrompt.value.trim()) {
      cfg.system_prompt = systemPrompt.value.trim()
    }
    cfg.allow_private = allowPrivate.value
    if (reasoningEffort.value) cfg.reasoning_effort = reasoningEffort.value
    return cfg
  }

  async function listModels(): Promise<void> {
    modelsCache.value = await getSharedGateways().ai.listModels(config())
  }

  function clearModelsCache(): void {
    modelsCache.value = []
  }

  return {
    provider,
    model,
    baseUrl,
    modelsUrl,
    apiKey,
    temperature,
    maxTokens,
    systemPrompt,
    systemPromptOn,
    allowPrivate,
    reasoningEffort,
    modelsCache,
    saveKey,
    loadKey,
    config,
    listModels,
    clearModelsCache,
  }
}
