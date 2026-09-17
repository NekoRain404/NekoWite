import { describe, expect, it } from 'vitest'
import { AGENT_FAILURE_CODES, AGENT_STOP_REASONS, type AgentStopReason } from './agent-contracts'
import {
  PET_ALERT_BY_STATE,
  PET_CAPABILITIES,
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_PAGES,
  PET_SETTINGS_SCHEMA_VERSION,
  PET_SETTINGS_SECTION,
  PET_TASK_STATES,
  isPetTaskSettled,
  petKeyToken,
  petStateFromFailure,
  petTaskToken,
  readPetNumber,
  samePetTask,
  type PetSettingsLoad,
  type PetTaskKey,
  type PetTaskProjection,
  type PetTaskState,
} from './pet-contracts'
import {
  MEMORY_PET_VAULT,
  createMemoryPetGateway,
  type MemoryPetGateway,
  type PetIngestOutcome,
} from './memory-pet'

const IDENTITY = {
  agentId: 'memory',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: MEMORY_PET_VAULT,
  sessionId: 'session-1',
}

/**
 * A frame delivered by hand, for the cases no verb can express: a foreign identity, a
 * reused sequence, a payload that is not the one a verb builds.
 */
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...IDENTITY,
    runId: 'run-1',
    sequence: 1,
    kind: 'run-finished',
    payload: { stopReason: 'end-turn', usage: null },
    ...overrides,
  }
}

/** The one task, for the many cases that drive a single run. */
async function onlyTask(pet: MemoryPetGateway): Promise<PetTaskProjection> {
  const tasks = await pet.tasks()
  expect(tasks).toHaveLength(1)
  return tasks[0]
}

/** The task a key names, or a failure that says which key was missing. */
async function taskFor(pet: MemoryPetGateway, key: PetTaskKey): Promise<PetTaskProjection> {
  const task = (await pet.tasks()).find((candidate) => samePetTask(candidate.key, key))
  if (!task) throw new Error(`no task for run ${key.runId}`)
  return task
}

/** The outcome of a frame that had to have been applied. */
function applied(outcome: PetIngestOutcome): PetTaskProjection {
  expect(outcome.status).toBe('applied')
  if (outcome.status !== 'applied') throw new Error(`expected an applied frame`)
  return outcome.task
}

/** The record a load reports, for a test that only cares about the values. */
function recordOf(load: PetSettingsLoad) {
  if (load.status === 'read-only') throw new Error('the host reported the data as read-only')
  return load.record
}

/** Turn the feature on through the settings path, the way the settings page does. */
async function enable(pet: MemoryPetGateway, revision: number): Promise<void> {
  await pet.updateSettings({
    domain: 'general',
    revision,
    values: { ...PET_SETTINGS_DEFAULTS.general, enabled: true },
  })
}

/**
 * The same write with the pet switched *off*, which is the two window switches rather than the
 * master: `general.enabled` is derived from them (`characterWindow || ball`), so a write that set
 * only the master would be recomputed to `true` against the schema's two on-by-default switches —
 * and the pet would come back on the next read. That is exactly the defect the derivation and the
 * 3→4 migration exist to prevent, seen from the side that writes.
 */
async function disable(pet: MemoryPetGateway, revision: number): Promise<void> {
  await pet.updateSettings({
    domain: 'general',
    revision,
    values: {
      ...PET_SETTINGS_DEFAULTS.general,
      characterWindow: false,
      ball: false,
      enabled: false,
    },
  })
}

