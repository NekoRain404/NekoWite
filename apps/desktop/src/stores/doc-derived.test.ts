import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
import { useDocDerivedStore } from './doc-derived'
import { useTabsStore, type OpenTab } from './tabs'
import { countWords, taskProgress } from '../services/editor-behaviors'
import { parseOutline } from '../services/outline'

/** Counts the scans, so "the memo did not re-run" is observable rather than a
 *  claim about Vue's internals. */
const calls = { computeDocStats: 0, parseOutline: 0 }

vi.mock('../services/doc-stats', async (orig) => {
  const mod = await orig<typeof import('../services/doc-stats')>()
  return {
    ...mod,
    computeDocStats: (md: string) => {
      calls.computeDocStats += 1
      return mod.computeDocStats(md)
    },
  }
})

vi.mock('../services/outline', async (orig) => {
  const mod = await orig<typeof import('../services/outline')>()
  return {
    ...mod,
    parseOutline: (md: string) => {
      calls.parseOutline += 1
      return mod.parseOutline(md)
    },
  }
})

let pinia: Pinia

function seed(content: string, id = 't1', path: string | null = '/vault/a.md'): OpenTab {
  const s = useTabsStore()
  const tab: OpenTab = {
    id,
    path,
    content,
    savedContent: content,
    dirty: false,
    pendingAssetPaths: [],
  }
  s.tabs.push(tab)
  s.activeId = tab.id
  return tab
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  calls.computeDocStats = 0
  calls.parseOutline = 0
})

describe('the shared document readings', () => {
  it('answers every reading the panels show, with the same numbers the status bar used', () => {
    // These are the readings the status bar rendered from its own private
    // copies of the algorithms; they must not change when they come from here.
    const content = 'Hello world 你好 世界\n\n- [ ] todo\n- [x] done\n\n## Heading\n'
    seed(content)
    const doc = useDocDerivedStore()

    expect(doc.stats.words).toBe(countWords(content))
    expect(doc.stats.chars).toBe(content.length)
    expect(doc.stats.readMinutes).toBe(Math.max(1, Math.ceil(countWords(content) / 300)))
    const tasks = taskProgress(content)
    expect([doc.stats.taskDone, doc.stats.taskTotal]).toEqual([tasks.done, tasks.total])
    expect(doc.outline).toEqual(parseOutline(content))
  })

  it('re-derives when the document changes', async () => {
    // The memo-invalidation test: a memo keyed wrongly shows a stale number,
    // and a stale word count is worse than a slow one.
    seed('# One\n\nfirst text\n')
    const doc = useDocDerivedStore()
    expect(doc.stats.words).toBe(4)
    expect(doc.outline.map((i) => i.text)).toEqual(['One'])

    useTabsStore().activeTab!.content = '# Two\n\nsecond text 中文\n'
    await nextTick()

    expect(doc.stats.words).toBe(6)
    expect(doc.outline.map((i) => i.text)).toEqual(['Two'])
  })

  it('swaps the whole reading when the active note changes', async () => {
    seed('# A\n\nalpha\n', 't1', '/vault/a.md')
    seed('# B\n\nbeta text here\n', 't2', '/vault/b.md')
    const tabs = useTabsStore()
    const doc = useDocDerivedStore()
    expect(doc.outline.map((i) => i.text)).toEqual(['B'])

    tabs.activeId = 't1'
    await nextTick()
    expect(doc.outline.map((i) => i.text)).toEqual(['A'])
    expect(doc.stats.words).toBe(3)
  })

  it('reads as empty with no document open', () => {
    const doc = useDocDerivedStore()
    expect(doc.stats.words).toBe(0)
    expect(doc.stats.chars).toBe(0)
    expect(doc.stats.readMinutes).toBe(0)
    expect(doc.outline).toEqual([])
  })

  it('holds one entry: publishing the same text again does not re-derive', async () => {
    // Keyed on the published text (and the tab), not on "something was written":
    // a re-publish of identical text — the save path does this — must not pay
    // for a scan, and nothing accumulates in between.
    seed('# One\n\nsome text\n')
    const doc = useDocDerivedStore()
    void doc.stats.words
    void doc.outline.length
    const before = { ...calls }

    const tab = useTabsStore().activeTab!
    tab.content = '# One\n\nsome text\n'
    tab.savedContent = tab.content
    await nextTick()
    void doc.stats.words
    void doc.outline.length

    expect(calls).toEqual(before)
  })

  it('derives once per document change, however many panels read it', async () => {
    // The dedupe the rail needs: four consumers, one scan per pause.
    seed('# One\n\nsome text\n')
    const doc = useDocDerivedStore()
    void doc.stats.words
    calls.computeDocStats = 0

    useTabsStore().activeTab!.content = '# One\n\nsome more text\n'
    await nextTick()

    void doc.stats.words
    void doc.stats.chars
    void doc.stats.readMinutes
    void doc.stats.taskTotal
    expect(calls.computeDocStats).toBe(1)
  })
})
