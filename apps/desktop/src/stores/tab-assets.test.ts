/**
 * The staged-asset relocation's failure policy (audit L07).
 *
 * The state the audit reproduced: two staged images, the first move lands, the
 * second fails — and the retry starts again from the first source, which is no
 * longer there, so it fails forever and the second image never moves either.
 * Every test below is a shape of that state, driven through a fake port that
 * refuses a rename for the same two reasons both real backends do: the source is
 * gone (`not found`), or the destination is occupied (the Rust `rename_entry`
 * guard, which refuses rather than replacing).
 */

import { describe, expect, it, vi } from 'vitest'
import { createTabAssets, type TabAssetFilePort } from './tab-assets'
import type { OpenTab } from './tabs'

const VAULT = '/vault'
const NOTE = '/vault/notes/foo.md'

interface FakeVault {
  /** Vault-relative paths that exist. */
  files: Set<string>
  /** Every rename the relocation attempted, in order. */
  moves: Array<[string, string]>
  /** Refuse every move of `from` — the injected backend fault. */
  failMovesOf(from: string): void
  clearFaults(): void
  /** Hold the next move of `from` open so a test can act while it is in flight. */
  parkMoveOf(from: string, gate: Promise<void>): void
  port: TabAssetFilePort
}

function fakeVault(seed: string[]): FakeVault {
  const files = new Set(seed)
  const moves: Array<[string, string]> = []
  const faults = new Set<string>()
  const gates = new Map<string, Promise<void>>()
  return {
    files,
    moves,
    failMovesOf: (from) => void faults.add(from),
    clearFaults: () => faults.clear(),
    parkMoveOf: (from, gate) => void gates.set(from, gate),
    port: {
      createDir: async (_vault, path) => path,
      renameEntry: async (_vault, from, to) => {
        moves.push([from, to])
        const gate = gates.get(from)
        if (gate) await gate
        if (faults.has(from)) throw new Error(`injected fault moving ${from}`)
        if (!files.has(from)) throw new Error(`not found: ${from}`)
        if (files.has(to)) throw new Error(`target already exists: ${to}`)
        files.delete(from)
        files.add(to)
        return to
      },
    },
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
      t: (key) => key,
      notifyError: (message) => errors.push(message),
    }),
  }
}

