/**
 * The registry IPC: three commands, and the argument shapes they are called with.
 *
 * This is the window's half of `R/src/commands/agent_registry.rs`, and it is the second file in the
 * adapter that names a Tauri API (the first is `ipc.ts`, whose doc gives the rule this file follows
 * too): the arguments go over the wire **verbatim**, so every key below is the camelCase spelling of
 * the Rust parameter it must land on — `agentId` for `agent_id`, `draft` for the one struct
 * argument `agent_registry_add` takes. A key in the wrong case rejects, which reads exactly like the
 * command not existing.
 *
 * ## What is deliberately not here
 *
 * No types for the *answers*. The commands are the Tauri-facing surface; what a readout or a refusal
 * means is the feature's vocabulary, and it lives in `features/agent-settings/services/`, where the
 * page and its policy can see it. So this port's answers are `unknown` and the client next door is
 * what narrows them — which is also the direction the layering requires: `platform` may not import
 * from `features` (plan §6.1), and a port declared here with the feature's types in its signature
 * would be that import wearing a different name. The two sides meet at the composition site
 * (`app/agent-composition.ts`), where a drift between them is a compile error.
 *
 * ## What every one of these can answer
 *
 * Three outcomes, and the renderer must keep them apart (T13a §7.1):
 *
 *  - an **accepted** change answers `null`;
 *  - a **refusal** answers the facts, which the page renders through its own copy tree;
 *  - a **rejection** means the call did not complete at all — the registry could not be built, a
 *    start is in flight, or the command is not there. The page's answer to that is its "could not be
 *    read from the backend" state with a retry, never "no engines are registered".
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * The three calls, as the backend answers them.
 *
 * The draft is `unknown` for the reason above: its shape is the feature's (`AgentDraft`), and this
 * file passes it through without an opinion. The names stay the page's — `read`, `add`,
 * `setEnabled` — because they are what the settings section asks for; the `agent_registry_` prefix
 * appears only where a command is actually named.
 */
export interface AgentRegistryCommands {
  read(): Promise<unknown>
  add(draft: unknown): Promise<unknown>
  setEnabled(agentId: string, enabled: boolean): Promise<unknown>
}

/**
 * The port implemented by the running app.
 *
 * A port rather than a set of free functions, for the reason `AgentIpc` is one: a test can drive
 * the client without a window, and the composition site chooses which implementation a build gets.
 */
export function createTauriAgentRegistryCommands(): AgentRegistryCommands {
  return {
    read: () => invoke('agent_registry_read'),
    add: (draft: unknown) => invoke('agent_registry_add', { draft }),
    setEnabled: (agentId: string, enabled: boolean) =>
      invoke('agent_registry_set_enabled', { agentId, enabled }),
  }
}
