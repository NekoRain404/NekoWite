/**
 * The field rules: whether one value may be used, what it becomes when it may not, and
 * which fields a domain has at all (§5.3).
 *
 * Split out of `pet-settings-policy.ts` because it is the *shared* half: §5.3 separates the
 * schemas — 主开关, 角色选择, 视图参数, 消息配置, 通知, 养成, 项目绑定 — into independent
 * versioned domains and requires the interface and the backend to validate them by the same
 * rule (「界面和后端使用同一规则」). One module that every domain's values go through is
 * that requirement as a file layout; a copy per domain would be the two truths §9 forbids,
 * and `R/src/desktop_pet/settings.rs` has to mirror this file and nothing else of it.
 *
 * There is deliberately no per-domain code here. Every field's rule is derived from the
 * schema D1 shipped — the field list from `PET_SETTINGS_DEFAULTS`, a number's bounds from
 * `PET_NUMBER_RULES`, a boolean's type from its own default — so a domain that gains a
 * field gains its validation without this file changing, and a field nothing validates
 * cannot be added silently (the two directions a hand-written table per domain gets wrong).
 *
 * The only table that has to exist by hand is {@link PET_FIELD_MEMBERS}, because a
 * TypeScript union cannot be read at run time.
 */
import { PET_NUMBER_RULES, PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import type {
  PetNumberRule,
  PetSettingsDomain,
  PetSettingsValues,
} from '../../../platform/gateways/pet-contracts'

/**
 * Why a field was not acceptable, as a code.
 *
 * Codes and not sentences: the message catalogue is enforced in both directions and the
 * language packs are not this feature's to add to. The numeric clauses of §5.3 stay apart
 * from each other because "not a number at all", "not finite" and "outside the range" are
 * three different defects, and a mirror that cannot tell them apart cannot report one.
 */
export type PetSettingsProblemKind =
  | 'unknown-field'
  | 'missing'
  | 'wrong-type'
  | 'not-finite'
  | 'out-of-range'
  | 'not-integer'
  | 'unknown-member'

/** One submitted field that is not acceptable, and why. `path` is `domain.field`. */
export interface PetSettingsValueProblem {
  path: string
  kind: PetSettingsProblemKind
}

/** What normalizing one domain's stored values produced. */
export interface PetSettingsReadout<D extends PetSettingsDomain> {
  values: PetSettingsValues[D]
  /**
   * The paths whose stored value could not be used and took its fallback. Reported rather
   * than applied silently, so a value the user set can be *shown* to have been repaired
   * instead of quietly reading as something they never chose.
   */
  repaired: string[]
}

/**
 * The members of the three string-union fields, as values, keyed by `domain.field`.
 *
 * A TypeScript union cannot be read at run time, so a validator has to write the members
 * down once; this is that one place, and the shape is deliberately the same flat
 * `domain.field` path the numeric rules and the problem reports use, so the Rust half can
 * carry the same table verbatim. `motion` has two members and no `'full'`: §5.2 lets the pet
 * reduce motion further than the host, never the reverse.
 */
const PET_FIELD_MEMBERS: Readonly<Record<`${PetSettingsDomain}.${string}`, readonly string[]>> = {
  'general.motion': ['system', 'reduced'],
  'view.roam': ['off', 'stay', 'follow-pointer', 'climb'],
  'message.theme': ['system', 'light', 'dark'],
}

/** A JSON object, as opposed to `null`, an array, or a primitive. Both halves use this one. */
export function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One domain's defaults as a plain field map.
 *
 * The runtime view of the mapped type: every walk below is keyed by field *name*, and
 * walking the defaults is what keeps the schema's own list of fields the only list. A field
 * the schema does not declare is therefore never read, never written and never compared —
 * §5.3's 「不得把一个无类型对象贯穿所有组件」, enforced by construction.
 */
function defaultFields(domain: PetSettingsDomain): Record<string, unknown> {
  return PET_SETTINGS_DEFAULTS[domain] as Record<string, unknown>
}

function numberRule(path: string): PetNumberRule {
  const rule = (PET_NUMBER_RULES as Record<string, PetNumberRule | undefined>)[path]
  if (!rule) {
    // Not reachable from data: the rules table is total over `PetNumberField` by type, and a
    // test asserts every field whose default is a number appears in it. A throw and not a
    // fallback, because guessing here would validate against a rule nobody wrote — exactly
    // the "two behaviours that agree until they do not" §5.3 forbids.
    throw new Error(`no numeric rule for ${path}`)
  }
  return rule
}

/**
 * Whether one field's value may be used, and if not, why — the single predicate both
 * directions read from.
 *
 * The read path replaces what this rejects with the rule's own fallback (「越界旧值在迁移
 * 阶段确定回退」); the write path refuses the submission whole. Two policies, one rule: that
 * is what makes the interface and the backend agree by construction rather than by review.
 */
function fieldProblem(
  domain: PetSettingsDomain,
  field: string,
  fallback: unknown,
  raw: unknown,
): PetSettingsValueProblem | null {
  const path = `${domain}.${field}`
  if (typeof fallback === 'boolean') {
    return typeof raw === 'boolean' ? null : { path, kind: 'wrong-type' }
  }
  if (typeof fallback === 'number') {
    const rule = numberRule(path)
    if (typeof raw !== 'number') return { path, kind: 'wrong-type' }
    // Finiteness before range, and both before integer-ness: three separate requirements,
    // and upstream's two numeric defects are one of each — a `parseInt` with no finiteness
    // guard, and a range clamp that then reads the clamped value as a number.
    if (!Number.isFinite(raw)) return { path, kind: 'not-finite' }
    if (raw < rule.min || raw > rule.max) return { path, kind: 'out-of-range' }
    if (rule.integer && !Number.isInteger(raw)) return { path, kind: 'not-integer' }
    return null
  }
  if (typeof fallback === 'string') {
    const members = PET_FIELD_MEMBERS[path as `${PetSettingsDomain}.${string}`]
    if (typeof raw !== 'string' || !members?.includes(raw)) return { path, kind: 'unknown-member' }
    return null
  }
  // The remaining field kind is `characterId: string | null`, whose default is the `null`
  // that reached this branch: §5.3 keeps identifiers in settings and the assets in the
  // managed data directory.
  return raw === null || typeof raw === 'string' ? null : { path, kind: 'wrong-type' }
}

/** What a stored value that cannot be used becomes: the rule's own fallback, decided once. */
function fallbackFor(domain: PetSettingsDomain, field: string, fallback: unknown): unknown {
  return typeof fallback === 'number' ? numberRule(`${domain}.${field}`).fallback : fallback
}

/**
 * A stored domain's values, normalized field by field.
 *
 * Absent and unusable are told apart deliberately: a field the record does not carry at all
 * was never set (an older schema's field, or a fresh install) and defaults quietly, while a
 * field that *is* there and cannot be used is defaulted **and reported**. Merging the two
 * would make every migrated record look as though it had repaired something.
 */
export function readPetSettingsValues<D extends PetSettingsDomain>(
  domain: D,
  raw: unknown,
): PetSettingsReadout<D> {
  const stored = isSettingsObject(raw) ? raw : {}
  const values: Record<string, unknown> = {}
  const repaired: string[] = []
  for (const [field, fallback] of Object.entries(defaultFields(domain))) {
    if (!Object.prototype.hasOwnProperty.call(stored, field)) {
      values[field] = fallbackFor(domain, field, fallback)
      continue
    }
    const candidate = stored[field]
    const problem = fieldProblem(domain, field, fallback, candidate)
    values[field] = problem ? fallbackFor(domain, field, fallback) : candidate
    if (problem) repaired.push(`${domain}.${field}`)
  }
  // The runtime half of a mapped type: every key written above came from
  // `PetSettingsValues[D]`'s own defaults, so the object is that type by construction.
  return { values: values as unknown as PetSettingsValues[D], repaired }
}

/**
 * The values blob of a stored record, or null when it is not a values blob at all.
 *
 * The distinction the caller needs is between "this object has no values" and "these values
 * are a string": the first is an empty record to fill with defaults, the second is a record
 * that cannot be read as one, and reporting the second as the first is how a corrupt file
 * gets quietly replaced by defaults.
 */
export function readStoredPetSettingsValues<D extends PetSettingsDomain>(
  domain: D,
  raw: unknown,
): PetSettingsReadout<D> | null {
  return isSettingsObject(raw) ? readPetSettingsValues(domain, raw) : null
}

/**
 * Every reason a submitted domain's values cannot be accepted.
 *
 * A write is the *whole* domain and never a patch: a field that is missing is refused rather
 * than merged from the stored record, because merging a submission into what is stored is
 * the silent merge §5.3 forbids, one field at a time. A key the schema does not declare is
 * refused too — dropping it would report "saved" for a submission this build did not fully
 * understand. (A *stored* object is the other way round: unknown keys there are dropped,
 * because a record on disk may be ahead of this build in ways a submission from this build's
 * own form cannot be.)
 */
export function petSettingsValueProblems(
  domain: PetSettingsDomain,
  values: unknown,
): PetSettingsValueProblem[] {
  if (!isSettingsObject(values)) return [{ path: domain, kind: 'wrong-type' }]
  const defaults = defaultFields(domain)
  const problems: PetSettingsValueProblem[] = []
  for (const [field, fallback] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) {
      problems.push({ path: `${domain}.${field}`, kind: 'missing' })
      continue
    }
    const problem = fieldProblem(domain, field, fallback, values[field])
    if (problem) problems.push(problem)
  }
  for (const key of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      problems.push({ path: `${domain}.${key}`, kind: 'unknown-field' })
    }
  }
  return problems
}

/** The diagnostic form of a refusal: `domain.field:kind`, in the order the fields were checked. */
export function petSettingsProblemMessage(problems: readonly PetSettingsValueProblem[]): string {
  return problems.map((problem) => `${problem.path}:${problem.kind}`).join(', ')
}

/**
 * Whether two sets of values for one domain are the same field for field.
 *
 * Key *order* is not part of it — a draft assembled by spread and a record read from disk
 * hold the same keys in different orders — and the comparison walks the schema's fields
 * rather than the objects' own, so a stray key on either side cannot make two different
 * values look equal. Callers need this for two rules: a form is "dirty" when its draft is
 * not what is stored, and an unchanged draft must not be written, because a write that
 * changes nothing still moves the revision and turns every other window's open form into a
 * conflict.
 */
export function samePetSettingsValues(domain: PetSettingsDomain, a: unknown, b: unknown): boolean {
  if (!isSettingsObject(a) || !isSettingsObject(b)) return false
  return Object.keys(defaultFields(domain)).every((field) => a[field] === b[field])
}