describe('relocating staged assets into the note directory', () => {
  it('retries from the pair that did not move, not from the one that did', async () => {
    const vault = fakeVault(['.tmp/a.png', '.tmp/b.png'])
    const { assets, errors } = harness(vault.port)
    const tab = stagedTab('![a](.tmp/a.png)\n\n![b](.tmp/b.png)\n', ['.tmp/a.png', '.tmp/b.png'])

    // The audit's failure: the first move lands, the second does not.
    vault.failMovesOf('.tmp/b.png')
    await assets.relocate(tab, VAULT, NOTE)

    expect([...vault.files].sort()).toEqual(['.tmp/b.png', 'notes/foo_assets/a.png'])
    // A moved file under an old reference is the permanently broken image, so
    // the pair that DID move gets its reference rewritten in the same pass.
    expect(tab.content).toBe('![a](foo_assets/a.png)\n\n![b](.tmp/b.png)\n')
    expect(tab.pendingAssetPaths).toEqual(['.tmp/b.png'])
    expect(errors).toEqual(['tabs.saveAttachmentFailed'])

    // The fault is cleared and the user saves again.
    vault.clearFaults()
    await assets.relocate(tab, VAULT, NOTE)

    expect([...vault.files].sort()).toEqual(['notes/foo_assets/a.png', 'notes/foo_assets/b.png'])
    expect(tab.content).toBe('![a](foo_assets/a.png)\n\n![b](foo_assets/b.png)\n')
    expect(tab.pendingAssetPaths).toEqual([])
    // One attempt of the moved source, and it was the first pass that made it.
    expect(vault.moves.filter(([from]) => from === '.tmp/a.png')).toHaveLength(1)
    expect(vault.moves.filter(([from]) => from === '.tmp/b.png')).toHaveLength(2)
  })

  it('is idempotent: a repeated attempt while the fault is still there moves nothing twice', async () => {
    const vault = fakeVault(['.tmp/a.png', '.tmp/b.png'])
    const { assets } = harness(vault.port)
    const tab = stagedTab('![a](.tmp/a.png)\n\n![b](.tmp/b.png)\n', ['.tmp/a.png', '.tmp/b.png'])

    vault.failMovesOf('.tmp/b.png')
    await assets.relocate(tab, VAULT, NOTE)
    await assets.relocate(tab, VAULT, NOTE)

    expect(vault.moves.filter(([from]) => from === '.tmp/a.png')).toHaveLength(1)
    expect(vault.files.has('notes/foo_assets/a.png')).toBe(true)
  })

  it('does not mistake an occupied destination for a completed move', async () => {
    // `notes/foo_assets/b.png` already exists and is a DIFFERENT image; the
    // staged `b` has not moved anywhere.
    const vault = fakeVault(['.tmp/a.png', '.tmp/b.png', 'notes/foo_assets/b.png'])
    const { assets, errors } = harness(vault.port)
    const tab = stagedTab('![a](.tmp/a.png)\n\n![b](.tmp/b.png)\n', ['.tmp/a.png', '.tmp/b.png'])

    await assets.relocate(tab, VAULT, NOTE)

    // Refused, not replaced and not renamed around: the reference is left as it
    // is, because `.tmp/b.png` is still where the note says the image is.
    expect(tab.content).toBe('![a](foo_assets/a.png)\n\n![b](.tmp/b.png)\n')
    expect(tab.pendingAssetPaths).toEqual(['.tmp/b.png'])
    expect(errors).toEqual(['tabs.saveAttachmentFailed'])
    // The pair that collided holds nothing else hostage.
    expect(vault.files.has('notes/foo_assets/a.png')).toBe(true)
    expect(vault.moves).toEqual([
      ['.tmp/a.png', 'notes/foo_assets/a.png'],
      ['.tmp/b.png', 'notes/foo_assets/b.png'],
    ])
  })

  it('rewrites against the live document when the note is edited mid-move', async () => {
    const vault = fakeVault(['.tmp/a.png', '.tmp/b.png'])
    let release: () => void = () => {}
    vault.parkMoveOf(
      '.tmp/a.png',
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    vault.failMovesOf('.tmp/b.png')
    const { assets } = harness(vault.port)
    const tab = stagedTab('![a](.tmp/a.png)\n', ['.tmp/a.png', '.tmp/b.png'])

    const pass = assets.relocate(tab, VAULT, NOTE)
    await vi.waitFor(() => expect(vault.moves).toHaveLength(1))
    tab.content += 'typed while the move was in flight\n'
    release()
    await pass

    // The keystroke survives, and the reference rewrite lands on it.
    expect(tab.content).toBe('![a](foo_assets/a.png)\ntyped while the move was in flight\n')
    expect(tab.pendingAssetPaths).toEqual(['.tmp/b.png'])
  })

  it('leaves no reference pointing at a file that has moved', async () => {
    const vault = fakeVault(['.tmp/a.png', '.tmp/b.png'])
    vault.failMovesOf('.tmp/b.png')
    const { assets } = harness(vault.port)
    const tab = stagedTab('![a](.tmp/a.png)\n\n![b](.tmp/b.png)\n', ['.tmp/a.png', '.tmp/b.png'])

    await assets.relocate(tab, VAULT, NOTE)

    // The invariant the whole finding turns on, stated against the vault rather
    // than against memory: after any pass, a `.tmp/…` reference in the body may
    // only name a file that is still there. It survives a restart because it is
    // a property of the body and the disk, not of what the app remembers.
    const refs = [...tab.content.matchAll(/\.tmp\/[\w.-]+/g)].map((m) => m[0])
    expect(refs).toEqual(['.tmp/b.png'])
    for (const ref of refs) expect(vault.files.has(ref)).toBe(true)
  })

  it('does nothing when the note has no staged assets or no usable assets dir', async () => {
    const vault = fakeVault(['.tmp/a.png'])
    const { assets } = harness(vault.port)
    const empty = stagedTab('text\n', [])

    expect(await assets.relocate(empty, VAULT, NOTE)).toBe(false)
    expect(vault.moves).toEqual([])
    // A tab still without a path stages into `.tmp`; there is nowhere to move to.
    const untitled = stagedTab('![a](.tmp/a.png)\n', ['.tmp/a.png'])
    expect(await assets.relocate(untitled, VAULT, '')).toBe(false)
    expect(vault.moves).toEqual([])
  })
})
