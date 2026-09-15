/**
 * The staged-asset half of a note's first save: an untitled document's pasted
 * images live in the vault-wide `.tmp/` directory until the note has a path of
 * its own, and this is what moves them into that path's assets directory and
 * rewrites the body to reference them relatively.
 *
 * Split out of `tab-save.ts` for the budget (§13.1), and because it is a
 * vertical slice with its own failure policy: relocation is best-effort, and it
 * is best-effort PER PAIR. A pair that fails is left alone — its file where it
 * is, its reference naming it there — rather than blocking the save, because the
 * text is what the user cannot retype and it goes to disk whether or not its
 * images could follow.
 *
 * "Left alone for a later attempt" is what the loop had to be built for and was
 * not (audit L07): it assumed it was starting from nothing, so a second attempt
 * began at the pair that HAD moved, failed on a source that no longer existed,
 * and so never reached the pair that had not — which is how one failed move
 * turned into a note that referenced two `.tmp` paths, one of them moved, with
 * nothing left that would ever repair it. Now each pair is finished on its own
 * and only the pairs that did not move stay pending, so an attempt starts from
 * what is actually outstanding.
 *
 * The two steps of a pair are adjacent on purpose: from the rename resolving to
 * the reference rewrite there is no await, so no keystroke and no second save
 * can land between them, and a pair is never left half-done. A moved file under
 * an old reference is the permanently broken image; a reference to a file that
 * never arrived is the other one.
 *
 * That fix left two residuals, and neither is about a single pair.
 *
 * "What is outstanding" was the tab's staged list, and that list does not
 * survive a restart: the stored session is a list of PATHS, and a tab restored
 * from one is built with `pendingAssetPaths: []`. A note whose image did not
 * move on its first save came back with a body still saying `.tmp/…` and a list
 * saying there was nothing to do — and since the save path called this only when
 * the list was non-empty, an empty list meant "do not look" and nothing ever
 * repaired it. It is derived from the note now (`outstandingTmpPaths`). The
 * list is not persisted instead: a persisted list and a body can disagree, and
 * then there are two authorities — and the one on disk is the body.
 *
 * The first derivation of that read the body as a string and took any `.tmp/…`
 * substring in it for a reference, so a note of ordinary prose about the feature
 * — "images live in `.tmp/` until you save" — renamed a file on every save: the
 * `endsWith('/')` test written for exactly that sentence was defeated by the
 * backtick around it, and the rename target became a file named `` ` ``. A
 * mention is not a reference. What the body must carry is the syntax the app's
 * own writer emits, `![alt](.tmp/…)` (`markdownImageBlock`), and that is what
 * `tmpRefsInContent` reads.
 *
 * And a throw from `renameEntry` was taken as proof the file had not moved. It
 * is an IPC command: a rename that landed and whose response was lost rejects
 * like any other failure, and such a pair was then retried for the life of the
 * note — failing forever on a source that is no longer there, with a toast the
 * user can neither act on nor stop, once per save. The disk is asked instead
 * (`movedDespiteTheError`), in that branch only.
 *
 * It edits `tab.content` in place, which is why it takes the tab rather than a
 * string: the rewrite has to land on the same object the editor's publish
 * writes to, or the next keystroke would put the `.tmp/` paths back.
 */

import {
  assetsDirForNote,
  moveAttachments,
  rewireTempRefsInContent,
} from '../services/rename-asset'
import type { AssetMove } from '../services/rename-asset'
import type { FileStat } from '../platform/gateways/contracts'
import type { OpenTab } from './tabs'

/** The fs operations the relocation performs: the two it moves files with, and
 *  the existence check its failure branch needs. */
export interface TabAssetFilePort {
  createDir(vault: string, path: string): Promise<string>
  renameEntry(vault: string, from: string, to: string): Promise<string>
  /** Whether a path is there (`FsPort.stat`, which rejects when it is not) — the
   *  only way to tell a move that did not happen from one that did and was not
   *  reported. Optional because the app's gateway always has it while a
   *  hand-rolled harness may not, and a port that cannot answer has to mean
   *  "assume it did not move": the direction that keeps a pair outstanding
   *  rather than dropping one on a guess. */
  stat?(vault: string, path: string): Promise<FileStat>
}

