/**
 * The agent feature's public API.
 *
 * Nothing outside the feature imports one of its files by path (§9): a caller goes through
 * this entry point, so the internals can move without a call site changing, and two features
 * cannot reach into each other's working parts.
 *
 * What is here is what a caller actually needs: the panel, and the shape of the words it
 * draws. The store, the service modules and the scroll composable stay internal — the panel
 * is this feature's only caller of them, and §13.11's rule is that a name is exported when a
 * second real caller exists rather than in case one appears. The two components that other
 * tasks own (`AgentPermissionPrompt`, `AgentCommandMenu`) are not exported either: they are
 * placed by the panel, which is why they are inside the feature and not part of its surface.
 *
 * The label types *are* exported, and they are the entry point's important half: the panel has
 * no copy of its own (see {@link AgentPanelLabels}), so the caller that mounts it is the
 * caller that supplies every sentence it shows.
 */

export { default as AgentPanel } from './components/AgentPanel.vue'

export type { AgentPanelLabels } from './components/AgentPanel.vue'
export type { AgentSessionBarLabels } from './components/AgentSessionBar.vue'
export type { AgentTimelineLabels } from './components/AgentTimeline.vue'
export type { AgentToolLabels } from './components/AgentToolActivity.vue'
export type { AgentComposerLabels } from './components/AgentComposer.vue'
