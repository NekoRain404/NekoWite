/**
 * Moving a note in the file tree — the whole move, not just the bytes.
 *
 * `rename_entry` moves the file and migrates its history/trash keys; it knows
 * nothing about the note's *file-relative* references. Both forms the app
 * writes resolve against the note's own directory:
 *
 *   - the attachments library inserts `../attachments/…` (see
 *     `AttachmentsPanel.vue`), and
 *   - a pasted image lands in `<noteDir>/<basename>_assets/…` (see
 *     `renameAsset.assetsDirForNote`).
 *
 * Dragging a note into another folder therefore used to break every image in
 * it and leave its `_assets` directory behind in the old folder. This service
 * does the move correctly: it moves the sibling assets directory next to the
 * note (keeping its name in step with the note's new basename), moves the note,
 * and rewrites only the reference URLs the move invalidated. Everything else in
 * the document is preserved byte-for-byte.
 *
 * Two shapes a move cannot carry out as a plain move, and what happens instead —
 * because a move whose other half was refused is not a move this service is
 * allowed to finish:
 *
 *   - **the note goes INTO its `_assets` folder** (`assetsWouldNest`): the
 *     folder cannot follow (it would land inside itself), so it stays put and
 *     the note moves into it. From there its files are SIBLINGS, and the
 *     references are re-spelled accordingly — `a_assets/pic.png` is `pic.png`;
 *   - **a reference has no spelling from the new directory** at all (see
 *     {@link planNoteRefRewrite}): the move is refused before the first
 *     mutation, and the caller's notification is truthful because nothing
 *     moved. A note that moved with a stale body is worse than a gesture that
 *     did not take.
 *
 * All filesystem access is injected (the `externalDocSync` /
 * `recoveryClosedLoop` style) so the flow runs against the real gateway, the
 * memory gateway or a mock — see `noteMove.test.ts`.
 */

import { relativePathFromNoteVault, vaultRelativeFromNoteVault } from './attachments'
import { assetsDirForNote } from './rename-asset'
import { baseName, dirName, joinPath, stripVaultPrefix } from './paths'

export interface NoteMoveIo {
  /** Read the note body. A rejection here aborts the move untouched. */
  read(vault: string, path: string): Promise<string>
  /** Write the rewritten body. Never called when nothing changed. */
  write(vault: string, path: string, content: string): Promise<void>
  /** Move a file or directory inside the vault (the `rename_entry` command). */
  rename(vault: string, from: string, to: string): Promise<unknown>
  /** List a directory; used to see whether the note has an assets directory. */
  list(vault: string, dir: string): Promise<{ name: string; is_dir: boolean }[]>
}

export interface NoteMoveResult {
  /** The rewritten body, already written to the note's new path; `null` when
   *  the move invalidated no reference and the file was not written at all. */
  content: string | null
  /** True when a sibling `_assets` directory moved with the note. */
  movedAssets: boolean
}

export interface NoteRefContext {
  vault: string
  /** The note before the move (absolute, native spelling is fine). */
  from: string
  /** The note after the move. */
  to: string
}

/** A markdown link/image as the app and the link graph write it: `[alt](dest)`
 *  / `![alt](dest)`, optionally with a title and with the destination wrapped
 *  in angle brackets. The destination may not contain whitespace or parens —
 *  the same limit `linkGraph`'s scanner has (attachment names are sanitized to
 *  `[A-Za-z0-9_.-]`, so the app's own refs always match). */