/**
 * A markdown image, and the destination of one: `![alt](dest)`, with the
 * optional `<…>` wrapper CommonMark allows and an optional title after the
 * destination (`![alt](dest "title")` — the destination ends at the first
 * whitespace or `)`).
 *
 * This is a SYNTAX test, not a substring one, and that is the bound. Every
 * `.tmp/…` reference the app itself writes has this shape — an untitled note's
 * paste inserts exactly `![alt](.tmp/…)`, because `relativePathFromNoteVault`
 * of a note with no path is the staged path verbatim — while everything else a
 * note might carry is a mention: inline code, a bare path in a sentence, a URL,
 * prose about the feature. The pattern this replaces was the substring alone
 * (`/\.tmp\/[^\s"')\]>,]+/`), so a mention was indistinguishable from a
 * reference, and the `endsWith('/')` guard that was supposed to catch the
 * sentence "images live in `.tmp/` until you save" was defeated by the backtick
 * around `.tmp/` — not excluded by the character class, so the match ran on into
 * it and the rename target became a file named `` ` ``. A guard that depends on
 * which characters a regex happens to exclude is defeated by the next
 * character; one that depends on the shape the app writes cannot be.
 *
 * The known residual, and what it costs: a COMPLETE image line inside a fenced
 * block is still matched, because telling a sample from a use needs a document
 * parse rather than a pattern. It is left as it is rather than fenced off
 * because the app's own insert can land inside a fence (the caret was there),
 * and `pendingAssetPaths` does not survive a restart — excluding fences would
 * strand exactly the pair this derivation exists to repair. The cost of the
 * other choice is bounded: it is a file the app staged, moved for a note whose
 * text carries the app's own insert form.
 */
