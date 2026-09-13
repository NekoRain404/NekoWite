import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { useAppearanceStore } from '../../../stores/appearance'
import { useEditorFocus } from './useEditorFocus'
import { resetAnnouncer } from '../../../services/announcer'

vi.mock('../../../services/announcer', () => ({
  announce: vi.fn(),
  resetAnnouncer: vi.fn(),
}))
import { announce } from '../../../services/announcer'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: { read: readMock, write: writeMock },
}))

/** Counts full-document readings from either implementation, so "the goal being
 *  off costs nothing" is measured rather than asserted about a call path. */
const docReads = { count: 0 }
vi.mock('../../../services/docStats', async (orig) => {
  const mod = await orig<typeof import('../../../services/docStats')>()
  return {
    ...mod,
    computeDocStats: (md: string) => {
      docReads.count += 1
      return mod.computeDocStats(md)
    },
  }
})
vi.mock('../../../services/editorBehaviors', async (orig) => {
  const mod = await orig<typeof import('../../../services/editorBehaviors')>()
  return {
    ...mod,
    countWords: (md: string) => {
      docReads.count += 1
      return mod.countWords(md)
    },
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
  readMock.mockReset()
  writeMock.mockReset()
  vi.clearAllMocks()
  docReads.count = 0
})

afterEach(() => {
  resetAnnouncer()
})

describe('useEditorFocus word-goal live-region', () => {
  it('announces the goal once when the user crosses the word goal', async () => {
    const tabs = useTabsStore()
    const appearance = useAppearanceStore()
    readMock.mockResolvedValue('')
    tabs.setVault('/vault')
    await tabs.openTab(null, '')
    appearance.wordGoal = 3

    useEditorFocus({ getEditor: () => null, getScrollEl: () => null })

    // Start below the goal, then cross it in one edit.
    tabs.tabs[0].content = 'one two three'
    tabs.markDirty(tabs.tabs[0].id)

    await nextTick()
    expect(announce).toHaveBeenCalledWith(
      expect.stringContaining(String(appearance.wordGoal)),
    )
  })

  it('does not read the document per edit while the goal is off', async () => {
    // The goal is off by default, and the live-region watch used to keep the
    // word count alive anyway: a full-document scan per typing pause for a
    // widget that is not on screen.
    const tabs = useTabsStore()
    const appearance = useAppearanceStore()
    readMock.mockResolvedValue('')
    tabs.setVault('/vault')
    await tabs.openTab(null, '')
    appearance.wordGoal = 0

    useEditorFocus({ getEditor: () => null, getScrollEl: () => null })
    docReads.count = 0

    tabs.activeTab!.content = 'one two three'
    await nextTick()
    await nextTick()

    expect(docReads.count).toBe(0)
  })

  it('counts the words again as soon as a goal is set', async () => {
    const tabs = useTabsStore()
    const appearance = useAppearanceStore()
    readMock.mockResolvedValue('')
    tabs.setVault('/vault')
    await tabs.openTab(null, '')
    appearance.wordGoal = 0

    const focus = useEditorFocus({ getEditor: () => null, getScrollEl: () => null })
    tabs.activeTab!.content = 'one two three'
    await nextTick()
    expect(focus.wordCount.value).toBe(0)

    appearance.wordGoal = 10
    await nextTick()

    expect(focus.wordCount.value).toBe(3)
    expect(focus.wordGoalMet.value).toBe(false)
  })

  it('does not announce when the word goal is disabled (goal = 0)', async () => {
    const tabs = useTabsStore()
    const appearance = useAppearanceStore()
    readMock.mockResolvedValue('')
    tabs.setVault('/vault')
    await tabs.openTab(null, '')
    appearance.wordGoal = 0

    useEditorFocus({ getEditor: () => null, getScrollEl: () => null })

    tabs.tabs[0].content = 'one two three'
    tabs.markDirty(tabs.tabs[0].id)

    await nextTick()
    expect(announce).not.toHaveBeenCalled()
  })
})
