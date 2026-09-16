/**
 * The profile IPC: two commands, and the argument shapes they are called with.
 *
 * This is the window's half of `R/src/commands/agent_settings.rs`, and it follows the rule
 * `registry.ts` next door states for the same reason: the arguments go over the wire **verbatim**,
 * so every key below is the camelCase spelling of the Rust parameter it must land on — `agentId`
 * for `agent_id`, `profileId` for `profile_id`, `submission` for the one struct argument
 * `agent_profile_write` takes. A key in the wrong case rejects, which reads exactly like the
 * command not existing.
 *
 * ## What is deliberately not here
 *
 * No types for the *answers*, and no vote on what a profile is. The commands are the Tauri-facing
 * surface; `AgentProfileReadout`, `ProfileWrite` and `ProfileUpdate` are the settings feature's
 * vocabulary (§8.1's configuration ownership), and they live in
 * `features/agent-settings/services/`, where the page and its policy can see them. So this port's
 * answers are `unknown` and the client next door is what narrows them — which is also the direction
 * the layering requires: `platform` may not import from `features` (plan §6.1), and a port declared
 * here with the feature's types in its signature would be that import wearing a different name. The
 * two sides meet at the composition site, where a drift between them is a compile error.
 *
 * ## What every one of these can answer
 *
 * Three outcomes, and the renderer must keep them apart — the same three the registry's port
 * documents, in this surface's words:
 *
 *  - a **written** profile answers `{"status":"written","revision":…}` — the new revision, which is
 *    what makes the next write's conflict check possible;
 *  - a **conflict** answers `{"status":"conflict","current":…}` — someone else's write landed
 *    first, and the caller rebuilds its form from that record rather than merging;
 *  - a **rejection** means the call did not complete: a profile this host cannot open, an id it
 *    refuses, a revision that is not the shape this host issues, or no such command. Those are
 *    refusals *of a call that ran*, which is why they arrive as errors with the backend's own
 *    sentence rather than as a value the page would have to invent a reading for.
 *
 * `read` answers a profile that **did not exist** as one this host created and bound (§8.1:
 * opening a profile is what creates it), so a first run's read is not an error and there is no
 * "no profile yet" arm for a caller to handle.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * The two calls, as the backend answers them.
 *
 * `submission` is `unknown` for the reason above: its shape is the feature's (`ProfileWrite`'s
 * fields, flattened the way `ProfileSubmission` expects), and this file passes it through without
 * an opinion. The names stay the page's — `read`, `write` — because they are what the settings
 * section asks for; the `agent_profile_` prefix appears only where a command is actually named.
 */
export interface AgentProfileCommands {
  read(agentId: string, profileId: string): Promise<unknown>
  write(request: {
    agentId: string
    profileId: string
    /** The revision the form was built from — the token the backend decides a conflict on. */
    revision: string
    /** `mode`, `provider` and `modelId`, and nothing else: `agent_settings.rs` has no fourth field. */
    submission: unknown
  }): Promise<unknown>
}

/**
 * The port implemented by the running app.
 *
 * A port rather than a set of free functions, for the reason `AgentIpc` and the registry's port
 * are: a test can drive the client without a window, and the composition site chooses which
 * implementation a build gets.
 */
export function createTauriAgentProfileCommands(): AgentProfileCommands {
  return {
    read: (agentId: string, profileId: string) =>
      invoke('agent_profile_read', { agentId, profileId }),
    write: (request) =>
      invoke('agent_profile_write', {
        agentId: request.agentId,
        profileId: request.profileId,
        revision: request.revision,
        submission: request.submission,
      }),
  }
}