const LINK_RE = /(!?)\[([^\]]*)\]\((<[^<>\n]*>|[^()\s]+)((?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?)\)/g
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** True for a reference whose meaning is "relative to this note's directory".
 *  URL schemes, absolute paths (a Windows drive letter matches the scheme
 *  pattern while being a path) and in-page anchors are not ours to rewrite. */
function isNoteRelative(src: string): boolean {
  if (!src || src.startsWith('#')) return false
  if (src.startsWith('/') || src.startsWith('\\')) return false
  return !/^[a-z][a-z0-9+.-]*:/i.test(src)
}

/** True when `to` files the note inside its own `_assets` folder — the one
 *  destination that folder cannot follow it to, because the folder would land
 *  inside itself (the backend refuses that). The folder then stays where it is
 *  and the NOTE moves into it, which is the case the reference remap has to
 *  model: from the note's new home the folder's files are siblings. */
function assetsWouldNest(from: string, to: string, vault: string): boolean {
  const dir = assetsDirForNote(from, vault)
  return dir !== null && stripVaultPrefix(to, vault).startsWith(`${dir}/`)
}

/** The move would leave one of the note's own references unsatisfiable: it has
 *  no spelling from the note's new directory, so writing the rewritten body
 *  would silently point the link somewhere else. Thrown BEFORE the first
 *  mutation, so the caller's notification is truthful — nothing moved. */
export class NoteMoveBlockedError extends Error {
  /** The note path the move would have landed at. */
  readonly to: string
  /** The destinations as the note spells them today. */
  readonly refs: readonly string[]

  constructor(to: string, refs: readonly string[]) {
    super(
      `cannot move to ${to}: ${refs.length} reference(s) have no spelling from there (${refs.join(', ')})`,
    )
    this.name = 'NoteMoveBlockedError'
    this.to = to
    this.refs = refs
  }
}

interface NoteRefRewrite {
  /** The body with every expressible note-relative reference re-spelled. */
  content: string
  /** The destinations that cannot be expressed from the note's new directory.
   *  When this is not empty, `content` would retarget them: a move that
   *  produced it must be refused rather than written. */
  unexpressible: string[]
}

/** Rewrite the note-relative references in `content` for a move from
 *  `ctx.from` to `ctx.to`, leaving every other byte alone — plus the ones that
 *  cannot be rewritten at all, which the caller has to refuse the move over.
 *
 *  Each reference is resolved to a vault-relative path exactly the way the
 *  display resolver does it (`vaultRelativeFromNoteVault`), remapped to where
 *  that target lives after the move, and spelled relative to the note's new
 *  directory. So `../attachments/…` follows a depth change, a reference into
 *  the note's own `<basename>_assets` follows a rename, and a reference to the
 *  note itself follows the note. */
function planNoteRefRewrite(content: string, ctx: NoteRefContext): NoteRefRewrite {
  const fromRel = stripVaultPrefix(ctx.from, ctx.vault)
  const toRel = stripVaultPrefix(ctx.to, ctx.vault)
  const oldAssetsDir = assetsDirForNote(ctx.from, ctx.vault)
  const newAssetsDir = assetsDirForNote(ctx.to, ctx.vault)
  // When the note lands inside its own assets folder that folder stays put, so
  // the files in it do not move at all and the remap below must say so. Assuming
  // they followed the note is what broke this gesture: `a_assets/pic.png`
  // became `a_assets/a_assets/pic.png`, which re-spelled from the note's new
  // directory is the original string again — so `rewrite` returned null, the
  // body was never written, and the note moved anyway.
  const assetsFollowNote = !assetsWouldNest(ctx.from, ctx.to, ctx.vault)

  function remap(vaultRel: string): string {
    if (vaultRel === fromRel) return toRel
    if (assetsFollowNote && oldAssetsDir && newAssetsDir) {
      if (vaultRel === oldAssetsDir) return newAssetsDir
      if (vaultRel.startsWith(`${oldAssetsDir}/`)) {
        return newAssetsDir + vaultRel.slice(oldAssetsDir.length)
      }
    }
    return vaultRel
  }

  const unexpressible: string[] = []

  function rewrite(src: string): string | null {
    if (!isNoteRelative(src)) return null
    const target = remap(vaultRelativeFromNoteVault(ctx.from, ctx.vault, src))
    const next = relativePathFromNoteVault(ctx.to, ctx.vault, target)
    // The new spelling has to mean at the destination what the old one meant
    // here. It does not when the resolver has a rule of its own for the string
    // it produces — a folder literally named `attachments` spells as the
    // vault-level `attachments/…` from a note beside it, which is a different
    // file. Nothing can express that reference from there, so it is reported
    // instead of being written as something else.
    if (vaultRelativeFromNoteVault(ctx.to, ctx.vault, next) !== target) {
      unexpressible.push(src)
      return null
    }
    return next === src ? null : next
  }

  let out = ''
  let pos = 0
  // Mirrors `linkGraph`'s scan: a fenced code block is sample text, not
  // references, so it must come out of a move byte-for-byte.
  let fence: { char: string; len: number } | null = null
  while (pos < content.length) {
    const newline = content.indexOf('\n', pos)
    const end = newline === -1 ? content.length : newline + 1
    const line = content.slice(pos, end)
    pos = end
    // `$` (no `m` flag) only matches the very end of the string, so the
    // line terminator must come off before the fence test.
    const marker = FENCE_RE.exec(line.replace(/\r?\n$/, ''))
    if (fence) {
      out += line
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.len &&
        marker[2].trim() === ''
      ) {
        fence = null
      }
      continue
    }
    if (marker) {
      fence = { char: marker[1][0], len: marker[1].length }
      out += line
      continue
    }
    out += line.replace(LINK_RE, (whole, _bang, _text, dest: string, title: string) => {
      const bracketed = dest.startsWith('<') && dest.endsWith('>')
      const next = rewrite(bracketed ? dest.slice(1, -1) : dest)
      if (next === null) return whole
      // Rebuild from the matched pieces instead of replacing `dest` in `whole`:
      // the same string can appear in the alt text (`![a.png](a.png)`), and a
      // string replace would hit that one first.
      const head = whole.slice(0, whole.length - 1 - title.length - dest.length)
      return `${head}${bracketed ? `<${next}>` : next}${title})`
    })
  }
  return { content: out, unexpressible }
}

