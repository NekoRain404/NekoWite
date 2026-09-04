/** Session persistence for multi-tab restore across app restarts.
 *
 * A session records which vault-relative (well, absolute) note paths were
 * open in tabs at the last capture, plus which one was active. It is kept
 * deliberately small and serializable: only tabs that already have a real
 * `path` are stored — unsaved, temporary tabs (untitled docs with no path)
 * cannot be restored by path and are dropped. Restoring replays the paths
 * through the tabs store's own `openTab`, which reuses its duplicate guard
 * and async content refill. */

export const SESSION_KEY = 'nekowite.session'
export const SESSION_VERSION = 1

export interface Session {
  v: 1
  vault: string
  paths: string[]
  activeId: string | null
}

/** Shape consumed by `serializeSession`. Only `tabs[].path` is read; the
 * active tab is referenced by its *path* so it survives the id regeneration
 * that happens on restore (ids are meaningless across processes). */
export interface SessionSource {
  vault: string | null
  activeId: string | null
  tabs: Array<{ path: string | null }>
}

export function serializeSession(source: SessionSource): string | null {
  if (!source.vault) return null
  const paths = source.tabs
    .map((t) => t.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  // Nothing restorable — no note tabs were open for this vault.
  if (paths.length === 0) return null
  const session: Session = {
    v: SESSION_VERSION,
    vault: source.vault,
    paths,
    activeId: source.activeId ?? null,
  }
  return JSON.stringify(session)
}

export function parseSession(raw: string | null): Session | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupted storage (truncated write, hand-edited key, ...) must not
    // crash startup; treat it as "no session".
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.v !== SESSION_VERSION) return null
  if (typeof obj.vault !== 'string' || obj.vault.length === 0) return null
  if (!Array.isArray(obj.paths)) return null
  const paths = obj.paths.filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  if (paths.length === 0) return null
  const activeId =
    typeof obj.activeId === 'string' && obj.activeId.length > 0
      ? obj.activeId
      : null
  return { v: SESSION_VERSION, vault: obj.vault, paths, activeId }
}
