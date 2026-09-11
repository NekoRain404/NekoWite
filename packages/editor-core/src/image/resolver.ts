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

let resolver: ImageSrcResolver | null = null
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
export function configureImageResolver(resolve: ImageSrcResolver | null): void {
  resolver = resolve
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
 * `refresh` drops the memoized entry first. A failed resolution is memoized
 * like a successful one, so without this a Retry would replay the same failure
 * forever — which is what happened when the first attempt ran before the vault
 * was authorized.
 */
export function resolveImageSrc(src: string, options: { refresh?: boolean } = {}): Promise<string> {
  if (!src) return Promise.resolve(src)
  // Already displayable, or nothing to resolve with: hand the src straight back
  // and never memoize it — caching a pass-through would outlive the reason for
  // it (e.g. no vault yet) and block every later resolution.
  if (isSelfDisplayableSrc(src) || !resolver) return Promise.resolve(src)
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
