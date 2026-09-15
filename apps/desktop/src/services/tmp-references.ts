/**
 * Vault-wide `.tmp` reference scan.
 *
 * The recovery closed loop (`recoveryClosedLoop.ts`) decides which `.tmp` files
 * are crash litter by comparing the directory listing against the note bodies
 * that reference them. That comparison ran on `tabs.referencedTmpPaths()`, which
 * only sees OPEN tabs: a note sitting on disk whose tab was closed contributed
 * nothing, so the vault-open notice offered to "restore" its still-referenced
 * image (renaming it to `attachments/…` while the note kept pointing at
 * `.tmp/…`) and `gc` then deleted it for good. This scan closes that hole by
 * reading every note in the vault, not just the live ones.
 *
 * Pure and dependency-injected — the note list and the reader come from the
 * caller — so it unit-tests without Tauri, following the style of
 * `recoveryClosedLoop`/`externalDocSync`.
 */

import { stripVaultPrefix } from './paths'

/** Reads in flight at once (the bounded-pool pattern from `GraphPanel.vue`): a
 *  large vault must not fire thousands of IPC reads in one burst. */
const READ_CONCURRENCY = 8

/** Broader than the pattern the relocation uses, and deliberately so.
 *
 *  `stores/tab-assets.ts#outstandingTmpPaths` — which the open-tab half
 *  (`tab-persistence.ts#referencedTmpPaths`) now delegates to — derives only
 *  from real markdown image destinations, because a false positive there moves
 *  somebody else's file. This half is a scan of every note in the vault, where a
 *  false positive costs a temp file that is not collected this time; the two
 *  errors are not the same size, so the two patterns are not the same width.
 *
 *  The relationship worth keeping is the direction, not the equality: this set
 *  must be a SUPERSET of the relocation's, so a file the relocation still means
 *  to move is never collected as litter out from under it. It was written as an
 *  equality when both were the same regex; widening this one and narrowing that
 *  one left the containment intact and the comment wrong. */
const TMP_REFERENCE_RE = /\.tmp\/[^\s"')\]>,]+/g

/** `.md`/`.mdx` only: the index also lists attachments, and reading a binary or
 *  an unrelated file would be wasted I/O that cannot contain a note reference. */
const NOTE_RE = /\.mdx?$/i

export interface TmpReferenceScanDeps {
  /** Note paths as the vault file index returned them (the absolute spelling on
   *  Tauri; a mock may be relative). Directories are skipped. */
  notes: string[]
  /** Read one note's text. May reject for an unreadable file. */
  read(vault: string, path: string): Promise<string>
  /** Optional abort check consulted before each read, so a vault switch
   *  mid-scan stops issuing reads into the abandoned vault. */
  shouldAbort?: () => boolean
  /** Whether the note list itself is complete — a walk that hit its directory
   *  cap or a listing that failed cannot tell us about the notes it never saw. */
  isComplete?: () => boolean
}

export interface TmpReferenceScan {
  paths: Set<string>
  /** False when the answer is KNOWN to be partial (a note could not be read, or
   *  the note list was truncated). The recovery loop deletes `.tmp` files and
   *  moves them into `attachments/` on the strength of this set, so a caller
   *  must treat an incomplete scan as "possibly referenced", never as
   *  "unreferenced". */
  complete: boolean
}

/** Every `.tmp/…` path referenced by ANY note in `vault`, normalised to the
 *  vault-relative spelling the recovery loop compares `.tmp` listings against,
 *  plus whether that answer is complete. */
export async function scanTmpReferences(
  vault: string,
  deps: TmpReferenceScanDeps,
): Promise<TmpReferenceScan> {
  // A directory path can carry a `.md` name (`notes/topic.md/`), so drop the
  // trailing-separator spellings before the extension test.
  const notes = deps.notes.filter(
    (p) => !p.endsWith('/') && !p.endsWith('\\') && NOTE_RE.test(p),
  )
  const referenced = new Set<string>()
  let complete = true
  let cursor = 0
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, notes.length) }, async () => {
    while (cursor < notes.length) {
      if (deps.shouldAbort?.()) return
      const path = notes[cursor++]
      try {
        const content = await deps.read(vault, path)
        for (const match of content.matchAll(TMP_REFERENCE_RE)) {
          referenced.add(stripVaultPrefix(match[0], vault))
        }
      } catch {
        // One unreadable note (deleted mid-scan, permission, not text) must not
        // fail the whole scan — but it must not be reported as "nothing here
        // references anything" either: the caller acts on this set.
        complete = false
      }
    }
  })
  await Promise.all(workers)
  if (deps.isComplete?.() === false) complete = false
  return { paths: referenced, complete }
}

/** The referenced `.tmp` paths only (see {@link scanTmpReferences}). */
export async function findReferencedTmpPaths(
  vault: string,
  deps: TmpReferenceScanDeps,
): Promise<Set<string>> {
  return (await scanTmpReferences(vault, deps)).paths
}
