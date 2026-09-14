import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getSharedGateways } from '../platform/runtime/gateway-runtime'
import { persistence } from '../services/persistence'
import { EXPORT_MARGIN_MM_DEFAULT, clampMarginMm } from '../services/export-page'
import {
  readBaseUrls,
  readModelsUrls,
  scopedUrl,
  writeBaseUrls,
  writeModelsUrls,
} from './provider-urls'

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

export type AutosaveInterval = 'off' | 5000 | 15000 | 30000 | 60000
/** Paper sizes the office-format export offers. Wider than it was — A4 and
 *  Letter were the only two — but still a closed list: `@page{size:…}` accepts
 *  these five natively, and a free-text field would let a typo through to the
 *  print dialog as a silently ignored rule. */
export type ExportPdfPageSize = 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal'
export type ExportPdfOrientation = 'portrait' | 'landscape'
/** The long image's format. WebP is deliberately absent: this webview's canvas
 *  cannot encode it — `toDataURL('image/webp')` answers with a PNG — so
 *  offering it would write a PNG under a `.webp` name. */
export type ExportImageFormat = 'png' | 'jpeg'

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
const LS_AUTOSAVE = 'nekowite.settings.autosaveInterval'
const LS_MAXHISTORY = 'nekowite.settings.maxHistory'
const LS_EXPORT_FRONTMATTER = 'nekowite.settings.exportFrontmatter'
const LS_EXPORT_PDF_PAGE = 'nekowite.settings.exportPageSize'
const LS_EXPORT_PDF_ORIENT = 'nekowite.settings.exportOrientation'
const LS_EXPORT_MARGIN_MM = 'nekowite.settings.exportMarginMm'
const LS_EXPORT_IMAGE_FORMAT = 'nekowite.settings.exportImageFormat'
const LS_EXPORT_IMAGE_QUALITY = 'nekowite.settings.exportImageQuality'
const LS_CONTEXT_CHARS = 'nekowite.ai.contextChars'
const LS_DISABLED_PROMPTS = 'nekowite.ai.disabledPrompts'

function readLs(key: string, fallback: string): string {
  const v = persistence.get(key)
  return v && v.length > 0 ? v : fallback
}

/**
 * The ceiling the settings UI enforces on the note-context budget, in
 * characters. The user's number: their model takes a 200K context and they
 * asked for the app to allow the whole of it.
 *
 * It is a **character** budget, and a context window is measured in **tokens**,
 * so the two are not the same unit and the gap between them is the whole reason
 * {@link DEFAULT_CONTEXT_CHARS} is not this number. For CJK, roughly one token
 * per character; for Latin, roughly a quarter. At this ceiling a Chinese note
 * is therefore on the order of 200 000 tokens — the entire window, with nothing
 * left for the system prompt, the conversation or the answer — while the same
 * count of English is nearer 50 000, a quarter of it.
 */
export const CONTEXT_CHARS_MAX = 200000

/**
 * What the app picks when the user has not chosen.
 *
 * **Half the ceiling, and the halving is the point.** At the pessimistic end of
 * what a tokenizer does to Chinese (modern BPE tokenizers land anywhere between
 * 1.0 and 1.5 tokens per character depending on the vocabulary), 200 000
 * characters is 200 000–300 000 tokens against a 200 000-token window: the
 * request overflows and the provider rejects it, on exactly the long Chinese
 * note this setting exists to stop cutting off. 100 000 characters is
 * 100 000–150 000 tokens, which leaves 50 000–100 000 for everything else in
 * the request — and the rest of it is bounded and small: the transcript is
 * capped separately at 6 000 characters by `buildChatPrompt`, the answer at the
 * max-output setting, the system prompt by whatever the user wrote.
 *
 * So the ceiling is theirs and the default is deliberately cautious: a number
 * that overflows on the case the feature is *for* is worse than a number that
 * is 16x the old one and still fits. A user who knows their model and their
 * script can raise it to 200 000; nothing stops them.
 *
 * (The old default was 6 000, against a 32 000 ceiling. The note is truncated
 * to this on the way out — see `buildContextBlock` — so this is the difference
 * between the model reading a section and reading the whole note.)
 */
export const DEFAULT_CONTEXT_CHARS = 100000

/** The bounds the settings UI enforces on {@link DEFAULT_CONTEXT_CHARS}. */
export const CONTEXT_CHARS_MIN = 1000

