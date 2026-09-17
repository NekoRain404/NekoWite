/**
 * The two calls a provider form makes that are not an edit: fetch the endpoint's models, and put the
 * key where the block's `{env:…}` reference will find it.
 *
 * ## Why the model fetch is this app's own AI fetch
 *
 * 「获取模型」 is one GET. `providers::ai` already makes it — `{baseURL}/models`, `Authorization:
 * Bearer <key>`, `data[].id` or `models[].name` read out of the answer, sorted and deduped — and the
 * provider block this form writes names `@ai-sdk/openai-compatible`, whose own model list is that
 * same request against that same address. So the call is `ai_list_models`, the command the AI
 * settings page's own refresh button calls, with the address the user typed. Measured on the endpoint
 * this repository's live tests use: `GET {base}/v1/models` answers `{"object":"list","data":[{"id":
 * …}]}`, and the ids the form then writes into `models` are readable from exactly that shape.
 *
 * **What differs, and what the form has to say rather than leave to be discovered.**
 *
 *  - **The key has to be the one in the field.** `ai_list_models` backfills a missing or masked key
 *    from *this app's own* key vault for the provider the request names, so a fetch sent with an empty
 *    field would authenticate with a key the user did not type — and answer about an endpoint and a
 *    credential the engine will never use. The form therefore refuses to fetch without a key and says
 *    why, which is the whole of the guard: the request below always carries a real value.
 *  - **The app's URL policy applies to the fetch, and not to the engine.** `validate_base_url` refuses
 *    a loopback or private address unless the caller opts in, because the fetch is this app making a
 *    request to an address a form supplied. The engine is bound by none of that — it is a process on
 *    the user's machine talking to whatever the block says — so a provider the engine can use may be
 *    one the *fetch* refuses. The opt-in is on the form for exactly that case, and the refusal's own
 *    sentence names it.
 *  - **A fetch that fails is not a save that is refused.** Nothing here writes: the models it returns
 *    are the form's to tick, and a form that could not fetch can still be submitted with ids typed by
 *    hand.
 *
 * ## Where the key goes
 *
 * Into the profile's credential set, through the same client the credentials section uses —
 * `agent_credentials_write`, whose patch shape is the one that command takes, and whose answer is the
 * profile readout with every value replaced by the placeholder. The value is written to
 * `credentials.json` (mode 0600) inside the profile root, and it is read back by nothing: the readout
 * carries names, and the block carries the variable's name. The engine gets the value from the
 * environment this app spawns it with, which is the channel `profile::Credentials::launch_pairs`
 * exists for.
 */

import type { AgentCredentialClient } from './agent-credential-ipc'

/** What the form asks the endpoint for: the address, the key it typed, and the app's own opt-in. */
export interface ProviderModelsRequest {
  baseUrl: string
  /** Never empty: the form refuses to fetch without one, for the reason in this file's header. */
  apiKey: string
  /** Whether this app may send the request to a loopback or private address. */
  allowPrivate: boolean
}

/**
 * The two calls, as the form sees them.
 *
 * `setCredential` answers nothing: the value goes one way. What comes back from a credential write is
 * the profile readout — names and the placeholder — and this client is not the page that renders it,
 * so it drops the answer rather than narrowing a second copy of one wire.
 */
export interface AgentProviderAuthoringClient {
  fetchModels(request: ProviderModelsRequest): Promise<string[]>
  setCredential(name: string, value: string): Promise<void>
}

/**
 * The model-list command, as `platform/gateways/contracts.ts`'s `AiPort` declares it — repeated
 * structurally here so this module does not depend on the platform layer (§6.1), and so a test can
 * drive it with a list of ids.
 */
export interface ProviderModelCommands {
  listModels(config: unknown): Promise<string[]>
}

/**
 * The provider this request names to `ai_list_models`.
 *
 * It is not one of this app's own AI providers, and that is deliberate: the command reads its own
 * vault under this name when — and only when — the request carries no real key, and the form guarantees
 * one. `custom` is the id that means "the address is in `base_url`" to `resolve_base_url`, which is the
 * whole of what this fetch needs from it.
 */
const MODELS_PROVIDER = 'custom'

export function createAgentProviderAuthoringClient(deps: {
  models: ProviderModelCommands
  credentials: AgentCredentialClient
}): AgentProviderAuthoringClient {
  return {
    async fetchModels(request: ProviderModelsRequest): Promise<string[]> {
      return deps.models.listModels({
        provider: MODELS_PROVIDER,
        // Required by the command's DTO and unused on this path: the fetch names no model.
        model: '',
        base_url: request.baseUrl.trim(),
        api_key: request.apiKey,
        allow_private: request.allowPrivate,
      })
    },

    async setCredential(name: string, value: string): Promise<void> {
      // Through `credentialWrite`'s own rule rather than a second one: a draft that is not null and
      // not blank is a `set`, which is the only arm this form can produce — it calls this only when
      // the field holds a key.
      const answer = await deps.credentials.write([{ name, display: '', draft: value }])
      // `refused` is the policy's pre-flight, and it is a rejection here rather than a value: the
      // caller's next move is to stop the save, and a form that carried on would write a block
      // pointing at a variable this call did not set. The arm is reachable from a real field — a
      // value that is the placeholder the credentials section displays is refused by name — so it
      // is not a branch nobody can reach.
      if (answer.status === 'refused') throw new Error(answer.message)
    },
  }
}
