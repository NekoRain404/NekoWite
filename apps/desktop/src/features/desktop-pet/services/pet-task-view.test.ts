/**
 * The window's read model: what the character shows when several tasks are in flight at once.
 *
 * Two of these assertions are the acceptance rather than tidiness. The first is §3.1.3's
 * correction — 「上游 working 情绪优先于 waiting」, so a run waiting on the user must not be shown
 * under one that is merely busy — and the second is §6.1's identity: two engines that both call
 * their session `ses_1` are two rows, and the aggregate has to see both. A display that grouped by
 * session id first would pass every other test in this file and fail those two.
 *
 * The rest is the boundary this file must keep. Nothing here is about a notification: the cases
 * below read a `mood` and never an unread count, a sound or a delivery, because §6.3 gives those
 * to one backend ledger and a second opinion on the frontend is how one completion becomes two
 * sounds.
 */
import { describe, expect, it } from 'vitest'
import {
  PET_ALERT_BY_STATE,
  PET_TASK_STATES,
  isPetTaskSettled,
  petTaskToken,
  type PetTaskAlert,
  type PetTaskKey,
  type PetTaskProjection,
  type PetTaskState,
} from '../../../platform/gateways/pet-contracts'
import { DEFAULT_ANIMATION_CONFIG } from '../rendering/animation-bindings'
import {
  PET_COMPLETION_HOLD_MS,
  PET_TASK_MOODS,
  buildPetTaskView,
  petTaskAlert,
  petTaskMood,
} from './pet-task-view'

/**
 * The host clock every case reads from.
 *
 * Fixed rather than `Date.now()` so the completion hold can be tested by moving a number instead
 * of waiting six seconds — §6.3's 「参数注入时钟测试，不写死到组件定时器」, applied to the one
 * thing here that is a duration.
 */
const NOW = 1_000_000

function task(
  state: PetTaskState,
  options: {
    agentId?: string
    runtimeEpoch?: string
    vaultId?: string
    sessionId?: string
    runId?: string
    updatedAt?: number
    permissionRequestId?: string | null
  } = {},
): PetTaskProjection {
  const key: PetTaskKey = {
    agentId: options.agentId ?? 'opencode',
    profileId: 'default',
    runtimeEpoch: options.runtimeEpoch ?? 'epoch-1',
    vaultId: options.vaultId ?? 'vault-a',
    sessionId: options.sessionId ?? 'ses_1',
    runId: options.runId ?? 'run-1',
  }
  return {
    key,
    state,
    permissionRequestId: options.permissionRequestId ?? null,
    updatedAt: options.updatedAt ?? NOW,
  }
}

