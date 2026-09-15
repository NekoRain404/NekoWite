/**
 * The file the OS asked this process to open.
 *
 * `nekowite notes.md` on the command line, and a `.md` double-clicked in the
 * file manager, both reach the backend as arguments — and the backend is the
 * only party that can turn them into an answer, because a path from `argv` is
 * evidence the renderer cannot produce. What arrives here is that answer: the
 * canonical file and the vault root it belongs to, already decided and already
 * vouched for on the Rust side (`open_file.rs`). Nothing in this layer may take
 * a path from anywhere else and call it one of these.
 *
 * Two calls, and the split between them is the whole point. The request lives in
 * backend state until `takePendingOpen` collects it, so a first launch's
 * argument (known before any window exists) is not lost the way a one-shot event
 * would be; the `open-file-request` event is only a nudge to come and collect it
 * after a second launch. Collecting is what empties the slot, so the startup
 * pull and the nudge can both ask without a request being carried out twice.
 *
 * Like `platform/create-new-file.ts`, this is a narrow platform adapter: the
 * layers above it stay free of the Tauri bridge.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** Mirrors `open_file::OpenFileRequest`, including the `kind` tag. */
export type OpenFileRequest =
  | {
      kind: 'open'
      /** Absolute, canonical path of the file to open. */
      path: string
      /** The vault root it belongs to — the current one, or the file's own
       *  folder when it is inside no vault the backend knows. */
      root: string
      /** The file already belongs to the vault the app has open (or to the one
       *  startup is about to restore), so nothing about the vault changes. */
      same_vault: boolean
    }
  | {
      kind: 'refused'
      /** Why the backend will not open it, in the user's words. */
      message: string
    }

/** Must match `open_file::OPEN_FILE_EVENT`. A nudge with no payload. */
export const OPEN_FILE_EVENT = 'open-file-request'

/**
 * Take the request the backend is holding, if any.
 *
 * A `null` answer is the ordinary one — most launches name no file — and an
 * unreachable backend answers the same way: the browser demo and an older
 * backend have no `take_pending_open`, and a missing command must not be
 * mistaken for a failed open.
 */
export async function takePendingOpen(): Promise<OpenFileRequest | null> {
  try {
    return await invoke<OpenFileRequest | null>('take_pending_open')
  } catch {
    return null
  }
}

/**
 * Call `cb` whenever the backend has a request waiting — a second launch, which
 * is how a file manager opens a file in an app that is already running.
 *
 * Resolves to the unsubscribe, or to a no-op outside Tauri, so the caller can
 * always release what it was given.
 */
export async function onOpenFileRequest(cb: () => void): Promise<() => void> {
  try {
    return await listen(OPEN_FILE_EVENT, () => cb())
  } catch {
    return () => {}
  }
}
