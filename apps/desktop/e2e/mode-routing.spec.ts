import { expect, test } from '@playwright/test'
import {
  modelMarkdown,
  openNote,
  showRendered,
  showSource,
  showSplit,
  sourceDoc,
} from './support/editorHarness'

/**
 * Every command entry point has to reach the pane that owns the document.
 *
 * The toolbar buttons, the plugin/registry buttons and the command palette all
 * used to dispatch straight into the rendered editor. In source mode that model
 * is hidden and stale, so the edit was invisible and then discarded when the
 * model was re-opened from the tab.
 */

/** The label of a command, resolved through the app's own i18n. */
async function label(page: import('@playwright/test').Page, key: string): Promise<string> {
  return page.evaluate(async (k) => {
    const mod = (await import('/src/i18n/index.ts')) as unknown as { t(key: string): string }
    return mod.t(k)
  }, key)
}

/** Open the command palette, filter to `query` and run the first match. */
async function runFromPalette(page: import('@playwright/test').Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox')
  await expect(input).toBeVisible()
  await input.fill(query)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('combobox')).toHaveCount(0)
}

test.describe('command palette routing', () => {
  test('a formatting command edits the source text in source mode', async ({ page }) => {
    await openNote(page, { doc: 'hello\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+a')

    await runFromPalette(page, await label(page, 'command.quote'))

    await expect.poll(() => sourceDoc(page)).toBe('> hello\n')
    // The rendered model must be untouched: it is stale while CodeMirror owns
    // the text, and writing to it would later overwrite the raw Markdown.
    expect(await modelMarkdown(page)).not.toContain('> hello')
  })

  test('a formatting command still edits the model in rendered mode', async ({ page }) => {
    await openNote(page, { doc: 'hello\n\n' })
    await showRendered(page)
    await page.locator('.pane.rendered .ProseMirror p').first().click()
    await page.keyboard.press('Control+a')

    await runFromPalette(page, await label(page, 'command.quote'))

    await expect.poll(() => modelMarkdown(page)).toContain('> hello')
  })
})

test.describe('plugin command routing', () => {
  test('the math button writes a math block into the source text', async ({ page }) => {
    await openNote(page, { doc: 'body\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()

    await page.locator('.toolbar-btn[data-command-id="math.insert"]').click()

    await expect.poll(() => sourceDoc(page)).toContain('$$')
    // Rendered as a display-math block, not an inline pair.
    expect(await sourceDoc(page)).toContain('$$\n\n$$')
  })

  test('the table button asks for a size in source mode, and writes that table', async ({ page }) => {
    // It used to write a fixed 3×3 with no question asked — the same button
    // meaning two different things in two view modes, and no way for the reader
    // to say how big the table was. There is no grid to insert into here, but
    // "how many rows and columns" still has an answer the reader has to give,
    // and it is the same dialog the rendered pane raises.
    await openNote(page, { doc: 'body\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()

    await page.locator('.toolbar-btn[data-command-id="table.insert"]').click()

    // Nothing is written before the reader answers.
    const dialog = page.locator('.table-dialog')
    await expect(dialog).toBeVisible()
    expect(await sourceDoc(page)).toBe('body\n')

    // Two columns, the way a reader would ask for them.
    const steps = page.locator('.table-dialog-stepper')
    await steps.nth(1).locator('button').nth(1).click()
    await page.locator('.table-dialog-actions button.primary').click()
    await expect(dialog).toHaveCount(0)

    await expect.poll(() => sourceDoc(page)).toContain('| a | b |')
    expect(await sourceDoc(page)).toContain('| - | - |')
  })

  test('a cancelled size dialog inserts nothing', async ({ page }) => {
    // The old fixed template was a default the reader never chose. Cancelling
    // has to mean "no table", or the dialog is decoration.
    await openNote(page, { doc: 'body\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()

    await page.locator('.toolbar-btn[data-command-id="table.insert"]').click()
    await expect(page.locator('.table-dialog')).toBeVisible()
    await page.locator('.table-dialog-actions button').first().click()
    await expect(page.locator('.table-dialog')).toHaveCount(0)

    expect(await sourceDoc(page)).toBe('body\n')
  })

  test('the callout button writes JSX source into the source text', async ({ page }) => {
    await openNote(page, { doc: 'body\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()

    await page.locator('.toolbar-btn[title="插入 Callout"]').click()

    await expect.poll(() => sourceDoc(page)).toContain('<Callout')
    expect(await sourceDoc(page)).toContain('type="info"')
  })

  test('the same callout button still inserts a node in rendered mode', async ({ page }) => {
    await openNote(page, { doc: 'body\n' })
    await showRendered(page)
    await page.locator('.pane.rendered .ProseMirror').click()

    await page.locator('.toolbar-btn[title="插入 Callout"]').click()

    await expect.poll(() => modelMarkdown(page)).toContain('<Callout')
  })

  test('a source-mode table insert survives a round trip through the preview', async ({ page }) => {
    await openNote(page, { doc: 'body\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.locator('.toolbar-btn[data-command-id="table.insert"]').click()
    await expect(page.locator('.table-dialog')).toBeVisible()
    await page.locator('.table-dialog-actions button.primary').click()
    await expect.poll(() => sourceDoc(page)).toContain('| a | b | c |')

    await showRendered(page)
    await showSource(page)

    await expect.poll(() => sourceDoc(page)).toContain('| a | b | c |')
    // The preview parses it as a real table rather than literal pipes.
    await showRendered(page)
    await expect(page.locator('.pane.rendered .ProseMirror table')).toHaveCount(1)
  })
})

test.describe('split-mode command routing', () => {
  // Split mode is a live two-way preview: the pane the user last worked in is
  // the author, and the tab mirrors its result. Each step below therefore
  // starts from a state the other pane did not produce, so the direction the
  // command took is unambiguous.
  test('the palette targets the pane the user last worked in', async ({ page }) => {
    await openNote(page, { doc: 'alpha\n' })
    await showSplit(page)

    // Work in the preview: the command edits the model, which the split view
    // then mirrors back into the Markdown.
    await page.locator('.pane.rendered .ProseMirror p').first().click()
    await page.keyboard.press('Control+a')
    await runFromPalette(page, await label(page, 'command.quote'))
    await expect.poll(() => modelMarkdown(page)).toContain('> alpha')
    await expect.poll(() => sourceDoc(page)).toBe('> alpha\n')

    // Now work in the CodeMirror pane: the same command toggles the quote off
    // in the source text. Opening the palette moved focus to its input, so this
    // also covers the case the DOM alone cannot answer.
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+a')
    await runFromPalette(page, await label(page, 'command.quote'))
    await expect.poll(() => sourceDoc(page)).toBe('alpha\n')
  })
})
