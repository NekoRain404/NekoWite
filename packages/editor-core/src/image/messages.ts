/**
 * User-visible strings for the image node view.
 *
 * editor-core is a reusable package with no i18n of its own, so the node view
 * shipped hardcoded English ("Image failed to load", "Retry") inside an
 * otherwise fully localized app. The host installs its own strings here, the
 * same way it installs the src resolver; the defaults keep a bare consumer
 * (tests, the demo page) working unchanged.
 */

export interface ImageNodeMessages {
  /** Retry action for a load that failed for a reason a retry can fix. */
  retry: string
  /** The node has no src at all. */
  missingSource: string
  /** The image could not be loaded. */
  loadFailed: string
  /**
   * A remote http(s) image the host refuses to load.
   *
   * The packaged app ships a strict CSP (`img-src 'self' asset: data: blob:`),
   * so a remote picture cannot render. Saying "failed to load" and offering
   * Retry there is actively misleading — Retry can never succeed.
   */
  remoteBlocked: string
  /** Action that hands a blocked remote image to the system browser. */
  openInBrowser: string
}

const DEFAULTS: ImageNodeMessages = {
  retry: 'Retry',
  missingSource: 'Missing image source',
  loadFailed: 'Image failed to load',
  remoteBlocked: 'Remote image not loaded (blocked by the security policy)',
  openInBrowser: 'Open in browser',
}

let messages: ImageNodeMessages = { ...DEFAULTS }

/** Install the host's strings. Pass null (or omit keys) to restore defaults. */
export function configureImageNodeMessages(next: Partial<ImageNodeMessages> | null): void {
  messages = next ? { ...DEFAULTS, ...next } : { ...DEFAULTS }
}

/** The strings the node view currently renders. */
export function imageNodeMessages(): ImageNodeMessages {
  return messages
}

/** True for an http(s) URL, i.e. an image that lives on another machine. */
export function isRemoteHttpSrc(src: string): boolean {
  return /^https?:\/\//i.test(src.trim())
}
