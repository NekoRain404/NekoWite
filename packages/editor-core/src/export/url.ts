/**
 * URL sanitising for rendered output.
 *
 * Markdown link and image destinations are attacker-controlled whenever a note
 * comes from elsewhere (a shared vault, a downloaded file, a pasted document).
 * Emitting one straight into `href`/`src` turns the export into a script host:
 * `[x](javascript:alert(1))` produces a clickable `javascript:` link, and a
 * `data:text/html,...` link executes on click in the same way. Escaping HTML
 * metacharacters does not help — `javascript:alert(1)` contains none.
 *
 * The editor's own rendered pane is safe by a different mechanism (the link
 * mark drops the href), which is exactly why this was only visible in exports.
 * The rule here is an allowlist: anything that is not clearly safe is emitted
 * without a destination.
 */

/** Schemes that may appear in a link. */
const SAFE_LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']

/**
 * Schemes an `<img src>` may use.
 *
 * `data:` is allowed here but NOT for links: an image payload rendered as an
 * image cannot execute, while a `data:text/html` navigation can.
 *
 * `asset:` is the scheme the app itself resolves vault media to, so the
 * sanitiser must not strip the URLs it produced. (On Windows Tauri's
 * `convertFileSrc` emits an `http://asset.localhost/...` URL instead, which the
 * `http:` entry already covers.)
 */
const SAFE_IMAGE_SCHEMES = [...SAFE_LINK_SCHEMES, 'data:', 'asset:']

/**
 * Image data payloads considered safe to inline.
 *
 * SVG is deliberately excluded even though it is a valid image type: an SVG
 * document CAN carry script, and "open image in new tab" turns the payload into
 * a top-level document where that script runs. Raster formats have no such
 * capability. The cost is that an inlined SVG attachment does not render in an
 * export; it stays a vault file, and the SVG itself is unaffected.
 */
const SAFE_INLINE_IMAGE_TYPES = [
  'data:image/png',
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/gif',
  'data:image/webp',
  'data:image/bmp',
  'data:image/avif',
  'data:image/tiff',
  'data:image/x-icon',
  'data:image/vnd.microsoft.icon',
]

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i

/**
 * Strip the characters a browser ignores inside a scheme.
 *
 * `java\tscript:alert(1)` and `java\nscript:` both execute after the browser
 * removes the control characters, so the check has to see the same string the
 * browser will. Only used for the check — the original text is what gets
 * emitted.
 */
function forSchemeCheck(url: string): string {
  let out = ''
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) continue
    out += ch
  }
  return out.toLowerCase()
}

/** The scheme of `url` (lowercased, with the colon), or null when it has none
 *  — a relative path, an absolute path, or a `#fragment`. */
export function urlScheme(url: string): string | null {
  const match = SCHEME_RE.exec(forSchemeCheck(url))
  return match ? `${match[1]}:` : null
}

/**
 * A link destination safe to emit, or null when the URL must not be used.
 *
 * A URL with no scheme is kept as-is: `notes/other.md`, `/abs/path` and
 * `#anchor` are all same-document or relative references.
 */
export function safeLinkUrl(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim()
  if (!raw) return null
  const scheme = urlScheme(raw)
  if (scheme === null) return raw
  return SAFE_LINK_SCHEMES.includes(scheme) ? raw : null
}

/** An image destination safe to emit, or null when it must not be used. */
export function safeImageUrl(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim()
  if (!raw) return null
  const scheme = urlScheme(raw)
  if (scheme === null) return raw
  if (!SAFE_IMAGE_SCHEMES.includes(scheme)) return null
  // `data:` is only acceptable for a raster image payload.
  if (scheme === 'data:') {
    const normalized = forSchemeCheck(raw)
    if (!SAFE_INLINE_IMAGE_TYPES.some((type) => normalized.startsWith(type))) return null
  }
  return raw
}
