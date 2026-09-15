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
import type { ExportImageFormat } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'
import type { OpenTab } from '../../../stores/tabs'
import { onNotify } from '../../../services/errors'
import type { ExportUiOptions, ExportImageResult } from '../../../services/export'
import { VAULT_ROOT_DIR } from '../../../platform/gateways/contracts'

// Every mock declares what it answers with: an inferred return type here is how
// a gateway double ends up able to answer only `null`, and the test that reads
// a path through it passes while proving nothing about the path.
const mocks = vi.hoisted(() => ({
  exportHtml: vi.fn<(source: string, vault: string, savePath: string, opts: ExportUiOptions) => Promise<void>>(),
  exportToPdf: vi.fn<(source: string, opts: ExportUiOptions) => Promise<void>>(),
  exportImage: vi.fn<(source: string, format: ExportImageFormat, quality: number, opts: ExportUiOptions) => Promise<ExportImageResult>>(),
  renderPlainText: vi.fn<(source: string, opts: ExportUiOptions) => Promise<string>>(),
  renderCsv: vi.fn<(source: string, opts: ExportUiOptions) => Promise<string | null>>(),
  flushEdits: vi.fn<() => Promise<void>>(),
  saveFileDialog: vi.fn<(defaultName: string, startDir?: string) => Promise<string | null>>(),
  write: vi.fn<(vault: string, path: string, content: string) => Promise<string | null>>(),
  saveAttachment: vi.fn<(vault: string, fileName: string, base64: string, dir?: string) => Promise<string>>(),
  announce: vi.fn<(text: string) => void>(),
}))

