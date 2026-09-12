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
 */
export interface AiReadiness {
  provider: string
  baseUrl: string
  apiKey: string
  /** The stored key is replaced by a mask when it is loaded from the vault, so
   *  a non-empty value means "a key exists" even though the raw key is never
   *  handed to the window. */
  keyConfigured?: boolean
}

export function isAiConfigured(state: AiReadiness): boolean {
  const hasKey = state.apiKey.trim().length > 0 || state.keyConfigured === true
  if (state.provider === 'local' || state.provider === 'custom') {
    return state.baseUrl.trim().length > 0
  }
  return hasKey
}
