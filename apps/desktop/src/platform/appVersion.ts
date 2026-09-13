/**
 * The app's own version, for the settings panel.
 *
 * Support needs it: a bug report that does not say which build produced it
 * costs a round trip. Kept in the platform layer like `window.ts` and
 * `systemAccent.ts` - the UI calls it, and nothing here knows about settings.
 *
 * Two sources, because the app runs in two places: inside Tauri the packaged
 * version is authoritative (it is what the exe is built from), and in the
 * browser demo (or a unit test) there is no app to ask, so the build-time
 * value from package.json is used. Both failing is possible and returns null;
 * the caller then shows nothing rather than a wrong number.
 */

import { getVersion } from '@tauri-apps/api/app'

/** Injected by vite.config.ts from this package's package.json. */
export const BUILD_VERSION: string = __APP_VERSION__

export async function readAppVersion(): Promise<string | null> {
  try {
    const version = await getVersion()
    return typeof version === 'string' && version.trim() ? version.trim() : BUILD_VERSION
  } catch {
    // Outside Tauri (the browser demo, a bare unit test) there is no app handle.
    return BUILD_VERSION || null
  }
}
