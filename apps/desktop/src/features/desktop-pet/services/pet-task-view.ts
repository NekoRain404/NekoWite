/**
 * The window's read model: what the host's snapshot means on screen (§9's 快照到展示).
 *
 * It is the one thing the pet's drawing needs that the snapshot does not already say. `PetTaskList`
 * draws the rows from `PetTaskProjection[]` as they arrive (`pet-bubble-layout.ts` decides their
 * order), and nothing here repeats that: this file answers a different question, which is *what
 * the character is doing* when several tasks are in flight at once. §6.3 gives that rule a
 * name — 「聚合角色优先呈现待授权/失败等需关注状态，再工作，再短暂完成，再待机」 — and gives it
 * an order that is not any single task's.
 *
 * Three boundaries, because each is a thing this file must not become:
 *
 *  - **It does not decide notification delivery.** Nothing here says whether a sound plays, a
 *    system notification is sent or a task is unread — that is §6.3's one backend ledger (D5), and
 *    a second opinion on the frontend is how one completion becomes two sounds. What this file
 *    produces is a *mood*: a fact about what to draw.
 *  - **It holds nothing.** {@link buildPetTaskView} is a function of its input, and there is no
 *    store, no subscription and no cache behind it. That is §6.1's single source of truth applied
 *    to a display: a window that remembered a task between snapshots would be holding a fact the
 *    host has since replaced — and the case it would get wrong is the one §6.1's `runtimeEpoch`
 *    exists for, where the next engine reports the *same* session id and a remembered entry quietly
 *    answers for it. The task subscription belongs to `use-pet-lifecycle.ts`, which is also the
 *    only thing that knows the host went away.
 *  - **It never decides which epoch is current.** The display cannot: `registry.rs` mints epochs as
 *    `epoch-<pid>-<counter>`, so "later string" is not "later incarnation", and the host is the only
 *    party that knows which instance it is serving. A comparison here would be a second answer that
 *    disagrees the first time a start fails.
 *
 * The mood vocabulary is the sprite's own, not a new one: `idle`, `working`, `waiting` and `done`
 * are the states `DEFAULT_ANIMATION_CONFIG.stateRows` maps to rows 0, 7, 6 and 3
 * (`rendering/animation-bindings.ts:78-101`), and `DesktopPetRoot.vue:39` takes exactly this
 * string. A state with no row falls to the sheet's own fallback, and §5.2 lets the user bind one —
 * which is why the mapping is four coarse moods and not nine states.
 */
import {
  PET_ALERT_BY_STATE,
  isPetTaskSettled,
  petOutcomeFromRuntimeLoss,
  type PetTaskAlert,
  type PetTaskProjection,
} from '../../../platform/gateways/pet-contracts'

/**
 * What the character plays, in the sprite's own vocabulary.
 *
 * Four and not nine. `DEFAULT_ANIMATION_CONFIG.stateRows` has a row for each of these, which is
 * what makes them renderable on a sheet that has never heard of this feature; anything finer would
 * be a mood the default sheet draws as idle, and a pet that looks asleep during a failure is worse
 * than one that looks attentive during a success.
 */
export const PET_TASK_MOODS = ['idle', 'working', 'waiting', 'done'] as const

export type PetTaskMood = (typeof PET_TASK_MOODS)[number]

/** §6.2's 待授权/失败/中断 all need the user, and the sheet draws all of them as `waiting`. */
const MOOD_BY_ALERT: { [A in PetTaskAlert]: PetTaskMood } = {
  'needs-attention': 'waiting',
  quiet: 'working',
  'turn-finished': 'done',
}

/**
 * How long a completion holds the character before it goes back to idle.
 *
 * §6.3 calls the completion tier 短暂, and without a bound it is not brief — it is a pose the
 * character stands in until something else happens, which is the same defect as a notification
 * that never clears. The figure is §6.3's suggested bubble lifetime (6 seconds) rather than a new
 * number, so the two do not disagree about how long "just finished" lasts. Only this tier is
 * time-bounded: a task that needs the user stays until the user deals with it, which is the
 * correction §3.1.3 makes.
 */
export const PET_COMPLETION_HOLD_MS = 6_000

/** What the window renders from, and nothing else. */
export interface PetTaskView {
  /**
   * The tasks, as the host stated them — or, when the host is gone, the same tasks restated as
   * `unknown`. Never fewer: a window that dropped them would be §3.1.2's defect (upstream deletes
   * quiet sessions) committed by the display instead of by the host.
   */
  tasks: readonly PetTaskProjection[]
  /** §6.3's aggregate, for the character. `null` when there is nothing to show. */
  alert: PetTaskAlert | null
  /** The aggregate, as the row the sprite plays. */
  mood: PetTaskMood
  /**
   * Whether the host could be reached at all.
   *
   * Kept because "nothing is running" and "nobody can say what is running" look identical in
   * `tasks` and are not the same thing (§7.2's rule about stating what is missing, applied to the
   * connection). `DesktopPetRoot.vue` shows a sentence for the second.
   */
  hostLost: boolean
}

