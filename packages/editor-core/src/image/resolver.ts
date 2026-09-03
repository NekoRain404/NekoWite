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
 * Install (or clear) the async src resolver. Re-configuring drops the cache
 * so a vault switch can never serve URLs resolved against the old vault.
 */
export function configureImageResolver(resolve: ImageSrcResolver | null): void {
  resolver = resolve
  cache.clear()
}

/** Resolve `src` for display, with per-src memoization and error fallback. */
export function resolveImageSrc(src: string): Promise<string> {
  if (!src || isSelfDisplayableSrc(src) || !resolver) return Promise.resolve(src)
  let pending = cache.get(src)
  if (!pending) {
    const current = resolver
    pending = Promise.resolve()
      .then(() => current(src))
      .catch(() => src)
    cache.set(src, pending)
  }
  return pending
}
