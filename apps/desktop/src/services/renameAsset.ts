import { relativePathFromNoteVault, suggestedPasteFileName } from './attachments'

export interface AssetMove {
  /** vault-relative source path (e.g. `.tmp/pic.png`) */
  from: string
  /** vault-relative destination path (e.g. `notes/a_assets/pic.png`) */
  to: string
}

/** Pre-fill the rename dialog with the pasted file's suggested name. */
export function suggestRename(file: { name: string; type: string }): string {
  return suggestedPasteFileName(file)
}

/** Validate a user-entered attachment file name against the rules the backend
 * sanitizer enforces. Returns an error message, or `null` when acceptable. */
export function validateRenameName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '请输入文件名'
  if (trimmed.includes('/') || trimmed.includes('\\')) return '文件名不能包含路径分隔符'
  if (trimmed.includes('..')) return '文件名不能包含连续的 .'
  if (trimmed.startsWith('.')) return '文件名不能以 . 开头'
  if (!trimmed.includes('.')) return '请保留扩展名，如 .png'
  return null
}

/** The vault-relative directory that owns a note's resources. A saved note
 * gets `<noteDir>/<basename>_assets`; a `null` or empty `notePath` (unsaved
 * tab) stages into `.tmp` at the vault root instead. */
export function assetsDirForNote(notePath: string | null, vault: string): string | null {
  if (!notePath) return '.tmp'
  const v = (vault || '').replace(/\/+$/, '')
  let p = notePath
  if (v !== '' && (p === v || p.startsWith(`${v}/`))) {
    p = p.slice(v.length).replace(/^\/+/, '')
  } else if (p.startsWith('/')) {
    p = p.replace(/^\/+/, '')
  }
  const name = p.split('/').pop() ?? p
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  if (!base) return null
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
  return dir ? `${dir}/${base}_assets` : `${base}_assets`
}

/** Build the rename (move) operations for a set of vault-relative asset paths
 * that live under `fromDir` and must land under `toDir`. */
export function moveAttachments(
  fromDir: string,
  toDir: string,
  relPaths: string[],
): AssetMove[] {
  const prefix = fromDir.replace(/\/+$/, '')
  return relPaths.map((rel) => {
    if (prefix && rel !== prefix && !rel.startsWith(`${prefix}/`)) {
      throw new Error(`asset ${rel} is not under ${prefix}`)
    }
    const name = rel.split('/').pop() ?? rel
    if (!name) throw new Error('empty asset path')
    return { from: rel, to: `${toDir}/${name}` }
  })
}

/** Rewrite `.tmp/…` markdown srcs in a note body to their new `to` locations
 * once the staged resources are moved into the note's assets directory. */
export function rewireTempRefsInContent(
  content: string,
  moves: AssetMove[],
  notePath: string,
  vault: string,
): string {
  let out = content
  for (const { from, to } of moves) {
    // An unsaved note inserted the staged path verbatim (no note-relative
    // `../` prefix because it was authored at the vault root).
    const oldSrc = from
    const newSrc = relativePathFromNoteVault(notePath, vault, to)
    out = out.split(oldSrc).join(newSrc)
  }
  return out
}
