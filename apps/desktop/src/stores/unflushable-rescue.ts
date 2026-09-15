/**
 * The way out of a close that a refused save would otherwise block forever.
 *
 * `flushDirty()` cannot put every dirty tab on disk when one of them is
 * read-only: the backend refuses that write deliberately, and no retry of it can
 * ever land. The close then will not go ahead — correctly, since the text is
 * unsaved — but a user who typed into a protected note (a note restored from the
 * trash carries the bit, so they need never have set it) had no move left at
 * all: Ctrl+S refused, the X refused, and the only ways out were to lose the
 * edits or to leave the app and `chmod` the file. Offer the one route that needs
 * neither the protected file nor a retry, and let the close go ahead once the
 * text is somewhere the user chose.
 *
 * **One loop, two controls.** The window close asks this before it lets the
 * window go (`app-lifecycle.ts`), and "Close all" asks it before it takes the
 * tab set away (`tab-close.ts`), because the two actions differ and the question
 * a refused save asks does not. One of the two carried its own copy of the loop
 * and the other carried nothing, which is exactly how the same action came to
 * have different powers depending on which control issued it — so the loop lives
 * here, and callers get it by asking for this factory rather than by writing it
 * again.
 *
 * Read from a store-shaped slice rather than from the store itself, like the
 * other save-path modules (`refused-save.ts`, `tab-settle.ts`): this names the
 * part of the store the route uses, and keeps the module cycle-free — the app
 * layer instantiates it, the store layer instantiates it, and neither has to
 * import the other.
 */

import type { RecoveryPrompt } from '../services/errors'
import type { OpenTab } from './tabs'

/** What the route needs of whoever owns a tab set. Narrower than the store on
 *  purpose, the same way `RefusedSaveCopyPort` is narrower than the fs gateway:
 *  it is the part of it this route uses. */
export interface UnflushableRescuePorts {
  /** The open tabs, read fresh: the loop asks again after every await, because
   *  the saves it awaits are exactly where a tab is closed or a copy retargets
   *  it. A getter and not a snapshot — the two callers hold the set in two
   *  different shapes (`app-lifecycle.ts` reads the store's unwrapped array, the
   *  store itself holds the ref), and a getter is the one that stays live for
   *  both. */
  listTabs(): OpenTab[]
  t: (key: string, params?: Record<string, unknown>) => string
  notifyRecovery(prompt: RecoveryPrompt): void
  /** `offerCopy` is the whole point: only a save the user asked for may put a
   *  file dialog in front of them (see `TabSaveOptions.offerCopy`), and this
   *  route is a question they answered. */
  saveTab(id: string, opts: { offerCopy: true }): Promise<boolean>
  /** The gate the close asks instead of `saveTab`: one landed write is not a
   *  saved tab (`tab-settle.ts`). */
  saveUntilSettled(id: string): Promise<boolean>
}

export function createUnflushableRescue(ports: UnflushableRescuePorts) {
  const { listTabs, t, notifyRecovery, saveTab, saveUntilSettled } = ports

  /** The user's answer to the copy question below. */
  function requestSaveCopies(count: number): Promise<boolean> {
    return new Promise((resolve) => {
      notifyRecovery({
        message: t('tabs.unsavedWorkRescue', { count }),
        onRestore: () => resolve(true),
        onDismiss: () => resolve(false),
      })
    })
  }

  /**
   * Offer the copy of every tab a refused flush could not put on disk. Resolves
   * true only once the caller may go on: every stuck tab's text is on disk under
   * a name the user picked, or the route did not apply (nothing was stuck).
   *
   * False is not a failure to report — the caller has its own sentence for the
   * close it is about to refuse, and the refusal itself has already been named
   * by the write path.
   */
  return async function rescueUnflushableTabs(): Promise<boolean> {
    const stuck = listTabs().filter((tab) => tab.dirty && tab.path)
    if (stuck.length === 0) return false
    if (!(await requestSaveCopies(stuck.length))) return false
    for (const tab of stuck) {
      // Resolves true only once that tab's text is on disk — under the copy's
      // name. A cancelled dialog, or a copy that was refused in turn, leaves
      // this false and the close refused, with the text still in the editor.
      if (!(await saveTab(tab.id, { offerCopy: true }))) return false
      // That true is "the text this save captured is on disk", not "this tab is
      // saved": a keystroke landing while the copy was written leaves the tab
      // dirty holding text no file has, and the close this rescue exists to let
      // through cancels the autosave timer the keystroke armed — so the "own
      // save" the write path relies on can never happen on this route. Settle it
      // where the copy put it, with the gate the closes use.
      //
      // The copy option does not survive the first attempt, by construction:
      // `saveUntilSettled` retries through `saveTab(id)`, and a retry that still
      // offered a copy would re-open a dialog for a tab that has a path now. A
      // tab nobody typed into during the copy is settled already, and asking the
      // gate again would write the same bytes a second time.
      const copied = listTabs().find((x) => x.id === tab.id)
      if (copied?.dirty && !(await saveUntilSettled(tab.id))) return false
    }
    return true
  }
}

export type UnflushableRescue = ReturnType<typeof createUnflushableRescue>
