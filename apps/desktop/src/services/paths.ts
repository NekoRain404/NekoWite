/**
 * Path helpers that work with BOTH separators.
 *
 * The app receives absolute paths from the Rust layer in the platform's native
 * form — on Windows that is `\\?\C:\Users\...\note.md`, with backslashes —
 * while every *derived* value it builds (vault-relative keys, markdown links,
 * history and trash keys) is `/`-separated. Code that assumed `/` therefore
 * broke on Windows in a way that is invisible on macOS/Linux:
 *
 *   - the tab bar and the note list rendered the ENTIRE absolute path as the
 *     document's name, because `path.split('/').pop()` returns the input
 *     unchanged when there is no `/`;
 *   - renaming a file from the tree silently did nothing, because the parent
 *     directory lookup could never match a node.
 *
 * These helpers only ever *derive* strings (a name, a directory, a joined
 * path). They never rewrite the path itself, so a value that goes back over IPC
 * keeps the exact spelling the backend produced.
 */

/** True when `p` uses a Windows path separator somewhere in its body. */
export function usesBackslash(p: string): boolean {
  return p.includes('\\')
}

/** The last segment of `p` (its name), for either separator.
 *  A trailing separator is ignored, and a bare name is returned as-is. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** Everything before the last segment of `p`, keeping the original
 *  separators. Returns `p` unchanged when it has no separator. */
export function dirName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? (cut === 0 ? trimmed.slice(0, 1) : p) : trimmed.slice(0, cut)
}

/** Join `dir` and `name` with ONE separator, matching the style already used
 *  by `dir` so a Windows path never turns into a mixed spelling. */
export function joinPath(dir: string, name: string): string {
  const sep = usesBackslash(dir) ? '\\' : '/'
  const trimmed = dir.replace(/[\\/]+$/, '')
  return trimmed === '' ? name : `${trimmed}${sep}${name}`
}

/** Strip a leading `vault` prefix from `path`, tolerating either separator on
 *  both sides, and return the remainder with any leading separators removed.
 *  A path that does not start with the vault is returned unchanged (minus
 *  leading separators). */
export function stripVaultPrefix(path: string, vault: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/')
  const v = norm(vault).replace(/\/+$/, '')
  const p = norm(path)
  if (v !== '' && (p === v || p.startsWith(`${v}/`))) {
    return p.slice(v.length).replace(/^\/+/, '')
  }
  return p.replace(/^\/+/, '')
}

/** Whether two paths name the same location on this platform.
 *
 *  Windows (and macOS) compare paths case-insensitively, and the same folder
 *  reaches the app in several spellings: the folder picker, a stored session, a
 *  mapped drive letter, or a user who re-typed the capitalisation. Comparing the
 *  raw strings made those look like different vaults — which dropped the whole
 *  restored tab set silently, because the session was "for another vault".
 *  Separators are normalised too, since a path may arrive with either. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/[/]+$/, '')
  const left = norm(a)
  const right = norm(b)
  if (left === right) return true
  // POSIX filesystems are case-sensitive, so folding there would merge two real
  // directories. Only Windows gets the case-insensitive comparison.
  if (!isWindowsPath(left) || !isWindowsPath(right)) return false
  return left.toLowerCase() === right.toLowerCase()
}

/** A path that is (or looks like) a Windows absolute path. */
function isWindowsPath(p: string): boolean {
  const sep = String.fromCharCode(92)
  if (p.startsWith('//') || p.startsWith(sep + sep)) return true
  return p.length > 2 && p[1] === ':' && (p[2] === '/' || p[2] === sep)
}
