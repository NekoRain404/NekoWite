/**
 * Create-only file write.
 *
 * `fsService.write` replaces whatever it finds - that is what saving means - so
 * anything that *creates* a note has to answer one question first: is this name
 * still free? Listing and then writing is two steps, and a second writer (another
 * instance of the app, a sync client, the user in Explorer) can take the name in
 * between. This adapter asks the backend for the atomic version instead, and
 * reports "taken" as an ordinary outcome for the caller to react to.
 *
 * Like `platform/window.ts`, this is a narrow platform adapter: the layers above
 * it stay free of the Tauri bridge.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Prefix the backend puts on "the file already exists" (mirrors
 * `errors::ALREADY_EXISTS_PREFIX` in the Rust side). Kept in one place so the
 * matching does not spread across call sites, and never shown to the user.
 */
export const ALREADY_EXISTS_PREFIX = 'EEXIST: '

export type CreateNewFileOutcome =
  /** The file was created, with exactly these bytes. */
  | 'created'
  /** The name is taken; nothing was written, so the caller can try another. */
  | 'exists'
  /** No create-only command behind this build (browser, or an older backend). */
  | 'unsupported'

/** Writes `content` to `path` only when `path` does not exist yet. */
export async function createNewFile(
  vault: string,
  path: string,
  content: string,
): Promise<CreateNewFileOutcome> {
  try {
    await invoke<void>('create_new_file', { vault_root: vault, path, content })
    return 'created'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Anything else (permissions, a path outside the vault, ...) is a real
    // failure: the caller's fallback write surfaces it with its own message.
    return message.startsWith(ALREADY_EXISTS_PREFIX) ? 'exists' : 'unsupported'
  }
}
