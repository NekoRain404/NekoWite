/**
 * The settings page's session: the draft the user is editing, the write it becomes, and what
 * the last one did.
 *
 * It exists because three of §5.3's clauses are about a *sequence* of edits rather than about a
 * value, and no value-level rule can state them: a debounced write must not lose the last edit
 * before the page closes (「防抖写入不得丢掉关闭设置前最后一次修改」), a save that failed must
 * stay retryable and must not read as a success (「保存失败展示错误并保持可重试状态，不伪装成功」),
 * and a refused write sends the caller back to what the store holds (「旧 revision 冲突拒绝并重
 * 新加载」). The policy decides one write; this decides the session around it.
 *
 * No rule is re-implemented here: a write is built by `petSettingsWrite` and pre-checked by
 * `decidePetSettingsWrite` — the functions the store mirrors (§5.3 「界面和后端使用同一规则」) —
 * and the authority's own answer always wins over the pre-check. Two further clauses hold by
 * construction: the draft *is* the live preview (only a persisted write produces `saved`), and
 * `resetDomain` is the only reset verb there is, for this session's domain alone, so
 * 「恢复本页默认只影响当前域」 has nothing to reach for.
 */
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  type ComputedRef,
  type ShallowRef,
} from 'vue'
import type {
  PetGateway,
  PetSettingsDomain,
  PetSettingsRecord,
  PetSettingsValues,
} from '../../../platform/gateways/pet-contracts'
import {
  decidePetSettingsWrite,
  petSettingsRecordFor,
  petSettingsWrite,
  readPetSettingsValues,
  resetPetSettingsDomain,
  samePetSettingsValues,
  type PetSettingsRecordFor,
} from '../services/pet-settings-policy'

/**
 * The window a debounced write waits for, named because §5.3's last-edit rule is about it: a
 * page that closes inside this window must `settle()` first.
 */
export const PET_SETTINGS_DEBOUNCE_MS = 400

/**
 * What the page can say about the last write, as a code — the same reason the policy returns
 * codes. There is no `preview` member (the draft is the preview, live on every keystroke) and
 * `saved` is only ever produced by an `applied` outcome.
 */
export type PetSettingsSaveStatus =
  | 'loading'
  | 'ready'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'invalid'
  | 'conflict'
  | 'failed'
  | 'read-only'

/** The two settings calls a session needs: the authority's port, not the whole pet surface. */
export type PetSettingsAuthority = Pick<PetGateway, 'readSettings' | 'updateSettings'>

export interface PetSettingsOptions<D extends PetSettingsDomain> {
  authority: PetSettingsAuthority
  domain: D
  /** How long an edit waits before it is written. Injected so a test can drive the window. */
  debounceMs?: number
}

export interface PetSettingsSession<D extends PetSettingsDomain> {
  readonly domain: D
  /** The draft: replaced whole on every edit (a patch is what §5.3 forbids), never mutated. */
  readonly values: ShallowRef<PetSettingsValues[D]>
  readonly status: ShallowRef<PetSettingsSaveStatus>
  /** The authority's own words about the last refusal or failure. A diagnostic, never rendered. */
  readonly problem: ShallowRef<string | null>
  /** Whether the draft differs from what the store holds. */
  readonly dirty: ComputedRef<boolean>
  /** Read the domain. Not called automatically: a page that is not on screen should not read. */
  load: () => Promise<void>
  edit: <K extends keyof PetSettingsValues[D]>(field: K, value: PetSettingsValues[D][K]) => void
  /** Write whatever the debounce is still holding. A close handler awaits this first. */
  settle: () => Promise<void>
  /** Write now, and retry a failed write with the values it failed on. */
  save: () => Promise<void>
  /** §5.3's per-page default reset — one domain, and only this session's. */
  resetDomain: () => void
  /** Stop the timer. Does not write: a close path settles first. */
  dispose: () => void
}

/**
 * The draft with one field replaced — the only way a draft changes. A new object rather than a
 * mutation, so the shallow ref reacts and the record the store handed back stays unaliased.
 */
function withField<D extends PetSettingsDomain, K extends keyof PetSettingsValues[D]>(
  values: PetSettingsValues[D],
  field: K,
  value: PetSettingsValues[D][K],
): PetSettingsValues[D] {
  // A computed key on a generic mapped type: TypeScript cannot express "the same type with one
  // field replaced", and `field` is a key of that type by construction.
  return { ...values, [field]: value } as unknown as PetSettingsValues[D]
}

