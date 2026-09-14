/**
 * The per-provider endpoint addresses: each provider's Base URL and its
 * models-URL override, how they are stored, and how a field binds to one
 * provider's entry.
 *
 * Both are JSON objects keyed by provider rather than one shared scalar — see
 * {@link LOCAL_BASE_URL_DEFAULT} for what a shared endpoint field cost — so the
 * keys and their parsing live here, while the store keeps the refs, the
 * watchers that persist through them, and the request they end up in.
 *
 * Extracted from `stores/settings.ts`, which had crossed §13.1's 300-line
 * trigger; the behaviour is unchanged, the legacy-scalar attribution below
 * included.
 */

import { computed, type Ref, type WritableComputedRef } from 'vue'
import { persistence } from '../services/persistence'

// The endpoint fields as JSON objects keyed by provider — see `config()` in
// settings.ts for why neither is one shared scalar like its neighbours.
// `LS_BASE_URL` is the scalar those objects replace: still read for an install
// that predates them, never written again.
const LS_BASE_URL = 'nekowite.ai.baseUrl'
const LS_BASE_URLS = 'nekowite.ai.baseUrls'
const LS_MODELS_URLS = 'nekowite.ai.modelsUrls'

/**
 * The address a local model server is assumed to be on — LM Studio's default.
 *
 * It is no provider's default but `local`'s, which is why it is named rather
 * than inlined at its use: attributed to a hosted provider it would name an
 * endpoint that provider's requests never reach. It is also the one Base URL
 * the backend has no fallback for — Rust's `default_base_url` has no arm for
 * `local`, so an empty field there sends the request to api.openai.com.
 */
const LOCAL_BASE_URL_DEFAULT = 'http://localhost:1234/v1'

/** One of the per-provider URL maps, as stored. Corruption is survivable on
 *  purpose: these are hand-editable keys like any other, and a half-written
 *  value must not take the settings page down with it. */
function readUrlMap(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(persistence.get(key) || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [provider, url] of Object.entries(parsed)) {
      if (typeof url === 'string' && url) out[provider] = url
    }
    return out
  } catch {
    return {}
  }
}

/** The legacy single Base URL as stored, or {@link LOCAL_BASE_URL_DEFAULT} for
 *  an install that never wrote the key: the address the field showed then is
 *  the one it is migrated as. */
function readLegacyBaseUrl(): string {
  const v = persistence.get(LS_BASE_URL)
  return v && v.length > 0 ? v : LOCAL_BASE_URL_DEFAULT
}

/**
 * Every provider's Base URL, with the legacy single scalar folded into the
 * provider it could have meant.
 *
 * The scalar was typed under whichever provider was selected at the time, so
 * that is the entry it becomes — except when it is the field's own localhost
 * default, which belongs to `local` and never to a hosted provider. A provider
 * the per-provider map already names keeps that entry: the scalar is only read
 * once, for an install that predates the map.
 */
export function readBaseUrls(provider: string): Record<string, string> {
  const stored = readLegacyBaseUrl()
  const storedFor = stored === LOCAL_BASE_URL_DEFAULT ? 'local' : provider
  return { [storedFor]: stored, ...readUrlMap(LS_BASE_URLS) }
}

/** Every provider's models-URL override, as stored. */
export function readModelsUrls(): Record<string, string> {
  return readUrlMap(LS_MODELS_URLS)
}

/** Persist a map whole. The write stays here because the key does: a caller
 *  holding the key could store a shape this module would then have to read. */
export function writeBaseUrls(urls: Record<string, string>): void {
  persistence.set(LS_BASE_URLS, JSON.stringify(urls))
}

export function writeModelsUrls(urls: Record<string, string>): void {
  persistence.set(LS_MODELS_URLS, JSON.stringify(urls))
}

/**
 * A two-way view onto the selected provider's entry in a per-provider map.
 *
 * Bound to a field, it shows that provider's own address and writes back to
 * that same slot. Empty drops the entry, which is what leaves `config()` to
 * omit the field so the backend derives its own endpoint.
 */
export function scopedUrl(map: Ref<Record<string, string>>, provider: Ref<string>): WritableComputedRef<string> {
  return computed({
    get: () => map.value[provider.value] ?? '',
    set: (v: string) => {
      const next = { ...map.value }
      if (v.trim()) next[provider.value] = v
      else delete next[provider.value]
      map.value = next
    },
  })
}
