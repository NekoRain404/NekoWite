/**
 * The question a bulk route asks before it takes the tab set away.
 *
 * Three controls destroy every open tab: "Close all" (`tab-close.ts`), the
 * window's X (`app-lifecycle.ts`) and a vault switch (`app/vault-switch.ts`).
 * Each one flushes first, and the flush cannot carry an untitled tab — with no
 * path it would need a Save-As dialog a bulk flush must not open — so each one
 * has to ask the user about the untitled dirty ones before the set goes.
 *
 * That question is USER TIME in the middle of a destructive sequence. The prompt
 * is a corner toast with no focus trap, so the app stays live behind it and the
 * user can type into a tab that is not the one that raised it. The set is taken
 * after the answer, cancelling every tab's autosave timer on the way — so a
 * keystroke typed during the answer was destroyed, in no file and in no prompt,
 * while the question that would have covered it had been asked about a different
 * tab at an earlier moment. (And the tabs it was asked about are not the tabs it
 * destroys, which is the same defect from the other side.)
 *
 * So the question is asked HERE: at the point where the set actually goes, of
 * whatever is in the set at that moment, keyed by tab id so a tab the user has
 * already ruled on is never asked about a second time. That is the shape
 * `aa2155f` established for "Close all"; this module is the one implementation
 * of it, and the other two routes ask this factory for the loop rather than
 * carrying their own. Three copies of a loop whose entire subject is *when* it
 * runs is how the three controls came to disagree about what a close owes the
 * user's text.
 *
 * Read through store-shaped ports rather than from the store itself, like the
 * rest of the save path (`unflushable-rescue.ts`, `tab-settle.ts`): this names
 * the part of a tab set the loop uses, and keeps the module cycle-free — the
 * store layer instantiates it and the app layer instantiates it, and neither has
 * to import the other.
 */

import type { OpenTab } from './tabs'

/** What the user chose for the untitled dirty tabs a bulk route is about to
 *  destroy. Structural rather than imported: `UntitledCloseChoice`
 *  (`tab-lifecycle.ts`) and `UntitledVaultChoice` (`app/recovery-closed-loop.ts`)
 *  are the same two answers, and naming either one here would make this module
 *  depend on a layer that instantiates it. */
export type UntitledAnswer = 'save' | 'discard'

export interface UntitledRescuePorts {
  /** The untitled dirty tabs, read FRESH on every pass — never a snapshot taken
   *  before the question, which is the whole defect this loop closes. */
  listUntitledDirty(): OpenTab[]
  /** Every open tab, for the path'd half of the question below. */
  listTabs(): OpenTab[]
  /** Put the question to the user about `count` tabs at once. */
  ask(count: number): Promise<UntitledAnswer>
  /** The gate the closes ask, not `saveTab`: one landed write is not a saved tab
   *  (`tab-settle.ts`), and this loop's whole job is to run at the moment the
   *  autosave timers are cancelled — so a write that was overtaken by a keystroke
   *  has nowhere else to go. `false` ends the route. */
  settle(id: string): Promise<boolean>
  /** What this route does with a tab the user chose to discard. "Close all"
   *  leaves it where it is — `removeAllTabs()` takes the set a moment later, and
   *  removing it here would move the moment it disappears above the pass that is
   *  still looking for late typing. The two routes that keep the set alive past
   *  the loop (the window stays open on a refusal, the vault switch has not
   *  committed yet) take it out, which is what they did before the loop existed.
   *
   *  A discard is a ruling either way: a tab this ran for is in `answered` below
   *  and is not offered to the user again. */
  onDiscard(tab: OpenTab): void
  /** True when the work this route is doing has been superseded. Only the vault
   *  switch passes one: a second switch can begin while the user is reading the
   *  prompt, and the superseded one must stop before it asks again or writes
   *  another file. It then reports `false` and says nothing — a stale reason is
   *  not a refusal of anything the user is still doing. */
  isStale?: () => boolean
}

export function createUntitledRescue(ports: UntitledRescuePorts) {
  const { listUntitledDirty, listTabs, ask, settle, onDiscard, isStale } = ports
  const stale = (): boolean => isStale?.() === true

  /**
   * Ask about every untitled dirty tab the set holds NOW, settle the path'd ones
   * that were typed into after the caller's flush, and keep going until neither
   * is left. Resolves true when the caller may destroy the set.
   *
   * `answered` holds the ids of the tabs a prompt has already named, which is
   * what stops the re-ask from being a second nag: a tab the user ruled on is
   * never offered again — `discard` is a ruling too — while a tab that was not
   * part of what they answered about is asked, including one that only came into
   * existence while the toast was up (the + button, and a read landing on a
   * placeholder they typed into). Ids come from the lifecycle's monotonic
   * counter, so one id is one tab for the whole of this route.
   *
   * It ends, and that is a property of the loop rather than of the user:
   *
   *   - the untitled half cannot ask the same tab twice — `answered` only grows
   *     and a tab is put into it before the saves that follow, so no answer can
   *     be re-opened by the work it triggered;
   *   - each pass asks about a tab that no earlier pass asked about, and there
   *     are only as many tabs as the user has opened;
   *   - the path'd half ends when the typing does, each pass consuming exactly
   *     what overtook the last one — which rests on the gate's own postcondition,
   *     stated where the gate lives: `settle` answers true only for a tab that is
   *     gone or holds nothing that is not on disk (`tab-settle.ts`).
   *
   * When it cannot end — a tab that is dirty again after every write that lands
   * — the gate's own bound answers `false` (`tab-settle.ts`: three attempts per
   * tab) and the route refuses rather than retrying forever, with the text still
   * in the editor.
   */
  return async function rescueUntitledTabs(): Promise<boolean> {
    const answered = new Set<string>()
    for (;;) {
      if (stale()) return false
      const untitled = listUntitledDirty().filter((tab) => !answered.has(tab.id))
      if (untitled.length > 0) {
        const choice = await ask(untitled.length)
        if (stale()) return false
        // Recorded before the saves below and before the loop goes round again:
        // this answer is the user's ruling on exactly these tabs, and nothing
        // that follows it may re-open the question about one of them.
        for (const tab of untitled) answered.add(tab.id)
        if (choice === 'save') {
          for (const tab of untitled) {
            if (!(await settle(tab.id))) return false
            if (stale()) return false
          }
        } else {
          for (const tab of untitled) onDiscard(tab)
        }
        // A tab can arrive during the saves too, and the next pass is what asks
        // about it.
        continue
      }
      // A tab that is dirty HERE became dirty after the flush: the flush settles
      // what it touched, so what is left is the typing the answer above was
      // overtaken by. It is settled rather than asked about — it has a file, and
      // the question is only ever about text that has nowhere to go.
      const late = listTabs().filter((tab) => tab.path && tab.dirty)
      if (late.length === 0) break
      for (const tab of late) {
        if (!(await settle(tab.id))) return false
        if (stale()) return false
      }
    }
    return true
  }
}

export type UntitledRescue = ReturnType<typeof createUntitledRescue>
