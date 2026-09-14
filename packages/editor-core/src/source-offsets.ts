/**
 * Map a text node's decoded VALUE back to the source it was written from.
 *
 * remark hands a text node back in its DECODED form: `&amp;` is five source
 * characters and one value character, `\[` is two and one, and the indentation
 * of a continuation line is dropped entirely. The citation and the wikilink
 * matcher both ask the SOURCE whether a match was escaped — `\[@foo]` is a
 * literal, `[@foo]` is a citation — so each value index has to be resolved to
 * the offset of the spelling it came from before the backslash can be looked
 * for there.
 *
 * The walk follows the source and the value together, and where the two
 * disagree it skips the source characters the value does not carry and
 * resynchronises. Assuming backslash escapes were the only skew is what broke
 * this: after an entity every later index pointed at the wrong character, so
 * `a &amp; \[@foo]` came back as a live citation with its escape gone.
 */

/** A remark text node: the value, and where it sits in the source. */
export interface SourceMappedText {
  value?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/**
 * The source offset of each character of `node.value`, as far as the two can be
 * walked in step. A character whose spelling starts with a backslash maps to
 * that backslash, so `source[offset] === '\\'` is the escape test.
 */
export function valueToSourceOffsets(source: string, node: SourceMappedText): Map<number, number> {
  const map = new Map<number, number>()
  const value = node.value
  const pos = node.position
  if (!pos || typeof value !== 'string' || source.length === 0) return map
  const start = pos.start.offset
  const end = pos.end.offset
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end > source.length) {
    return map
  }
  let si = start
  let vi = 0
  while (si < end && vi < value.length) {
    const ch = source[si]
    if (ch === '\\' && si + 1 < end) {
      map.set(vi, si)
      si += 2
      vi += 1
      continue
    }
    if (ch !== value[vi]) {
      // Desync: the value is shorter than the source here. Skip what the value
      // does not carry (the rest of an entity, a continuation line's indent) so
      // the characters after it keep their true offsets. When the value's
      // character never reappears, the walk stops and the remaining indexes are
      // left unmapped — an unmapped index is treated as "not escaped", which is
      // the behaviour without a map at all.
      const wanted = value[vi]
      let skip = si
      while (skip < end && source[skip] !== wanted) skip += 1
      if (skip >= end) break
      si = skip
    }
    map.set(vi, si)
    si += 1
    vi += 1
  }
  return map
}

/**
 * The indexes in `node.value` where `pattern` matches AND the match was
 * backslash-escaped in the source. Both matchers skip these indexes, so an
 * escaped construct stays literal text.
 */
export function escapedMatchIndexes(
  pattern: RegExp,
  source: string,
  node: SourceMappedText,
): Set<number> {
  const escaped = new Set<number>()
  const value = node.value
  if (typeof value !== 'string' || source.length === 0) return escaped
  const valueToSource = valueToSourceOffsets(source, node)
  if (valueToSource.size === 0) return escaped
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    const offset = valueToSource.get(match.index)
    if (offset !== undefined && source[offset] === '\\') escaped.add(match.index)
  }
  return escaped
}
