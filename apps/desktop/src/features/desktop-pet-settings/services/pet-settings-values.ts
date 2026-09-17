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
 * Two tables have to exist by hand, and only two. {@link PET_FIELD_MEMBERS} because a
 * TypeScript union cannot be read at run time, and {@link PET_STRUCTURED_RULES} because an
 * array's members cannot be read out of an empty array: the default says a field holds a
 * list, and only a written rule says a list of *what*.
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
  /**
   * A structured field's value is not one this field may hold: the wrong container, more
   * members than the rule allows, a member that is not what the rule names, or a key that
   * is not one line of text.
   *
   * One code for the family rather than one per member, and the reason is the mirror: every
   * clause above already means "this is not a value of this field", so four codes would give
   * the Rust half four more ways to disagree with this one without giving a caller one more
   * thing it could do about it. Where the clause matters it is visible in the field's own
   * rule, which is the table a reader has to consult either way.
   */
  | 'wrong-shape'

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
  'character.idleMode': ['random', 'sequential'],
  // The renderer's own member names, not upstream's `byKind`/`all`: the control and the
  // surface have to spell the same choice the same way, and upstream's names are the ones
  // the port renamed.
  'message.layoutMode': ['list', 'compact', 'carousel'],
  'message.grouping': ['by-agent', 'flat'],
  'message.filter': ['all', 'attention', 'active', 'working'],
  'message.separator': ['dot', 'arrow', 'bar', 'space'],
  'message.dot': ['plain', 'claude'],
}

/**
 * What one member of a structured field may be.
 *
 * Three, and each is a ledger row rather than a step towards a general schema language:
 * a spritesheet row (`ap_bind_<mood>`'s values and `ap_idle_clips`' members), one line of
 * plain text (a quick bubble, an agent id, an icon spec), and one bubble row field with
 * its visibility (`ap_bub_tokens`). A fourth kind would be a rule for data no setting
 * carries.
 */
type PetMemberRule =
  | { kind: 'row' }
  | { kind: 'line'; maxLength: number }
  | { kind: 'token-item' }

/**
 * What a structured setting may hold, and how much of it.
 *
 * `max` is a bound on stored data and not a layout rule: it exists because the value
 * arrives from a file that nothing on this side wrote, and an array whose length is
 * whatever the file says is a read that costs whatever the file costs. Every cap below is
 * an order of magnitude above what the setting means in use.
 */
type PetStructuredRule =
  | { container: 'list'; member: PetMemberRule; max: number }
  | { container: 'map'; value: PetMemberRule; max: number }

/** A mood name or an agent id: short, but longer than any this build has heard of. */
const KEY_MAX_LENGTH = 64
/** One bubble row field's name (`PET_BUBBLE_TOKENS` has seven, the longest six characters). */
const TOKEN_MAX_LENGTH = 32

/**
 * The second hand-written table: the rule for a field whose default is an array or an
 * object, keyed by the same `domain.field` path the members and the numeric rules use.
 *
 * The keys of a map are open in both maps, and deliberately. `character.bindings` is keyed
 * by mood and `message.agentIcons` by agent id, and both vocabularies belong to something
 * this file cannot see — the renderer's state lookup takes a free string, and §5.2
 * requires an engine the registry has never heard of to work rather than be rejected. A
 * closed key set here would be this file inventing a vocabulary and then refusing the
 * user's data for not being in it.
 */