describe('the states §6.2 maps runs onto', () => {
  it('shows a run the snapshot says is executing as working, and reads nothing into a lull', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    expect((await onlyTask(pet)).state).toBe('working')

    // A streamed chunk is not a start signal, and a pause in one is not a completion
    // (§6.2 row 1): neither changes what the pet shows.
    const chunk = pet.ingest(frame({ sequence: 1, kind: 'text-delta', payload: { text: 'hi' } }))
    expect(chunk.status).toBe('no-change')
    expect((await onlyTask(pet)).state).toBe('working')
  })

  it('shows a permission request as waiting-input, and carries nothing to answer it with', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const outcome = applied(pet.requestPermission(key, 'p-1'))

    expect(outcome.state).toBe('waiting-input')
    expect(outcome.permissionRequestId).toBe('p-1')
    // §6.2: the pet points at the host's own permission UI and authorises nothing. The
    // field list is the check, not a rule: there is no option, title or argument here
    // for a component to act on even by accident.
    expect(Object.keys(outcome).sort()).toEqual([
      'key',
      'permissionRequestId',
      'state',
      'updatedAt',
    ])
  })

  it('says a turn finished on end-turn, and claims nothing beyond that turn', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    expect(applied(pet.finishRun(key, 'end-turn')).state).toBe('turn-finished')
    // §6.2: "this turn finished" is the whole claim. A goal-level completion would need a
    // goal identifier, and the ACP contract carries none — so the pet state that would
    // assert it does not exist rather than being guessed from a stop reason.
    expect(PET_ALERT_BY_STATE['turn-finished']).toBe('turn-finished')
  })

  it('shows a limit as stopped and a refusal as refused, neither of them a celebration', async () => {
    for (const reason of ['max-tokens', 'max-turn-requests'] as const) {
      const pet = createMemoryPetGateway()
      const key = pet.startRun()
      const state = applied(pet.finishRun(key, reason)).state
      expect(state).toBe('stopped')
      // §6.2: reached a limit, so it is explained and not celebrated.
      expect(PET_ALERT_BY_STATE[state]).toBe('needs-attention')
    }

    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const state = applied(pet.finishRun(key, 'refusal')).state
    expect(state).toBe('refused')
    expect(PET_ALERT_BY_STATE[state]).toBe('needs-attention')
  })

  it('keeps the three non-error stop reasons apart from each other and from a failure', async () => {
    const expected: { [S in AgentStopReason]: PetTaskState } = {
      'end-turn': 'turn-finished',
      'max-tokens': 'stopped',
      'max-turn-requests': 'stopped',
      refusal: 'refused',
      cancelled: 'cancelled',
    }
    for (const reason of AGENT_STOP_REASONS) {
      const pet = createMemoryPetGateway()
      const key = pet.startRun()
      const outcome = applied(pet.finishRun(key, reason))
      expect(outcome.state).toBe(expected[reason])
      // Not one of the five endings is a runtime failure, which is why they belong to
      // `run-finished` and why four of them get their own row rather than a shared one.
      expect(outcome.state).not.toBe('failed')
    }
    // Five reasons, four states: the two ceilings share `stopped`, and nothing else does.
    expect(new Set(Object.values(expected)).size).toBe(4)
  })

  it('reads an ending whose reason it does not know as unknown, not as a finished turn', async () => {
    // The reason is one this version has never seen, which P0 §6.3's measurement of the same
    // engine's changing protocol surface makes a normal frame rather than a corrupt one. Neither
    // wrong reading may happen: refusing the frame reports the engine's finished turn as a
    // failure, and `turn-finished` asserts an ending nobody established (§6.2). It lands on
    // `unknown` — and `unknown` is deliberately not settled, so a later frame that does know wins.
    const pet = createMemoryPetGateway()
    const key = pet.startRun()

    const outcome = applied(
      pet.ingest(frame({ payload: { stopReason: 'budget_exceeded', usage: null } })),
    )
    expect(outcome.state).toBe('unknown')
    expect(PET_ALERT_BY_STATE.unknown).toBe('needs-attention')
    expect(isPetTaskSettled('unknown')).toBe(false)

    const informed = pet.ingest(
      frame({ sequence: 2, payload: { stopReason: 'refusal', usage: null } }),
    )
    expect(informed.status).toBe('applied')
    expect((await taskFor(pet, key)).state).toBe('refused')
  })

  it('shows a cancelled run as cancelled, whether it ended or failed that way', async () => {
    const ended = createMemoryPetGateway()
    const endedKey = ended.startRun()
    expect(applied(ended.finishRun(endedKey, 'cancelled')).state).toBe('cancelled')

    const failed = createMemoryPetGateway()
    const failedKey = failed.startRun()
    // §6.2 row 6 covers the cancellation-class failure as well, and it is the failure
    // code — not the event kind — that decides it.
    expect(applied(failed.failRun(failedKey, 'cancelled')).state).toBe('cancelled')

    // No success sound and not a failure reward: quiet is the only reaction that is
    // neither (§6.2).
    expect(PET_ALERT_BY_STATE.cancelled).toBe('quiet')
  })

  it('keeps the task entry of a run that failed, with the detail staying in the main panel', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const outcome = applied(pet.failRun(key, 'timeout'))
    expect(outcome.state).toBe('failed')
    expect(PET_ALERT_BY_STATE.failed).toBe('needs-attention')
    // §6.2: the entry stays. The pet does not explain the failure and does not retry it.
    expect(await taskFor(pet, key)).toMatchObject({ state: 'failed' })
  })

  it('classifies every failure code, and reads a lost runtime as an interruption', () => {
    for (const code of AGENT_FAILURE_CODES) {
      expect(['failed', 'interrupted', 'cancelled']).toContain(petStateFromFailure(code))
    }
    expect(petStateFromFailure('cancelled')).toBe('cancelled')
    expect(petStateFromFailure('process-exited')).toBe('interrupted')
    expect(petStateFromFailure('runtime-unavailable')).toBe('interrupted')
    expect(petStateFromFailure('timeout')).toBe('failed')
    // The vocabulary's eleventh code: a runtime that cannot verify a certificate failed
    // the run, it did not lose it.
    expect(petStateFromFailure('certificate-untrusted')).toBe('failed')
  })

  it('never reads a lost runtime as done, and has no state that could stand for it', () => {
    // §6.2's last row is the reason this assertion is structural rather than textual:
    // there is no single success state for `interrupted` to collapse into.
    expect(PET_TASK_STATES).not.toContain('done')
    expect(PET_TASK_STATES).not.toContain('completed')
    expect(isPetTaskSettled('interrupted')).toBe(true)
    // `unknown` is not settled: it admits the host does not know, so a later fact has to
    // be able to replace it.
    expect(isPetTaskSettled('unknown')).toBe(false)
  })

  it('interrupts what was in flight when the runtime crashed, and leaves settled runs alone', async () => {
    const pet = createMemoryPetGateway()
    const croaked = pet.startRun()
    const finished = pet.startRun()
    applied(pet.finishRun(finished, 'end-turn'))

    const restated = pet.loseRuntime('runtime-crashed')
    expect(restated.map((task) => task.state)).toEqual(['interrupted'])
    expect(restated[0].key.runId).toBe(croaked.runId)
    // The runtime went away after this one ended, so it says nothing about it (§6.3).
    expect(await taskFor(pet, finished)).toMatchObject({ state: 'turn-finished' })
  })

  it('admits it does not know when the connection is lost, and lets a later fact resolve it', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    pet.loseRuntime('connection-lost')
    expect((await onlyTask(pet)).state).toBe('unknown')

    const late = pet.finishRun(key, 'end-turn')
    expect(applied(late).state).toBe('turn-finished')
  })

  it('can produce every state the contract names, with none left over', async () => {
    const produced = new Set<PetTaskState>()
    const collect = async (pet: MemoryPetGateway) => {
      for (const task of await pet.tasks()) produced.add(task.state)
    }

    const pet = createMemoryPetGateway()
    pet.startRun()
    await collect(pet)
    const waiting = pet.startRun()
    pet.requestPermission(waiting, 'p-1')
    await collect(pet)
    const done = pet.startRun()
    pet.finishRun(done, 'end-turn')
    await collect(pet)
    const cancelled = pet.startRun()
    pet.finishRun(cancelled, 'cancelled')
    await collect(pet)
    pet.startRun()
    pet.loseRuntime('runtime-crashed')
    await collect(pet)
    pet.startRun()
    pet.loseRuntime('connection-lost')
    await collect(pet)

    const stopped = createMemoryPetGateway()
    applied(stopped.finishRun(stopped.startRun(), 'max-tokens'))
    await collect(stopped)

    const refused = createMemoryPetGateway()
    applied(refused.finishRun(refused.startRun(), 'refusal'))
    await collect(refused)

    const failed = createMemoryPetGateway()
    applied(failed.failRun(failed.startRun(), 'timeout'))
    await collect(failed)

    expect([...produced].sort()).toEqual([...PET_TASK_STATES].sort())
  })
})

