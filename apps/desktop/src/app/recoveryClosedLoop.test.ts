import { describe, expect, it, vi } from 'vitest'
import type { FileEntry, FileStat } from '../platform/gateways/contracts'
import type { RecoveryPrompt } from '../services/errors'
import {
  createTmpRecovery,
  requestUntitledVaultSwitch,
  TMP_GC_AGE_MS,
  type TmpRecoveryDeps,
} from './recoveryClosedLoop'

const DAY = 24 * 60 * 60 * 1000

interface FakeFs {
  files: Map<string, { size: number; mtime: number }>
  list: (vault: string, dir: string) => Promise<FileEntry[]>
  stat: (vault: string, path: string) => Promise<FileStat>
  deleteFile: (vault: string, path: string) => Promise<string>
  renameEntry: (vault: string, from: string, to: string) => Promise<string>
  deleted: string[]
  renamed: Array<{ from: string; to: string }>
}

function makeFakeFs(seed: Record<string, number> = {}): FakeFs {
  const files = new Map<string, { size: number; mtime: number }>(
    Object.entries(seed).map(([path, mtime]) => [path, { size: 1, mtime }]),
  )
  const deleted: string[] = []
  const renamed: Array<{ from: string; to: string }> = []
  return {
    files,
    deleted,
    renamed,
    list: async (_vault, dir) => {
      if (dir !== '.tmp') return []
      return [...files.entries()]
        .filter(([path]) => path.startsWith('.tmp/'))
        .map(([path]) => ({
          name: path.split('/').pop() ?? path,
          path,
          is_dir: false,
          is_mdx: false,
        }))
    },
    stat: async (_vault, path) => {
      const f = files.get(path)
      if (!f) throw new Error(`no file ${path}`)
      return { size: f.size, mtime: f.mtime }
    },
    deleteFile: async (_vault, path) => {
      deleted.push(path)
      files.delete(path)
      return `trash/${path}`
    },
    renameEntry: async (_vault, from, to) => {
      renamed.push({ from, to })
      const f = files.get(from)
      if (f) {
        files.set(to, f)
        files.delete(from)
      }
      return to
    },
  }
}

function makeRecovery(opts: {
  seed?: Record<string, number>
  referenced?: string[]
  now?: number
}): {
  fs: FakeFs
  controller: ReturnType<typeof createTmpRecovery>
  prompts: RecoveryPrompt[]
} {
  const fs = makeFakeFs(opts.seed)
  const prompts: RecoveryPrompt[] = []
  const referenced = new Set(opts.referenced ?? [])
  const deps: TmpRecoveryDeps = {
    fs,
    getReferencedTmp: () => referenced,
    notify: (p) => prompts.push(p),
    now: () => opts.now ?? 1000 * DAY * 30,
  }
  return { fs, controller: createTmpRecovery(deps), prompts }
}

