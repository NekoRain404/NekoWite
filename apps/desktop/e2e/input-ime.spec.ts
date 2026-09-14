import { test, expect, type Page } from '@playwright/test'
import {
  openNote,
  showSource,
  showRendered,
  sourceCaret,
  renderedTexts,
  sourceCaretToEnd,
  modelMarkdown,
  placeRenderedCaretInParagraph,
  waitForRenderedCaretSettle,
} from './support/editorHarness'

// Input-method (IME) and non-latin input coverage.
//
// Chinese / Japanese / Korean users type through a composition session: the
// IME owns the keystrokes, shows an inline pre-edit string, and finally commits
// the chosen text with a `compositionend`/`insertText` pair. An editor that
// treats every keystroke as a direct edit, or that rebuilds its DOM mid-
// composition, drops or reorders the committed text and moves the caret.
//
// There is no real IME in a headless browser, so these tests replay the
// browser events an IME produces. `keyboard.insertText` is Chromium's own
// "commit this composed string" path (the insertText path the source suite
// already exercises); `Input.imeSetComposition` drives the real composition
// machinery through the CDP.

/** The rendered DOM can hold NBSPs where the model holds plain spaces. */
function normaliseSpaces(text: string | undefined): string {
  return (text ?? '').replace(/\u00a0/g, ' ')
}

/**
 * End of the first paragraph of `DEFAULT_DOC` (`alpha  one`, 10 characters).
 *
 * The three composition tests below park the caret here before committing, and
 * they used to reach it the way a user would: click the paragraph, press End.
 * That is not where the caret ends up under load, and the failure it produces
 * is indistinguishable from the app eating the text — so the position is set
 * through the model instead (see `placeRenderedCaretInParagraph`).
 */
const FIRST_PARAGRAPH_END = 'alpha  one'.length

/** Let the browser process `count` animation frames. A fixed sleep loses its
 *  meaning under parallel load; two frames are what "the browser has painted
 *  the composition state" actually requires. */
async function nextFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n
        const step = (): void => {
          left -= 1
          if (left <= 0) resolve()
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    count,
  )
}

/** Wait until the model has stopped changing, so an assertion runs after the
 *  editor applied the commit rather than after an arbitrary delay. */
async function settleModel(page: Page): Promise<void> {
  let previous = '\u0000'
  let stable = 0
  for (let i = 0; i < 60; i += 1) {
    const md = await modelMarkdown(page)
    stable = md === previous ? stable + 1 : 0
    previous = md
    if (stable >= 2) return
    await nextFrames(page, 1)
  }
}

/** Drive a full composition session through the CDP and commit `text`. */
async function composeAndCommit(page: Page, preedit: string, committed: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: preedit,
    selectionStart: preedit.length,
    selectionEnd: preedit.length,
  })
  await nextFrames(page)
  await cdp.send('Input.insertText', { text: committed })
  await settleModel(page)
  await cdp.detach()
}

test.describe('rendered pane - IME composition', () => {
  test('a committed CJK syllable lands once, in order, without moving earlier text', async ({ page }) => {
    await openNote(page)
    // Park the caret after "alpha" through the model: the position is what this
    // test is built on, and reaching it by click-then-arrow is a chain of input
    // events that can drop one under load.
    await placeRenderedCaretInParagraph(page, 0, 5)

    // Type latin first so a caret reset would be obvious in the model.
    await page.keyboard.type('ab')
    await page.keyboard.insertText('中文')
    await page.keyboard.type('cd')
    await waitForRenderedCaretSettle(page)

    const texts = await renderedTexts(page)
    // The spell-check overlay wraps words in spans and renders the spaces
    // between them as non-breaking, so the DOM text is normalised before the
    // comparison; the model keeps the plain spaces.
    expect(normaliseSpaces(texts[1])).toBe('alphaab中文cd  one')
  })

  test('composition pre-edit followed by commit produces exactly one copy', async ({ page }) => {
    await openNote(page)
    // Park the caret through the model. Reaching it by click-then-End used to
    // send the commit into `gamma    three` — the paragraph the editor's own
    // caret sits in on open — while this test read `texts[1]`, which then failed
    // with the pre-commit text and read as "the CJK commit was dropped". It was
    // not: it was one paragraph down. See FIRST_PARAGRAPH_END.
    await placeRenderedCaretInParagraph(page, 0, FIRST_PARAGRAPH_END)
    await composeAndCommit(page, 'zhongwen', '中文测试')

    const texts = await renderedTexts(page)
    // The pre-edit must not be left behind next to the committed text.
    expect(texts[1]).toBe('alpha  one中文测试')
    expect(texts[1]).not.toContain('zhongwen')
  })

  test('repeated commits accumulate at the caret instead of replacing the line', async ({ page }) => {
    await openNote(page)
    await placeRenderedCaretInParagraph(page, 0, FIRST_PARAGRAPH_END)

    for (const chunk of ['你好', '世界', '测试']) {
      await composeAndCommit(page, chunk, chunk)
    }

    const texts = await renderedTexts(page)
    expect(texts[1]).toBe('alpha  one你好世界测试')
  })

  test('a newline committed through a composition splits the paragraph', async ({ page }) => {
    await openNote(page)
    await placeRenderedCaretInParagraph(page, 0, FIRST_PARAGRAPH_END)

    await page.keyboard.insertText('\n')
    await page.waitForTimeout(150)
    await page.keyboard.insertText('second line')
    await waitForRenderedCaretSettle(page)

    const texts = await renderedTexts(page)
    expect(texts[1]).toBe('alpha  one')
    expect(texts[2]).toBe('second line')
  })

  test('CJK typed into the source pane keeps the caret monotonic', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)

    const start = await sourceCaret(page)
    let previous = start.column
    for (const ch of '这是一段中文测试') {
      await page.keyboard.insertText(ch)
      const caret = await sourceCaret(page)
      expect(caret.line).toBe(start.line)
      expect(caret.column).toBeGreaterThan(previous)
      previous = caret.column
    }
  })

  test('the committed text survives a round trip through rendered mode', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    await page.keyboard.insertText('中文标记')
    await page.waitForTimeout(250)

    await showRendered(page)
    await waitForRenderedCaretSettle(page)
    const texts = await renderedTexts(page)
    expect(texts[texts.length - 1]).toContain('中文标记')
    expect(await modelMarkdown(page)).toContain('中文标记')
  })
})
