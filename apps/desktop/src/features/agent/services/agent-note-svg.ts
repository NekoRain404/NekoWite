/**
 * The caller's half of §7.3: read the artifact the run staged, and put it in the vault where the
 * plan said it would be.
 *
 * `agent-svg-insertion.ts` decides everything it can decide alone — whether the document may be
 * previewed, what the vault name resolves to, the exact text the note gains, and whether the anchor
 * still describes the spot the user pointed at. Three things it deliberately cannot do, and this
 * module is those three:
 *
 *  - **Read the file.** The stat and the read are the caller's, and their ORDER is the check §7.3
 *    clause 1 asks for: a declared size that disagrees with the bytes read is the only honest
 *    evidence that the engine's write has not finished. The service compares them; the caller is
 *    what takes them in the only order in which they can disagree.
 *  - **Write the attachment.** §7.3 clause 4 leaves placement to the attachments feature, and this
 *    goes through its own vault write. What is added here is the check clause 6 needs: the file has
 *    to land exactly where the plan's markdown points, or the note would link a file that is not
 *    there. A backend that resolved the name differently is reported, not silently accepted.
 *  - **Report, rather than throw.** Every arm below is a value, so the surface can say what
 *    happened — including the one that matters most, which is that nothing was written.
 *
 * The bytes written are the artifact's own, encoded once from the text that was read. The verified
 * preview is never what lands in the vault: §7.3 keeps the raw artifact and the safe preview apart,
 * and the one the agent drew is the one the note links.
 */

import {
  STAGED_SVG_MEDIA_TYPE,
  type AgentStagedSvg,
  type AgentSvgInsertionPlan,
} from './agent-svg-insertion'

/**
 * The two reads this module takes, as the file port spells them.
 *
 * Structural rather than the gateway's own type so a test can drive this without a Tauri module
 * graph — the same arrangement the responder uses for the editor's lookup.
 */
export interface StagedFileReads {
  stat(vault: string, path: string): Promise<{ size: number; mtime: number }>
  read(vault: string, path: string): Promise<string>
}

export type StagedSvgRead =
  | { readonly status: 'read'; readonly staged: AgentStagedSvg }
  /** The file could not be stat'ed or read. Not an empty document: "there is nothing here" and
   *  "here is a document with nothing in it" are two different things to tell the user. */
  | { readonly status: 'unreadable'; readonly path: string }

/** What the vault write answered.
 *
 * The method keeps the attachments port's own name, so the gateway satisfies this structurally and
 * no adapter stands between the two — the same reason `StagedFileReads` above is spelled the way
 * the port spells it. */
export interface AttachmentWrite {
  saveAttachment(vault: string, fileName: string, base64: string, dir: string): Promise<string>
}

export type AttachmentSaveOutcome =
  | { readonly status: 'saved' }
  /** The file landed somewhere other than where the note is about to point. Refused rather than
   *  linked: a broken image in the note is worse than a sentence saying why there is none. */
  | { readonly status: 'elsewhere'; readonly plannedPath: string; readonly savedPath: string }
  | { readonly status: 'failed' }

/** The month directory the plan's own path names — `attachments/<YYYY-MM>` comes from the same
 *  function that produced `vaultPath`, so the two cannot drift apart. */
function monthDirOf(vaultPath: string): string {
  const cut = vaultPath.lastIndexOf('/')
  return cut === -1 ? vaultPath : vaultPath.slice(0, cut)
}

/** The artifact, as the disk has it, with the size that was stat'ed before it was read. */
export async function readStagedSvg(
  vault: string,
  path: string,
  files: StagedFileReads,
): Promise<StagedSvgRead> {
  let sizeBytes: number
  try {
    // Before the read, always: after it, the two numbers describe the same instant and a write
    // still in flight would look like a complete document.
    sizeBytes = (await files.stat(vault, path)).size
  } catch {
    return { status: 'unreadable', path }
  }
  try {
    const text = await files.read(vault, path)
    return Object.freeze({
      status: 'read',
      staged: Object.freeze({ path, mediaType: STAGED_SVG_MEDIA_TYPE, sizeBytes, text }),
    })
  } catch {
    return { status: 'unreadable', path }
  }
}

/**
 * Save the artifact where the plan said it would be, and say whether it landed there.
 *
 * The name is the plan's own resolved one and the directory is the plan's own path, so the two
 * halves of one decision are not recomputed here. What is checked is the answer: the attachments
 * port returns where the file really went, and a backend that resolved it differently — a
 * collision it knew about and this window did not — has produced a path the note's markdown does
 * not name.
 */
export async function savePlannedAttachment(
  vault: string,
  plan: AgentSvgInsertionPlan,
  text: string,
  attachments: AttachmentWrite,
): Promise<AttachmentSaveOutcome> {
  const base64 = textToBase64(text)
  let savedPath: string
  try {
    savedPath = await attachments.saveAttachment(vault, plan.fileName, base64, monthDirOf(plan.vaultPath))
  } catch {
    return { status: 'failed' }
  }
  if (savedPath !== plan.vaultPath) {
    return { status: 'elsewhere', plannedPath: plan.vaultPath, savedPath }
  }
  return { status: 'saved' }
}

/** UTF-8 bytes as base64, which is what the attachment port takes. `btoa` reads code UNITS, so a
 *  document with any non-ASCII character would be written as mojibake without the encode. */
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
