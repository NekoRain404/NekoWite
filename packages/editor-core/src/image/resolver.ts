/**
 * Display-layer image src resolution.
 *
 * The document model keeps the markdown-faithful src (a vault-relative or
 * note-relative path); only the rendered <img> DOM receives a display URL
 * (asset: / data:) produced by an injected resolver. When no resolver is
 * configured the raw src is used as-is, so plain web/demo contexts keep
 * working without any wiring.
 */

export type ImageSrcResolver = (src: string) => Promise<string>

/** Src forms that are already displayable and must never hit the resolver. */
const SELF_DISPLAYABLE_RE = /^(https?:|data:|asset:|blob:|mailto:)/i

export function isSelfDisplayableSrc(src: string): boolean {
  return SELF_DISPLAYABLE_RE.test(src) || src.startsWith('/')
}

export interface ImageResolverOptions {
  /**
   * Token for the context a resolution depends on, beyond the src itself —
   * typically the vault plus the note the src is relative to.
   *
   * The app resolver turns a relative src into a display URL using the CURRENT
   * note, so `pic.png` means a different file in every directory. Keying the
   * memo on the src alone therefore served the previous note's picture in the
   * next one. When this token changes the memo is dropped, so an entry is never
   * reused across contexts.
   */
  scope?: () => string
}

let resolver: ImageSrcResolver | null = null
let scopeOf: (() => string) | null = null
let lastScope: string | null = null
const cache = new Map<string, Promise<string>>()

/**
 * Consumers that must re-resolve when the cache is dropped.
 *
 * A node view resolves once, at render time. If that resolution could not
 * succeed yet — the vault is not authorized, the file is still being written —
 * it has no way to know that a later attempt would work, so it subscribes here
 * and re-resolves on {@link invalidateImageResolution}.
 */
const listeners = new Set<() => void>()

/**
 * Install (or clear) the async src resolver. Re-configuring drops the cache
 * so a vault switch can never serve URLs resolved against the old vault.
 */
export function configureImageResolver(
  resolve: ImageSrcResolver | null,
  options: ImageResolverOptions = {},
): void {
  resolver = resolve
  scopeOf = options.scope ?? null
  // Force the next resolution to start from a clean memo: the scope is part of
  // what a memoized entry is valid for.
  lastScope = null
  invalidateImageResolution()
}

/**
 * Drop every memoized resolution and ask listeners to resolve again.
 *
 * Call this when the thing that resolutions depend on has changed — most
 * importantly when a vault becomes available. Without it, a resolution that
 * ran before the vault was ready stays cached and every image keeps pointing at
 * its unloadable document path.
 */
export function invalidateImageResolution(): void {
  cache.clear()
  notifyListeners()
}

/** Ask every subscribed consumer to resolve again. A torn-down node view must
 *  not abort the others, so each call is isolated. */
function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A torn-down node view must not abort the others.
    }
  }
}

/** Subscribe to resolution invalidation. Returns an unsubscribe. */
export function onImageResolutionInvalidated(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True when a resolver is installed (i.e. a vault-backed display URL is
 *  available and the document src is not directly loadable). */
export function hasImageResolver(): boolean {
  return resolver !== null
}

/**
 * Resolve `src` for display, with per-src memoization and error fallback.
 *
 * A SUCCESS is memoized (per `scope`, when one is configured); a failure is
 * not, so the next attempt re-runs it. `refresh` additionally drops the
 * memoized entry first, which is what a Retry uses to re-run even a success.
 */
export function resolveImageSrc(src: string, options: { refresh?: boolean } = {}): Promise<string> {
  if (!src) return Promise.resolve(src)
  // Already displayable, or nothing to resolve with: hand the src straight back
  // and never memoize it — caching a pass-through would outlive the reason for
  // it (e.g. no vault yet) and block every later resolution.
  if (isSelfDisplayableSrc(src) || !resolver) return Promise.resolve(src)
  // A memo is only valid for the context that produced it.
  if (scopeOf) {
    const scope = scopeOf()
    if (scope !== lastScope) {
      // The first observation commits a scope; nothing is mounted against a
      // previous one yet, so only a real CHANGE has to wake consumers up.
      const changed = lastScope !== null
      lastScope = scope
      cache.clear()
      // Mounted node views still hold the previous scope's display URL, and the
      // model is not necessarily re-opened when the scope changes (two notes can
      // hold byte-identical text, which the editor treats as "already applied").
      // Ask them to resolve again rather than relying on a re-render. The token
      // is committed above, so the re-entrant resolve does not recurse.
      if (changed) notifyListeners()
    }
  }
  if (options.refresh) cache.delete(src)
  let pending = cache.get(src)
  if (!pending) {
    const current = resolver
    pending = Promise.resolve()
      .then(() => current(src))
      .catch((error: unknown) => {
        // A failure is NOT memoized: it is usually a transient "not ready yet"
        // (vault not authorized, file mid-write), and caching it made the
        // first failure permanent — the "images fail on open, Retry fixes it"
        // report. The caller still gets the raw src as its fallback.
        cache.delete(src)
        throw error
      })
    cache.set(src, pending)
  }
  return pending.catch(() => src)
}