describe('the task key', () => {
  it('keeps two agents whose sessions share a name apart', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    // The upstream store keys on `agent:session` and then finds a session by its suffix
    // (`windows/src/state.ts:54`, `:85-89`), so this frame would land on the first task.
    const other = pet.ingest(frame({ agentId: 'opencode' }))
    expect(other.status).toBe('applied')
    expect(await pet.tasks()).toHaveLength(2)
  })

  it('encodes a key so that no two different keys produce one string', () => {
    // Bare colons would make these two the same string.
    expect(petKeyToken(['a:b', 'c'])).not.toBe(petKeyToken(['a', 'b:c']))
    expect(petKeyToken(['a:b', 'c'])).not.toBe(petKeyToken(['a:b:c']))
    const key: PetTaskKey = { ...IDENTITY, runId: 'run-1' }
    expect(petTaskToken(key)).toBe(petKeyToken([
      'memory',
      'default',
      'epoch-1',
      MEMORY_PET_VAULT,
      'session-1',
      'run-1',
    ]))
  })

  it('does not apply a frame from a runtime instance that is over', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const stale = pet.ingest(frame({ runtimeEpoch: 'epoch-0' }))
    expect(stale).toMatchObject({ status: 'foreign', key: { runtimeEpoch: 'epoch-0' } })
    // The live run is untouched: a queued frame from a previous instance cannot settle a
    // task the current one is still carrying.
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
  })

  it('does not file a frame that names no run under one', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    const orphan = pet.ingest(frame({ runId: null, kind: 'text-delta', payload: { text: 'x' } }))
    expect(orphan).toMatchObject({ status: 'foreign', key: null })
    expect(await onlyTask(pet)).toMatchObject({ state: 'working' })
  })
})

