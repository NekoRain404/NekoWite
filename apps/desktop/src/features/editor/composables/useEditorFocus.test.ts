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
vi.mock('../../../services/fs', () => ({
  fsService: { read: readMock, write: writeMock },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  readMock.mockReset()
  writeMock.mockReset()
  vi.clearAllMocks()
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
