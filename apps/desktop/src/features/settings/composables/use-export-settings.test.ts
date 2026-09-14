/**
 * The export commands the settings panel owns.
 *
 * `ExportSettings.vue` only emits `export-html` / `export-pdf` (§10.3-C), so
 * these cases are the whole of the section's behaviour that matters: which
 * destination is refused before anything is written, that the live text is
 * flushed before it is exported, and that a failure is reported rather than
 * looking like the button doing nothing.
 *
 * The composable is mounted inside a real component: its computed properties
 * need an effect scope, and mounting is how the app gives it one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useExportSettings, type ExportSettingsModel } from './use-export-settings'
import { useSettingsStore } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'
import type { OpenTab } from '../../../stores/tabs'
import { onNotify } from '../../../services/errors'

const mocks = vi.hoisted(() => ({
  exportHtml: vi.fn(),
  exportToPdf: vi.fn(),
  flushEdits: vi.fn(),
  saveFileDialog: vi.fn(),
}))

vi.mock('../../../services/export', () => ({
  exportHtml: mocks.exportHtml,
  exportToPdf: mocks.exportToPdf,
}))
vi.mock('../../../services/editor-ownership', () => ({ flushEdits: mocks.flushEdits }))
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: { saveFileDialog: mocks.saveFileDialog },
}))

let pinia: Pinia
let mounted: VueApp[] = []

function mountModel(): ExportSettingsModel {
  let created: ExportSettingsModel | null = null
  const app = createApp({
    setup() {
      created = useExportSettings()
      return () => null
    },
  })
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  return created!
}

function openTab(over: Partial<OpenTab> = {}): void {
  const tabs = useTabsStore()
  tabs.vault = '/vault'
  // Replace rather than append: the active tab is the first match by id, so a
  // second push would leave the previous one answering for it.
  tabs.tabs.splice(0, tabs.tabs.length)
  tabs.tabs.push({
    id: 't1',
    path: 'notes/alpha.md',
    content: '# Alpha',
    savedContent: '# Alpha',
    dirty: false,
    pendingAssetPaths: [],
    ...over,
  })
  tabs.activeId = 't1'
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  mocks.exportHtml.mockReset().mockResolvedValue(undefined)
  mocks.exportToPdf.mockReset().mockResolvedValue(undefined)
  mocks.flushEdits.mockReset().mockResolvedValue(undefined)
  mocks.saveFileDialog.mockReset().mockResolvedValue(null)
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

describe('useExportSettings', () => {
  it('reports no active note until one is open, so both buttons stay disabled', () => {
    const m = mountModel()
    // The model is read outside a template here, so its refs are not unwrapped
    // the way a component's would be.
    expect(m.hasActiveTab.value).toBe(false)

    openTab({ content: '' })
    // The old gate: a tab whose content has not loaded yet is not exportable.
    expect(m.hasActiveTab.value).toBe(false)

    openTab({ content: '# Alpha' })
    expect(m.hasActiveTab.value).toBe(true)
  })

  it('refuses a destination outside the vault before writing anything', async () => {
    const m = mountModel()
    openTab()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.saveFileDialog.mockResolvedValue('/home/user/Desktop/alpha.html')

    await m.exportHtmlFile()
    off()

    // The Rust `write_file` command is vault-confined; leading the user to a
    // doomed path would fail silently, which is the bug this guard replaced.
    expect(mocks.exportHtml).not.toHaveBeenCalled()
    expect(mocks.flushEdits).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
  })

  it('flushes the pending edits before exporting, so the saved text is the live text', async () => {
    const m = mountModel()
    openTab({ content: '# Alpha edited' })
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.html')

    await m.exportHtmlFile()

    expect(mocks.flushEdits).toHaveBeenCalledTimes(1)
    expect(mocks.exportHtml).toHaveBeenCalledTimes(1)
    expect(mocks.exportHtml.mock.calls[0]![0]).toBe('# Alpha edited')
    // The order is the contract: a flush after the read would export the
    // version the source pane has already stopped showing.
    expect(mocks.flushEdits.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.exportHtml.mock.invocationCallOrder[0]!)
  })

  it('exports nothing when the save dialog is cancelled', async () => {
    const m = mountModel()
    openTab()
    mocks.saveFileDialog.mockResolvedValue(null)

    await m.exportHtmlFile()

    expect(mocks.exportHtml).not.toHaveBeenCalled()
    expect(mocks.flushEdits).not.toHaveBeenCalled()
  })

  it('reports a failed HTML write instead of swallowing it', async () => {
    const m = mountModel()
    openTab()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.html')
    mocks.exportHtml.mockRejectedValue(new Error('path escapes vault'))

    await m.exportHtmlFile()
    off()

    expect(messages).toHaveLength(1)
  })

  it('reports a failed PDF render — the case that used to look like a dead button', async () => {
    const m = mountModel()
    openTab()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.exportToPdf.mockRejectedValue(new Error('no vault open'))

    await m.exportPdfFile()
    off()

    expect(mocks.flushEdits).toHaveBeenCalledTimes(1)
    expect(messages).toHaveLength(1)
  })

  it('does nothing when no note is open', async () => {
    const m = mountModel()
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.html')

    await m.exportHtmlFile()
    await m.exportPdfFile()

    expect(mocks.saveFileDialog).not.toHaveBeenCalled()
    expect(mocks.exportToPdf).not.toHaveBeenCalled()
  })

  it('writes the export defaults through to the store', () => {
    const m = mountModel()
    const settings = useSettingsStore()

    expect(m.frontmatter.value).toBe(settings.exportIncludeFrontmatter)
    m.frontmatter.value = false
    m.pageSize.value = 'Letter'
    m.orientation.value = 'landscape'

    expect(settings.exportIncludeFrontmatter).toBe(false)
    expect(settings.exportPdfPageSize).toBe('Letter')
    expect(settings.exportPdfOrientation).toBe('landscape')
  })
})