describe('the frame log §6.3 needs to have survived', () => {
  it('reports a repeated frame instead of applying it twice', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    expect(applied(pet.finishRun(key, 'end-turn')).state).toBe('turn-finished')

    const again = pet.ingest(frame({ sequence: 1 }))
    expect(again.status).toBe('replayed')
    expect(await taskFor(pet, key)).toMatchObject({ state: 'turn-finished' })
  })

  it('reports the sequence numbers that never arrived', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    pet.ingest(frame({ sequence: 1, kind: 'text-delta', payload: { text: 'a' } }))
    const jumped = pet.ingest(frame({ sequence: 4, kind: 'text-delta', payload: { text: 'b' } }))
    expect(jumped).toMatchObject({ status: 'no-change', order: { sequence: 4, missing: [2, 3] } })
  })

  it('does not revive a settled run with a work event that arrives after it', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    applied(pet.finishRun(key, 'end-turn'))

    const late = pet.requestPermission(key, 'p-late')
    expect(late.status).toBe('settled')
    expect(await taskFor(pet, key)).toMatchObject({ state: 'turn-finished' })
  })

  it('keeps a later turn of one session as a second task rather than a revival', async () => {
    const pet = createMemoryPetGateway()
    const first = pet.startRun()
    applied(pet.finishRun(first, 'end-turn'))
    // §6.3: a later turn has to carry a new run id, which is what makes it a second task.
    const second = pet.startRun({ sessionId: first.sessionId })
    expect(second.runId).not.toBe(first.runId)

    const tasks = await pet.tasks()
    expect(tasks).toHaveLength(2)
    expect(await taskFor(pet, first)).toMatchObject({ state: 'turn-finished' })
    expect(await taskFor(pet, second)).toMatchObject({ state: 'working' })
  })

  it('keeps one task visible while another is being worked on', async () => {
    const pet = createMemoryPetGateway()
    const a = pet.startRun()
    const b = pet.startRun()
    pet.finishRun(a, 'end-turn')
    const tasks = await pet.tasks()
    expect(tasks.map((task) => task.state).sort()).toEqual(['turn-finished', 'working'])
    expect(tasks.map((task) => task.key.runId).sort()).toEqual([a.runId, b.runId].sort())
  })

  it('refuses a frame that is not an event at all, before it becomes a pet fact', () => {
    const pet = createMemoryPetGateway()
    expect(pet.ingest({ kind: 'nonsense' })).toMatchObject({
      status: 'rejected',
      code: 'invalid-response',
    })
  })
})

