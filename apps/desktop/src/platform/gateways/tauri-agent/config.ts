/**
 * The configuration-document IPC: the two commands that read and edit one document inside a
 * profile.
 *
 * This is the window's half of `R/src/commands/agent_settings.rs`'s `agent_config_document` and
 * `agent_config_edit`, and it follows the rule `registry.ts` states for the other ports in this
 * adapter: the arguments go over the wire **verbatim**, so every key below is the camelCase
 * spelling of the Rust parameter it must land on — `agentId` for `agent_id`, `relative` for the
 * path inside the profile root, `edits` for the list of member changes. A key in the wrong case
 * rejects, which reads exactly like the command not existing.
 *
 * ## Why the path is an argument and not a constant here
 *
 * Which document an engine reads under its own root is that engine's layout (§3.4.5), and this
 * adapter is the one place a Tauri API may be named — but a path literal in it would be the engine
 * known by name in a window, which §3.4's last line forbids. So the relative path arrives from the
 * backend, on the profile readout's `configDocument`, and is passed through as the caller's. This
 * file knows the command's parameter names and nothing about the engine.
 *
 * ## What every one of these can answer
 *
 * The three outcomes `registry.ts` describes, and the third is why the page needs its own read
 * state: an **accepted** edit answers an outcome object, a **refusal** — a read-only profile, a
 * path that would leave the root, a value whose parent chain the document does not have —
 * rejects with the backend's own sentence, and a **rejection** means the call did not complete at
 * all. The page keeps a refusal (rendered as its own sentence) apart from a rejection ("could not
 * be read from the backend", with a retry).
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * One member the editor changed, as the backend takes it: a path and a value, never a document.
 *
 * `unknown` for the value, and that is the layering rule rather than laziness: what a member may
 * hold is the document's business, and this port passes the caller's JSON through without an
 * opinion. The path is a list of names because the backend's `EditSubmission` takes one — a
 * joined `a.b` string would have to be split on this side, and a member name containing a dot
 * would then address two different places depending on which side split it.
 */
export interface AgentConfigEditRequest {
  readonly path: readonly string[]
  readonly value: unknown
}

/**
 * The two calls, as the backend answers them.
 *
 * The names stay the page's — `read`, `edit` — because they are what the settings section asks
 * for; the `agent_config_` prefix appears only where a command is actually named.
 */
export interface AgentConfigCommands {
  read(agentId: string, profileId: string, relative: string): Promise<unknown>
  edit(request: {
    agentId: string
    profileId: string
    relative: string
    /**
     * The revision the read answered, or `null` for a document that is not there — the backend's
     * `Option<String>`, whose `None` is the claim a create is checked on. It is sent as `null`
     * rather than omitted, because the two mean the same thing to serde and only one of them says
     * what the caller meant.
     */
    revision: string | null
    edits: readonly AgentConfigEditRequest[]
  }): Promise<unknown>
}

/**
 * The port implemented by the running app.
 *
 * A port rather than a set of free functions, for the reason `AgentRegistryCommands` is one: a test
 * can drive the client without a window, and the composition site chooses which implementation a
 * build gets.
 */
export function createTauriAgentConfigCommands(): AgentConfigCommands {
  return {
    read: (agentId: string, profileId: string, relative: string) =>
      invoke('agent_config_document', { agentId, profileId, relative }),
    edit: (request: {
      agentId: string
      profileId: string
      relative: string
      revision: string | null
      edits: readonly AgentConfigEditRequest[]
    }) =>
      invoke('agent_config_edit', {
        agentId: request.agentId,
        profileId: request.profileId,
        relative: request.relative,
        revision: request.revision,
        edits: request.edits,
      }),
  }
}
