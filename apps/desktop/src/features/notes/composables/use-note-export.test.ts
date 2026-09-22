/**
 * The export commands, and the one note they are about.
 *
 * `useNoteExport` is the boundary where "export" stops meaning the active tab:
 * the path arrives from the menu that was opened on a note, and everything — the
 * read, the attachment and citation resolution, the default file name — is
 * resolved against that path. The wrong-note export this prevents is not
 * observable from the settings dialog's own tests, and until this file existed
 * the composable had no test at all: `docs/test-plan.md` §3 named it, and named
 * PDF export as covered only through the print frame's lifecycle.
 *
 * The decisions pinned here are all in the composable, so `readTargetContent` is
 * mocked: it has its own tests, and what it does with a tab is a different
 * question from what this module hands it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onNotify } from '../../../services/errors'
import { exportBaseName } from '../../../services/export-name'
import type { ExportUiOptions } from '../../../services/export'
import type { NoteActionDeps, NoteActionTarget } from '../../../services/note-actions'
import { t } from '../../../i18n'
import { useNoteExport, type UseNoteExportOptions } from './use-note-export'

/**
 * The mocks carry their real signatures and their implementations take no
 * arguments: `@typescript-eslint/no-unused-vars` (flat/recommended) reports
 * every unused parameter when there is no later used one, so the `_name`
 * convention this repository uses elsewhere cannot help a mock whose parameters
 * are all ignored — the signature is what the call sites are checked against.
 */
const read = vi.hoisted(() => vi.fn<(vault: string, path: string) => Promise<string>>(async () => ''))
const saveDialog = vi.hoisted(() =>
  vi.fn<(name: string, dir?: string) => Promise<string | null>>(async () => null),
)
const html = vi.hoisted(() =>
  vi.fn<(source: string, vault: string, savePath: string, opts: ExportUiOptions) => Promise<void>>(async () => {}),
)
const pdf = vi.hoisted(() =>
  vi.fn<(source: string, opts: ExportUiOptions) => Promise<{ outcome: Promise<string> }>>(async () => ({
    outcome: Promise.resolve('printed'),
  })),
)
const readTarget = vi.hoisted(() =>
  vi.fn<(deps: NoteActionDeps, vault: string | null, target: NoteActionTarget) => Promise<string>>(async () => ''),
)

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: { read, saveFileDialog: saveDialog },
}))

vi.mock('../../../services/export', () => ({
  exportHtml: html,
  exportToPdf: pdf,
}))

vi.mock('../../../services/note-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/note-actions')>()),
  readTargetContent: readTarget,
}))

const VAULT = '/vault'
const PATH = '/vault/notes/a.md'
const DESTINATION = '/vault/out/a.html'
/** A native dialog may aim anywhere; the backend's write may not follow it. */
const OUTSIDE = '/home/user/Desktop/a.html'

/** Everything the app reported to the user, in order. */
const reported: string[] = []
let stopListening: (() => void) | null = null

function model(overrides: Partial<UseNoteExportOptions> = {}) {
  return useNoteExport({
    vault: () => VAULT,
    findTab: () => null,
    openTab: async () => {},
    refs: () => [{ key: 'smith2020', title: 'A paper', authors: ['Smith'], year: '2020', type: 'article' }],
    ...overrides,
  })
}

beforeEach(() => {
  reported.length = 0
  stopListening = onNotify((message) => reported.push(message))
  read.mockClear()
  saveDialog.mockReset().mockResolvedValue(DESTINATION)
  html.mockReset().mockResolvedValue(undefined)
  pdf.mockReset().mockResolvedValue({ outcome: Promise.resolve('printed') })
  readTarget.mockReset().mockResolvedValue('# A\n\nbody')
})

afterEach(() => {
  stopListening?.()
  stopListening = null
})

