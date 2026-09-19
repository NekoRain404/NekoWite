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
 * ## Why the default is on (and the argument for off, which it overruled)
 *
 * This section said 「Why the default is off」 and gave two facts for it. Both
 * were real, and neither was wrong; the maintainer's own report is what settled
 * it the other way, and the reasoning is kept here because a reader deserves to
 * know what the change costs rather than only what it bought.
 *
 * **For off.** The panel needs an engine to be *there*, and whether one is
 * depends on the build: `program_to_launch` refuses with a sentence when the
 * sidecar was not carried by the package, and the refusal is correct — a build
 * without the bundled engine cannot run an agent at all. And the chat panel was
 * the surface that worked for every user, so §12's 分阶段替换 had the change
 * opted into by the person who wanted the panel rather than by everyone.
 *
 * **For on, which won.** §5.1 already requires the panel to state a missing
 * engine in the backend's own words and offer a way back — that requirement is
 * below, under the constant — so a wrong guess about a build costs a stated
 * refusal, not a lost chat panel. Against that, the cost of being off was
 * measured rather than argued: the maintainer could not find the `/` menu and
 * reported it as a feature that was never built. A surface nobody can reach looks
 * exactly like a surface nobody wired, and only one of the two shows up in a test
 * run.
 *
 * The rollback is unchanged and is what keeps this cheap to be wrong about: one
 * click in the other direction, persisted, so it survives the restart that would
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
 *
 * **On, since 2026-09-19, and it was off before that.** The maintainer reported
 * the symptom first and the cause turned out to be this constant: 「AI 界面没有
 * / 命令提示」 — the `/` menu exists, is mounted by the panel and is covered end
 * to end (`e2e/agent-command-menu.spec.ts` walks the reader's own route to it),
 * but the rail draws `ChatPanel` until this is on, and the chat panel has no
 * `/` menu at all. A surface nobody can find is the same defect as a surface
 * that is not wired; the difference is only which file you fix.
 *
 * What makes it safe to turn on by default: everything behind it is a
 * *runtime* answer, not an assumption. With no engine the panel states that,
 * with the backend's own sentence and a way back, which is what the paragraph
 * above is for. And the rollback is one click and persists — `AppShell.vue`'s
 * `@use-chat` sets this false, and this is read from `localStorage` on the next
 * launch like every other setting, so a reader who prefers the chat panel is
 * not dragged back here on every start.
 *
 * An existing installation that never touched the switch has no stored value
 * and therefore follows this default, which is the intended reading: the stored
 * value records a choice, and silence is not one.
 */
export const AGENT_PANEL_DEFAULT = true

export function createAgentSettings() {
  const agentPanel = ref<boolean>(readBool(LS_AGENT_PANEL, AGENT_PANEL_DEFAULT))

  watch(agentPanel, (v) => persistence.set(LS_AGENT_PANEL, String(v)))

  return { agentPanel }
}
