/**
 * The agent settings tree's public API.
 *
 * §9 gives a feature one entry point, and §13.11 gives it one rule — a name is exported when a
 * second real caller exists, rather than in case one appears. The second caller here is T16's
 * `SettingsPanel.vue`, which mounts these sections in the settings dialog, and that is what this
 * file is for: it names the seven sections, the vocabulary they share, and nothing else. No store,
 * no service and no helper is exported, because nothing outside the tree calls one.
 *
 * `AgentRegistrySettings` is exported beside the six rather than rebuilt: T13a delivered it and it
 * is done, and a page that an export line can reach does not need a second version of itself. Its
 * own entry points (`AgentRegistryClient`, `AgentRegistryLabels`, the policy functions) stay where
 * they are, in `components/AgentRegistrySettings.vue` and `services/agent-registry-policy.ts`,
 * because a caller that wants them can name those files directly.
 *
 * ## Where the copy lives, for now
 *
 * Every section takes an optional `labels` prop with an English default in its own file. The
 * catalogue (`src/i18n/namespaces/agent.ts`, where `agent.registry.*` lives) is **not** this task's
 * file, so the sentences were not moved into it. The shape is the one T13a's page already uses, so a
 * later move is mechanical: each default is a single function returning one flat record, and every
 * key in it is a literal in that function — which is what the i18n guard test needs to see. Until
 * then these pages are English-only, which is a real gap rather than a decision: it is reported.
 *
 * ## The one thing declared here rather than in a component
 *
 * {@link SettingOrigin} is the vocabulary for §8's acceptance clause on these pages — that a model,
 * an MCP server and a command each say *where they came from* rather than only what they are. Three
 * sections need it, and three copies of a union this small is three places for it to drift apart;
 * the components import it as a type, so the import is erased and this barrel stays a barrel rather
 * than becoming a runtime dependency of the pages it lists.
 */

export { default as AgentRuntimeSettings } from './components/AgentRuntimeSettings.vue'
export { default as AgentProviderSettings } from './components/AgentProviderSettings.vue'
export { default as AgentSkillsSettings } from './components/AgentSkillsSettings.vue'
export { default as AgentCommandsSettings } from './components/AgentCommandsSettings.vue'
export { default as AgentMcpSettings } from './components/AgentMcpSettings.vue'
export { default as AgentPermissionSettings } from './components/AgentPermissionSettings.vue'
export { default as AgentRegistrySettings } from './components/AgentRegistrySettings.vue'

export type { AgentRuntimeLabels } from './components/AgentRuntimeSettings.vue'
export type { AgentProviderLabels } from './components/AgentProviderSettings.vue'
export type { AgentSkillsLabels } from './components/AgentSkillsSettings.vue'
export type { AgentCommandsLabels } from './components/AgentCommandsSettings.vue'
export type { AgentMcpLabels } from './components/AgentMcpSettings.vue'
export type { AgentPermissionLabels } from './components/AgentPermissionSettings.vue'

/**
 * Where one value on these pages comes from.
 *
 * The three arms are the three answers that are actually different, and each one exists because
 * leaving it out produces a specific mistake:
 *
 *  - **`host`** — this app injected a root or wrote a document, and it can say which one. An
 *    environment variable is named when there is one, because §8.1 requires 「列出实际生效源」 and a
 *    path alone does not say what put it there.
 *  - **`engine`** — the engine found it by its own rules, in a place this app does not own and does
 *    not claim to have closed. §8.1 names the failure this prevents: `OPENCODE_CONFIG_DIR` is not a
 *    complete isolation switch, so a page that rendered only injected paths would be describing a
 *    world with nothing else in it.
 *  - **`session`** — the engine published it while a session was running (§4.1's command list), so it
 *    is true of *that* session and stops being true when the session changes.
 */
export type SettingOrigin =
  | { kind: 'host'; variable: string | null; path: string }
  | { kind: 'engine'; what: string }
  | { kind: 'session'; what: string }

/**
 * One section of the tree, in the order a navigation should offer it.
 *
 * A list rather than seven imports at the call site, because the order and the identity of the pages
 * are one fact and T16's navigation would otherwise keep its own copy of it. This file declares
 * *what exists*; T16 decides what is shown, and whether a page with nothing behind it is hidden.
 * `mounts` is the component's own name so a navigation can bind it without a second lookup table.
 */
export interface AgentSettingsSection {
  id: string
  /** The component's export name in this file. */
  mounts: string
  /** Whether the section can do anything at all when the runtime is not running. */
  needsRuntime: boolean
}

export const AGENT_SETTINGS_SECTIONS: readonly AgentSettingsSection[] = [
  { id: 'runtime', mounts: 'AgentRuntimeSettings', needsRuntime: true },
  { id: 'provider', mounts: 'AgentProviderSettings', needsRuntime: true },
  { id: 'skills', mounts: 'AgentSkillsSettings', needsRuntime: true },
  { id: 'commands', mounts: 'AgentCommandsSettings', needsRuntime: true },
  { id: 'mcp', mounts: 'AgentMcpSettings', needsRuntime: true },
  { id: 'permission', mounts: 'AgentPermissionSettings', needsRuntime: true },
  { id: 'registry', mounts: 'AgentRegistrySettings', needsRuntime: false },
]
