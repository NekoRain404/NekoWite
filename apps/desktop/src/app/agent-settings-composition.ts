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
 * Six of the nine sections have a backend this build really answers: the registry
 * (`agent_registry_read` / `_add` / `_set_enabled`), the profile (`agent_profile_read` / `_write`),
 * the permission pair (`agent_permission_grants` / `_revoke`), the engine's own configuration
 * (`agent_config_document` / `_edit`), the ACP catalogue (`agent_catalogue_read`) and the skills
 * page (`agent_skills_read` / `_preview` / `_import` / `_set_enabled`). All of them are registered
 * in `R/src/lib.rs`, and every one of their clients is built here. The other three have no client
 * in this object, because there is nothing for one to call — the section states each absence rather
 * than mounting a page that could only fail, and a client added here for an unregistered command
 * would be that failure with a longer name.
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
import {
  createTauriAgentConfigCommands,
  type AgentConfigCommands,
} from '../platform/gateways/tauri-agent/config'
import {
  createTauriAgentCatalogueCommands,
  type AgentCatalogueCommands,
} from '../platform/gateways/tauri-agent/catalogue'
import {
  createTauriAgentSkillsCommands,
  type AgentSkillsCommands,
} from '../platform/gateways/tauri-agent/skills'
import { createAgentRegistryClient } from '../features/agent-settings/services/agent-registry-ipc'
import type { AgentRegistryClient } from '../features/agent-settings/services/agent-registry-policy'
import { createAgentProviderClient } from '../features/agent-settings/services/agent-profile-ipc'
import type { AgentProviderClient } from '../features/agent-settings/services/agent-profile-ipc'
import {
  createAgentPermissionClient,
  type AgentPermissionClient,
} from '../features/agent-settings/services/agent-permission-ipc'
import {
  createAgentConfigClient,
  type AgentConfigClient,
} from '../features/agent-settings/services/agent-config-ipc'
import { createAgentCatalogueClient } from '../features/agent-settings/services/agent-catalogue-ipc'
import type { AgentCatalogueClient } from '../features/agent-settings/services/agent-catalogue-policy'
import { createAgentSkillsClient } from '../features/agent-settings/services/agent-skills-ipc'
import type { AgentSkillsClient } from '../features/agent-settings/components/AgentSkillsSettings.vue'

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
  /**
   * The engine's own configuration document, for one engine/profile pair.
   *
   * A builder for the permission client's reason, and one more of its own: this page *writes*, and
   * the path it writes to arrives from the profile readout, so the pair has to be bound before any
   * call exists rather than checked after. {@link AgentSettingsClients.provider} is handed to it —
   * the same object the profile page uses — because the document's name is a field on that readout
   * and a second reader of it here would be a second narrowing of the same wire.
   */
  readonly config: (agentId: string, profileId: string) => AgentConfigClient
  /**
   * The ACP catalogue, which is about no profile and no window: one read of what the public
   * registry publishes.
   *
   * A value rather than a builder, unlike the three above: its answer does not depend on which
   * engine a page is about, so a builder would take an argument it has no use for.
   */
  readonly catalogue: AgentCatalogueClient
  /**
   * The skills page's client, built for one engine/profile pair.
   *
   * A builder for the configuration client's reason, one more directory over: the scope list is
   * built from *that profile's* roots — where its engine's `HOME` and `XDG_CONFIG_HOME` point — so
   * a client that could be asked about another pair is a page describing directories it does not
   * have. Which pair that is arrives from the registry readout, read by the section rather than
   * here, exactly as the other two builders' does.
   */
  readonly skills: (agentId: string, profileId: string) => AgentSkillsClient
}

/**
 * The ports a caller may substitute, for a test that wants to drive the real clients without a
 * window. The same shape `agent-composition.ts` gives its `registryCommands`.
 */
export interface AgentSettingsDeps {
  registryCommands?: AgentRegistryCommands
  profileCommands?: AgentProfileCommands
  grantCommands?: AgentPermissionGrantCommands
  configCommands?: AgentConfigCommands
  catalogueCommands?: AgentCatalogueCommands
  skillsCommands?: AgentSkillsCommands
}

/** Build the settings tree's clients over the window's own commands. */
export function createAgentSettingsClients(deps: AgentSettingsDeps = {}): AgentSettingsClients {
  const profileCommands = deps.profileCommands ?? createTauriAgentProfileCommands()
  const grantCommands = deps.grantCommands ?? createTauriAgentPermissionGrantCommands()
  const configCommands = deps.configCommands ?? createTauriAgentConfigCommands()
  // One provider client, two pages. The configuration page reads this same object for the field
  // that names the document it edits, so building a second one would be two narrowings of one wire
  // and two chances for them to disagree about which document the pair has.
  const provider = createAgentProviderClient(profileCommands)
  return {
    registry: createAgentRegistryClient(
      deps.registryCommands ?? createTauriAgentRegistryCommands(),
    ),
    provider,
    permission: (agentId: string, profileId: string) =>
      createAgentPermissionClient({
        wire: profileCommands,
        grants: grantCommands,
        agentId,
        profileId,
      }),
    config: (agentId: string, profileId: string) =>
      createAgentConfigClient({ profile: provider, config: configCommands, agentId, profileId }),
    catalogue: createAgentCatalogueClient(
      deps.catalogueCommands ?? createTauriAgentCatalogueCommands(),
    ),
    // The skills page's commands are built once and bound per pair, like the two clients above: the
    // port the page calls takes no pair of its own, because the client is already that pair.
    skills: (agentId: string, profileId: string) =>
      createAgentSkillsClient({
        skills: deps.skillsCommands ?? createTauriAgentSkillsCommands(),
        agentId,
        profileId,
      }),
  }
}
