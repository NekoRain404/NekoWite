/**
 * A write the backend refused, told apart from one that merely failed.
 *
 * The difference is the whole of this module. A failure is transient — the disk
 * filled up, the vault moved — and "please retry" is honest advice for it. A
 * REFUSAL is a decision: the destination is read-only, so the same write will be
 * refused again for as long as the file stays protected, and the user needs to
 * hear the reason and be given a route that does not need that file. Telling the
 * two apart matters to the copy too, which is why the reason is not read back
 * out of the sentence.
 *
 * So the backend says why in a token in front of the message, the shape
 * `errors::ALREADY_EXISTS_PREFIX` already uses to carry "the name is taken" from
 * Rust to `platform/create-new-file.ts`. The prose after the token is the
 * USER's — free to be reworded, translated or improved — and nothing here looks
 * at it. `READ_ONLY_PREFIX` is the mirror of `READ_ONLY_PREFIX` in
 * `src-tauri/src/storage/destination_file.rs`; the two are held together by a
 * test on each side, and that pair is the entire contract.
 *
 * Leaf module: a token, a name, and no imports.
 */

/** Mirrors `READ_ONLY_PREFIX` in `src-tauri/src/storage/destination_file.rs`. */
export const READ_ONLY_PREFIX = 'EREADONLY: '

/** Why a write did not land. `none` covers both an ordinary failure and a
 *  rejection that carries no reason at all — neither is answered with the
 *  read-only route. */
export type WriteRefusal = 'read-only' | 'none'

function messageOf(e: unknown): string {
  // Tauri rejects an `invoke` with the command's error value as it stands, so
  // the common case is a bare string; `Error` shows up when something in
  // between wrapped it, and the reason has to survive that too.
  return e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)
}

/** Which refusal `e` is, read from the token and never from the sentence. */
export function classifyWriteRefusal(e: unknown): WriteRefusal {
  return messageOf(e).startsWith(READ_ONLY_PREFIX) ? 'read-only' : 'none'
}

/** The backend's own sentence, without the token: for a caller that wants to
 *  log or show the reason verbatim. */
export function withoutRefusalToken(message: string): string {
  return message.startsWith(READ_ONLY_PREFIX)
    ? message.slice(READ_ONLY_PREFIX.length)
    : message
}

/**
 * The name to offer for a copy of `path`.
 *
 * Marked, because a Save-As dialog defaulting to the note's own name invites the
 * user to pick the one file that has just refused the write — and the refusal
 * would be repeated to no purpose. Only the LAST dot starts the extension, so
 * `.hidden` is a name and not an extension.
 */
export function copyNameFor(path: string): string {
  const name = path.split(/[\\/]/).pop() || path
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name} (copy)`
  return `${name.slice(0, dot)} (copy)${name.slice(dot)}`
}