describe('what the character shows', () => {
  it('is idle when there is nothing to show', () => {
    const view = buildPetTaskView({ tasks: [], now: NOW })

    expect(view.alert).toBeNull()
    expect(view.mood).toBe('idle')
  })

  it('prefers a task waiting on the user over one that is merely busy', () => {
    // §3.1.3 outright: upstream ranks `working` above `waiting` (`state.ts:43`).
    const view = buildPetTaskView({
      tasks: [task('working', { sessionId: 'ses_busy' }), task('waiting-input', { sessionId: 'ses_asked' })],
      now: NOW,
    })

    expect(view.alert).toBe('needs-attention')
    expect(view.mood).toBe('waiting')
  })

  it('prefers a failure over a task that is merely busy', () => {
    for (const settling of ['failed', 'refused', 'stopped', 'interrupted', 'unknown'] as const) {
      const view = buildPetTaskView({
        tasks: [task('working', { sessionId: 'ses_busy' }), task(settling, { sessionId: 'ses_bad' })],
        now: NOW,
      })
      expect(view.alert, settling).toBe('needs-attention')
    }
  })

  it('shows a run in flight over a completion', () => {
    const view = buildPetTaskView({
      tasks: [task('turn-finished', { sessionId: 'ses_done' }), task('working', { sessionId: 'ses_busy' })],
      now: NOW,
    })

    expect(petTaskAlert(view.tasks, { now: NOW })).toBe('quiet')
    expect(view.mood).toBe('working')
  })

  it('goes back to idle once a completion stops being news', () => {
    const finished = [task('turn-finished', { updatedAt: NOW - PET_COMPLETION_HOLD_MS + 1 })]
    expect(buildPetTaskView({ tasks: finished, now: NOW }).mood).toBe('done')

    const stale = [task('turn-finished', { updatedAt: NOW - PET_COMPLETION_HOLD_MS })]
    expect(buildPetTaskView({ tasks: stale, now: NOW }).mood).toBe('idle')
  })

  it('holds a completion for as long as the caller says, not for a fixed six seconds', () => {
    const tasks = [task('turn-finished', { updatedAt: NOW - 100 })]

    expect(petTaskAlert(tasks, { now: NOW, completionHoldMs: 50 })).toBeNull()
    expect(petTaskAlert(tasks, { now: NOW, completionHoldMs: 200 })).toBe('turn-finished')
  })

  it('never lets a failure or a permission expire the way a completion does', () => {
    // The asymmetry is the point of the hold: a completion is news, a failure is still true an
    // hour later, and §6.3's 「待授权必须可见」 cannot be satisfied by a mood that timed out.
    const old = NOW - 60 * 60 * 1_000
    for (const state of ['waiting-input', 'failed', 'refused', 'stopped', 'interrupted', 'unknown'] as const) {
      const view = buildPetTaskView({ tasks: [task(state, { updatedAt: old })], now: NOW })
      expect(view.alert, state).toBe('needs-attention')
    }
  })

  it('does not celebrate a cancellation', () => {
    // §6.2: a cancellation is neither a success nor a failure — the default reaction of "neither"
    // is no reaction at all, so the character goes back to idle rather than waving.
    const view = buildPetTaskView({ tasks: [task('cancelled')], now: NOW })

    expect(view.alert).toBeNull()
    expect(view.mood).toBe('idle')
  })

  it('sits each state in exactly the tier its own alert names', () => {
    // Derived from D1's two axes rather than from a second table of states, and checked against
    // them here so the two cannot drift apart in silence: a state that is announced as needing the
    // user must not be aggregated as if it did not.
    for (const state of PET_TASK_STATES) {
      const alert: PetTaskAlert = PET_ALERT_BY_STATE[state]
      const view = buildPetTaskView({ tasks: [task(state)], now: NOW })

      if (alert === 'needs-attention') expect(view.alert, state).toBe('needs-attention')
      else if (alert === 'turn-finished') expect(view.alert, state).toBe('turn-finished')
      else expect(view.alert, state).toBe(isPetTaskSettled(state) ? null : 'quiet')
    }
  })
})

describe('the tasks the view shows', () => {
  it('keeps every run, one row each', () => {
    const view = buildPetTaskView({
      tasks: [
        task('working', { sessionId: 'ses_1', runId: 'run-1' }),
        task('working', { sessionId: 'ses_1', runId: 'run-2' }),
        task('turn-finished', { sessionId: 'ses_2', runId: 'run-1' }),
      ],
      now: NOW,
    })

    expect(view.tasks).toHaveLength(3)
    expect(new Set(view.tasks.map((row) => petTaskToken(row.key))).size).toBe(3)
  })

  it('counts two engines that report one session id as two tasks', () => {
    const view = buildPetTaskView({
      tasks: [
        task('working', { agentId: 'opencode', sessionId: 'ses_1' }),
        task('waiting-input', { agentId: 'other-engine', sessionId: 'ses_1', permissionRequestId: 'req-1' }),
      ],
      now: NOW,
    })

    expect(view.tasks).toHaveLength(2)
    expect(
      petTaskAlert(view.tasks, { now: NOW }),
      'a display that collapsed by session id would see only the first row',
    ).toBe('needs-attention')
  })

  it('does not let one run’s permission make another run look asked', () => {
    const view = buildPetTaskView({
      tasks: [
        task('working', { runId: 'run-1' }),
        task('waiting-input', { runId: 'run-2', permissionRequestId: 'req-1' }),
      ],
      now: NOW,
    })

    const asking = view.tasks.filter((row) => row.permissionRequestId !== null)
    expect(asking.map((row) => row.key.runId)).toEqual(['run-2'])
  })
})

describe('a task from another runtime instance', () => {
  it('is a different task, and both are shown', () => {
    // §6.1's `runtimeEpoch`: the same engine, profile, vault, session and run id — one restart
    // apart. They are not one task, and a view that keyed on anything less would say they were.
    const view = buildPetTaskView({
      tasks: [
        task('turn-finished', { runtimeEpoch: 'epoch-1' }),
        task('working', { runtimeEpoch: 'epoch-2' }),
      ],
      now: NOW,
    })

    expect(view.tasks).toHaveLength(2)
    expect(petTaskAlert(view.tasks, { now: NOW })).toBe('quiet')
  })

  it('leaves nothing behind when the next snapshot belongs to it', () => {
    // The view holds no cache, so this is a claim about the shape of the module rather than about
    // a branch: a remembered entry would be exactly the way the previous instance's state answers
    // for the next one, and it would answer with the same session id.
    const before = buildPetTaskView({
      tasks: [task('waiting-input', { runtimeEpoch: 'epoch-1', permissionRequestId: 'req-1' })],
      now: NOW,
    })
    const after = buildPetTaskView({
      tasks: [task('working', { runtimeEpoch: 'epoch-2' })],
      now: NOW,
    })

    expect(before.alert).toBe('needs-attention')
    expect(after.tasks).toHaveLength(1)
    expect(after.tasks[0].key.runtimeEpoch).toBe('epoch-2')
    expect(after.alert).toBe('quiet')
    expect(before.tasks[0].key.runtimeEpoch, 'the earlier view was not rewritten').toBe('epoch-1')
  })
})

