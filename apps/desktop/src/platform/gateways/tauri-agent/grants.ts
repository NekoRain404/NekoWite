/**
 * The grant IPC: the two commands that read and remove a permission the user answered "always" to.
 *
 * This is the window's half of `R/src/commands/agent.rs`'s `agent_permission_grants` and
 * `agent_permission_grant_revoke`, and it follows the rule `registry.ts` states for the same
 * reason: arguments go over the wire verbatim, so `grantId` is the camelCase spelling of the Rust
 * parameter `grant_id`, and a key in the wrong case rejects exactly like a missing command.
 *
 * ## What is deliberately not here
 *
 * No answer types. `GrantsReadout` and `SavedGrant` are the settings feature's vocabulary, and
 * they live in `features/agent-settings/services/agent-permission-ipc.ts` — `platform` may not
 * import from `features` (plan §6.1), so this port answers `unknown` and the client next door
 * narrows it. The two sides meet at the composition site, where drift is a compile error.
 *
 * ## The three answers, which the renderer must keep apart
 *
 *  - `{"kind":"listed","grants":[…]}` — the engine itself says this is what it holds. An empty
 *    array here is the engine stating it has written nothing down.
 *  - `{"kind":"unsupported"}` — the connected agent has no verified HTTP surface, so nothing can
 *    be listed or revoked. **Not** the same claim as an empty list, and the page draws it as its
 *    own state.
 *  - `{"kind":"not-running"}` — no engine is running, so there is no table to read. Also not the
 *    same claim.
 *
 * A rejection is the fourth thing, and it is not an answer: the engine was asked and the call did
 * not complete, which the page renders as unreadable with a retry.
 */

import { invoke } from '@tauri-apps/api/core'

export interface AgentPermissionGrantCommands {
  /** What the engine has written down, or why it cannot be asked. */
  list(): Promise<unknown>
  /** Removes one by the engine's own id, and answers the engine's list afterwards. */
  revoke(grantId: string): Promise<unknown>
}

export function createTauriAgentPermissionGrantCommands(): AgentPermissionGrantCommands {
  return {
    list: () => invoke('agent_permission_grants'),
    revoke: (grantId: string) => invoke('agent_permission_grant_revoke', { grantId }),
  }
}
