import { describe, expect, it } from 'vitest'
import {
  basename,
  dirname,
  joinPath,
  resolveDropTarget,
  type DropRow,
} from './treeDrop'

describe('path helpers', () => {
  it('basename takes the last segment', () => {
    expect(basename('docs/a.md')).toBe('a.md')
    expect(basename('a.md')).toBe('a.md')
    expect(basename('docs/')).toBe('docs')
  })

  it('dirname takes the containing directory', () => {
    expect(dirname('docs/a.md')).toBe('docs')
    expect(dirname('a.md')).toBe('a.md')
  })

  it('joinPath joins with a single slash', () => {
    expect(joinPath('docs', 'a.md')).toBe('docs/a.md')
    expect(joinPath('docs/', 'a.md')).toBe('docs/a.md')
  })
})

describe('resolveDropTarget', () => {
  const rows: DropRow[] = [
    { path: '.', isDir: true },
    { path: 'docs', isDir: true },
    { path: 'docs/nested', isDir: true },
    { path: 'docs/a.md', isDir: false },
    { path: 'archive', isDir: true },
    { path: 'b.md', isDir: false },
  ]

  it('moves a file into a directory (target dir + basename)', () => {
    const r = resolveDropTarget(rows, 'docs/a.md', 'archive', '.')
    expect(r).toMatchObject({ ok: true, reason: 'ok', from: 'docs/a.md', to: 'archive/a.md' })
  })

  it('moves a directory into another directory', () => {
    const r = resolveDropTarget(rows, 'docs', 'archive', '.')
    expect(r).toMatchObject({ ok: true, reason: 'ok', from: 'docs', to: 'archive/docs' })
  })

  it('moves a file to the vault root (bare basename)', () => {
    const r = resolveDropTarget(rows, 'docs/a.md', '.', '.')
    expect(r).toMatchObject({ ok: true, reason: 'ok', from: 'docs/a.md', to: 'a.md' })
  })

  it('rejects dropping a node onto itself', () => {
    const r = resolveDropTarget(rows, 'docs', 'docs')
    expect(r.reason).toBe('self')
    expect(r.ok).toBe(false)
    expect(r.to).toBeNull()
  })

  it('rejects dropping a directory into its own subtree', () => {
    const r = resolveDropTarget(rows, 'docs', 'docs/nested')
    expect(r.reason).toBe('descendant')
    expect(r.ok).toBe(false)
  })

  it('rejects a destination that already exists (conflict)', () => {
    const rowsWithRootFile: DropRow[] = [
      { path: '.', isDir: true },
      { path: 'docs', isDir: true },
      { path: 'docs/a.md', isDir: false },
      { path: 'a.md', isDir: false },
    ]
    const r = resolveDropTarget(rowsWithRootFile, 'docs/a.md', '.', '.')
    expect(r.reason).toBe('conflict')
    expect(r.ok).toBe(false)
    expect(r.to).toBeNull()
  })
  it('rejects dropping onto a file (only dirs/root accept a drop)', () => {
    const r = resolveDropTarget(rows, 'docs/a.md', 'b.md')
    expect(r.reason).toBe('invalid')
    expect(r.ok).toBe(false)
  })

  it('rejects an unknown source', () => {
    const r = resolveDropTarget(rows, 'ghost.md', 'docs')
    expect(r.reason).toBe('invalid')
    expect(r.ok).toBe(false)
  })

  it('treats a no-op reposition as self', () => {
    // A file that already lives at root dropped onto the root is a no-op.
    const plain: DropRow[] = [
      { path: '.', isDir: true },
      { path: 'a.md', isDir: false },
    ]
    const noop = resolveDropTarget(plain, 'a.md', '.', '.')
    expect(noop.reason).toBe('self')
    expect(noop.ok).toBe(false)
  })
})