const MD_IMAGE_DEST_RE = /!\[[^\]]*\]\(\s*(<[^<>\n]*>|[^()\s]*)/g

/**
 * The `.tmp/…` paths a note body REFERENCES — its markdown image destinations,
 * not the places its text happens to mention the temp directory.
 *
 * A destination ending in `/` names a directory rather than a staged asset and
 * is still left out: `moveAttachments` refuses a pair whose file name would be
 * empty, and a throw from that is a throw out of the save that called it.
 */
export function tmpRefsInContent(content: string): string[] {
  const refs: string[] = []
  for (const match of content.matchAll(MD_IMAGE_DEST_RE)) {
    const raw = match[1]
    const dest = raw.startsWith('<') ? raw.slice(1, -1) : raw
    if (!dest.startsWith('.tmp/') || dest.endsWith('/')) continue
    refs.push(dest)
  }
  return refs
}

/**
 * What a relocation pass still has to do, derived from the note rather than
 * remembered: the tab's staged list unioned with the `.tmp/…` paths its body
 * references.
 *
 * The body is the half that survives a restart and the authority for the
 * question; the list is the fresher one, because a paste stages its file before
 * the insert can reference it — an insert that never happened (`the editor was
 * not ready`) leaves a staged file with no ref anywhere. So the answer is the
 * union.
 *
 * It is deliberately NOT the set `referencedTmpPaths` hands the recovery GC.
 * That one is every `.tmp/…` reference AND every mention, because its two
 * mistakes do not cost the same: a file the GC spares on the strength of a
 * mention is a stale file left in `.tmp`, while a file this relocation moved on
 * the strength of one is somebody's image, renamed out from under the note that
 * pasted it. The GC's set is therefore the wider of the two, which is the safe
 * direction — every file this pass is about to move is one the GC is already
 * protecting.
 *
 * Deduplicated: a path in both halves is one file to move, and a second rename
 * of it would fail on a source the first one took.
 */
export function outstandingTmpPaths(tab: OpenTab): string[] {
  return [...new Set([...tab.pendingAssetPaths, ...tmpRefsInContent(tab.content)])]
}

export interface TabAssetDeps {
  files: TabAssetFilePort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
}

export function createTabAssets(deps: TabAssetDeps) {
  const { files, t, notifyError } = deps

  /**
   * Move the tab's staged assets into `notePath`'s assets dir and rewire the
   * body. Returns true when the content was rewritten.
   *
   * The rewire runs against the tab's LIVE content — the source of user typing
   * — rather than a snapshot captured before the awaits, so a keystroke that
   * landed during the relocation cannot be clobbered by the rewrite.
   *
   * Idempotent by construction: `pendingAssetPaths` is rebuilt here to hold
   * exactly the pairs whose file is still staged, so a pair whose file has
   * moved leaves the list in the same pass that moved it and no later attempt
   * can start from a source that is no longer there. A second call with every
   * file moved therefore finds nothing outstanding and does not touch the
   * filesystem at all, and one that still has work re-attempts only that work.
   */
  async function relocate(tab: OpenTab, vaultPath: string, notePath: string): Promise<boolean> {
    // Before any port call, so an ordinary note — nothing staged, and no
    // `![alt](.tmp/…)` in the body — does no filesystem work at all: no rename,
    // no rewrite, no toast, and no `<note>_assets/` directory. Prose that
    // mentions the temp directory is an ordinary note, and `outstandingTmpPaths`
    // is where that is decided. That early exit is what the guard this replaces
    // was for; what it must not be is the ANSWER, which is what an empty
    // `pendingAssetPaths` was allowed to stand for.
    const outstanding = outstandingTmpPaths(tab)
    if (outstanding.length === 0) return false
    const assetsDir = assetsDirForNote(notePath, vaultPath)
    if (!assetsDir || assetsDir === '.tmp') return false
    const moves = moveAttachments('.tmp', assetsDir, outstanding)
    // Best-effort: a backend whose rename creates the parent does not need it,
    // and the directory existing is not an error worth stopping a save for.
    await files.createDir(vaultPath, assetsDir).catch(() => undefined)

    const stillStaged: string[] = []
    let rewritten = false
    for (const m of moves) {
      try {
        await files.renameEntry(vaultPath, m.from, m.to)
      } catch {
        // This pair only. The ones behind it in the list are separate files
        // with separate destinations, and one of them failing used to cancel
        // the rewrite of every pair that had already moved.
        //
        // But the throw is not the verdict: it is also what a rename that
        // LANDED and whose response was lost looks like. Asking the disk here,
        // in the branch where the rename did not resolve, is deliberate — the
        // pair that did move still reaches its rewrite below with no await
        // between the two (see the module note on adjacency).
        if (!(await movedDespiteTheError(vaultPath, m))) {
          stillStaged.push(m.from)
          continue
        }
      }
      const next = rewireTempRefsInContent(tab.content, [m], notePath, vaultPath)
      if (next !== tab.content) {
        tab.content = next
        rewritten = true
      }
    }
    tab.pendingAssetPaths = stillStaged
    // Once per save, not once per image: ten staged files that all failed is one
    // thing that happened to the user.
    if (stillStaged.length > 0) notifyError(t('tabs.saveAttachmentFailed'))
    return rewritten
  }

  /**
   * Whether a pair whose rename REJECTED moved anyway.
   *
   * The source gone with the destination present is a move that landed and was
   * not reported. Everything else is not one: the source still there is a
   * transient, or a destination the backend refuses to replace, and it keeps
   * its place in the outstanding set.
   *
   * A ref that is at NEITHER end is a reference to nothing, and it is
   * deliberately not treated as a move. The note keeps its `.tmp/…` ref, the
   * pair stays outstanding, and the save says so again — the user can put the
   * file back where the note says it is, or remove the reference from the note,
   * and both end it. Deleting their prose about an image that is gone would be
   * the other way to stop repeating ourselves, and it is the worse answer.
   */
  async function movedDespiteTheError(vaultPath: string, move: AssetMove): Promise<boolean> {
    // Bound before the guard: TypeScript does not carry the narrowing into the
    // closure below, and the port may genuinely be without a stat.
    const stat = files.stat
    if (!stat) return false
    const exists = async (path: string): Promise<boolean> => {
      try {
        await stat(vaultPath, path)
        return true
      } catch {
        return false
      }
    }
    const [source, destination] = await Promise.all([exists(move.from), exists(move.to)])
    return !source && destination
  }

  return { relocate }
}

export type TabAssets = ReturnType<typeof createTabAssets>
