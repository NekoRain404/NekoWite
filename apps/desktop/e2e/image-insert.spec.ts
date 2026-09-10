import { expect, test } from '@playwright/test'
import {
  DEFAULT_DOC,
  dropImageFiles,
  focusParagraph,
  imageToolbarButton,
  modelMarkdown,
  openNote,
  pasteImage,
  pasteImageFiles,
  queuePick,
  showRendered,
  showSource,
  showSplit,
  sourceDoc,
  sourceText,
} from './support/editorHarness'

/**
 * Image intake and toolbar routing across the three view modes.
 *
 * All of these used to be rendered-pane-only: the source pane had no paste or
 * drop handler at all, and the image command inserted an empty-src node instead
 * of asking for a file. The toolbar also ran ProseMirror commands while the
 * smoke test's mode hid that editor, which silently edited the wrong document
 * and pulled focus out of the pane the user was typing in.
 */

const PICKED = { 'C:/pics/cat.png': 'QUJD' }

test.describe('image intake', () => {
  test('source mode: the insert-image button opens the picker and imports the file', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await queuePick(page, PICKED)

    await (await imageToolbarButton(page)).click()

    await expect.poll(() => sourceDoc(page)).toContain('![cat.png](welcome_assets/cat.png)')
    // The rendered model must not be touched: in source mode it is stale, and
    // writing to it would replace the raw Markdown on the way back.
    expect(await modelMarkdown(page)).not.toContain('cat.png')
  })

  test('rendered mode: the insert-image button opens the picker and imports the file', async ({ page }) => {
    await openNote(page)
    await queuePick(page, PICKED)

    await (await imageToolbarButton(page)).click()

    await expect.poll(() => modelMarkdown(page)).toContain('![cat.png](welcome_assets/cat.png)')
  })

  test('source mode: pasting an image inserts Markdown into the source text', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await pasteImage(page, 'clip.png')

    await expect.poll(() => sourceDoc(page)).toContain('![clip.png](')
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('![clip.png]')
  })

  test('source mode: dropping an image inserts Markdown into the source text', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await dropImageFiles(page, ['dropped.png'])

    const input = page.locator('.rename-dialog .input')
    await expect(input).toBeVisible()
    await input.fill('dropped.png')
    await page.locator('.rename-dialog .btn-primary').click()

    await expect.poll(() => sourceDoc(page)).toContain('![dropped.png](')
  })

  test('split mode: an image paste lands in the pane that has focus', async ({ page }) => {
    await openNote(page)
    await showSplit(page)

    // Focus the rendered pane: the insert belongs to the model.
    await focusParagraph(page, 0)
    await queuePick(page, PICKED)
    await (await imageToolbarButton(page)).click()
    await expect.poll(() => modelMarkdown(page)).toContain('cat.png')

    // Focus the CodeMirror pane: the same button must write Markdown instead.
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await queuePick(page, { 'C:/pics/dog.png': 'QUJD' })
    await (await imageToolbarButton(page)).click()
    await expect.poll(() => sourceDoc(page)).toContain('dog.png')
  })

  test('reports an import failure without changing the document', async ({ page }) => {
    await openNote(page, { importFails: true })
    await showSource(page)
    await queuePick(page, PICKED)

    await (await imageToolbarButton(page)).click()

    await expect(page.locator('.toast-stack .toast').first()).toBeVisible()
    expect(await sourceDoc(page)).toBe(DEFAULT_DOC)
  })
})

test.describe('source-mode toolbar commands', () => {
  test('bold edits the Markdown and leaves the caret in the source pane', async ({ page }) => {
    await openNote(page, { doc: 'hello\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+A')

    await page.getByRole('button', { name: '加粗' }).click()

    await expect.poll(() => sourceDoc(page)).toBe('**hello**\n')
    // The toolbar must not steal focus from the editor it just edited.
    const focused = await page.evaluate(() =>
      document.activeElement?.classList.contains('cm-content') ?? false,
    )
    expect(focused).toBe(true)
  })

  test('a heading command prefixes the source line', async ({ page }) => {
    await openNote(page, { doc: 'Title\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+A')

    // The heading menu opens from the H2 button and applies the chosen level.
    await page.getByRole('button', { name: '标题' }).click()
    await page.getByRole('button', { name: '标题 2' }).click()

    await expect.poll(() => sourceDoc(page)).toBe('## Title\n')
  })
})

test.describe('mode round trips', () => {
  test('text typed in source mode survives a trip through the rendered pane', async ({ page }) => {
    await openNote(page, { doc: 'alpha\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('beta  gamma')

    await expect.poll(() => sourceDoc(page)).toBe('alpha\nbeta  gamma')
    await expect.poll(() => sourceText(page)).toContain('beta  gamma')

    await showRendered(page)
    await showSource(page)

    // The exact typed text must come back, not a canonicalized rewrite. The
    // serializer appends one trailing newline to the file, which is expected.
    await expect
      .poll(async () => (await sourceDoc(page)).replace(/\n$/, ''))
      .toBe('alpha\nbeta  gamma')
    expect(await modelMarkdown(page)).toContain('beta  gamma')
  })

  test('an insert in source mode survives the same round trip', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await pasteImage(page, 'kept.png')
    await expect.poll(() => sourceDoc(page)).toContain('![kept.png](')

    await showRendered(page)
    await showSource(page)

    await expect.poll(() => sourceDoc(page)).toContain('![kept.png](')
  })
})
