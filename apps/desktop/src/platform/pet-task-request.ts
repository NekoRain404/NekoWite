/**
 * The pet's click on a task, as the main window hears it.
 *
 * §6.2's 点击返回任务 has two halves, and this is the receiving one: the pet window's row calls
 * `desktop_pet_open_task`, the host raises this window and retains a request before signalling
 * `pet-open-task`. This listener consumes pending requests after mounting and on each signal. What
 * arrives here is D1's `PetTaskKey` — the session, the profile, the engine, the epoch, the session
 * id and the run — and nothing else. No URL, no path, no command: §6.3 requires a notification's
 * action to be a host-issued target, and the key is the only shape the host mints.
 *
 * **This file is the one `tauri-pet.ts` used to name and nothing had written.** The comment on
 * `PET_TASK_OPEN_CHANNEL` there asserted that "the receiving half is `platform/pet-task-request.ts`"
 * while the path did not exist, so a click raised the window and emitted an event nobody heard.
 * That is the same defect class as the comment the reminder ledger removed one file over — a name
 * stating a wiring state that was not so — and it is closed by this file existing rather than by
 * the sentence being reworded.
 *
 * The channel name is not spelled here: `tauri-pet.ts` exports `PET_TASK_OPEN_CHANNEL`, and a
 * second spelling would be a click that raises a window and focuses nothing. What the main window
 * does with the key is `app/pet-task-link.ts`'s business; this layer only checks that what arrived
 * is a key (`isPetTaskKey`) and hands it on.
 *
 * Like `platform/pet-settings-request.ts` and `platform/open-request.ts`, this is a narrow platform
 * adapter: outside Tauri there is no such window and `listen` has nothing to register, so the caller
 * is handed a no-op release and the layers above stay free of the bridge.
 */

import { onPetNavigation } from './pet-navigation-listener'
import { isPetTaskKey, type PetTaskKey } from './gateways/pet-contracts'
import { PET_TASK_OPEN_CHANNEL } from './gateways/tauri-pet'

/**
 * Call `cb` whenever the pet window clicked a task.
 *
 * Resolves to the unsubscribe, or to a no-op outside Tauri, so the caller can always release what
 * it was given — the shape `onOpenFileRequest` established and `onPetSettingsRequest` kept.
 *
 * A payload that is not a key is refused here and never reaches `cb`. The alternative — handing a
 * half-key on and letting the consumer notice — is not available: the consumer focuses a session by
 * it, and the store's `focus` accepts any string, so a malformed payload would silently address a
 * session that does not exist and mark the one on screen unread behind it. The refusal is stated in
 * the console rather than swallowed, because the only producer of this channel is the host.
 */
export async function onPetTaskRequest(cb: (key: PetTaskKey) => void): Promise<() => void> {
  return onPetNavigation<unknown>(
    PET_TASK_OPEN_CHANNEL, 'desktop_pet_take_task_requests', (request) => {
      if (!isPetTaskKey(request)) {
        console.error(
          `[NekoWite] a ${PET_TASK_OPEN_CHANNEL} payload was not a task key, so nothing was focused`,
          request,
        )
        return
      }
      cb(request)
    },
  )
}
