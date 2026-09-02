import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useRefsStore } from './refs'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
vi.mock('../services/fs', () => ({
  fsService: { list: listMock, read: readMock, write: vi.fn(), watch: vi.fn() },
}))

const BIB = `@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John and Doe, Jane},
  year = {2020},
}`

const RIS = `TY  - JOUR
AU  - Smith, John
TI  - An RIS Paper
PY  - 2021
ER  -`

describe('useRefsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listMock.mockReset()
    readMock.mockReset()
  })

  it('loads reference files from vault root and indexes by key', async () => {
    listMock.mockResolvedValue([
      { name: 'refs.bib', path: '/vault/refs.bib', is_dir: false, is_mdx: false },
      { name: 'notes.md', path: '/vault/notes.md', is_dir: false, is_mdx: true },
    ])
    readMock.mockResolvedValue(BIB)
    const s = useRefsStore()
    await s.loadVault('/vault')
    expect(listMock).toHaveBeenCalledWith('/vault', '.')
    expect(readMock).toHaveBeenCalledWith('/vault', '/vault/refs.bib')
    expect(s.refFiles).toEqual(['refs.bib'])
    expect(s.refs.size).toBe(1)
    expect(s.get('smith2020')?.title).toContain('Great Paper')
  })

  it('indexes multiple formats and search matches key, title, author and year', async () => {
    listMock.mockResolvedValue([
      { name: 'refs.bib', path: '/vault/refs.bib', is_dir: false, is_mdx: false },
      { name: 'refs.ris', path: '/vault/refs.ris', is_dir: false, is_mdx: false },
    ])
    readMock.mockImplementation((_vault, path) =>
      Promise.resolve(path.endsWith('.ris') ? RIS : BIB),
    )
    const s = useRefsStore()
    await s.loadVault('/vault')
    expect(s.refFiles).toEqual(['refs.bib', 'refs.ris'])
    expect(s.refs.size).toBe(2)

    expect(s.search('smith').map((r) => r.key)).toContain('smith2020')
    expect(s.search('great paper').map((r) => r.key)).toContain('smith2020')
    expect(s.search('john').map((r) => r.title)).toContain('A Great Paper')
    const risMatches = s.search('2021')
    expect(risMatches.some((r) => r.year === '2021' && r.title === 'An RIS Paper')).toBe(true)
    expect(s.search('nomatch')).toEqual([])
  })

  it('returns all refs for an empty query', async () => {
    listMock.mockResolvedValue([
      { name: 'refs.bib', path: '/vault/refs.bib', is_dir: false, is_mdx: false },
    ])
    readMock.mockResolvedValue(BIB)
    const s = useRefsStore()
    await s.loadVault('/vault')
    expect(s.search('   ').length).toBe(1)
  })

  it('get returns undefined for an unknown key', async () => {
    const s = useRefsStore()
    expect(s.get('missing')).toBeUndefined()
  })

  it('swallows per-file read failures without aborting others', async () => {
    listMock.mockResolvedValue([
      { name: 'a.bib', path: '/vault/a.bib', is_dir: false, is_mdx: false },
      { name: 'b.bib', path: '/vault/b.bib', is_dir: false, is_mdx: false },
    ])
    readMock.mockRejectedValueOnce(new Error('bad file')).mockResolvedValueOnce(BIB)
    const s = useRefsStore()
    await s.loadVault('/vault')
    expect(s.refFiles).toEqual(['b.bib'])
    expect(s.refs.size).toBe(1)
  })

  it('clear empties refs and refFiles', async () => {
    listMock.mockResolvedValue([
      { name: 'refs.bib', path: '/vault/refs.bib', is_dir: false, is_mdx: false },
    ])
    readMock.mockResolvedValue(BIB)
    const s = useRefsStore()
    await s.loadVault('/vault')
    s.clear()
    expect(s.refs.size).toBe(0)
    expect(s.refFiles).toEqual([])
  })

  it('computed search results re-evaluate as the query changes (RefSidebar pattern)', async () => {
    listMock.mockResolvedValue([
      { name: 'refs.bib', path: '/vault/refs.bib', is_dir: false, is_mdx: false },
      { name: 'refs.ris', path: '/vault/refs.ris', is_dir: false, is_mdx: false },
    ])
    readMock.mockImplementation((_vault, path) =>
      Promise.resolve(path.endsWith('.ris') ? RIS : BIB),
    )
    const s = useRefsStore()
    await s.loadVault('/vault')

    const query = ref('')
    const results = computed(() => s.search(query.value))
    expect(results.value.length).toBe(2)

    query.value = 'great paper'
    expect(results.value.map((r) => r.key)).toEqual(['smith2020'])
    query.value = 'nomatch'
    expect(results.value.length).toBe(0)
    query.value = ''
    expect(results.value.length).toBe(2)
  })
})