function readNumber(key: string, fallback: number): number {
  const v = persistence.get(key)
  if (!v || v.length === 0) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** JPEG's quality knob. The bounds are the ones the encoder is worth using
 *  inside: below 0.5 a page of 16px text is visibly soft, and 1.0 disables the
 *  quantisation that is the only reason to choose JPEG over PNG at all — for a
 *  document image it is both larger and worse than the PNG. */
export const EXPORT_JPEG_QUALITY_MIN = 0.5
export const EXPORT_JPEG_QUALITY_MAX = 1
/** The default is the one the format's own documentation uses for "visually
 *  indistinguishable", and it is a compromise rather than a preference: a long
 *  image of a text note is legible at 0.8 and enormous at 1.0, and the user can
 *  see the size it produces next to the control before they commit to it. */
export const EXPORT_JPEG_QUALITY_DEFAULT = 0.92

function readQuality(key: string): number {
  const n = readNumber(key, EXPORT_JPEG_QUALITY_DEFAULT)
  return Math.min(EXPORT_JPEG_QUALITY_MAX, Math.max(EXPORT_JPEG_QUALITY_MIN, n))
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

/**
 * A list of ids, stored as JSON.
 *
 * The prompt shelf persists *what is switched off* rather than what is on, so a
 * prompt added in a later build is available without the stored list having to
 * be migrated — the thing that would otherwise happen is an existing install
 * never seeing a new prompt because its saved list predates it. A value that is
 * not the array we wrote is discarded rather than repaired: half a list of
 * unknown strings is worse than none.
 */
function readStringList(key: string): string[] {
  const v = persistence.get(key)
  if (!v) return []
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function readEnum<T extends string>(key: string, values: readonly T[], fallback: T): T {
  const v = persistence.get(key)
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fallback
}

export const useSettingsStore = defineStore('settings', () => {
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
  const autosaveInterval = ref<AutosaveInterval>(readAutosaveInterval(15000))
  const maxHistory = ref<number>(readNumber(LS_MAXHISTORY, 10))
  // How much of the active note the chat rail may send as context, in
  // characters. It used to be a hardcoded 2000 with no way to change it, which
  // made the feature useless for the long documents people actually write:
  // the model saw the first two pages of a fifty-page note and answered
  // confidently about the wrong part of it. The WINDOW is split between the
  // note's opening and its ending (see buildContextBlock), so this is the whole
  // budget, not one half of it.
  const contextChars = ref<number>(readNumber(LS_CONTEXT_CHARS, DEFAULT_CONTEXT_CHARS))
  // Which writing prompts the user switched off (see `features/ai/prompts`).
  // Stored as the off-list, not the on-list: a prompt added later is then on by
  // default for everybody instead of hidden from every install that has ever
  // opened this page.
  const disabledPrompts = ref<string[]>(readStringList(LS_DISABLED_PROMPTS))
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
  const exportIncludeFrontmatter = ref<boolean>(readBool(LS_EXPORT_FRONTMATTER, true))
  // The values array is the widened one, but an install that stored 'A4' or
  // 'Letter' before still reads back its own choice — the union grew, the two
  // spellings it already held did not change.
  const exportPdfPageSize = ref<ExportPdfPageSize>(
    readEnum(LS_EXPORT_PDF_PAGE, ['A3', 'A4', 'A5', 'Letter', 'Legal'], 'A4'),
  )
  const exportPdfOrientation = ref<ExportPdfOrientation>(readEnum(LS_EXPORT_PDF_ORIENT, ['portrait', 'landscape'], 'portrait'))
  // The paper margin, in millimetres, uniform on all four sides. See
  // `services/export-page.ts` for why one number and why millimetres.
  const exportMarginMm = ref<number>(clampMarginMm(readNumber(LS_EXPORT_MARGIN_MM, EXPORT_MARGIN_MM_DEFAULT)))
  const exportImageFormat = ref<ExportImageFormat>(readEnum(LS_EXPORT_IMAGE_FORMAT, ['png', 'jpeg'], 'png'))
  const exportImageQuality = ref<number>(readQuality(LS_EXPORT_IMAGE_QUALITY))
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
  watch(autosaveInterval, (v) => persistence.set(LS_AUTOSAVE, String(v)))
  watch(maxHistory, (v) => persistence.set(LS_MAXHISTORY, String(v)))
  watch(contextChars, (v) => persistence.set(LS_CONTEXT_CHARS, String(v)))
  watch(disabledPrompts, (v) => persistence.set(LS_DISABLED_PROMPTS, JSON.stringify(v)), { deep: true })
  watch(exportIncludeFrontmatter, (v) => persistence.set(LS_EXPORT_FRONTMATTER, String(v)))
  watch(exportPdfPageSize, (v) => persistence.set(LS_EXPORT_PDF_PAGE, v))
  watch(exportPdfOrientation, (v) => persistence.set(LS_EXPORT_PDF_ORIENT, v))
  watch(exportMarginMm, (v) => persistence.set(LS_EXPORT_MARGIN_MM, String(clampMarginMm(v))))
  watch(exportImageFormat, (v) => persistence.set(LS_EXPORT_IMAGE_FORMAT, v))
  watch(exportImageQuality, (v) => persistence.set(LS_EXPORT_IMAGE_QUALITY, String(v)))

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

  return { provider, model, baseUrl, modelsUrl, apiKey, temperature, maxTokens, systemPrompt, systemPromptOn, allowPrivate, reasoningEffort, autosaveInterval, maxHistory, contextChars, disabledPrompts, modelsCache, exportIncludeFrontmatter, exportPdfPageSize, exportPdfOrientation, exportMarginMm, exportImageFormat, exportImageQuality, saveKey, loadKey, config, listModels, clearModelsCache }
})