/** {@link planNoteRefRewrite}'s content for a caller that has no refusal to
 *  offer — the tab keeps the user's unsaved text in step with the rewrite the
 *  move wrote to disk, and `moveNote` has already refused any move whose
 *  references could not be expressed. */
export function rewriteNoteRefs(content: string, ctx: NoteRefContext): string {
  return planNoteRefRewrite(content, ctx).content
}

/** Move the note at `from` to `to`, carrying its sibling `_assets` directory
 *  and its relative references along. Callers pass a note; moving a directory
 *  (where every note inside would need this same rewrite) is deliberately not
 *  handled here.
 *
 *  Ordering is deliberate: the body is read first, so a note whose references
 *  cannot be read is never half-moved, and a body whose references have no
 *  spelling at the destination refuses the move before anything is touched —
 *  neither rename has run at that point. The assets directory is moved before
 *  the note so a conflict there leaves the note where it was. If the note rename
 *  or the rewrite then fails, both are put back. */
export async function moveNote(
  io: NoteMoveIo,
  vault: string,
  from: string,
  to: string,
): Promise<NoteMoveResult> {
  const body = await io.read(vault, from)
  const plan = planNoteRefRewrite(body, { vault, from, to })
  if (plan.unexpressible.length > 0) {
    // Nothing has been renamed yet, so this refusal IS the whole move not
    // happening. Writing the body without it, or moving the note onto the old
    // body, is the half-step this section exists to prevent.
    throw new NoteMoveBlockedError(to, plan.unexpressible)
  }
  const rewritten = plan.content
  const changed = rewritten !== body

  const noteDir = dirName(from)
  const oldAssetsDir = assetsDirForNote(from, vault)
  const newAssetsDir = assetsDirForNote(to, vault)
  // A note dropped into its own `_assets` folder would make the folder move
  // land inside itself (the backend refuses that), and the folder's files are
  // still reachable from where the note lands — as siblings — so the folder
  // stays put and the gesture is carried by the reference rewrite above.
  const nested = assetsWouldNest(from, to, vault)
  let assetsMove: { from: string; to: string } | null = null
  if (oldAssetsDir && newAssetsDir && oldAssetsDir !== newAssetsDir && !nested) {
    const entries = await io.list(vault, noteDir)
    if (entries.some((e) => e.is_dir && e.name === baseName(oldAssetsDir))) {
      // Both sides are built from the moved note's own spelling (`joinPath`
      // matches the separator style), so a Windows path stays native instead of
      // becoming a mixed `/`-and-`\` string the backend would reject.
      assetsMove = {
        from: joinPath(noteDir, baseName(oldAssetsDir)),
        to: joinPath(dirName(to), baseName(newAssetsDir)),
      }
      await io.rename(vault, assetsMove.from, assetsMove.to)
    }
  }

  /** Best effort undo of the assets move. A failure here must not mask the
   *  original error the caller is about to see. */
  async function undoAssetsMove(): Promise<void> {
    if (!assetsMove) return
    try {
      await io.rename(vault, assetsMove.to, assetsMove.from)
    } catch {
      // Best effort only.
    }
  }

  try {
    await io.rename(vault, from, to)
  } catch (error) {
    // Only the assets folder moved. The note is untouched, and `to` may hold a
    // conflicting file the user already had — never move anything out of it.
    await undoAssetsMove()
    throw error
  }

  if (changed) {
    try {
      await io.write(vault, to, rewritten)
    } catch (error) {
      // The renames landed but the body could not take the rewrite: put the note
      // back first (it is ours at `to`), then its assets, so a failed move never
      // leaves the note in the new folder while its images point at the old one.
      try {
        await io.rename(vault, to, from)
      } catch {
        // Best effort only.
      }
      await undoAssetsMove()
      throw error
    }
  }
  return { content: changed ? rewritten : null, movedAssets: assetsMove !== null }
}
