/**
 * The provider block a settings form writes, and the rules it is built under.
 *
 * ## Why this is a module rather than code inside the form
 *
 * §3.4.5 leaves the *format* of an engine's configuration to a verified adapter, and this app has one
 * for the engine it bundles — so the names below are that engine's own schema, spelled where they can
 * be read and tested rather than inside a template. `tests/agent_live_test.rs`'s `PROVIDER_CONFIG` is
 * the block this repository measured against the pinned engine, and
 * `agent-provider-block.test.ts` reads *that file* to hold these member paths to it: a name invented
 * here would fail a test rather than reaching a user as an engine that lists no models.
 *
 * ## What the form writes, and what it deliberately does not
 *
 * The block is the whole value of one member, `provider.<id>`, and the submission that writes it has
 * exactly two edits: the group (`provider`), which the backend may only *add* — `ConfigEdit.ifAbsent`,
 * so a document that already holds the user's own providers keeps every one of them — and the block
 * itself. Nothing else in the document is touched, and the backend splices both into the text rather
 * than rewriting it, so comments and unknown members survive.
 *
 * ## The key is a reference, never a value
 *
 * `options.apiKey` is `{env:<name>}`: the engine resolves the variable out of the environment this
 * app spawns it with, and the value itself goes to the profile's credential store through
 * `agent_credentials_write` — the file `credentials.json`, mode 0600, whose readout shows names and a
 * placeholder and never a value. So the configuration document, which this app's own settings page
 * renders in full and which the engine rewrites as it likes, carries no key at all.
 *
 * The name is *derived from the id* rather than typed: one rule, one place, so the block and the
 * credential write cannot name two different variables. {@link providerCredentialName} is that rule,
 * and the id rule above it is what keeps the derivation unambiguous — `a.b` and `a-b` must not both
 * become `A_B`.
 */

import type { ConfigEdit } from './agent-settings-policy'

/**
 * The adapter a provider block names.
 *
 * One value and no choices, because one is what this repository has measured: `@ai-sdk/openai-compatible`
 * is what `agent_live_test.rs` runs the pinned engine against, and what this block was re-measured
 * with offline (`opencode models <id>` against a config carrying exactly this shape, listing the
 * models the block declares, with the same id against an empty config answering `Provider not
 * found`). Any other value would be a guess about an adapter this app has never run, and a dropdown
 * of guesses is worse than one value that works.
 */
export const PROVIDER_ADAPTER = '@ai-sdk/openai-compatible'

/** The member the provider blocks live in, and the group edit's path. */
export const PROVIDER_MEMBER = 'provider'

/** One model the block declares, as the engine reads it: the id it is addressed by, and its label. */
export interface ProviderModel {
  id: string
  name: string
}

/** One row of the list the form draws: a model, whether it is ticked, and where the row came from. */
export interface ModelRow extends ProviderModel {
  checked: boolean
  /** `listed` rows are replaced by a fetch; `typed` ones are not. */
  source: 'listed' | 'typed'
}

/** What the form holds when it is submitted. */
export interface ProviderDraft {
  id: string
  /** The engine's display name for the provider. Blank means "the id". */
  name: string
  baseUrl: string
  key: ProviderKey
  models: readonly ProviderModel[]
}

/**
 * What a save does about this provider's key — the one thing a blank field cannot say by itself.
 *
 * The field is blank in two different situations and the block must come out differently in each:
 * the user never typed a key (nothing is stored, and an endpoint that needs none is a real
 * configuration), or one *is* stored and the field is empty because this page never shows a value
 * and clears the draft once a save lands. A builder that read blank as "no key" — which is what
 * this feature shipped — dropped the reference on the second save while the credential stayed in
 * the store, and the engine then authenticated with nothing.
 *
 * So the arm is decided *before* the block is built, by the form, from two facts it has to hand:
 * whether the profile stores a credential under this id's derived name (a read, not a guess), and
 * whether the user asked for it to be removed. A typed key outranks both: it is a value the user
 * just gave, and it is about to be stored.
 */
export type ProviderKey =
  /** Nothing is stored and nothing was typed: the block names no key. */
  | { kind: 'none' }
  /** The profile stores one: the block names it, and the save leaves the store alone. */
  | { kind: 'stored' }
  /** The user typed one: it is stored, and the block names it. */
  | { kind: 'set'; value: string }
  /** The user asked for the stored one to go: the block names none, and the store loses it. */
  | { kind: 'remove' }

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Why an id cannot be a provider id, or `null` when it can.
 *
 * Deliberately narrower than the two rules the backend actually enforces — a member name that is not
 * blank (`ConfigEdit::set`) and an environment variable name that is not blank, has no `=` and no
 * control character (`is_variable_name`). What this adds is the one thing the backend cannot check,
 * because it is a fact about the pair: {@link providerCredentialName} has to be *injective over the
 * ids a user may type*, and it is not if an id can hold anything. `a.b` and `a-b` both fold to `A_B`,
 * and two providers sharing one environment variable is a key sent to the wrong host.
 *
 * So the form's rule is stricter than the write's, and that direction is the safe one: every id this
 * accepts produces a name the backend accepts, and an id that would collide is refused here with a
 * sentence rather than silently sharing a credential.
 */
