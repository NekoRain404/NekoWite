/**
 * The field predicates every payload reader is built from.
 *
 * Shared so a field is judged the same way whichever payload it belongs to: a known
 * field that is missing or of the wrong type makes the frame malformed, while an
 * unknown *extra* field is ignored (a newer engine's addition must not break a window
 * that has not been rebuilt). Skipping a malformed field instead would hand a
 * component a value the contract does not describe — the one thing §6.2 forbids.
 */

/** A frame field that is an object rather than an array or null. */
export function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

/** A required, non-empty string field of `raw`, or null when it is missing. */
export function str(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A count that could have come from the engine: a non-negative safe integer. */
export function count(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null
}

/** A required list of non-empty strings. An empty list is a valid answer — a turn
 *  may touch no files, a plan may have no entries — so only the element type is
 *  checked. */
export function strings(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const values: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) return null
    values.push(entry)
  }
  return values
}

/** One member of a closed set of wire values, or null when it is not one of them.
 *  Used for the protocol's enums, so a value this host does not know is a validation
 *  failure rather than a silently different behaviour. */
export function member<T extends string>(values: readonly T[], raw: unknown): T | null {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw)
    ? (raw as T)
    : null
}

/**
 * An optional string field, in the three states the protocol distinguishes: absent
 * (the update did not mention it), an explicit null (the engine cleared it), and a
 * value. Returns null when the field is present but is neither — a wrong type is
 * malformed, not a clear.
 */
export function maybeStr(
  raw: Record<string, unknown>,
  key: string,
): { seen: boolean; value: string | null } | null {
  const value = raw[key]
  if (value === undefined) return { seen: false, value: null }
  if (value === null) return { seen: true, value: null }
  if (typeof value === 'string' && value.length > 0) return { seen: true, value }
  return null
}