export interface PetTaskViewInput {
  /** Every task the host handed the window, in whatever order it sent them. */
  tasks: readonly PetTaskProjection[]
  /**
   * The clock, in epoch ms, on the same scale as `updatedAt` — the host's, injected (§10.2). Left
   * out while a caller has none, in which case the wall clock is read here, the same fallback
   * `PetTaskList.vue` makes for its elapsed field. A test always passes one.
   */
  now?: number
  /**
   * The window cannot reach the host (§6.2's last row).
   *
   * Deliberately one flag and not a `PetRuntimeLoss`: `runtime-crashed` is the *host's* news, and
   * the host states it in the list itself — a task it watched go down arrives as `interrupted`,
   * already restated by the layer that saw the process exit. By the time a window hears
   * `runtime-crashed` from an unreachable host, what it has is `connection-lost`: the absence of
   * knowledge, not a fact.
   */
  hostLost?: boolean
  /** Overrides {@link PET_COMPLETION_HOLD_MS}. Injected so a test can shorten it rather than wait. */
  completionHoldMs?: number
}

/**
 * What the pet does about the tasks as a whole, or `null` when there is nothing to react to.
 *
 * §6.3's order, derived from the contract's own two axes rather than from a second table of
 * states: `PET_ALERT_BY_STATE` says what the pet does about a state, `isPetTaskSettled` says
 * whether it is an ending. Together they give exactly the three tiers:
 *
 *  - anything needing the user wins outright — this is §3.1.3's correction, and the reason a task
 *    waiting on a permission is never hidden under one that is merely busy;
 *  - a `quiet` task that has *not* settled is a run in flight, so `working`;
 *  - a `turn-finished` task is the brief completion. A `cancelled` task is `quiet` *and* settled,
 *    so it is neither — which is §6.2's rule that a cancellation is no more a success than it is a
 *    failure, and the reason the character goes back to idle rather than waving.
 *
 * A state whose completion is older than the hold has stopped being news and is skipped, so the
 * character returns to idle on its own. Nothing else expires on a clock: a failure or a permission
 * is still true an hour later.
 */
export function petTaskAlert(
  tasks: readonly PetTaskProjection[],
  options: { now?: number; completionHoldMs?: number } = {},
): PetTaskAlert | null {
  const hold = options.completionHoldMs ?? PET_COMPLETION_HOLD_MS
  let running = false
  let justFinished = false

  for (const task of tasks) {
    const alert = PET_ALERT_BY_STATE[task.state]
    if (alert === 'needs-attention') return 'needs-attention'
    if (alert === 'turn-finished') {
      // The clock is read here and nowhere else, so a list with nothing finishing in it answers
      // the same thing whatever the caller's clock says — which is what lets this sit inside a
      // computed without looking like it depends on time.
      //
      // `updatedAt` is the host's clock and the reading is on the same scale, so the difference is
      // the host's own measure of how long ago it changed, not the window's guess at one.
      if (clockOf(options.now) - task.updatedAt < hold) justFinished = true
      continue
    }
    // The remaining arm is `quiet`, which is two states: a run in flight, and a cancellation.
    if (!isPetTaskSettled(task.state)) running = true
  }

  if (running) return 'quiet'
  return justFinished ? 'turn-finished' : null
}

/**
 * The alert, as the row the sprite plays.
 *
 * `null` — nothing to show — is `idle` and not `done`: a pet that has nothing to report is
 * standing around, not celebrating something that ended before the window opened.
 */
export function petTaskMood(alert: PetTaskAlert | null): PetTaskMood {
  return alert === null ? 'idle' : MOOD_BY_ALERT[alert]
}

/**
 * The window's view of the host's snapshot.
 *
 * Two things happen here and they are the whole file. The aggregate is computed by
 * {@link petTaskAlert}; and, when the host cannot be reached, each task is restated from D1's own
 * table for a lost runtime (`petOutcomeFromRuntimeLoss`) rather than by this file naming a state.
 *
 * The restatement is the part worth being precise about, because both obvious alternatives are
 * wrong. Keeping the states would leave the window asserting `working` about a run it can no
 * longer see — a fact it cannot support, and §6.2 forbids exactly that direction of error (a
 * connection that is lost may never be read as an ending). Dropping the tasks would be §3.1.2's
 * defect: silence removing work from the list. What is left is what the window actually knows —
 * each task exists, and its state is unknown — and it carries one more thing: the permission
 * request id is cleared, because §7.2 forbids an inert button and §11 forbids an expired request
 * from staying operable. `updatedAt` is deliberately left alone: the window is not the host and
 * does not get to stamp the host's clock.
 */
export function buildPetTaskView(input: PetTaskViewInput): PetTaskView {
  const lost = input.hostLost === true
  const tasks = lost ? restateUnknown(input.tasks) : input.tasks
  const alert = petTaskAlert(tasks, {
    now: input.now,
    completionHoldMs: input.completionHoldMs,
  })
  return { tasks, alert, mood: petTaskMood(alert), hostLost: lost }
}

function restateUnknown(tasks: readonly PetTaskProjection[]): PetTaskProjection[] {
  if (tasks.length === 0) return []
  const known = petOutcomeFromRuntimeLoss('connection-lost')
  return tasks.map((task) => ({
    ...task,
    state: known.state,
    permissionRequestId: known.permissionRequestId,
  }))
}

/** The injected clock, or the wall clock when the caller has none — the same fallback D9 makes. */
function clockOf(now: number | undefined): number {
  return typeof now === 'number' && now > 0 ? now : Date.now()
}