describe('createTmpRecovery (orphaned .tmp scan + GC)', () => {
  it('lists orphaned .tmp files and surfaces a recoverable-version notice', async () => {
    const { fs, controller, prompts } = makeRecovery({
      seed: { '.tmp/paste-a.png': 1000 * DAY * 1 },
      referenced: [],
    })
    const orphans = await controller.scan('/vault')
    expect(orphans).toHaveLength(1)
    expect(orphans[0].path).toBe('.tmp/paste-a.png')
    expect(orphans[0].mtime).toBe(1000 * DAY * 1)
    // A notice is surfaced with a Restore action and a Dismiss action.
    expect(prompts).toHaveLength(1)
    const p = prompts[0]
    expect(p.message).toContain('1')
    expect(typeof p.onRestore).toBe('function')
    expect(typeof p.onDismiss).toBe('function')
    p.onRestore()
    await vi.waitFor(() => expect(fs.renamed).toHaveLength(1))
    expect(fs.renamed[0]).toEqual({ from: '.tmp/paste-a.png', to: expect.stringContaining('attachments/') })
  })

  it('does not surface a notice when no .tmp files exist', async () => {
    const { prompts, controller } = makeRecovery({ seed: {} })
    const orphans = await controller.scan('/vault')
    expect(orphans).toEqual([])
    expect(prompts).toHaveLength(0)
  })

  it('excludes referenced .tmp files from the orphan list', async () => {
    const { controller, prompts } = makeRecovery({
      seed: { '.tmp/pending.png': 1000 * DAY * 1, '.tmp/litter.png': 1000 * DAY * 1 },
      referenced: ['.tmp/pending.png'],
    })
    const orphans = await controller.scan('/vault')
    expect(orphans.map((o) => o.path)).toEqual(['.tmp/litter.png'])
    expect(prompts).toHaveLength(1)
  })

  it('is a no-op (no notice) when the vault has no .tmp dir (list throws)', async () => {
    const { prompts } = makeRecovery({ seed: {} })
    // Force list to reject like a missing directory.
    const c = createTmpRecovery({
      fs: {
        list: async () => {
          throw new Error('No such directory')
        },
        stat: async () => ({ size: 1, mtime: 0 }),
        deleteFile: async () => 'trash',
        renameEntry: async () => 'x',
      },
      getReferencedTmp: () => new Set(),
      notify: (p) => prompts.push(p),
    })
    expect(await c.scan('/vault')).toEqual([])
    expect(prompts).toHaveLength(0)
  })

  it('GC removes only orphaned .tmp files older than the threshold', async () => {
    const now = 1000 * DAY * 100
    const { fs, controller } = makeRecovery({
      seed: {
        '.tmp/old-orphan.png': now - 2 * TMP_GC_AGE_MS, // old + orphan
        '.tmp/fresh-orphan.png': now - 1 * 1000, // fresh orphan — keep
        '.tmp/old-referenced.png': now - 2 * TMP_GC_AGE_MS, // old but referenced
      },
      referenced: ['.tmp/old-referenced.png'],
      now,
    })
    const removed = await controller.gc('/vault')
    expect(removed).toBe(1)
    expect(fs.deleted).toEqual(['.tmp/old-orphan.png'])
  })

  it('GC keeps recent orphaned files so a real crash stays reviewable', async () => {
    const now = 1000 * DAY * 100
    const { fs, controller } = makeRecovery({
      seed: { '.tmp/recent.png': now - 5 * 60 * 1000 },
      now,
    })
    const removed = await controller.gc('/vault')
    expect(removed).toBe(0)
    expect(fs.deleted).toEqual([])
  })

  it('cancel aborts an in-flight GC at the next await boundary', async () => {
    const now = 1000 * DAY * 100
    const fs = makeFakeFs({
      '.tmp/one.png': now - 2 * TMP_GC_AGE_MS,
      '.tmp/two.png': now - 2 * TMP_GC_AGE_MS,
      '.tmp/three.png': now - 2 * TMP_GC_AGE_MS,
    })
    // Make the first delete settle after a tick so we can cancel mid-flight.
    let resolveDelete: (v: string) => void = () => {}
    fs.deleteFile = () => {
      return new Promise((r) => {
        resolveDelete = r
      })
    }
    const controller = createTmpRecovery({
      fs,
      getReferencedTmp: () => new Set(),
      now: () => now,
    })
    const pending = controller.gc('/vault')
    controller.cancel()
    expect(controller.isCancelled()).toBe(true)
    resolveDelete('trash/x')
    const removed = await pending
    // The loop breaks after the cancelled next iteration, so only one delete ran.
    expect(removed).toBe(0)
  })
})

describe('requestUntitledVaultSwitch', () => {
  it('resolves to save when the user restores', async () => {
    let prompt: RecoveryPrompt | null = null
    const promise = requestUntitledVaultSwitch({
      count: 2,
      notify: (p) => {
        prompt = p
      },
    })
    expect(prompt).toBeTruthy()
    expect(prompt!.message).toContain('2')
    prompt!.onRestore()
    expect(await promise).toBe('save')
  })

  it('resolves to discard when the user dismisses', async () => {
    const promise = requestUntitledVaultSwitch({
      count: 1,
      notify: (p) => {
        p.onDismiss()
      },
    })
    expect(await promise).toBe('discard')
  })
})

describe('TMP_GC_AGE_MS default', () => {
  it('is a 7-day threshold', () => {
    expect(TMP_GC_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
