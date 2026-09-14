/* ------------------------------------------------------------------------- *
 * Version comparison, shared by the two governance gates that decide whether a
 * plugin may run: the supported-range check (`isVersionAllowed`) and the
 * revocation check (`isPluginRevoked` matches a version against a semver range).
 *
 * Pure and environment-agnostic: no state, no IO, nothing to inject. It is its
 * own module because both gates compare versions and neither should own the
 * other's rules — an off-by-one here is a plugin loading that should not have.
 * ------------------------------------------------------------------------- */

export interface SemVer {
  major: number
  minor: number
  patch: number
}

/** Parse a `major.minor.patch` version (an optional leading `v` is accepted).
 *  Pre-release/build metadata after `-`/`+` is ignored for comparison. Returns
 *  null for anything that is not a well-formed `d.d.d` version. */
export function parseSemver(version: string): SemVer | null {
  const m = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i)
  if (!m) return null
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) }
}

function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

function satisfiesToken(version: string, token: string): boolean {
  if (token === '*' || token === 'x' || token === 'X') return true
  const v = parseSemver(version)
  if (!v) return false
  // Wildcard ranges like "1.x", "1.2.*".
  if (/(^|[.])x$/i.test(token) || token.includes('*')) {
    const parts = token.replace(/[v ^~]/g, '').split('.')
    if (parts[0] && parts[0] !== '*' && parts[0] !== 'x' && Number(parts[0]) !== v.major) return false
    if (parts[1] && parts[1] !== '*' && parts[1] !== 'x' && Number(parts[1]) !== v.minor) return false
    if (parts[2] && parts[2] !== '*' && parts[2] !== 'x' && Number(parts[2]) !== v.patch) return false
    return true
  }
  // Caret range: >= base and < (major+1).0.0.
  if (token.startsWith('^')) {
    const base = parseSemver(token.slice(1))
    if (!base) return false
    const upper: SemVer = { major: base.major + 1, minor: 0, patch: 0 }
    return compareSemver(v, base) >= 0 && compareSemver(v, upper) < 0
  }
  // Tilde range: >= base and < major.(minor+1).0.
  if (token.startsWith('~')) {
    const base = parseSemver(token.slice(1))
    if (!base) return false
    const upper: SemVer = { major: base.major, minor: base.minor + 1, patch: 0 }
    return compareSemver(v, base) >= 0 && compareSemver(v, upper) < 0
  }
  let op = '='
  let rest = token
  const m = token.match(/^(>=|<=|>|<|=)?\s*(.+)$/)
  if (m && m[1]) {
    op = m[1]
    rest = m[2]
  }
  const target = parseSemver(rest)
  if (!target) return false
  const cmp = compareSemver(v, target)
  if (op === '>=') return cmp >= 0
  if (op === '<=') return cmp <= 0
  if (op === '>') return cmp > 0
  if (op === '<') return cmp < 0
  return cmp === 0
}

/** True when `version` satisfies `range`. Supports: exact, `all`, `||`,
 *  whitespace/comma-separated comparator sets (`>=1.0.0 <2.0.0`), caret (`^1.0.0`),
 *  tilde (`~1.2.0`) and x-ranges (`1.x`, `1.2.*`). */
export function versionSatisfies(version: string, range: string): boolean {
  const r = String(range).trim()
  if (r === 'all' || r === '*') return true
  if (String(version).trim() === r) return true
  if (r.includes('||')) return r.split('||').some((part) => versionSatisfies(version, part.trim()))
  const tokens = r.split(/[,\s]+/).filter(Boolean)
  if (tokens.length === 0) return false
  return tokens.every((tok) => satisfiesToken(version, tok))
}