describe('what reaches the pet window', () => {
  it('carries no engine text, reasoning or tool output with a task', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    pet.ingest(frame({ sequence: 1, kind: 'text-delta', payload: { text: 'the note says X' } }))
    pet.ingest(frame({ sequence: 2, kind: 'thought-delta', payload: { text: 'the user wants Y' } }))

    // §6.1: raw chat content, reasoning and full tool output are not sent to the pet
    // window. The projection is a closed shape, so this is a property of the type.
    const shown = JSON.stringify(await onlyTask(pet))
    expect(shown).not.toContain('the note says X')
    expect(shown).not.toContain('the user wants Y')
  })

  it('stamps the injected clock rather than reading one', async () => {
    let clock = 1000
    const pet = createMemoryPetGateway({ now: () => clock })
    const key = pet.startRun()
    clock = 5000
    pet.finishRun(key, 'end-turn')
    expect((await onlyTask(pet)).updatedAt).toBe(5000)
  })

  it('gives a subscriber the current list and every change after it', async () => {
    const pet = createMemoryPetGateway()
    const seen: PetTaskProjection[][] = []
    const off = await pet.subscribe((tasks) => seen.push(tasks))
    expect(seen).toEqual([[]])

    const key = pet.startRun()
    pet.finishRun(key, 'end-turn')
    expect(seen.map((tasks) => tasks.length)).toEqual([0, 1, 1])
    expect(seen[2][0]).toMatchObject({ state: 'turn-finished' })

    off()
    pet.startRun()
    expect(seen).toHaveLength(3)
  })
})

