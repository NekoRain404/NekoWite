/**
 * What the pet's menu items do, in one place.
 *
 * D9's `pet-context-menu.ts` decides where the menu goes and names the three actions; this is
 * where each one becomes something. Two are calls on the host — `settings` raises the main window
 * on a page (§5.1: 右键"设置"打开主窗口并定位到 desktop-pet 及指定子页) and `hide` asks the host to stop
 * drawing — and the third is this window's own surface (the task list, which the pet already
 * owns). So the answer is not `void`: a caller that receives `window` knows it still has to show
 * the list, and one that receives `host` knows the host was asked. Returning nothing would make
 * "done" and "somebody else's job" indistinguishable, which is how a menu item comes to look like
 * it did nothing.
 *
 * The actions are §4's three and no more. There is no 退出, 更新 or 开机启动 here and nothing that
 * could implement one: a pet window that could quit the application would be the second quit path
 * §7.1 forbids, the updater belongs to the host's own flow, and startup registration is the
 * host's, not a decoration's.
 *
 * It takes a `PetGateway` rather than the composition's wider connection, because these are the
 * two calls the contract already has — a function that asked for more than it used would be a
 * reason for a caller to hold the teardown-capable object.
 */
import type { PetGateway } from '../../../platform/gateways/pet-contracts'
import type { PetMenuAction } from './pet-context-menu'

/**
 * Where an action was handled.
 *
 * `host` — the host was asked for something, and the call is on its way. `window` — the action is
 * this window's own surface, and the caller owns what happens next.
 */
export type PetMenuOutcome = 'host' | 'window'

export async function actOnPetMenu(
  gateway: PetGateway,
  action: PetMenuAction,
): Promise<PetMenuOutcome> {
  switch (action.id) {
    case 'settings':
      // The host raises the main window itself (§5.1: 主窗口隐藏时先安全唤起，不依赖 DOM 是否已挂载).
      // That is why this window sends a page rather than trying to find a window to talk to: a pet
      // window cannot name a window, and a request delivered to a page that is not mounted would
      // be a right-click answered by nothing.
      await gateway.openSettings(action.page)
      return 'host'
    case 'hide':
      // Hide and not disable: §7.1 keeps the reminders and the subscription, and the way back is
      // the same settings page, or this menu's own show item once the window is visible again.
      await gateway.setVisible(false)
      return 'host'
    case 'tasks':
      // The task list is a surface this window draws (`PetTaskList.vue`), so there is no call to
      // make — and the caller is told so rather than left to guess from a resolved promise.
      return 'window'
  }
}