export function usePetSettings<D extends PetSettingsDomain>(
  options: PetSettingsOptions<D>,
): PetSettingsSession<D> {
  const { authority, domain } = options
  const debounceMs = options.debounceMs ?? PET_SETTINGS_DEBOUNCE_MS

  /** What the store holds, and the revision every write is built from. */
  const store = shallowRef<PetSettingsRecordFor<D> | null>(null)
  // Vue models `shallowRef`'s result through a conditional type that a *generic* indexed access
  // cannot satisfy: `PetSettingsValues[D]` makes TypeScript try every domain's branch and settle
  // on their union. The ref holds exactly the declared type, so it is given it.
  const values = shallowRef(readPetSettingsValues(domain, {}).values) as unknown as ShallowRef<PetSettingsValues[D]>
  const status = shallowRef<PetSettingsSaveStatus>('loading')
  const problem = shallowRef<string | null>(null)
  const dirty = computed(
    () => store.value !== null && !samePetSettingsValues(domain, values.value, store.value.values),
  )

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  /** A normalized copy — the same walk that judged the record usable, so no draft value can be
   *  one the store would refuse to read back. */
  function copyOf(raw: unknown): PetSettingsValues[D] {
    return readPetSettingsValues(domain, raw).values
  }

  /** Take a record as the truth, and reload the draft from it. */
  function adopt(record: PetSettingsRecord | null): void {
    const narrowed = petSettingsRecordFor(record, domain)
    store.value = narrowed
    if (narrowed !== null) values.value = copyOf(narrowed.values)
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer)
    // A timer even at 0 ms: a write fired synchronously from `edit` would make every step of a
    // slider its own revision, and every other window's open form a conflict.
    timer = setTimeout(() => {
      timer = null
      void save()
    }, debounceMs)
  }

  async function save(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (inFlight !== null) await inFlight
    // One writer per session, and waiting is what keeps it one: a second write has to carry the
    // revision the first one produced, or it conflicts with the change it just made itself.
    const record = store.value
    if (record === null || status.value === 'read-only' || !dirty.value) return
    const write = petSettingsWrite(domain, record.revision, values.value)
    const verdict = decidePetSettingsWrite(record, write)
    if (verdict.status === 'refused') {
      // The store's rules, applied here first: the same function, so a value this page can see
      // is unusable never leaves the window.
      status.value = verdict.reason === 'schema-newer' ? 'read-only' : 'invalid'
      problem.value = verdict.message
      return
    }
    if (verdict.status === 'conflict') {
      // Unreachable for a write built from `record` itself — kept because the alternative is a
      // save that silently does nothing.
      adopt(verdict.current)
      status.value = 'conflict'
      return
    }
    status.value = 'saving'
    problem.value = null
    const run = authority.updateSettings(write).then((outcome) => {
      if (outcome.status === 'applied') {
        store.value = petSettingsRecordFor(outcome.record, domain)
        // `saved` only when nothing newer is pending: an edit that arrived while this write was
        // in flight is not saved, and saying so would be the one thing the status must not do.
        status.value = dirty.value ? 'pending' : 'saved'
        problem.value = null
        return
      }
      if (outcome.status === 'conflict') {
        // Refused, not merged: the draft is replaced by what the store holds, because merging
        // would undo whatever the other window changed (§5.3 「旧 revision 冲突拒绝并重新加载」).
        adopt(outcome.current)
        status.value = 'conflict'
        return
      }
      if (outcome.status === 'refused') {
        status.value = outcome.reason === 'schema-newer' ? 'read-only' : 'invalid'
        problem.value = outcome.message
        return
      }
      // The store could not persist it. The draft stays, and stays dirty, so the same write is
      // still the right one to retry — and nothing here reports success (§5.3).
      status.value = 'failed'
      problem.value = outcome.message
    })
    inFlight = run
    try {
      await run
    } finally {
      if (inFlight === run) inFlight = null
    }
    // The draft is never assigned from an `applied` outcome: an edit made during the write is
    // still in the draft, still dirty, and the timer it scheduled writes it next.
  }

  async function load(): Promise<void> {
    status.value = 'loading'
    problem.value = null
    const loaded = await authority.readSettings(domain)
    if (loaded.status === 'read-only') {
      // §10.2: a store written by a newer build is left alone. The form still renders — this
      // build's defaults, and every write refused — because a blank page would read as "the pet
      // has no settings" rather than "this build cannot edit them".
      store.value = null
      values.value = copyOf({})
      status.value = 'read-only'
      return
    }
    const record = petSettingsRecordFor(loaded.record, domain)
    if (record === null) {
      // The store answered for another domain. Reading those values through this schema is the
      // mismatch the write path refuses on the way in, seen on the way out.
      store.value = null
      status.value = 'failed'
      problem.value = `the store answered with a ${loaded.record.domain} record`
      return
    }
    store.value = record
    values.value = copyOf(record.values)
    status.value = 'ready'
  }

  function edit<K extends keyof PetSettingsValues[D]>(field: K, value: PetSettingsValues[D][K]): void {
    if (status.value === 'read-only') return
    values.value = withField(values.value, field, value)
    status.value = 'pending'
    problem.value = null
    schedule()
  }

  async function settle(): Promise<void> {
    // `save` clears the timer before it writes, so this is a flush and not a second path.
    await save()
  }

  function resetDomain(): void {
    const record = store.value
    if (record === null || status.value === 'read-only') return
    // The policy builds the write for this domain alone, and it goes out through the same
    // revision-checked path as an edit. Resetting a domain the store already holds defaults for
    // leaves `dirty` false, so nothing is written — a reset that changes nothing is not a change.
    values.value = copyOf(resetPetSettingsDomain(domain, record.revision).values)
    status.value = 'pending'
    problem.value = null
    schedule()
  }

  function dispose(): void {
    // Stops the timer and writes nothing: a flush fired from a teardown is a write nobody
    // awaits, for a page that is already gone — the close path settles first. A session disposed
    // with work pending keeps `dirty` true, so a caller can see it dropped an edit instead of
    // being told the draft was saved.
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  if (getCurrentScope()) onScopeDispose(dispose)

  const session: PetSettingsSession<D> = {
    domain,
    values,
    status,
    problem,
    dirty,
    load,
    edit,
    settle,
    save,
    resetDomain,
    dispose,
  }
  return session
}