describe('exporting the note the menu was opened on', () => {
  it('offers the target note’s own name, and nothing is read if the dialog is cancelled', async () => {
    saveDialog.mockResolvedValue(null)
    await model().exportHtml(PATH)

    expect(saveDialog).toHaveBeenCalledWith('a.html', VAULT)
    // The dialog comes first on purpose: a cancelled save is a decision with no
    // side effects, so nothing was read, written or said.
    expect(readTarget).not.toHaveBeenCalled()
    expect(html).not.toHaveBeenCalled()
    expect(reported).toEqual([])
  })

  it('refuses a destination outside the vault before reading the note', async () => {
    saveDialog.mockResolvedValue(OUTSIDE)
    await model().exportHtml(PATH)

    // Without this the backend rejects the write with "path escapes vault", and
    // the user sees the menu item do nothing at all behind the closed dialog.
    expect(reported).toEqual([t('error.exportOutsideVault')])
    expect(readTarget).not.toHaveBeenCalled()
    expect(html).not.toHaveBeenCalled()
  })

  it('hands the pipeline the target’s path, its text and the citation library', async () => {
    readTarget.mockResolvedValue('# A\n\nbody')
    await model().exportHtml(PATH)

    expect(readTarget).toHaveBeenCalledTimes(1)
    expect(readTarget.mock.calls[0][1]).toBe(VAULT)
    expect(readTarget.mock.calls[0][2]).toMatchObject({ path: PATH })
    expect(html).toHaveBeenCalledTimes(1)
    const [source, vault, savePath, options] = html.mock.calls[0]
    expect(source).toBe('# A\n\nbody')
    expect(vault).toBe(VAULT)
    expect(savePath).toBe(DESTINATION)
    expect(options).toMatchObject({ title: exportBaseName(PATH), notePath: PATH })
    // The same map the settings dialog exports with, so a cited `[@key]` renders
    // identically whichever route the note leaves by.
    const refs = (options as { refs: Map<string, unknown> }).refs
    expect(refs.get('smith2020')).toBeTruthy()
  })

  it('speaks when the read fails, instead of looking like a menu item that did nothing', async () => {
    const failure = new Error('the note is gone')
    readTarget.mockRejectedValue(failure)
    await model().exportHtml(PATH)

    expect(html).not.toHaveBeenCalled()
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('the note is gone')
  })

  it('maps the write’s own vault refusal to the message the user already knows', async () => {
    // The up-front check cannot see a symlink or a `..` the backend canonicalizes
    // into an escape, so the write can still refuse; that refusal has its own
    // wording rather than a raw "path escapes vault".
    html.mockRejectedValue(new Error('path escapes vault'))
    await model().exportHtml(PATH)

    expect(reported).toEqual([t('error.exportOutsideVault')])
  })

  it('prints the target without asking for a destination', async () => {
    readTarget.mockResolvedValue('# A\n\nbody')
    await model().exportPdf(PATH)

    expect(saveDialog).not.toHaveBeenCalled()
    expect(pdf).toHaveBeenCalledTimes(1)
    const [source, options] = pdf.mock.calls[0]
    expect(source).toBe('# A\n\nbody')
    expect(options).toMatchObject({ notePath: PATH, title: exportBaseName(PATH) })
  })

  it('speaks when printing fails', async () => {
    pdf.mockRejectedValue(new Error('the print frame never loaded'))
    await model().exportPdf(PATH)

    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('the print frame never loaded')
  })

  it('speaks when the webview never started a print, and says what still works', async () => {
    // Measured on WebKitGTK 2.52.6: `window.print()` returns, no dialog appears
    // and nothing is thrown, so without this the menu item closes and the page is
    // unchanged. `docs/DOC-AUDIT.md` §4 kept this unverified for two rounds.
    pdf.mockResolvedValue({ outcome: Promise.resolve('no-print-started') })
    await model().exportPdf(PATH)

    expect(reported).toEqual([t('error.exportNoPrintDialog')])
  })

  it('says nothing extra when the print did start', async () => {
    // The control for the case above: the same call, the same wiring, one value
    // different — so the notice is the outcome's doing and not this path's.
    pdf.mockResolvedValue({ outcome: Promise.resolve('printed') })
    await model().exportPdf(PATH)

    expect(reported).toEqual([])
  })

  it('with no vault open, offers the dialog without a directory and skips the vault check', async () => {
    // Not reachable from the UI — the menu that calls this needs a vault to have
    // a note to act on. Pinned so the missing `vault` cannot silently become a
    // *passing* check: `isPathWithinVault(anything, '')` is false, so guarding on
    // the vault here would refuse every export rather than allow one.
    saveDialog.mockResolvedValue(OUTSIDE)
    await model({ vault: () => null }).exportHtml(PATH)

    expect(saveDialog).toHaveBeenCalledWith('a.html', undefined)
    expect(html).toHaveBeenCalledWith('# A\n\nbody', '', OUTSIDE, expect.objectContaining({ notePath: PATH }))
    expect(reported).toEqual([])
  })
})
