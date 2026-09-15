/**
 * Is the AI configured well enough to answer a completion request?
 *
 * The ghost-writer's Tab shortcut is bound to the editor, so it fires for
 * everyone — including a fresh install that never opened the AI settings. Every
 * such press used to reach the backend and come back as an "AI generation
 * failed" toast, which reads as a broken app rather than as "not set up yet".
 * This predicate is the seam that lets the shortcut stay quiet when there is
 * nothing to talk to.
 *
 * The per-provider rule mirrors what the backend can actually do:
 *   - `local` / `custom` talk to a user-run, OpenAI-compatible endpoint, so a
 *     base URL must be present (the store defaults one for `local`, which is why
 *     a fresh install still gets completions from a running local server);
 *   - `deepseek` also accepts a gateway URL, but falls back to its own host, so
 *     it only needs a credential;
 *   - every other provider is a hosted API addressed by the backend itself and
 *     needs a credential.
 *
 * A credential counts as present either way it can be present: typed into the
 * settings field this session (`apiKey` — a real key the backend takes as
 * given), or stored in the vault (`keyConfigured` — the backend backfills it
 * from there). Both arms are needed, because the store empties the field
 * whenever a stored key arrives and only the second survives a restart.
 */
export interface AiReadiness {
  provider: string
  baseUrl: string
  apiKey: string
  /** Whether a credential is stored for this provider — the fact the vault
   *  answers `load_ai_key` with, published by the settings store as state of
   *  its own.
   *
   *  It is not derivable from `apiKey` and must not be replaced by a test on
   *  it. The store refuses to put the mask in the field (it would be sent back
   *  as the credential) and empties it instead, so after a restart or a
   *  provider switch `apiKey` is empty for a provider whose key is sitting in
   *  the vault. The backend then backfills that key from the vault, which is
   *  why this arm decides whether a request is worth making at all. */
  keyConfigured?: boolean
}

export function isAiConfigured(state: AiReadiness): boolean {
  const hasKey = state.apiKey.trim().length > 0 || state.keyConfigured === true
  if (state.provider === 'local' || state.provider === 'custom') {
    return state.baseUrl.trim().length > 0
  }
  return hasKey
}
