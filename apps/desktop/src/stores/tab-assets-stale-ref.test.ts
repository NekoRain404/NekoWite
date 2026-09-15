/**
 * The relocation's failure branch read "source gone and destination present" as
 * a move that landed and was not reported. Those two facts are true in two
 * different worlds, and this file is about the other one: `.tmp/pic.png` is gone
 * — moved by an earlier save, or deleted — while `notes/foo_assets/pic.png` is a
 * DIFFERENT image that happens to share the basename. The old inference dropped
 * the pair with no toast and rewired the reference to that file, so the note
 * silently started showing a picture nobody put there.
 *
 * What separates the worlds is the source's IDENTITY, read while the source is
 * still there to be read: the stamp taken immediately before the attempt. A move
 * carries it to the destination — `rename_entry` moves a file by hard-linking it
 * and unlinking the source, so the destination IS the source's inode and its
 * size and mtime arrive unchanged (`apps/desktop/src-tauri/src/storage/
 * atomic_write.rs`, `move_no_clobber`). A stale reference has no stamp at all:
 * there is nothing at the source to take one from, which is the half the old
 * inference could not see, because it only ever looked at what was left.
 *
 * The tests control the discriminator by controlling the stamps the fake vault
 * reports; nothing in this path reads a clock, so no fake timers are needed, and
 * the fake carries a file's stamp through a move the way the backend does.
 */

import { describe, expect, it } from 'vitest'
import { createTabAssets, type TabAssetFilePort } from './tab-assets'
import type { FileStat } from '../platform/gateways/contracts'
import type { OpenTab } from './tabs'

const VAULT = '/vault'
const NOTE = '/vault/notes/foo.md'
const TOAST = 'tabs.saveAttachmentFailed'

/** A file that has been sitting in the vault for a while. */
const ANCIENT = 1_700_000_000_000
/** The staged image's stamp: ten minutes before the save that is attempted. */
const PASTED_AT = 1_700_000_600_000

/** What the port does instead of moving the file. */
type Fault =
  /** The move lands and THEN the call rejects — an IPC whose response was lost. */
  | 'lost-response'
  /** The move lands as a create-new copy, which restamps the destination, and
   *  then rejects: the backend's fallback for a filesystem with no hard links. */
  | 'copied-then-lost-response'
  /** The source disappears without the move landing: something else took it
   *  while the attempt was in flight. */
  | 'source-vanished'

interface FakeVault {
  /** Contents and stamps by vault-relative path. */
  files: Map<string, string>
  mtimes: Map<string, number>
  /** Every rename that was attempted, in order. */
  moves: Array<[string, string]>
  loseResponseAfterMoving(from: string): void
  copyInsteadOfMoving(from: string): void
  vanishDuringMove(from: string): void
  port: TabAssetFilePort
}

/** Vault-relative spelling: `relocate` hands the port vault-relative paths. */
function rel(path: string): string {
  const norm = path.replace(/\\/g, '/')
  return norm.startsWith(`${VAULT}/`) ? norm.slice(VAULT.length + 1) : norm
}

function fakeVault(seed: Record<string, { content: string; mtime: number }>): FakeVault {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  for (const [path, entry] of Object.entries(seed)) {
    files.set(path, entry.content)
    mtimes.set(path, entry.mtime)
  }
  const moves: Array<[string, string]> = []
  const faults = new Map<string, Fault>()
  const port: TabAssetFilePort = {
    createDir: async (_vault: string, path: string): Promise<string> => path,
    renameEntry: async (_vault: string, from: string, to: string): Promise<string> => {
      const source = rel(from)
      const destination = rel(to)
      moves.push([source, destination])
      const fault = faults.get(source)
      if (fault === 'source-vanished') {
        files.delete(source)
        mtimes.delete(source)
        throw new Error(`not found: ${source}`)
      }
      const content = files.get(source)
      const stamp = mtimes.get(source) ?? 0
      if (content === undefined) throw new Error(`not found: ${source}`)
      if (files.has(destination)) throw new Error(`target already exists: ${destination}`)
      files.delete(source)
      mtimes.delete(source)
      files.set(destination, content)
      // A hard link plus an unlink: the destination IS the source's inode, so
      // the stamp arrives with it. `copy_new` writes the bytes afresh instead,
      // and the destination is stamped when it is written.
      mtimes.set(destination, fault === 'copied-then-lost-response' ? stamp + 1 : stamp)
      if (fault) throw new Error(`ipc closed after moving ${source}`)
      return to
    },
    // Rejecting when the path is not there, like both real backends
    // (`stat_file` fails on a missing path).
    stat: async (_vault: string, path: string): Promise<FileStat> => {
      const key = rel(path)
      const content = files.get(key)
      if (content === undefined) throw new Error(`No such file: ${path}`)
      return { size: content.length, mtime: mtimes.get(key) ?? 0 }
    },
  }
  return {
    files,
    mtimes,
    moves,
    loseResponseAfterMoving: (from) => void faults.set(rel(from), 'lost-response'),
    copyInsteadOfMoving: (from) => void faults.set(rel(from), 'copied-then-lost-response'),
    vanishDuringMove: (from) => void faults.set(rel(from), 'source-vanished'),
    port,
  }
}

function stagedTab(content: string, pending: string[]): OpenTab {
  return {
    id: 't1',
    path: null,
    content,
    savedContent: '',
    dirty: false,
    pendingAssetPaths: pending,
  }
}