vi.mock('../../../services/export', () => ({
  exportHtml: mocks.exportHtml,
  exportToPdf: mocks.exportToPdf,
  exportImage: mocks.exportImage,
  renderPlainText: mocks.renderPlainText,
  renderCsv: mocks.renderCsv,
}))
vi.mock('../../../services/editor-ownership', () => ({ flushEdits: mocks.flushEdits }))
vi.mock('../../../services/announcer', () => ({ announce: mocks.announce }))
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    saveFileDialog: mocks.saveFileDialog,
    write: mocks.write,
    saveAttachment: mocks.saveAttachment,
  },
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
  mocks.exportImage.mockReset().mockResolvedValue({
    base64: 'AAAA', mime: 'image/png', width: 864, height: 5000, bytes: 1024,
  })
  mocks.renderPlainText.mockReset().mockResolvedValue('Alpha')
  mocks.renderCsv.mockReset().mockResolvedValue('a,b\r\n1,2\r\n')
  mocks.flushEdits.mockReset().mockResolvedValue(undefined)
  mocks.saveFileDialog.mockReset().mockResolvedValue(null)
  mocks.write.mockReset().mockResolvedValue(null)
  mocks.saveAttachment.mockReset().mockResolvedValue('notes/alpha.png')
  mocks.announce.mockReset()
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

  it('titles the document with the note\'s name, not its path', async () => {
    const m = mountModel()
    openTab({ content: '# Alpha edited' })
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.html')

    await m.exportHtmlFile()

    // `title` reaches the renderer as the document's `<title>`, so a path here
    // puts `notes/alpha.md` in the browser tab and in the printed header.
    const opts = mocks.exportHtml.mock.calls[0]![3]
    expect(opts.title).toBe('alpha')
    expect(opts.notePath).toBe('notes/alpha.md')
  })

  it('exports an unsaved untitled note rather than refusing it', async () => {
    const m = mountModel()
    // `path` is null for a document that has never been saved —
    // `tab-lifecycle` opens tabs that way — and an export of one is a file
    // called `untitled.*`, not a failure and not an empty string.
    openTab({ path: null, content: '# Untitled draft' })
    mocks.saveFileDialog.mockResolvedValue('/vault/untitled.html')

    await m.exportHtmlFile()

    expect(mocks.saveFileDialog).toHaveBeenCalledWith('untitled.html', '/vault')
    expect(mocks.exportHtml.mock.calls[0]![2]).toBe('/vault/untitled.html')
    const opts = mocks.exportHtml.mock.calls[0]![3]
    expect(opts.title).toBe('untitled')
    expect(opts.notePath).toBeNull()
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
    m.pageSize.value = 'Legal'
    m.orientation.value = 'landscape'
    m.marginMm.value = 8
    m.imageFormat.value = 'jpeg'
    m.imageQuality.value = 0.8

    expect(settings.exportIncludeFrontmatter).toBe(false)
    expect(settings.exportPdfPageSize).toBe('Legal')
    expect(settings.exportPdfOrientation).toBe('landscape')
    expect(settings.exportMarginMm).toBe(8)
    expect(settings.exportImageFormat).toBe('jpeg')
    expect(settings.exportImageQuality).toBe(0.8)
  })

  it('forces the extension to match the format, whatever the dialog returned', async () => {
    const m = mountModel()
    openTab()
    useSettingsStore().exportImageFormat = 'jpeg'
    // The save dialog is a text field: a user who leaves `.png` in it while
    // JPEG is selected would otherwise get a `.png` holding JPEG bytes — a file
    // that opens here and fails in the next program.
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.png')

    await m.exportImageFile()

    const [, name, , dir] = mocks.saveAttachment.mock.calls[0]!
    expect(name).toBe('alpha.jpg')
    expect(dir).toBe('notes')
  })

  it('names the image after the note and reports where it actually landed', async () => {
    const m = mountModel()
    openTab()
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.png')
    // `saveAttachment` deduplicates rather than overwrites, so the name on disk
    // is the one it returns, not the one that was asked for.
    mocks.saveAttachment.mockResolvedValue('notes/alpha-1.png')

    await m.exportImageFile()

    expect(mocks.flushEdits).toHaveBeenCalledTimes(1)
    expect(mocks.saveAttachment).toHaveBeenCalledWith('/vault', 'alpha.png', 'AAAA', 'notes')
    expect(mocks.announce).toHaveBeenCalledWith(expect.stringContaining('notes/alpha-1.png'))
  })

  it('saves an image the user put at the vault root INTO the vault root', async () => {
    const m = mountModel()
    openTab()
    // The dialog OPENS in the vault root (`pickSavePath` passes it as
    // `startDir`) and Save without navigating is its default answer, so this is
    // the ordinary case and not a corner: the user chose `/vault/alpha.png`.
    mocks.saveFileDialog.mockResolvedValue('/vault/alpha.png')
    // No directory part, so the gateway answers with the bare name.
    mocks.saveAttachment.mockResolvedValue('alpha.png')

    await m.exportImageFile()

    // Asserted on the argument rather than only through `toHaveBeenCalledWith`,
    // so a regression reads as `expected '' to be ':vault-root:'` — the defect
    // in one line. The literal is no lazier than the constant here: it is a
    // wire value the Rust side spells independently in `attachment_store`, so
    // this is the only place that can catch the two drifting apart.
    const [, name, , dir] = mocks.saveAttachment.mock.calls[0]!
    expect(name).toBe('alpha.png')
    // Before the fix this was `''`. Empty is not "the root" at either gateway
    // — it is "no directory was chosen" and gets the legacy layout — so the
    // dialog said `/vault` and the file was written to
    // `attachments/2026-09/alpha.png`: the destination the user did not pick,
    // with both gateways agreeing on it and only the toast admitting it.
    expect(dir).toBe(':vault-root:')
    expect(mocks.saveAttachment).toHaveBeenCalledWith('/vault', 'alpha.png', 'AAAA', VAULT_ROOT_DIR)
    // ...and the toast names the place the user chose: the path the gateway
    // returned (`alpha.png`), not the one the suite defaults to
    // (`notes/alpha.png`) and not a folder the user never opened.
    expect(mocks.announce).toHaveBeenCalledWith(expect.stringContaining('alpha.png'))
  })

  it('refuses an image over the vault\'s own size limit before shipping it', async () => {
    const m = mountModel()
    openTab()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.png')
    mocks.exportImage.mockResolvedValue({
      base64: '', mime: 'image/jpeg', width: 864, height: 40000, bytes: 11 * 1024 * 1024,
    })

    await m.exportImageFile()
    off()

    // The Rust side caps an attachment at 10 MiB. Saying so here means the user
    // reads a sentence about their image, not a backend error string.
    expect(mocks.saveAttachment).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('11')
  })

  it('writes plain text through the text writer, not the attachment path', async () => {
    const m = mountModel()
    openTab()
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.txt')

    await m.exportTextFile()

    expect(mocks.write).toHaveBeenCalledWith('/vault', '/vault/notes/alpha.txt', 'Alpha')
    expect(mocks.saveAttachment).not.toHaveBeenCalled()
  })

  it('says there is nothing to export when the note has no table', async () => {
    const m = mountModel()
    openTab()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.csv')
    mocks.renderCsv.mockResolvedValue(null)

    await m.exportCsvFile()
    off()

    // Writing an empty file and letting the user find out in Excel would be a
    // lie dressed as a success.
    expect(mocks.write).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
  })

  it('writes the csv when there is a table', async () => {
    const m = mountModel()
    openTab()
    mocks.saveFileDialog.mockResolvedValue('/vault/notes/alpha.csv')

    await m.exportCsvFile()

    expect(mocks.write).toHaveBeenCalledWith('/vault', '/vault/notes/alpha.csv', 'a,b\r\n1,2\r\n')
  })
})