describe('when the host cannot be reached', () => {
  const lost = [
    task('working', { sessionId: 'ses_1' }),
    task('waiting-input', { sessionId: 'ses_2', permissionRequestId: 'req-1' }),
    task('turn-finished', { sessionId: 'ses_3' }),
  ]

  it('states every task as unknown rather than keeping a claim it cannot support', () => {
    const view = buildPetTaskView({ tasks: lost, now: NOW, hostLost: true })

    expect(view.hostLost).toBe(true)
    expect(view.tasks.map((row) => row.state)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(view.mood).toBe('waiting')
  })

  it('keeps the tasks, so silence does not remove work from the list', () => {
    // §3.1.2's defect is upstream deleting a quiet session; a display that dropped these on a lost
    // connection would be the same defect, committed one layer up.
    const view = buildPetTaskView({ tasks: lost, now: NOW, hostLost: true })

    expect(view.tasks.map((row) => petTaskToken(row.key))).toEqual(
      lost.map((row) => petTaskToken(row.key)),
    )
  })

  it('clears the request a click would have routed to', () => {
    // §11: 过期请求按钮不能继续操作. A window that cannot ask the host whether a request is still
    // open cannot offer a button that answers it.
    const view = buildPetTaskView({ tasks: lost, now: NOW, hostLost: true })

    expect(view.tasks.every((row) => row.permissionRequestId === null)).toBe(true)
  })

  it('leaves the host’s clock alone', () => {
    const view = buildPetTaskView({ tasks: lost, now: NOW + 5_000, hostLost: true })

    expect(view.tasks.map((row) => row.updatedAt)).toEqual(lost.map((row) => row.updatedAt))
  })

  it('states the loss but does not put the character on alert about it', () => {
    // The flag is the statement, and the mood is about the tasks. A pet that struck a concerned
    // pose over an unreachable host *with nothing to report* would be crying wolf during the
    // ordinary case — a window that is still mounting, and §6.2's `unknown` is a fact about a
    // task, so zero tasks are zero unknowns. What the window shows the user for the connection is
    // a sentence (`DesktopPetRoot.vue`'s notice), not a pose.
    const view = buildPetTaskView({ tasks: [], now: NOW, hostLost: true })

    expect(view.tasks).toEqual([])
    expect(view.hostLost).toBe(true)
    expect(view.alert).toBeNull()
    expect(view.mood).toBe('idle')
  })

  it('takes the alert from the restated tasks rather than from the flag', () => {
    // The consequence of the case above: `hostLost` never sets a mood by itself, so the two
    // cannot disagree about whether the window is looking at something.
    const restated = buildPetTaskView({ tasks: [task('working')], now: NOW, hostLost: true })
    expect(restated.alert).toBe('needs-attention')
    expect(restated.mood).toBe('waiting')

    const alone = buildPetTaskView({ tasks: [task('working')], now: NOW })
    expect(alone.alert).toBe('quiet')
    expect(alone.mood).toBe('working')
  })

  it('says nothing about a loss when there is none', () => {
    expect(buildPetTaskView({ tasks: lost, now: NOW }).hostLost).toBe(false)
  })
})

describe('the mood vocabulary', () => {
  it('names only rows the sprite sheet already has', () => {
    // Reusing D2's vocabulary rather than inventing a second one: a mood with no row would draw a
    // sheet's fallback, which is a pet that looks idle during a failure.
    for (const mood of PET_TASK_MOODS) {
      expect(DEFAULT_ANIMATION_CONFIG.stateRows[mood], mood).toBeTypeOf('number')
    }
  })

  it('answers with a mood for every alert the contract names', () => {
    const alerts: (PetTaskAlert | null)[] = ['needs-attention', 'quiet', 'turn-finished', null]
    for (const alert of alerts) {
      expect(PET_TASK_MOODS).toContain(petTaskMood(alert))
    }
    expect(petTaskMood(null)).toBe('idle')
  })
})
