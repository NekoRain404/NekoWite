/**
 * Where the pet's menu goes: a clamp, and the one thing the clamp changes about the entrance.
 *
 * The pet window is small and frameless, so the menu hangs off the point that was right-clicked.
 * At the window's edge there is nowhere for it to go: unclamped, a menu opened near the
 * bottom-right corner is drawn mostly outside the window — and a frameless window has no
 * scrollbar, no title bar and no resize handle to bring it back with, so a right-click there looks
 * like a right-click that did nothing.
 *
 * The arithmetic is the one `src/ui/ContextMenu.vue` already uses in the editor window (its
 * `place()`), and it is restated here rather than imported for a reason the plan names: that
 * component imports the application's whole i18n dictionary (`import { t } from '../i18n'`), and
 * §7.1 does not let this window carry it — `app/desktop-pet-entry.test.ts` asserts the pet's graph
 * stops short of `ui/` for exactly this. Same rule, own copy; the alternative is a menu placed by
 * a module that drags the editor's dictionary into a decoration.
 *
 * It is a function over numbers rather than a method on the component so the two cases that matter
 * — the corner, and a menu taller than its window — are assertions instead of screenshots.
 */

import type { PetSettingsPage } from '../../../platform/gateways/pet-contracts'

/** Space kept between the menu and the window's edge, so a clamped menu is legible. */
export const PET_MENU_PAD = 8

/**
 * What picking a menu item asks for.
 *
 * Three actions and no more, each one a call the host actually has: `PetGateway` has `setVisible`
 * and `openSettings`, and a task list is a surface this window already owns. Upstream's tray menu
 * also offered 退出, 更新 and 开机启动 (`windows/src/popover.ts` 111-135) — three duplicated shells
 * §4 removes from the port, and a pet window that could quit the application would be the second
 * quit path §7.1 forbids. An action type is the place that stays true: a new item has to name a
 * call, and there is nothing here to name.
 *
 * The settings action carries its page (§5.1: 右键"设置"打开主窗口并定位到 desktop-pet 及指定子页),
 * so the composition that receives it does not have to guess which page the menu meant.
 */
export type PetMenuAction =
  | { id: 'tasks' }
  | { id: 'settings'; page: PetSettingsPage }
  | { id: 'hide' }

export interface PetMenuPlacement {
  left: number
  top: number
  /**
   * True when the clamp pushed the menu above the point it opened at.
   *
   * Read by the stylesheet: the entrance grows out of the corner it shares with the pointer, and
   * that corner has become the menu's bottom edge. Left as "down", the menu would sit above the
   * pointer while rising from below it — arriving from the gap underneath, where nothing happened.
   */
  flipped: boolean
}

export interface PetMenuPlacementInput {
  /** The point that was clicked, in window coordinates. */
  anchor: { x: number; y: number }
  /** The menu's own box, measured after it is in the DOM at its natural size. */
  size: { width: number; height: number }
  /** The window it has to fit in. */
  viewport: { width: number; height: number }
  pad?: number
}

/**
 * The menu's position inside the window, whatever the anchor was.
 *
 * `Math.max(pad, …)` around the upper bound is what keeps a menu bigger than its window from being
 * placed at a negative offset: a 300px window cannot hold a long Chinese menu, and a menu that
 * starts off-screen is one whose first item cannot be clicked at all. Half a pixel is rounded
 * away, because a menu drawn on a half pixel is a menu whose text is resampled.
 */
export function placePetMenu(input: PetMenuPlacementInput): PetMenuPlacement {
  const pad = input.pad ?? PET_MENU_PAD
  const { anchor, size, viewport } = input

  const left = Math.min(
    Math.max(pad, Math.round(anchor.x)),
    Math.max(pad, Math.round(viewport.width - size.width - pad)),
  )
  const top = Math.min(
    Math.max(pad, Math.round(anchor.y)),
    Math.max(pad, Math.round(viewport.height - size.height - pad)),
  )

  return { left, top, flipped: top + size.height / 2 < anchor.y }
}