describe('the settings schemas', () => {
  it('refuses a write based on a revision that has moved on, and returns the current one', async () => {
    const pet = createMemoryPetGateway()
    const revision = recordOf(await pet.readSettings('general')).revision

    const applied = await pet.updateSettings({
      domain: 'general',
      revision,
      values: { ...PET_SETTINGS_DEFAULTS.general, enabled: true },
    })
    expect(applied).toMatchObject({ status: 'applied', record: { revision: revision + 1 } })

    // The second window wrote against the same revision. §5.3 refuses it and hands back
    // what is current, so the caller reloads rather than merging a stale form.
    const conflict = await pet.updateSettings({
      domain: 'general',
      revision,
      values: {
        ...PET_SETTINGS_DEFAULTS.general,
        characterWindow: false,
        ball: false,
        enabled: false,
      },
    })
    expect(conflict).toMatchObject({
      status: 'conflict',
      current: { revision: revision + 1, values: { enabled: true } },
    })
    expect(recordOf(await pet.readSettings('general')).values).toMatchObject({ enabled: true })
  })

  it('reports a write it could not persist, and leaves it retryable', async () => {
    const pet = createMemoryPetGateway({ writeFailures: 1 })
    const revision = recordOf(await pet.readSettings('notification')).revision
    const write = {
      domain: 'notification' as const,
      revision,
      values: { ...PET_SETTINGS_DEFAULTS.notification, sound: false },
    }

    // §5.3: a save failure is neither success nor an exception the caller reads as a bug.
    expect(await pet.updateSettings(write)).toMatchObject({ status: 'failed' })
    expect(recordOf(await pet.readSettings('notification')).revision).toBe(revision)
    // The revision did not move, so the same write is still the right one to retry.
    expect(await pet.updateSettings(write)).toMatchObject({ status: 'applied' })
  })

  it('stays off data written by a newer schema instead of overwriting it', async () => {
    const pet = createMemoryPetGateway({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 })
    expect(await pet.readSettings('character')).toMatchObject({
      status: 'read-only',
      reason: 'schema-newer',
      foundVersion: PET_SETTINGS_SCHEMA_VERSION + 1,
    })
    // §10.2: read-only or an error, never a default written over the user's data.
    expect(
      await pet.updateSettings({
        domain: 'character',
        revision: 1,
        values: PET_SETTINGS_DEFAULTS.character,
      }),
    ).toMatchObject({ status: 'refused', reason: 'schema-newer' })
  })

  it('reports older data as migrated', async () => {
    const pet = createMemoryPetGateway({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION - 1 })
    expect(await pet.readSettings('view')).toMatchObject({
      status: 'migrated',
      fromVersion: PET_SETTINGS_SCHEMA_VERSION - 1,
      repaired: [],
    })
  })

  it('repairs a stored number by one rule for both the interface and the backend', () => {
    const size = PET_NUMBER_RULES['character.size']
    // The bubble's background alpha, which is the schema's only fractional rule. Its bounds are
    // upstream's percent slider held as the *fraction* the alpha is (0.6 to 1.0), so a value
    // strictly inside them is what the assertion below has to use.
    const opacity = PET_NUMBER_RULES['message.opacity']

    expect(readPetNumber(200, size)).toBe(200)
    // Upstream reads these with `parseInt` and no finiteness guard
    // (`windows/src/roam/types.ts:112`), which is how a stored word becomes a NaN speed.
    expect(readPetNumber(Number.NaN, size)).toBe(size.fallback)
    expect(readPetNumber(Number.POSITIVE_INFINITY, size)).toBe(size.fallback)
    expect(readPetNumber('200', size)).toBe(size.fallback)
    // And `parseInt(...) || 100` (`windows/src/main.ts:115`) turns a stored 0 into 100,
    // so the fallback has to be one somebody chose rather than one truthiness chose.
    expect(readPetNumber(0, size)).toBe(size.fallback)
    // Range and integer-ness, on a field that is not an integer and a field that is.
    expect(readPetNumber(0.5, size)).toBe(size.fallback)
    expect(readPetNumber(2, opacity)).toBe(opacity.fallback)
    // Taken from the rule rather than written as a literal: a number this test made up would go
    // stale the day the rule moves, and it would still pass while doing it.
    expect(readPetNumber(opacity.min + 0.01, opacity)).toBe(opacity.min + 0.01)
    // §7.1's cap is a rule and not a suggestion.
    expect(readPetNumber(9, PET_NUMBER_RULES['project.maxCharacters'])).toBe(3)
  })

  it('keeps the task title off a notification unless the user asks for it', () => {
    // §6.3: titles carry no note content and no paths by default, and a default is the
    // only place that holds for a user who never opens the settings page.
    expect(PET_SETTINGS_DEFAULTS.notification.showTaskTitle).toBe(false)
    // §6.3's suggested bubble life, and §7.1's default character cap.
    expect(PET_SETTINGS_DEFAULTS.message.bubbleSeconds).toBe(6)
    expect(PET_SETTINGS_DEFAULTS.project.maxCharacters).toBe(3)
  })

  it('names a settings page the caller cannot invent, and records where it was asked to go', async () => {
    const pet = createMemoryPetGateway()
    await pet.openSettings('advanced')
    expect(pet.openedSettings()).toEqual(['advanced'])
    // §10.1 owns the section id; this is the same name, so a right-click opens something.
    expect(PET_SETTINGS_SECTION).toBe('desktop-pet')
    expect(PET_SETTINGS_PAGES).toContain('advanced')
  })
})

