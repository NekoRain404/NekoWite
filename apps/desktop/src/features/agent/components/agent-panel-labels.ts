/**
 * The panel's copy tree, handed in rather than reached for.
 *
 * One prop for the whole panel, holding one entry per component that needs words. They arrive
 * from above rather than being read here, so a missing sentence is a visible integration point
 * instead of an English string shipped in its place.
 *
 * The catalogue did not have the panel's keys when this prop was written, and it does now
 * (`src/i18n/namespaces/agent.ts`'s `agent.panel`, added with the composer's control row); the
 * tree is kept because the *shape* is what makes an unmounted or test-mounted panel say exactly
 * what its caller gave it. The newer components beside this one read their own defaults from the
 * catalogue and take these as overrides (`AgentCommandMenu.vue`, `AgentConfigRow.vue`), which is
 * the direction the rest of the tree moves in as its keys land.
 *
 * It lives beside `AgentPanel.vue` rather than in it for the reason `permissions/payload.rs` gives
 * next to its own caller: this is the panel's *interface with its caller*, and the caller
 * (`app/AgentRailBody.vue`) imports this and nothing else about the panel. The panel re-exports it,
 * so every existing import path stays valid.
 */
import type { AgentComposerLabels } from './AgentComposer.vue'
import type { AgentSessionBarLabels } from './AgentSessionBar.vue'
import type { AgentTimelineLabels } from './AgentTimeline.vue'

export interface AgentPanelLabels {
  bar: AgentSessionBarLabels
  timeline: AgentTimelineLabels
  composer: AgentComposerLabels
  /** The one notice the panel itself raises. */
  notice: {
    /** The record has a hole: a frame the subscription never saw. */
    gap: string
    /** Take a fresh snapshot and carry on from it. */
    resync: string
  }
  /** The transcript's first line, drawn only while the transcript is empty. It is one sentence
   *  with the engine's name in it, so it arrives assembled rather than in parts. */
  empty: {
    line: string
  }
  /**
   * The options menu — the panel's one place from which the actions that live outside it are
   * reached.
   *
   * `label` names both the control in the bar and the box it opens, because they are one
   * sentence; the panel hands it down rather than the bar keeping its own copy for the reason
   * `AgentSessionBar`'s `menuLabel` gives.
   */
  menu: {
    label: string
    /** The door to the agents tree in the settings dialog (row 43). */
    settings: string
    /** Put the rail back on the chat panel — the way out the live panel had nowhere to offer. */
    chat: string
  }
}