function harness(port: TabAssetFilePort) {
  const errors: string[] = []
  return {
    errors,
    assets: createTabAssets({
      files: port,
      t: (key: string): string => key,
      notifyError: (message: string): void => void errors.push(message),
    }),
  }
}

describe('a stale reference whose basename is already taken', () => {
  it('is left in the note, and the user is told', async () => {
    // The brief's state: an earlier save moved (or the user deleted) the staged
    // image, and what sits at the destination is an unrelated picture that
    // happens to be called `pic.png`.
    const vault = fakeVault({
      'notes/foo_assets/pic.png': { content: 'a different image', mtime: ANCIENT },
      'notes/foo.md': { content: '![pic](.tmp/pic.png)\n', mtime: ANCIENT },
    })
    const { assets, errors } = harness(vault.port)
    const note = stagedTab('![pic](.tmp/pic.png)\n', ['.tmp/pic.png'])

    await assets.relocate(note, VAULT, NOTE)

    // One assertion, because pre-fix the damage is what these four fields say
    // together: the reference the user is left looking at, what is still
    // outstanding, that nothing reported it, and that the unrelated file was
    // never even touched. Pre-fix this reads `theNote:
    // '![pic](foo_assets/pic.png)\n'` — the note now shows a picture nobody put
    // there — with `told: []`.
    expect({
      theNote: note.content,
      stillOutstanding: note.pendingAssetPaths,
      told: errors,
      thatFileIsUntouched: vault.files.get('notes/foo_assets/pic.png'),
    }).toEqual({
      theNote: '![pic](.tmp/pic.png)\n',
      stillOutstanding: ['.tmp/pic.png'],
      told: [TOAST],
      thatFileIsUntouched: 'a different image',
    })
  })
})

describe('a move that landed and was reported as a failure', () => {
  it('is still recognised, and the note is rewired', async () => {
    const vault = fakeVault({
      '.tmp/pic.png': { content: 'image bytes', mtime: PASTED_AT },
      'notes/foo.md': { content: '', mtime: ANCIENT },
    })
    vault.loseResponseAfterMoving('.tmp/pic.png')
    const { assets, errors } = harness(vault.port)
    const note = stagedTab('![pic](.tmp/pic.png)\n', ['.tmp/pic.png'])

    await assets.relocate(note, VAULT, NOTE)

    // The stamp the attempt took before it reached for the move is what the
    // destination carries, so this is the file the note pasted and the reference
    // has to follow it. The alternative — believing the throw — retries a source
    // that is no longer there, once per save, forever.
    expect({
      theNote: note.content,
      stillOutstanding: note.pendingAssetPaths,
      told: errors,
      theFile: vault.files.get('notes/foo_assets/pic.png'),
      staged: vault.files.has('.tmp/pic.png'),
    }).toEqual({
      theNote: '![pic](foo_assets/pic.png)\n',
      stillOutstanding: [],
      told: [],
      theFile: 'image bytes',
      staged: false,
    })
  })

  it('is recognised when the backend moved it by copy and restamped it', async () => {
    // A filesystem with no hard links takes `copy_new` instead of the link: the
    // destination holds the same bytes under a stamp written during the attempt.
    // The destination is therefore "not older than the source we saw", not
    // "stamped exactly like it".
    const vault = fakeVault({
      '.tmp/pic.png': { content: 'image bytes', mtime: PASTED_AT },
      'notes/foo.md': { content: '', mtime: ANCIENT },
    })
    vault.copyInsteadOfMoving('.tmp/pic.png')
    const { assets, errors } = harness(vault.port)
    const note = stagedTab('![pic](.tmp/pic.png)\n', ['.tmp/pic.png'])

    await assets.relocate(note, VAULT, NOTE)

    expect({
      theNote: note.content,
      stillOutstanding: note.pendingAssetPaths,
      told: errors,
      destinationStamp: vault.mtimes.get('notes/foo_assets/pic.png'),
    }).toEqual({
      theNote: '![pic](foo_assets/pic.png)\n',
      stillOutstanding: [],
      told: [],
      destinationStamp: PASTED_AT + 1,
    })
  })

  it('is NOT claimed by a destination that is not the file the note pasted', async () => {
    // The source was there when the attempt reached for it and vanished while
    // the move was in flight, and what is at the destination is older and
    // another size. Nothing accounts for that file, so the pair keeps reporting
    // rather than being rewired onto it.
    const vault = fakeVault({
      '.tmp/pic.png': { content: 'image bytes', mtime: PASTED_AT },
      'notes/foo_assets/pic.png': { content: 'a different image', mtime: ANCIENT },
      'notes/foo.md': { content: '', mtime: ANCIENT },
    })
    vault.vanishDuringMove('.tmp/pic.png')
    const { assets, errors } = harness(vault.port)
    const note = stagedTab('![pic](.tmp/pic.png)\n', ['.tmp/pic.png'])

    await assets.relocate(note, VAULT, NOTE)

    expect({
      theNote: note.content,
      stillOutstanding: note.pendingAssetPaths,
      told: errors,
    }).toEqual({
      theNote: '![pic](.tmp/pic.png)\n',
      stillOutstanding: ['.tmp/pic.png'],
      told: [TOAST],
    })
  })
})
