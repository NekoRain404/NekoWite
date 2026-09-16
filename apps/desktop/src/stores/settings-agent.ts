/**
 * The agent surface's subject of the settings store: whether the right rail
 * shows the agent panel or the chat panel.
 *
 * It is a slice of the settings store rather than a module of its own because it
 * is exactly what the other four slices are — one persisted scalar edited on a
 * settings page and read by the surface it changes — and because a second state
 * mechanism beside `stores/settings.ts` would be a second answer to "where do
 * this app's booleans live".
 *
 * ## Why this switch exists at all
 *
 * ACP plan §12: 新旧聊天通过明确的内部功能开关过渡 — the old chat is kept and the
 * new panel arrives behind one explicit switch, so the fallback is a decision the
 * user can take rather than a version they have to install. §5.1 and §12 also
 * make the rollback a first-class outcome: nothing may look broken while the new
 * path is off, and the app must not be in a state that pretends the feature is
 * merely unavailable.
 *
 * ## Why the default is off
 *
 * Two facts, and they point the same way.
 *
 * The panel needs an engine to be *there*, and whether one is depends on the
 * build: `program_to_launch` refuses with a sentence when the sidecar was not
 * carried by the package, and the refusal is correct — a build without the
 * bundled engine cannot run an agent at all. Defaulting the switch on would put
 * that sentence in front of every user of such a build in place of the chat they
 * had, which is the arrival §12 calls a rollout rather than a regression.
 *
 * And the release this task belongs to is M1's first visible slice, not the end
 * of §12's 分阶段替换: the chat panel is the surface that works today for every
 * user, so the change is opted into by the person who wants the panel and not by
 * everyone who did not ask. Rolling back is then the same click in the other
 * direction — the value is persisted, so it survives the restart that would
 * otherwise decide the question again.
 *
 * `createAgentSettings()` is invoked by the store in `stores/settings.ts`, which
 * is the public API; import this module only to reach the constant.
 */

import { ref, watch } from 'vue'
import { persistence } from '../services/persistence'
import { readBool } from './settings-persist'

/** The rail the agent panel takes over. Persisted like every other setting, so a
 *  rollback is not undone by the next launch. */
const LS_AGENT_PANEL = 'nekowite.agent.panel'

/**
 * Whether the rail shows the agent panel.
 *
 * A plain boolean and not a third state: "the switch is on but the engine could
 * not start" is a *runtime* answer, and it belongs to the surface that tried
 * (the rail states it, with the backend's own sentence and a way back) rather
 * than to the setting that asked for the attempt.
 */
export const AGENT_PANEL_DEFAULT = false

export function createAgentSettings() {
  const agentPanel = ref<boolean>(readBool(LS_AGENT_PANEL, AGENT_PANEL_DEFAULT))

  watch(agentPanel, (v) => persistence.set(LS_AGENT_PANEL, String(v)))

  return { agentPanel }
}
