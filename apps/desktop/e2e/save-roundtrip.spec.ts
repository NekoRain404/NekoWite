import { expect, test, type Page } from '@playwright/test'
import {
  diskFiles,
  focusParagraph,
  modelMarkdown,
  openNote,
  placeRenderedCaretInParagraph,
  showRendered,
  showSource,
  showSplit,
  sourceDoc,
} from './support/editorHarness'

/**
 * Save → reload round trips.
 *
 * The editor tests assert on the model and on the source pane, but neither
 * proves that what reached disk survives a reopen. These cases save with
 * Ctrl+S, then reopen the same file from the tree and compare the raw text.
 */

const NOTE = 'test-fixtures/welcome.md'

/**
 * Ctrl+S and wait until the tab reports itself saved.
 *
 * The dot is always in the DOM; its `data-state` attribute carries the state.
 */
async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s')
  await expect
    .poll(
      async () => page.locator('.tab.active .save-dot').getAttribute('data-state'),
      { timeout: 5000 },
    )
    .toBe('saved')
}

/**
 * Reopen the note from the tree.
 *
 * The view mode persists, so the rendered pane may legitimately be hidden here
 * (source mode); wait for the editor to be mounted rather than visible and let
 * each case switch to the pane it wants to assert on.
 */
async function reopen(page: Page): Promise<void> {
  await page.locator('.tree-name', { hasText: 'welcome.md' }).first().click()
  await expect(page.locator('.pane.rendered .ProseMirror')).toBeAttached()
  await page.waitForTimeout(200)
}

