/**
 * The skills IPC: four commands, and the argument spellings they are called with.
 *
 * This is the window's half of `R/src/commands/agent_skills.rs` (§8.2's page), and it follows the
 * rule `registry.ts` states for the other ports in this adapter: the arguments go over the wire
 * **verbatim**, so every key below is the camelCase spelling of the Rust parameter it must land on
 * — `agentId` for `agent_id`, `profileId` for `profile_id`, `source` for the folder an import reads,
 * `replace` for the confirmed second step. A key in the wrong case rejects, which reads exactly
 * like the command not existing.
 *
 * ## What a window may name, and what it may not
 *
 * The pair is the one thing every call carries: which profile's directories the page is asking
 * about. Everything else is the page's vocabulary — a scope *id* (not a directory) and a skill
 * name, never the path a row showed, because the path is what an action moves and a renderer that
 * could name one is a renderer that could move anything anywhere. The backend re-reads the disk
 * instead and refuses a name that is no longer there.
 *
 * ## What every one of these can answer
 *
 * Three outcomes, and the page keeps them apart the way every page in this tree does:
 *
 *  - an **accepted** action answers `null`;
 *  - a **refusal** answers data — the kind plus the facts the page's sentence interpolates, which
 *    the page renders through its own copy tree;
 *  - a **rejection** means the call did not complete at all: the profile could not be opened for
 *    this pair, or the command is not there. That is the page's "could not be read from the
 *    backend" state with a retry, never "no skills are installed" — which would be a claim about
 *    the engine.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * The four calls, as the backend answers them.
 *
 * The names stay the page's — `read`, `preview`, `import`, `setEnabled` — because they are what the
 * settings section asks for; the `agent_skills_` prefix appears only where a command is actually
 * named. The answers are `unknown` for the reason `registry.ts` gives: what a readout or a refusal
 * means is the feature's vocabulary, it lives in `features/agent-settings/`, and `platform` may not
 * import from `features` (plan §6.1). The two sides meet at the composition site, where a drift
 * between them is a compile error.
 */
export interface AgentSkillsCommands {
  read(agentId: string, profileId: string): Promise<unknown>
  preview(agentId: string, profileId: string, source: string): Promise<unknown>
  import(agentId: string, profileId: string, source: string, replace: boolean): Promise<unknown>
  setEnabled(
    agentId: string,
    profileId: string,
    name: string,
    scope: string,
    enabled: boolean,
  ): Promise<unknown>
}

/**
 * The port implemented by the running app.
 *
 * A port rather than a set of free functions, for the reason `AgentRegistryCommands` is one: a test
 * can drive the client without a window, and the composition site chooses which implementation a
 * build gets.
 */
export function createTauriAgentSkillsCommands(): AgentSkillsCommands {
  return {
    read: (agentId: string, profileId: string) =>
      invoke('agent_skills_read', { agentId, profileId }),
    preview: (agentId: string, profileId: string, source: string) =>
      invoke('agent_skills_preview', { agentId, profileId, source }),
    import: (agentId: string, profileId: string, source: string, replace: boolean) =>
      invoke('agent_skills_import', { agentId, profileId, source, replace }),
    setEnabled: (
      agentId: string,
      profileId: string,
      name: string,
      scope: string,
      enabled: boolean,
    ) => invoke('agent_skills_set_enabled', { agentId, profileId, name, scope, enabled }),
  }
}
