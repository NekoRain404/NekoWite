/**
 * The checks that turn an untrusted IPC answer into a domain shape, written once for the feature.
 *
 * `agent-{permission,catalogue,registry,profile,config}-ipc.ts` each read a wire whose answer is
 * `unknown` (`platform` may not name a feature's types, so the shape is this side's
 * responsibility), and each of them carried its own copy of the functions below — five copies of
 * one rule, which is five places for it to drift. This file is the rule, and those five import it.
 *
 * **A shape this window cannot read is a rejection.** Never a cast, which is a promise about a
 * foreign process, and never an empty readout, which is a claim about the backend: a renamed field
 * or an arm the backend grew would reach a page and render as a blank row — a state the backend
 * never stated, which is the one reading these clients exist to make impossible.
 *
 * **The message names the field, never the value it held.** What a malformed answer contains is
 * unknown by construction — that is what the check that just failed means — and one of these wires
 * carries a profile's credential fields, so a path that copied wire text into an error would be the
 * one with no mask at all. The subject is the feature rather than the file, which is also the truer
 * of the two: the permission client said "the profile" while reading the engine's grants, and the
 * configuration client said "the configuration document" while reading a profile.
 *
 * **`null` is a value and an absent member is not.** This is where the five copies disagreed, and
 * the four that agree are the ones kept: `asNullableString` accepted `undefined` as `null` in
 * `agent-permission-ipc.ts` alone, which is the loosest reading of the five and the one that lets a
 * member the backend stopped sending render as a fact it stated. The host writes its nullables
 * explicitly — `agent_settings.rs`'s `profile_view` sends `document` as a path or as a `null` — so
 * a member that is not there at all is an answer that did not come from this host, and refusing it
 * is the same arm every other field takes.
 *
 * What is *not* here is anything that reads a particular field: which members a wire carries and
 * which arms are legal for it stay in the client that reads it, because that is the vocabulary of
 * one answer and not of the rule.
 */

// ---------------------------------------------------------------------------
// The rejection
// ---------------------------------------------------------------------------

/** A failed call, not a refused one: the caller's unreadable state is the answer to this. */
export function malformed(what: string): never {
  throw new Error(
    `the agent settings backend answered something this window does not understand: ${what}`,
  )
}

// ---------------------------------------------------------------------------
// The members
// ---------------------------------------------------------------------------

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed(what)
  return value as Record<string, unknown>
}

export function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) return malformed(what)
  return value
}

export function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') return malformed(what)
  return value
}

/**
 * A member that may be `null`, and only `null`.
 *
 * An absent member is not one of them — see the module comment: the host sends an explicit `null`
 * for a nullable field, so `undefined` is a shape this build did not write and cannot read.
 */
export function asNullableString(value: unknown, what: string): string | null {
  if (value === null) return null
  return asString(value, what)
}

export function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') return malformed(what)
  return value
}

/** A whole number: the numbers these wires carry are counts, positions and byte sizes. */
export function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return malformed(what)
  return value
}

export function asStringList(value: unknown, what: string): string[] {
  return asList(value, what).map((item, index) => asString(item, `${what}[${index}]`))
}

export function asStringRecord(value: unknown, what: string): Record<string, string> {
  const record = asRecord(value, what)
  const entries = Object.entries(record).map(([key, item]) => [
    key,
    asString(item, `${what}.${key}`),
  ])
  return Object.fromEntries(entries)
}

/**
 * One of a closed set of ids, checked against the list rather than cast to the union.
 *
 * The caller passes its own list, typed against the union, so an arm the backend grew is a
 * rejection here and a compile error in the list — the one place a new arm has to be acknowledged.
 */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const text = asString(value, what)
  if (!(allowed as readonly string[]).includes(text)) return malformed(what)
  return text as T
}
