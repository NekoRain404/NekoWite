/**
 * The options menu: the panel's one place from which the actions that live outside it are reached.
 *
 * Both of its rows are doors out of the panel — the settings dialog and the rail's switch back to
 * the chat — so neither action is this composable's: a row *leaves* as a callback, and what the
 * caller does with it belongs to the shell that owns the dialog and to
 * `stores/settings-agent.ts` that owns the switch. What is here is the shape: which rows exist,
 * where the popup goes, and what a press on a row means.
 *
 * **The rows are derived rather than kept as a list of their own**, so a row cannot outlive the
 * ability behind it: the menu is drawn only while that list is non-empty, and an empty one is not
 * drawn rather than drawn empty. Each row is gated on its own capability rather than on "the panel
 * is live", which is the same rule the history control follows.
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useDetachedPopup, type PopupPlacement } from './use-detached-popup'
import AgentPanelMenu, { type AgentPanelMenuRow } from '../components/AgentPanelMenu.vue'

export interface UseAgentPanelMenuOptions {
  /** The control the menu hangs from: the options button in the session bar. */
  trigger: Ref<HTMLElement | null>
  /**
   * The menu's own component, which the caller renders and binds with `ref`.
   *
   * Handed in for the same reason `trigger` is: both are elements the caller's *template* owns,
   * and a composable cannot bind a template ref for markup it does not render.
   */
  popup: Ref<InstanceType<typeof AgentPanelMenu> | null>
  /**
   * Whether the caller can open the settings dialog on the agents tree — the same rule the
   * history control's `openable` follows.
   *
   * The dialog is not the panel's and never becomes it: `showSettings` is the window root's and
   * the landing section travels with the request (`features/settings/types.ts`,
   * `SettingsOpenTarget`). A panel whose caller says no here draws no such row, rather than one
   * that emits into nothing.
   */
  settingsOpenable: boolean
  /**
   * Whether the caller can put the rail back on the chat panel — the same rule again.
   *
   * The rail already offers this way out from its refused state (`AgentRailBody.vue`'s 用对话面板
   * action), and the live panel had no equivalent: a reader who wanted the chat back had to find
   * the switch in the settings dialog, or close and reopen the rail on the other tab.
   */
  chatOpenable: boolean
  /** The copy for the two rows, from the panel's own catalogue entry. */
  labels: { settings: string; chat: string }
  /** The reader asked for the agent settings. */
  onSettings: () => void
  /** The reader asked for the chat panel instead of this one. */
  onChat: () => void
}

export interface AgentPanelMenuState {
  /** The rows to draw, in the order the panel decided. Empty is not drawn. */
  rows: ComputedRef<readonly AgentPanelMenuRow[]>
  /** Whether the menu is up. */
  open: Ref<boolean>
  /** Where it was put, in viewport coordinates. */
  placement: Ref<PopupPlacement>
  /** Open the menu, or take it away — the trigger is a toggle. */
  toggle(): Promise<void>
  /** Close it and hand the keyboard back to the control it belongs to. */
  close(): void
  /** Act on a row. */
  choose(id: string): void
}

export function useAgentPanelMenu(options: UseAgentPanelMenuOptions): AgentPanelMenuState {
  const rows = computed<readonly AgentPanelMenuRow[]>(() => {
    const built: AgentPanelMenuRow[] = []
    if (options.settingsOpenable) built.push({ id: 'settings', label: options.labels.settings })
    if (options.chatOpenable) built.push({ id: 'chat', label: options.labels.chat })
    return built
  })

  /**
   * Where the menu goes, when it closes, and who owns Escape while it is up — the same recipe as
   * the session list beside it, measured against the control in the bar.
   */
  const menu = useDetachedPopup({
    floor: 180,
    claim: 'agent-options-menu',
    trigger: options.trigger,
    popup: () => options.popup.value?.element() ?? null,
  })

  /** Open the menu, or take it away — the trigger is a toggle, like the history control beside it. */
  async function toggle(): Promise<void> {
    if (menu.open.value) {
      close()
      return
    }
    await menu.show()
    options.popup.value?.focusFirst()
  }

  /** Close the menu and hand the keyboard back to the control it belongs to. */
  function close(): void {
    menu.hide()
    options.trigger.value?.focus()
  }

  /**
   * Act on a row.
   *
   * Both rows leave as a callback, because neither thing they ask for is this composable's: the
   * dialog belongs to the window root, and the rail's switch to the shell that reads it. `id` is
   * typed as a plain string because that is what crosses a component boundary in this codebase, and
   * the two cases below are exhaustive against {@link rows} — the ids pushed there and the ids
   * handled here are the same pair, and a row added to only one of them fails
   * `AgentPanel.menu.test.ts`, which is the test that exists for exactly that.
   */
  function choose(id: string): void {
    close()
    switch (id) {
      case 'settings':
        options.onSettings()
        return
      case 'chat':
        options.onChat()
    }
  }

  return { rows, open: menu.open, placement: menu.placement, toggle, close, choose }
}