const PET_STRUCTURED_RULES: Readonly<Record<`${PetSettingsDomain}.${string}`, PetStructuredRule>> = {
  // A playlist longer than the sheet has frames cannot be played: 8 columns by 9 rows is 72
  // frames, and a clip is at least one frame.
  'character.idleClips': { container: 'list', member: { kind: 'row' }, max: 72 },
  'character.bindings': { container: 'map', value: { kind: 'row' }, max: 32 },
  'message.hiddenAgents': { container: 'list', member: { kind: 'line', maxLength: KEY_MAX_LENGTH }, max: 64 },
  'message.tokens': { container: 'list', member: { kind: 'token-item' }, max: 16 },
  'message.quickBubbles': { container: 'list', member: { kind: 'line', maxLength: 120 }, max: 50 },
  'message.agentIcons': { container: 'map', value: { kind: 'line', maxLength: KEY_MAX_LENGTH }, max: 64 },
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

/** A spritesheet row: whole, non-negative, finite. `animation-bindings.ts`'s `isRow` is the rule. */
function isRow(raw: unknown): boolean {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
}

/**
 * Unicode's `Cc` — the C0 and C1 control characters, DEL included. A stored line carrying
 * one is not a line of text this build drew: the newline cases below are the ones a textarea
 * can produce, and the rest are what a hand-edited file can.
 *
 * A property escape rather than a character class, so the pattern does not itself carry the
 * characters it is refusing (`no-control-regex`, and the same spelling `services/rtl.ts`
 * uses for `Cf`).
 */
const CONTROL_CHARACTERS = /\p{Cc}/u

/**
 * One line of stored text: a string that is not blank, carries no control character, and
 * fits its cap.
 *
 * A newline is refused rather than trimmed, because the fields this serves are *lists of
 * lines*: a quick bubble with a newline inside it is two bubbles the user wrote as one, and
 * an agent id with one is an id no registry will ever match. Leading and trailing spaces
 * are kept as written — upstream trims on the way in (`settings.ts:1797`), and a validator
 * that trimmed on the way out would be a second editor of the user's words.
 */
function isLine(raw: unknown, maxLength: number): boolean {
  return (
    typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= maxLength &&
    raw.trim().length > 0 &&
    !CONTROL_CHARACTERS.test(raw)
  )
}

/**
 * One member as this build may keep it, or null.
 *
 * The check and the copy are one function on purpose. For a scalar member the two are the
 * same question; for a `token-item` the copy is also where a stray key is dropped, and a
 * separate predicate would have to be kept in step with that by review — the shape this
 * file's one-table-per-kind design exists to avoid.
 */
function readMember(rule: PetMemberRule, raw: unknown): { value: unknown } | null {
  if (rule.kind === 'row') return isRow(raw) ? { value: raw } : null
  if (rule.kind === 'line') return isLine(raw, rule.maxLength) ? { value: raw } : null
  if (!isSettingsObject(raw)) return null
  if (!isLine(raw.token, TOKEN_MAX_LENGTH) || typeof raw.visible !== 'boolean') return null
  // The two named keys only. A third is a member this build did not write — a record from a
  // future build, or an edited file — and it is dropped the way an unknown key of a stored
  // *domain* is dropped, rather than carried into the values this build hands out.
  return { value: { token: raw.token, visible: raw.visible } }
}

/**
 * One structured value as this build may keep it, or null when it may not be used at all.
 *
 * All or nothing, like every other field here: a list whose fourth member is not a row
 * takes the field's whole fallback rather than being trimmed to its usable prefix, because
 * a playlist the build silently shortened is a playlist the user did not write, and §5.3's
 * rule for a stored value that cannot be used is the rule's own fallback.
 */
function readStructured(rule: PetStructuredRule, raw: unknown): { value: unknown } | null {
  if (rule.container === 'list') {
    if (!Array.isArray(raw) || raw.length > rule.max) return null
    const members: unknown[] = []
    for (const item of raw) {
      const member = readMember(rule.member, item)
      if (member === null) return null
      members.push(member.value)
    }
    return { value: members }
  }
  if (!isSettingsObject(raw)) return null
  const entries = Object.entries(raw)
  if (entries.length > rule.max) return null
  const pairs: Array<[string, unknown]> = []
  for (const [key, item] of entries) {
    if (!isLine(key, KEY_MAX_LENGTH)) return null
    const member = readMember(rule.value, item)
    if (member === null) return null
    pairs.push([key, member.value])
  }
  // `Object.fromEntries` and not an assignment loop: it defines an own key, so a stored
  // `{"__proto__": …}` — which `JSON.parse` does produce as an own key — becomes a member
  // of the map rather than the prototype of the object this build keeps.
  return { value: Object.fromEntries(pairs) }
}

/**
 * The rule for one field, decided by the field's own default: an array or an object is a
 * structured value and has to have one.
 *
 * A throw where the table is missing, like `numberRule`, and for the same reason — guessing
 * here would validate against a rule nobody wrote.
 */
function structuredRuleFor(path: string, fallback: unknown): PetStructuredRule | null {
  if (!Array.isArray(fallback) && !isSettingsObject(fallback)) return null
  const rule = PET_STRUCTURED_RULES[path as `${PetSettingsDomain}.${string}`]
  if (!rule) throw new Error(`no structured rule for ${path}`)
  return rule
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
  const structured = structuredRuleFor(path, fallback)
  if (structured !== null) {
    return readStructured(structured, raw) === null ? { path, kind: 'wrong-shape' } : null
  }
  // The remaining field kind is `characterId: string | null`, whose default is the `null`
  // that reached this branch: §5.3 keeps identifiers in settings and the assets in the
  // managed data directory.
  return raw === null || typeof raw === 'string' ? null : { path, kind: 'wrong-type' }
}

/**
 * What a stored value that cannot be used becomes: the rule's own fallback, decided once.
 *
 * A structured fallback is handed out as a **copy**, and that is load-bearing rather than
 * tidy. `PET_SETTINGS_DEFAULTS` is a module constant the whole process shares, so handing
 * out its array would let one page's draft edit — a reactive proxy, in the caller — rewrite
 * the default every other page reads. For a scalar the language cannot even express that;
 * for an array it is one `push` away.
 */
function fallbackFor(domain: PetSettingsDomain, field: string, fallback: unknown): unknown {
  const path = `${domain}.${field}`
  const structured = structuredRuleFor(path, fallback)
  if (structured !== null) {
    const read = readStructured(structured, fallback)
    if (read === null) {
      // Not reachable from data: this is the schema's own default, judged by the rule
      // written next to it. A throw rather than an empty list, for `numberRule`'s reason.
      throw new Error(`the default of ${path} is not a value of its own rule`)
    }
    return read.value
  }
  return typeof fallback === 'number' ? numberRule(path).fallback : fallback
}

/**
 * The value a field that passed {@link fieldProblem} keeps.
 *
 * A scalar is kept as it stands. A structured value is kept as this build's own copy,
 * because the stored array is the *store's* object: handing it out would let a page's draft
 * edit reach back into the record it was read from, and the memory double would then hold a
 * value nobody wrote.
 *
 * The call walks a value the predicate has just accepted, which is a second pass over at
 * most a few dozen members. That is the price of one predicate for both directions, and it
 * is the same price `readPetSettingsValues` already pays by walking the defaults.
 */
function keptValue(path: string, fallback: unknown, candidate: unknown): unknown {
  const structured = structuredRuleFor(path, fallback)
  if (structured === null) return candidate
  const read = readStructured(structured, candidate)
  if (read === null) {
    // Not reachable from data: `fieldProblem` ran the same walk over the same value.
    throw new Error(`a value of ${path} that passed its rule could not be read back`)
  }
  return read.value
}

/**
 * A stored domain's values, normalized field by field.
 *
 * Absent and unusable are told apart deliberately: a field the record does not carry at all
 * was never set (an older schema's field, or a fresh install) and defaults quietly, while a
 * field that *is* there and cannot be used is defaulted **and reported**. Merging the two
 * would make every migrated record look as though it had repaired something.
 *
 * **`general.enabled` is recomputed here, and this is the only place it is decided on this
 * side.** It is not a control any more: its value is `characterWindow || ball`, and every
 * direction goes through this function — a record read off the disk, and a submission the
 * store is about to persist — so the page can never be handed a record whose master
 * disagrees with the two switches under it. The Rust half does the same thing in the same
 * place (`settings::values::read_values`), and §5.3's 「界面和后端使用同一规则」 is why the
 * two are written to match: a page that derived this differently from the store would show a
 * "unsaved" badge for a save that landed.
 *
 * It is *not* reported as a repair: the field is not a value the user set that this build
 * could not use, it is a sentence about two other fields. The one arm where a stored
 * `enabled` really does carry a user's choice is a record from before the derivation existed
 * — schema 3, where it was a master switch — and that is a *migration*, not a repair
 * (`pet-settings-policy.ts`'s `readPetSettingsDomain`).
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
    const path = `${domain}.${field}`
    const problem = fieldProblem(domain, field, fallback, candidate)
    values[field] = problem ? fallbackFor(domain, field, fallback) : keptValue(path, fallback, candidate)
    if (problem) repaired.push(path)
  }
  if (domain === 'general') {
    // Both fields are present and boolean by the loop above — it fills every field the
    // schema declares, and a boolean's rule admits booleans alone — so this reads them
    // rather than falling back on anything.
    values.enabled = values.characterWindow === true || values.ball === true
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
 * Whether two members of one structured field are the same value, by the member's own rule.
 *
 * Rule-driven rather than a generic deep walk: a member is one of the three shapes
 * {@link PetMemberRule} names and nothing else, so a general comparison would be a second
 * description of the same data with its own opinion about what counts as equal.
 */
function sameMember(rule: PetMemberRule, a: unknown, b: unknown): boolean {
  if (rule.kind !== 'token-item') return a === b
  return isSettingsObject(a) && isSettingsObject(b) && a.token === b.token && a.visible === b.visible
}

/**
 * Whether two structured values are the same, member for member.
 *
 * A list's *order* is part of it — `ap_idle_clips` is a playlist, and two lists of the same
 * clips in a different order play differently — while a map's key order is not, exactly as
 * it is not for a domain's own fields.
 */
function sameStructured(rule: PetStructuredRule, a: unknown, b: unknown): boolean {
  if (rule.container === 'list') {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameMember(rule.member, item, b[index]))
    )
  }
  if (!isSettingsObject(a) || !isSettingsObject(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && sameMember(rule.value, a[key], b[key]),
    )
  )
}

/**
 * Whether two sets of values for one domain are the same field for field.
 *
 * Key *order* is not part of it — a draft assembled by spread and a record read from disk
 * hold the same keys in different orders — and the comparison walks the schema's fields
 * rather than the objects' own, so a stray key on either side cannot make two different
 * values look equal. A structured field is compared by value and not by reference: two
 * equal arrays are two objects, and a `===` here would make every domain that holds one
 * permanently dirty, which is a form that writes on every open and moves the revision out
 * from under every other window.
 *
 * Callers need this for two rules: a form is "dirty" when its draft is not what is stored,
 * and an unchanged draft must not be written, because a write that changes nothing still
 * moves the revision and turns every other window's open form into a conflict.
 */
export function samePetSettingsValues(domain: PetSettingsDomain, a: unknown, b: unknown): boolean {
  if (!isSettingsObject(a) || !isSettingsObject(b)) return false
  const defaults = defaultFields(domain)
  return Object.keys(defaults).every((field) => {
    const path = `${domain}.${field}`
    const structured = structuredRuleFor(path, defaults[field])
    return structured === null
      ? a[field] === b[field]
      : sameStructured(structured, a[field], b[field])
  })
}