describe('the capabilities §7.2 requires to be stated rather than faked', () => {
  it('reports nothing as available on a host that has measured nothing', async () => {
    const pet = createMemoryPetGateway()
    const reports = await pet.capabilities()
    expect(reports.map((report) => report.capability).sort()).toEqual([...PET_CAPABILITIES].sort())
    for (const report of reports) {
      // §12 leaves the matrix to a later task, and "unverified" is not a synonym for
      // "unsupported": both would be a claim nobody has earned yet.
      expect(report.finding.status).toBe('unverified')
      if (report.finding.status === 'available') throw new Error('unreachable')
      expect(report.finding.fallback).not.toBe('none')
      expect(report.finding.detail.length).toBeGreaterThan(0)
    }
  })

  it('states what happens instead when a capability cannot be used', async () => {
    const pet = createMemoryPetGateway({
      capabilities: {
        'pointer-passthrough': {
          status: 'unavailable',
          fallback: 'compact-window',
          detail: 'this compositor does not support click-through',
        },
      },
    })
    const reports = await pet.capabilities()
    const passthrough = reports.find((report) => report.capability === 'pointer-passthrough')
    expect(passthrough?.finding).toEqual({
      status: 'unavailable',
      fallback: 'compact-window',
      detail: 'this compositor does not support click-through',
    })
    // The capability that needs the window list upstream implements for Windows only
    // (`sys_windows.rs:128-129`) is offered nowhere: §7.2 says not to copy Win32 and not
    // to pretend the feature works.
    const climb = reports.find((report) => report.capability === 'window-climb')
    expect(climb?.finding).toMatchObject({ fallback: 'not-offered' })
  })
})

describe('the care read the double offers', () => {
  it('answers empty until it is told what the ledger settled', async () => {
    const pet = createMemoryPetGateway()

    // §8's 「token 未知不是 0」 at the read: an unanswered ledger is *nothing to draw*, not a set of
    // zeroes a page could put a level on. The double's default is the same answer a real host gives
    // before anything settles, so a surface written against it is written against that state.
    expect(await pet.care()).toEqual({ status: 'empty' })
  })

  it('hands back exactly the summary it was given, and settles nothing itself', async () => {
    const summary = {
      schemaVersion: 1,
      revision: 4,
      xp: 100,
      meals: 4,
      streakDays: 2,
      unlocked: ['nightOwl'],
      days: [{ day: '2026-09-16', completions: 1, tokens: null }],
      reportedTokens: null,
      unreportedRuns: 4,
      lastSettledAt: 1_789_000_000_000,
    }
    const pet = createMemoryPetGateway({ care: summary })

    // The double is a *host*, not a second ledger: what it answers is what it was configured with,
    // and reading it twice changes nothing. A double that settled would be a second answer to what
    // a completion pays, which is `care_ledger.rs`'s alone (§9).
    const read = await pet.care()
    expect(read).toEqual({ status: 'current', summary })
    expect(await pet.care()).toEqual(read)
  })
})

describe('turning the pet off', () => {
  it('starts on, with the switch there for the people who do not want it', async () => {
    const pet = createMemoryPetGateway()
    // §5.1's 启用 turns the feature *off*: the switch exists for those who do not want a
    // pet at all. §7.1's explicit opt-in requirement is about the pet staying resident
    // after its window is closed, which is a different switch from whether it exists.
    expect(PET_SETTINGS_DEFAULTS.general.enabled).toBe(true)
    expect(await pet.feature()).toEqual({ enabled: true, visible: false })
  })

  it('keeps enabled and visible as two different facts', async () => {
    const pet = createMemoryPetGateway()
    // §5.1 lists 启用 and 显示 apart: on, and not showing, is a pet that is running with
    // its drawing stopped — which is not the same thing as off.
    expect(await pet.feature()).toEqual({ enabled: true, visible: false })
    expect(await pet.setVisible(true)).toEqual({ enabled: true, visible: true })
  })

  it('cannot show a pet that is off, and says so rather than pretending', async () => {
    const pet = createMemoryPetGateway()
    await disable(pet, 1)
    expect(await pet.setVisible(true)).toEqual({ enabled: false, visible: false })
  })

  it('keeps hidden work visible to the reminder path while the window is hidden', async () => {
    const pet = createMemoryPetGateway()
    await enable(pet, 1)
    await pet.setVisible(true)
    const key = pet.startRun()
    await pet.setVisible(false)

    // §7.1: hiding stops the drawing and keeps the backend reminder.
    expect(await pet.feature()).toEqual({ enabled: true, visible: false })
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
  })

  it('cancels no agent task and erases no character, care or history', async () => {
    const pet = createMemoryPetGateway()
    await pet.updateSettings({
      domain: 'character',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: 'memoir-cat', size: 200 },
    })
    await pet.updateSettings({
      domain: 'care',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.care, restReminders: false },
    })
    await enable(pet, 1)
    const key = pet.startRun()

    // §4's rollback is this switch. §7.1: disabling stops the animation, the listeners and
    // the timers and cancels no agent task.
    await disable(pet, 2)
    expect(await pet.feature()).toEqual({ enabled: false, visible: false })
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
    expect(recordOf(await pet.readSettings('care')).values).toMatchObject({
      restReminders: false,
    })

    // §4: turning it back on finds everything where it was. An erasing teardown would
    // have been unrecoverable here, which is why the contract offers no such affordance.
    await enable(pet, 3)
    expect(recordOf(await pet.readSettings('character')).values).toMatchObject({
      characterId: 'memoir-cat',
      size: 200,
    })
    expect(recordOf(await pet.readSettings('care')).values).toMatchObject({
      restReminders: false,
    })
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
  })
})