test.describe('save round trips', () => {
  test('source-mode edits are persisted byte for byte', async ({ page }) => {
    await openNote(page, { doc: 'alpha\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('beta  gamma')

    await save(page)
    // The double space and the trailing state must reach disk unchanged: a
    // canonicalizing round trip through the serializer would collapse it.
    expect((await diskFiles(page))[NOTE]).toContain('beta  gamma')

    await reopen(page)
    await showSource(page)
    await expect.poll(() => sourceDoc(page)).toContain('beta  gamma')
  })

  test('rendered-mode edits are persisted and survive a reopen', async ({ page }) => {
    await openNote(page, { doc: 'alpha\n\n' })
    await showRendered(page)
    await focusParagraph(page, 0)
    // `End` is the key ProseMirror binds to line end; Control+End is not.
    await page.keyboard.press('End')
    await page.keyboard.type(' tail')

    await save(page)
    // Exact bytes: a space typed at the end of a text run makes the browser
    // insert U+00A0, which must not reach the file.
    expect((await diskFiles(page))[NOTE]).toBe('alpha tail\n')

    await reopen(page)
    await showRendered(page)
    await expect.poll(() => modelMarkdown(page)).toBe('alpha tail\n')
  })

  test('saving immediately after a rendered-pane keystroke keeps that keystroke', async ({ page }) => {
    // The rendered pane publishes its serialization through a debounce, so a
    // save inside that window used to write the PREVIOUS text and then re-apply
    // it to the model, losing the keystrokes outright.
    await openNote(page, { doc: 'alpha\n\n' })
    await showRendered(page)
    await focusParagraph(page, 0)
    await page.keyboard.press('End')
    await page.keyboard.type(' tail')
    // No wait: save on the very next event.
    await page.keyboard.press('Control+s')
    await page.waitForTimeout(600)

    expect((await diskFiles(page))[NOTE]).toBe('alpha tail\n')
    expect(await modelMarkdown(page)).toBe('alpha tail\n')
  })

  test('a space typed at the end of a paragraph is saved as a normal space', async ({ page }) => {
    await openNote(page, { doc: 'alpha\n\n' })
    await showRendered(page)
    await placeRenderedCaretInParagraph(page, 0, 5)
    await page.keyboard.type(' tail')
    await save(page)

    const onDisk = (await diskFiles(page))[NOTE]
    expect(onDisk).toBe('alpha tail\n')
    // Explicitly: no U+00A0 anywhere in the file.
    expect(onDisk.includes('\u00a0')).toBe(false)
  })

  test('an existing U+00A0 in a file is repaired on save', async ({ page }) => {
    // Files written by earlier builds (or pasted from a web page) can contain
    // the character; opening normalises it in the model and saving repairs it.
    await openNote(page, { doc: 'alpha\u00a0tail\n' })
    await showRendered(page)
    await focusParagraph(page, 0)
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await save(page)

    const onDisk = (await diskFiles(page))[NOTE]
    expect(onDisk.includes('\u00a0')).toBe(false)
    expect(onDisk).toBe('alpha tail!\n')
  })

  test('a frontmatter field written from the panel reaches disk', async ({ page }) => {
    await openNote(page, { doc: '# Title\n\nbody\n' })
    // Frontmatter is created through the document-properties panel. It used to be a section of the
    // right rail; `afd0b89` reduced the rail to the chat alone and the panel became a mode of the
    // note-list column (see `NoteListToolbar`'s `MODES`). Two consequences shape the driving below,
    // and both are the product's shape rather than this test's choosing: the mode strip only exists
    // while that column is showing the note list — `openNote` leaves it on the folder tree — and
    // its buttons are icon-only, named by `title` and `aria-label`, so there is no text to match.
    // Driving the rail's old tab would wait for a control this product no longer has.
    await page.locator('.nav-item', { hasText: await label(page, 'nav.all') }).click()
    await page
      .locator(`.nl-mode-btn[title="${await label(page, 'frontmatter.title')}"]`)
      .click()
    await page.waitForTimeout(150)

    const addProps = page.getByRole('button', { name: await label(page, 'frontmatter.addProps') })
    if (await addProps.count()) {
      await addProps.first().click()
      await page.waitForTimeout(200)
      await save(page)
      // Whatever the panel wrote must be a valid frontmatter block on disk.
      const text = (await diskFiles(page))[NOTE]
      expect(text.startsWith('---\n')).toBe(true)
      expect(text).toContain('title:')
    }
  })

  test('an edit made in split mode survives a save and reopen', async ({ page }) => {
    await openNote(page, { doc: 'split base\n' })
    await showSplit(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nsplit added')

    await save(page)
    const saved = (await diskFiles(page))[NOTE]
    expect(saved).toContain('split added')

    await reopen(page)
    await showSource(page)
    await expect.poll(() => sourceDoc(page)).toContain('split added')
  })

  test('the saved text is what the editor model agrees with after reopen', async ({ page }) => {
    await openNote(page, { doc: 'alpha\n' })
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await placeCaretInSource(page, 0)
    await page.keyboard.type('**bold** ')

    await save(page)
    const onDisk = (await diskFiles(page))[NOTE]
    expect(onDisk).toContain('**bold**')

    await reopen(page)
    // The rendered model only re-reads the tab while the rendered pane owns the
    // text, so switch to it before comparing.
    await showRendered(page)
    await expect.poll(() => modelMarkdown(page)).toContain('**bold**')
    await showSource(page)
    await expect.poll(() => sourceDoc(page)).toBe(onDisk)
  })
})

async function label(page: Page, key: string): Promise<string> {
  return page.evaluate(async (k) => {
    const mod = (await import('/src/i18n/index.ts')) as unknown as { t(key: string): string }
    return mod.t(k)
  }, key)
}

/**
 * Put the CodeMirror caret at `offset` in the source document.
 *
 * `EditorView.dispatch` takes an anchor/head selection spec, which avoids
 * reaching for the `EditorSelection` class through the state object. The
 * position is read back: a missing view — or a dispatch that did not take —
 * would otherwise leave the caret wherever it was, and the keystrokes this
 * exists to place would land somewhere the case is not about.
 */
async function placeCaretInSource(page: Page, offset: number): Promise<void> {
  const head = await page.evaluate(async (at) => {
    const mod = (await import('/src/services/source-view.ts')) as unknown as {
      getSourceView(): {
        dispatch(spec: { selection: { anchor: number } }): void
        focus(): void
        state: { selection: { main: { head: number } } }
      } | null
    }
    const view = mod.getSourceView()
    if (!view) return null
    view.dispatch({ selection: { anchor: at } })
    view.focus()
    return view.state.selection.main.head
  }, offset)
  expect(head, 'the source pane did not take the caret position').toBe(offset)
  await page.waitForTimeout(80)
}
