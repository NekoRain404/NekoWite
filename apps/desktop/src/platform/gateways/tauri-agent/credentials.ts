/**
 * The credential IPC: one command, and the argument shape it is called with.
 *
 * This is the window's half of `agent_credentials_write` in
 * `R/src/commands/agent_settings.rs`, and it follows the rule `registry.ts` and `profile.ts` state
 * for the same reason: the arguments go over the wire **verbatim**, so every key below is the
 * camelCase spelling of the Rust parameter it must land on — `agentId` for `agent_id`, `profileId`
 * for `profile_id`, `changes` for the `Vec<CredentialSubmission>`. A key in the wrong case
 * rejects, which reads exactly like the command not existing.
 *
 * ## Why this is its own port rather than two more methods on the profile's
 *
 * The profile's wire (`profile.ts`) carries the *record* — mode, provider, model id — and this one
 * carries a patch to the credential set, which is a different resource with a different write
 * shape. The two are also narrowed differently: a record write answers a revision to compare, a
 * credential write answers the whole profile readout, and the client next door re-reads rather
 * than reading that answer twice. `config.ts` and `skills.ts` are separate ports over separate
 * commands for the same reason, so this is the shape the feature already has rather than a third
 * convention in it.
 *
 * ## What this port cannot do
 *
 * Read a credential. `agent_settings.rs`'s `profile_view` sends credential *names* and the
 * redacted placeholder, and `profile::Credentials` has no `Serialize` for exactly that reason — so
 * there is no command here to ask with, and a method that invented one would have nothing to call.
 * `changes` is the only direction this file goes.
 *
 * ## What every call can answer
 *
 * Two outcomes, and the renderer must keep them apart:
 *
 *  - **a write** answers the profile readout as it now stands — which this port passes on as
 *    `unknown` like every other answer here, because the shape is the feature's vocabulary and
 *    `platform` may not name it (plan §6.1);
 *  - **a rejection** means the call did not complete: a profile this host cannot open, an id it
 *    refuses, an engine this profile is not bound to, or no such command. Those are refusals *of a
 *    call that ran*, which is why they arrive as errors carrying the backend's own sentence rather
 *    than as a value a page would have to invent a reading for. The sentence never quotes a
 *    credential value — `refusal_message` in `agent_settings.rs` says so and `Secret` cannot be
 *    printed — but this file passes it through untouched either way.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * The one call, as the backend answers it.
 *
 * `changes` is `unknown` for the reason `profile.ts` gives for `submission`: its shape is the
 * feature's (`CredentialChange` in `agent-settings-policy.ts`, tagged `set`/`remove` the way
 * `CredentialSubmission` is), and this file passes it through without an opinion. The name stays
 * the page's — `write`, the sibling ports' word for the one thing this surface does.
 */
export interface AgentCredentialCommands {
  write(request: {
    agentId: string
    profileId: string
    /**
     * The patch, and deliberately a patch rather than a whole set: the page shows names and the
     * placeholder, so a form that edits one credential cannot resubmit the others. A surface that
     * took a whole set would delete every credential the form did not mention.
     */
    changes: unknown
  }): Promise<unknown>
}

/**
 * The port implemented by the running app.
 *
 * A port rather than a free function, for the reason `AgentConfigCommands` is one: a test can
 * drive the client without a window, and the composition site chooses which implementation a
 * build gets.
 */
export function createTauriAgentCredentialCommands(): AgentCredentialCommands {
  return {
    write: (request) =>
      invoke('agent_credentials_write', {
        agentId: request.agentId,
        profileId: request.profileId,
        changes: request.changes,
      }),
  }
}