describe('the double publishes the feature state the way the host does', () => {
  it('delivers the current state on subscribe, then every change', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: string[] = []

    const stop = await pet.subscribeFeature((state) => {
      seen.push(`${state.enabled}/${state.visible}`)
    })
    await pet.setVisible(false)
    await pet.setVisible(true)
    stop()
    await pet.setVisible(false)

    // The first delivery is the state as it is, and the last push reaches nobody: an unsubscribe
    // that only removed one of two routes would show here as a fourth entry.
    expect(seen).toEqual(['true/true', 'true/false', 'true/true'])
  })

  it('publishes a settings write, because that is how the other window’s switch arrives', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: boolean[] = []
    await pet.subscribeFeature((state) => seen.push(state.enabled))

    await disable(pet, 1)

    // §7.1's way back is a settings page in the main window, so the double has to publish from the
    // write path — a pet window in another window hears about the switch here and nowhere else.
    expect(seen).toEqual([true, false])
    expect(await pet.feature()).toEqual({ enabled: false, visible: false })
  })

  it('publishes nothing when the write was refused', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: boolean[] = []
    await pet.subscribeFeature((state) => seen.push(state.enabled))

    // A revision that has moved on is refused (§5.3), so the feature did not change — and telling
    // a subscriber otherwise would have the window act on a write that never landed.
    const refused = await pet.updateSettings({
      domain: 'general',
      revision: 99,
      values: {
        ...PET_SETTINGS_DEFAULTS.general,
        characterWindow: false,
        ball: false,
        enabled: false,
      },
    })

    expect(refused.status).toBe('conflict')
    expect(seen).toEqual([true])
  })

  it('publishes every applied write on the settings channel, with the revision it landed on', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: { domain: string; revision: number }[] = []
    const stop = await pet.subscribeSettings((change) => seen.push(change))

    await pet.updateSettings({
      domain: 'character',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: 'kitty' },
    })
    await pet.updateSettings({
      domain: 'character',
      revision: 2,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: null },
    })
    stop()
    await pet.updateSettings({
      domain: 'character',
      revision: 3,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: 'kitty' },
    })

    // The channel the pet window draws from (§5.1's 角色与动画): a character chosen in the main
    // window's settings has to reach a window that is already open, and this is the write path
    // that carries it — a *character* write, unlike the feature channel, which only fires for
    // `general`. The revision is the record's own, so a listener can tell which state to re-read.
    expect(seen).toEqual([
      { domain: 'character', revision: 2 },
      { domain: 'character', revision: 3 },
    ])

    // And a write that was refused says nothing, for the reason the feature channel says nothing:
    // the store did not move, so a listener that re-read would be re-reading the same record.
    const refused = await pet.updateSettings({
      domain: 'character',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.character },
    })
    expect(refused.status).toBe('conflict')
    expect(seen).toHaveLength(2)
  })

  it('publishes nothing for a write to another domain', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: boolean[] = []
    await pet.subscribeFeature((state) => seen.push(state.enabled))

    // The feature switch is `general.enabled` and nothing else: a care or bubble write is not a
    // reason to tell every pet window that the feature changed.
    await pet.updateSettings({
      domain: 'care',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.care },
    })

    expect(seen).toEqual([true])
  })
})
