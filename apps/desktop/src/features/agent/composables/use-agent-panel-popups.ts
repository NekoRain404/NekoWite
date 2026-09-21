/**
 * The panel's two popups: the control each hangs from, the element each is teleported into, and the
 * doors each opens.
 *
 * Both are rendered by `AgentPanel.vue`'s own template — a composable cannot bind a template ref for
 * markup it does not render — and both *placements* are one fact about the panel rather than two
 * about its menus: a popup left on `body` resolves `palettes.css`'s `:root` block — the light
 * palette, the default accent, the default face — inside a window the user has told to draw a dark
 * theme, because `AppShell.vue:285` publishes the appearance on `.shell` and nowhere else. Each
 * answer is walked from the control its own popup hangs off; today the bar draws both, so they are
 * one element.
 *
 * **The carrier is resolved by `computed` rather than once in `onMounted`, and the history control
 * is the reason**: the bar draws it on the engine's own `session/list` answer
 * (`AgentSessionBar.vue:354`), which arrives *after* the panel mounts — so a value taken at mount
 * would be `body`, the fallback standing in silently for a control that was merely late. Measured:
 * the `onMounted` shape passes for the options menu and fails for the session list.
 *
 * `body` is that fallback and not a second answer: a `Teleport` aimed at a selector that matched
 * nothing renders *nothing*, so a page without a shell must still get its popups — and the pet
 * window's page, which publishes the appearance on its document element, is that page.
 *
 * **What each popup is, is the two composables beside this one.** The session list's gates, its four
 * states and its free action are `use-agent-session-history`'s; the options rows and their own gates
 * are `use-agent-panel-menu`'s. This file supplies the two things only the panel has — the elements
 * the popups *are*, which its template binds and hands in, and the events a door leaves through,
 * which it forwards: a load has to be made for the rail's vault and it replaces the session this
 * panel is mounted on, so both callbacks leave the component as events.
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type {
  AgentCapabilityReport,
  AgentGateway,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { popupHostOf } from '../../../components/popup-host'
import type { AgentPanelLabels } from '../components/agent-panel-labels'
import AgentPanelMenu from '../components/AgentPanelMenu.vue'
import AgentSessionBar from '../components/AgentSessionBar.vue'
import AgentSessionHistoryMenu from '../components/AgentSessionHistoryMenu.vue'
import { useAgentPanelMenu, type AgentPanelMenuState } from './use-agent-panel-menu'
import { useAgentSessionHistory, type AgentSessionHistory } from './use-agent-session-history'

export interface UseAgentPanelPopupsOptions {
  /** The bar, which draws both controls and exposes the two elements they are. Bound by the panel's
   *  template (`ref="barEl"`) and handed in rather than created here, for the reason
   *  `use-agent-panel-menu`'s own `popup` gives: it is an element the caller's template owns. */
  bar: Ref<InstanceType<typeof AgentSessionBar> | null>
  /** The options menu's own component, rendered by the panel's template under `ref="menuEl"`. */
  optionsMenu: Ref<InstanceType<typeof AgentPanelMenu> | null>
  /** The session list's own component, rendered by the panel's template under `ref="historyEl"`. */
  historyMenu: Ref<InstanceType<typeof AgentSessionHistoryMenu> | null>
  /** The adapter behind the session: the history list's reads go through it. */
  gateway: AgentGateway
  /** The session on screen — its id names the list's current row, and its runtime is asked. */
  session: AgentSession
  /** The directory this runtime works in — the vault root on disk — handed to the history list
   *  unchanged. What the one comparison it feeds means is stated once, where it is made:
   *  `agent-session-history.ts`'s `AgentSessionHistoryInput`. */
  cwd: string
  /** The engine's whole report for this session's runtime: the history control's gate.
   *  `use-agent-capability-report` reads it; the composer reads the same ref. */
  capabilities: Ref<readonly AgentCapabilityReport[] | null>
  /** The options menu's words, from the panel's own catalogue entry: the control's label and the
   *  three rows'. Handed in whole rather than pre-split, because the label names both the control in
   *  the bar and the box it opens — they are one sentence. */
  menuLabels: AgentPanelLabels['menu']
  /** Whether the caller can open the settings dialog on the agents tree. Absent means no — see the
   *  panel's own prop, which is where each of these is explained. */
  settingsOpenable: boolean
  /** Whether the caller can put the rail back on the chat panel. */
  chatOpenable: boolean
  /** Whether the caller can take the engine down and bring it back up. */
  restartOpenable: boolean
  /** The reader picked a session out of the engine's history: the reopen is the caller's. */
  onResume: (sessionId: string) => void
  /** The reader asked for a new session on the runtime that is up. Also the caller's. */
  onNewSession: () => void
  /** The reader asked for the agent settings. */
  onOpenSettings: () => void
  /** The reader asked for the chat panel instead of this one. */
  onUseChat: () => void
  /** The reader asked for the engine to be restarted. */
  onRestart: () => void
}

export interface AgentPanelPopups {
  /** Where the options menu is teleported: the carrier of the control it hangs off. */
  menuHost: ComputedRef<Element | string>
  /** Where the session list is teleported: the carrier of the control it hangs off. */
  historyHost: ComputedRef<Element | string>
  /** The options menu: its rows, its placement, and what a press means. */
  menu: AgentPanelMenuState
  /** The engine's *other* sessions: the control's gate, the list it opens, and the free action. */
  history: AgentSessionHistory
}

export function useAgentPanelPopups(options: UseAgentPanelPopupsOptions): AgentPanelPopups {
  const menuHost = computed(() => popupHostOf(options.bar.value?.menuElement()))
  const historyHost = computed(() => popupHostOf(options.bar.value?.triggerElement()))

  /**
   * The engine's *other* sessions (§5.3's history control). The three things this file supplies are
   * the ones only it has: the element the list hangs from and the element the list *is* — both of
   * which the panel's template owns — and the two events a pick or a new-session leaves through.
   */
  const history = useAgentSessionHistory({
    gateway: options.gateway,
    sessionId: options.session.sessionId,
    cwd: options.cwd,
    capabilities: options.capabilities,
    trigger: computed(() => options.bar.value?.triggerElement() ?? null),
    popup: options.historyMenu,
    onResume: options.onResume,
    onNewSession: options.onNewSession,
  })

  /** The options menu, whose rows are all doors out of the panel — see `use-agent-panel-menu` for
   *  why each is gated on its own capability. */
  const menu = useAgentPanelMenu({
    trigger: computed(() => options.bar.value?.menuElement() ?? null),
    popup: options.optionsMenu,
    restartOpenable: options.restartOpenable,
    settingsOpenable: options.settingsOpenable,
    chatOpenable: options.chatOpenable,
    labels: {
      settings: options.menuLabels.settings,
      chat: options.menuLabels.chat,
      restart: options.menuLabels.restart,
    },
    onSettings: options.onOpenSettings,
    onChat: options.onUseChat,
    // An event rather than a call, for the reason `resume`'s own doc gives: the restart replaces
    // the session this panel is mounted on and only the rail can re-point it.
    onRestart: options.onRestart,
  })

  return { menuHost, historyHost, menu, history }
}
