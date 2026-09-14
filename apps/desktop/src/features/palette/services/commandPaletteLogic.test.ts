import { describe, expect, it } from 'vitest'
import {
  displayDir,
  fileEntryOf,
  filterEntries,
  flattenGroups,
  groupEntries,
  scoreEntry,
  splitPath,
  type PaletteEntry,
} from './commandPaletteLogic'

function cmd(id: string, label: string, keywords?: string): PaletteEntry {
  return { id, kind: 'command', label, keywords, run: () => {} }
}

function file(path: string): PaletteEntry {
  return fileEntryOf(path, null, () => {})
}

describe('scoreEntry', () => {
  const entry = cmd('bold', '加粗', 'bold b')
  it('ranks exact label and keyword matches highest', () => {
    expect(scoreEntry(entry, '加粗')).toBe(0)
    expect(scoreEntry(entry, 'bold')).toBe(0)
  })
  it('ranks label prefix before keyword prefix before includes', () => {
    const e = cmd('x', '标题', 'heading h2')
    expect(scoreEntry(e, '标题 1')).toBe(-1)
    expect(scoreEntry(e, '标')).toBe(1)
    expect(scoreEntry(e, 'head')).toBe(2)
    expect(scoreEntry(e, 'eading')).toBe(4)
  })
  it('matches case-insensitively', () => {
    expect(scoreEntry(cmd('bold', 'Bold'), 'bold')).toBe(0)
    expect(scoreEntry(cmd('bold', '加粗', 'BOLD'), 'bold')).toBe(0)
  })
  it('returns -1 when nothing matches', () => {
    expect(scoreEntry(entry, '斜体')).toBe(-1)
  })
})

describe('filterEntries', () => {
  const entries = [
    cmd('a', '加粗'),
    cmd('b', '斜体'),
    cmd('c', '引用', 'quote'),
  ]
  it('returns entries untouched for an empty query', () => {
    expect(filterEntries(entries, '  ')).toEqual(entries)
  })
  it('filters by label substring', () => {
    expect(filterEntries(entries, '粗').map((e) => e.id)).toEqual(['a'])
  })
  it('filters by keywords', () => {
    expect(filterEntries(entries, 'quote').map((e) => e.id)).toEqual(['c'])
  })
  it('excludes non-matching entries', () => {
    expect(filterEntries(entries, '代码')).toEqual([])
  })
  it('orders exact before prefix before includes', () => {
    const ranked = [
      cmd('1', '列表'),
      cmd('2', '无序列表'),
      cmd('3', '列表项'),
      cmd('4', '有序列表', 'ordered'),
    ]
    expect(filterEntries(ranked, '列表').map((e) => e.id)).toEqual(['1', '3', '2', '4'])
  })
  it('breaks score ties with the label, then the id', () => {
    const tied = [cmd('b', '列表'), cmd('a', '列表')]
    expect(filterEntries(tied, '列表').map((e) => e.id)).toEqual(['a', 'b'])
  })
  it('truncates to the limit for non-empty queries', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`id-${i}`, `文件 ${i}`))
    expect(filterEntries(many, '文件')).toHaveLength(30)
    expect(filterEntries(many, '文件', 20)).toHaveLength(20)
    expect(filterEntries(many, '文件', 5)).toHaveLength(5)
  })
})

describe('groupEntries / flattenGroups', () => {
  it('puts the command group before the file group', () => {
    const groups = groupEntries([file('/v/b.md'), cmd('bold', '加粗')])
    expect(groups.map((g) => g.label)).toEqual(['命令', '文件'])
    expect(groups[0].entries.map((e) => e.id)).toEqual(['bold'])
  })
  it('drops empty groups', () => {
    expect(groupEntries([cmd('bold', '加粗')])).toHaveLength(1)
    expect(groupEntries([file('/v/a.md')])).toHaveLength(1)
  })
  it('keeps input order inside each group', () => {
    const groups = groupEntries([cmd('b', '乙'), cmd('a', '甲'), file('/v/z.md'), file('/v/a.md')])
    expect(groups[1].entries.map((e) => e.id)).toEqual(['file:/v/z.md', 'file:/v/a.md'])
    expect(flattenGroups(groups).map((e) => e.kind)).toEqual(['command', 'command', 'file', 'file'])
  })
})

describe('path helpers', () => {
  it('splits a path into name and dir', () => {
    expect(splitPath('notes/数学/线性代数.md')).toEqual({ name: '线性代数.md', dir: 'notes/数学' })
    expect(splitPath('welcome.md')).toEqual({ name: 'welcome.md', dir: '' })
  })
  it('strips the vault prefix for display', () => {
    expect(displayDir('/home/u/vault/notes/a.md', '/home/u/vault')).toBe('notes')
    expect(displayDir('/home/u/vault/a.md', '/home/u/vault')).toBe('')
    expect(displayDir('notes/sub/b.md', null)).toBe('notes/sub')
  })
  it('strips a NATIVE Windows vault prefix too', () => {
    // The palette receives absolute native paths, so on Windows the prefix
    // test never matched a '/'-built root and the hint showed the whole path.
    const vault = 'C:\\Users\\me\\vault'
    expect(displayDir(`${vault}\\notes\\a.md`, vault)).toBe('notes')
    expect(displayDir(`${vault}\\a.md`, vault)).toBe('')
    // A path outside the vault keeps its directory rather than losing it.
    expect(displayDir('D:\\other\\b.md', vault)).toBe('D:/other')
  })

  it('builds file entries with path keywords and vault-relative hints', () => {
    const entry = fileEntryOf('/v/notes/idea.md', '/v', () => {})
    expect(entry.kind).toBe('file')
    expect(entry.label).toBe('idea.md')
    expect(entry.hint).toBe('notes')
    expect(entry.keywords).toBe('notes idea.md')
  })
})