export function providerIdProblem(id: string): string | null {
  const trimmed = id.trim()
  if (trimmed === '') {
    return 'A provider needs an id: it is the name of the block in the engine’s configuration.'
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return (
      'A provider id can hold letters, digits, dots, dashes and underscores, and has to start with ' +
      'a letter or a digit. It becomes the name of a block in the engine’s configuration and part ' +
      'of the name the key is stored under.'
    )
  }
  return null
}

/**
 * The environment variable the engine resolves this provider's key from.
 *
 * Derived from the id so that the block and the credential write cannot disagree about the name:
 * one function, called by the code that builds the block and by the code that stores the value.
 */
export function providerCredentialName(id: string): string {
  const slug = id
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
  return `NWK_${slug}_API_KEY`
}

/**
 * What a model is called on screen, derived from the id the endpoint listed.
 *
 * The catalogues an OpenAI-compatible `/models` answers with carry no display name — measured on the
 * endpoint this app's own live tests use, whose entries are `{"id": …, "object": "model", "created":
 * 0, "owned_by": …}` — so a name has to be made from the id or the user is shown `deepseek-v4.1-flash`
 * twice and reads one of them twice. Empty segments are dropped, a segment that already carries an
 * uppercase letter is left exactly as it is (`GLM-5.2` keeps its capitals), and the rest have their
 * first letter raised. It is a guess about presentation and nothing more, which is why it is the
 * `name` of a model the block already identifies by id, and why the form shows the block it is about
 * to write.
 */
