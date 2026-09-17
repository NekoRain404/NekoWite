/**
 * The settings tree's clients: which backend answers the agent settings pages, chosen once.
 *
 * ## Why this is not `agent-composition.ts`
 *
 * That file's composition is a *session*: it is built for a vault, it owns the gateway, and it
 * exists only while the rail is up and a folder is open (§6.2's per-vault instance). The settings
 * dialog is none of those things — it opens with nothing open at all, and the two pages it now
 * mounts read the registry and one profile, neither of which has a vault, a session or an event
 * stream in it. Sharing the rail's composition would mean the settings pages could not be reached
 * without starting an engine.
 *
 * What the two compositions do share is the rule: the adapter is chosen at a composition site
 * (§6.1), never inside a page. `AgentSettingsSection.vue` takes these clients as a prop and never
 * builds one, exactly as the registry page does — which is why this file is the only place a
 * settings-page client is constructed outside `agent-composition.ts`, and why it lives in `app/`
 * beside it rather than in `features/`.
 *
 * ## Which pages this unlocks, and which it deliberately does not
 *
 * Two of the seven sections have a backend this build really answers: the registry
 * (`agent_registry_read` / `_add` / `_set_enabled`) and the profile
 * (`agent_profile_read` / `_write`). Both are registered in `R/src/lib.rs`, and both clients are
 * built here. The other five have no client in this object, because there is nothing for one to
 * call — the section states each absence rather than mounting a page that could only fail, and a
 * client added here for an unregistered command would be that failure with a longer name.
 *
 * ## No double, and no fallback
 *
 * There is no memory implementation of either client, for the reason `agent-composition.ts` gives
 * for the registry: there is nothing a double could honestly stand in for. A build without a
 * backend (a browser, a test runner) rejects on Tauri's own "command not found", which names the
 * call — loud, and the pages' own unreadable state rather than a stub that would look like a host
 * with nothing registered.
 */

import {
  createTauriAgentRegistryCommands,
  type AgentRegistryCommands,
} from '../platform/gateways/tauri-agent/registry'
import {
  createTauriAgentProfileCommands,
  type AgentProfileCommands,
} from '../platform/gateways/tauri-agent/profile'
import {
  createTauriAgentPermissionGrantCommands,
  type AgentPermissionGrantCommands,
} from '../platform/gateways/tauri-agent/grants'
import { createAgentRegistryClient } from '../features/agent-settings/services/agent-registry-ipc'
import type { AgentRegistryClient } from '../features/agent-settings/services/agent-registry-policy'
import { createAgentProviderClient } from '../features/agent-settings/services/agent-profile-ipc'
import type { AgentProviderClient } from '../features/agent-settings/services/agent-profile-ipc'
import {
  createAgentPermissionClient,
  type AgentPermissionClient,
} from '../features/agent-settings/services/agent-permission-ipc'

/**
 * What the settings tree calls.
 *
 * One object rather than two props, because the pages' callers must not be able to pass the
 * registry's client where the provider's is expected: `registry` and `provider` are named ports,
 * and the section binds them by name.
 */
export interface AgentSettingsClients {
  readonly registry: AgentRegistryClient
  readonly provider: AgentProviderClient
  /**
   * The permission page's client, built for one engine/profile pair.
   *
   * A builder rather than a value, and the pair is its argument, because the page's own port binds
   * the pair at construction (`agent-permission-ipc.ts` says why: a permission page is about one
   * profile, and a client that could be asked about another is a value appearing under an engine
   * it does not belong to). The registry readout is what names that pair, and it is read by the
   * section rather than here — so this site can choose the implementation without also owning the
   * identity, which is the division §8.1 asks for.
   */
  readonly permission: (agentId: string, profileId: string) => AgentPermissionClient
}

/**
 * The ports a caller may substitute, for a test that wants to drive the real clients without a
 * window. The same shape `agent-composition.ts` gives its `registryCommands`.
 */
export interface AgentSettingsDeps {
  registryCommands?: AgentRegistryCommands
  profileCommands?: AgentProfileCommands
  grantCommands?: AgentPermissionGrantCommands
}

/** Build the settings tree's clients over the window's own commands. */
export function createAgentSettingsClients(deps: AgentSettingsDeps = {}): AgentSettingsClients {
  const profileCommands = deps.profileCommands ?? createTauriAgentProfileCommands()
  const grantCommands = deps.grantCommands ?? createTauriAgentPermissionGrantCommands()
  return {
    registry: createAgentRegistryClient(
      deps.registryCommands ?? createTauriAgentRegistryCommands(),
    ),
    provider: createAgentProviderClient(profileCommands),
    permission: (agentId: string, profileId: string) =>
      createAgentPermissionClient({
        wire: profileCommands,
        grants: grantCommands,
        agentId,
        profileId,
      }),
  }
}