export function modelDisplayName(id: string): string {
  return id
    .split(/[-_ ]+/)
    .filter((segment) => segment !== '')
    .map((segment) =>
      /[A-Z]/.test(segment) ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join(' ')
}

// ---------------------------------------------------------------------------
// The block and the submission
// ---------------------------------------------------------------------------

/**
 * The value of `provider.<id>`, in the engine's own shape.
 *
 * `options.apiKey` is present exactly when a key is *there to name*: the user typed one, or the
 * profile stores one (see {@link ProviderKey}). A provider that needs no key is a real
 * configuration — an endpoint on the user's own machine — so the absent member is a state rather
 * than a failure, and the one state it must never be chosen from is "the field is blank".
 */
export function providerBlock(draft: ProviderDraft): Record<string, unknown> {
  const id = draft.id.trim()
  const name = draft.name.trim() === '' ? id : draft.name.trim()
  const options: Record<string, unknown> = { baseURL: draft.baseUrl.trim() }
  if (draft.key.kind === 'set' || draft.key.kind === 'stored') {
    options['apiKey'] = `{env:${providerCredentialName(id)}}`
  }
  const models: Record<string, unknown> = {}
  for (const model of draft.models) {
    models[model.id] = { name: model.name }
  }
  return { npm: PROVIDER_ADAPTER, name, options, models }
}

/**
 * The two edits one submission carries, in the order the backend applies them.
 *
 * The group first, and it is the only edit that is not a plain `set`: it is `ifAbsent`, so a document
 * that already has a `provider` member — one holding the user's own blocks, with their comments —
 * is left byte for byte, while a document that has none (a first run: this app writes `permission`
 * and nothing else) gains the group the block needs. Written as a plain `set` it would replace the
 * group, and every provider in it would be gone.
 *
 * The block second, as a plain `set` of one member: `provider.<id>`, replaced wholesale if a provider
 * of that id is already there. That is the same thing the raw editor below does when it sets a
 * member, and the form says so rather than pretending otherwise.
 */
export function providerEdits(draft: ProviderDraft): ConfigEdit[] {
  return [
    { path: [PROVIDER_MEMBER], value: {}, ifAbsent: true },
    { path: [PROVIDER_MEMBER, draft.id.trim()], value: providerBlock(draft) },
  ]
}

/**
 * The list with a fetch's ids merged in.
 *
 * A fetch is not a statement about what the endpoint *has* — it is a listing of what it answered
 * with — so a typed row survives it: an id the endpoint does not list is a model the user means
 * anyway, and a list whose content depended on somebody else's catalogue is one nobody can plan
 * against. Where both sides name one id there is one row, and the listed spelling wins, because
 * that is the id the engine will be asked for.
 *
 * What it does *not* keep is a listed row's tick: every id the answer carries is drawn ticked, so
 * unticking one and fetching again loses the untick. That is the behaviour this function was moved
 * out of the form with — the move changes nothing — and the sentence it was moved with
 * (「re-fetching must not clear a choice the user made」) claims more than it does. Reportable, and
 * deliberately not changed here.
 */
export function mergeListedModels(rows: readonly ModelRow[], ids: readonly string[]): ModelRow[] {
  const ticked = new Set(rows.filter((row) => row.checked).map((row) => row.id))
  const typed = rows.filter((row) => row.source === 'typed')
  const listedIds = new Set(ids)
  const listed: ModelRow[] = ids.map((id) => ({
    id,
    name: modelDisplayName(id),
    checked: true,
    source: 'listed',
  }))
  const kept = typed
    .filter((row) => !listedIds.has(row.id))
    .map((row) => ({ ...row, checked: ticked.has(row.id) }))
  return [...listed, ...kept]
}

/**
 * The list with one id typed by hand added, or ticked where it is already there.
 *
 * The row's source is `typed`, which is what keeps a re-fetch from judging it: an id the endpoint
 * does not list is a model the user means anyway, and a fetch that dropped it would be a list whose
 * content depends on somebody else's catalogue.
 */
export function addTypedModel(rows: readonly ModelRow[], id: string): ModelRow[] {
  const trimmed = id.trim()
  if (trimmed === '') return [...rows]
  if (rows.some((row) => row.id === trimmed)) {
    return rows.map((row) => (row.id === trimmed ? { ...row, checked: true } : row))
  }
  return [...rows, { id: trimmed, name: modelDisplayName(trimmed), checked: true, source: 'typed' }]
}

/**
 * Which arm a save is in, from the three facts a form has: the field, the store, and the user.
 *
 * The precedence is the whole rule. A typed value wins, because it is the key the user means and it
 * outranks both a pending removal (a contradiction the field has just resolved) and whatever the
 * store holds (which the save is about to replace). A pending removal comes next, and it is only
 * ever reachable where a key *is* stored — the control that sets it is drawn from `stored`. The last
 * two arms are the store's answer, which is the reading the field may not make: a blank field is
 * what a form shows on every provider that *has* a key, so `stored === null` (the read has not
 * landed) falls to `none` for the block and the form refuses the save rather than writing it.
 */
export function providerKey(input: {
  /** What the key field holds. */
  field: string
  /** Whether the store holds one under this provider's derived name, or `null` if unread. */
  stored: boolean | null
  /** Whether the user asked for the stored one to go. */
  removing: boolean
}): ProviderKey {
  const typed = input.field.trim()
  if (typed !== '') return { kind: 'set', value: typed }
  if (input.removing) return { kind: 'remove' }
  return input.stored === true ? { kind: 'stored' } : { kind: 'none' }
}

/**
 * Which of a save's two writes goes first.
 *
 * One invariant decides both directions: **the block never names a key the store does not hold.**
 * A reference to a variable nothing sets is not a request without a key — the engine substitutes an
 * empty string for `{env:…}` (measured in the pinned engine's own `ConfigVariable.substitute`,
 * which has no missing-variable arm at all), and `@ai-sdk/openai-compatible` then sets no
 * `Authorization` header, so the failure lands on the endpoint as an authentication error with
 * nothing on this side to read. So the value is stored *before* the block names it, and the block
 * stops naming it *before* the value goes.
 *
 * The same rule read at the plan's level: what may survive a half-finished save is a credential no
 * block points at — invisible and harmless — and never the other way round.
 */
export function providerWriteOrder(key: ProviderKey): 'key-first' | 'key-last' | 'block-only' {
  if (key.kind === 'set') return 'key-first'
  if (key.kind === 'remove') return 'key-last'
  return 'block-only'
}

/**
 * Why a draft cannot be submitted yet, or `null` when it can.
 *
 * The checks the form would otherwise discover by round trip, and no more: the id's rule, a base URL
 * that is not empty (the backend's policy is what decides whether an address is *allowed*, and it
 * answers with its own sentence), and at least one model — a block that declares none is a provider
 * the engine can see and cannot use, which is what this form exists to prevent.
 */
export function providerDraftProblem(draft: ProviderDraft): string | null {
  const id = providerIdProblem(draft.id)
  if (id !== null) return id
  if (draft.baseUrl.trim() === '') {
    return 'A provider needs a base URL: it is the address the engine sends requests to.'
  }
  if (draft.models.length === 0) {
    return (
      'A provider with no models is one the engine can see and cannot use. Fetch the list and tick ' +
      'the ones to configure, or type an id that was not listed.'
    )
  }
  return null
}
