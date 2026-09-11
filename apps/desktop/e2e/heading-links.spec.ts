import { expect, test, type Page } from '@playwright/test'
import { openNote, showRendered } from './support/editorHarness'

/**
 * Heading deep links, end to end.
 *
 * Three consumers have to agree on the same id: the heading anchor that COPIES
 * a link, the exported HTML that must EXPOSE it, and the handler that SCROLLS
 * to it. When they disagreed, a copied link was either dead (the export emitted
 * no ids) or landed on the wrong heading (duplicate titles all copied the first
 * one's id).
 */

/** The link text every heading anchor copies, in document order. */
async function copyAllAnchors(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = []
    const mod = (await import(
      '/@fs/C:/Users/Lenovo/Documents/ChatGPT/NekoWrite/packages/editor-core/src/clipboard.ts'
    )) as unknown as { configureClipboardWriter(fn: ((t: string) => Promise<void>) | null): void }
    mod.configureClipboardWriter(async (text: string) => {
      out.push(text)
    })
    for (const anchor of Array.from(
      document.querySelectorAll<HTMLButtonElement>('.pane.rendered .nk-heading-anchor'),
    )) {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    }
    mod.configureClipboardWriter(null)
    return out
  })
}

/** Render the active document through the export renderer. */
function exportHtml(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const core = (await import(
      '/@fs/C:/Users/Lenovo/Documents/ChatGPT/NekoWrite/packages/editor-core/src/export/html.ts'
    )) as unknown as { renderDocument(md: string): string }
    const store = (await import('/src/stores/tabs.ts')) as unknown as {
      useTabsStore(): { activeTab: { content: string } | null }
    }
    return core.renderDocument(store.useTabsStore().activeTab?.content ?? '')
  })
}

const fragmentOf = (link: string): string => link.slice(link.lastIndexOf('#') + 1)

const DUPLICATES = '# Same\n\nbody\n\n# Same\n\nbody\n\n# Same\n'

test.describe('heading deep links', () => {
  test('duplicate headings copy distinct fragments', async ({ page }) => {
    await openNote(page, { doc: DUPLICATES })
    await showRendered(page)

    expect((await copyAllAnchors(page)).map(fragmentOf)).toEqual(['same', 'same-1', 'same-2'])
  })

  test('a copied link names the note once, not twice', async ({ page }) => {
    await openNote(page, { doc: DUPLICATES })
    await showRendered(page)

    const [link] = await copyAllAnchors(page)
    // The note path was joined onto the vault without normalising first, so the
    // vault appeared twice in every copied link.
    const note = 'welcome.md'
    const occurrences = link.split(note).length - 1
    expect(occurrences, `note named ${occurrences}x in ${link}`).toBe(1)
    expect(link).not.toContain('test-fixtures/test-fixtures')
  })

  test('the export exposes an id for every fragment an anchor copies', async ({ page }) => {
    await openNote(page, { doc: DUPLICATES })
    await showRendered(page)

    const fragments = (await copyAllAnchors(page)).map(fragmentOf)
    const html = await exportHtml(page)

    // The invariant that makes a copied link resolvable.
    for (const fragment of fragments) {
      expect(html, `export has no id for #${fragment}`).toContain(`id="${fragment}"`)
    }
  })

  test('following the last duplicate scrolls to that heading, not the first', async ({ page }) => {
    // Body text long enough that the later headings start off-screen.
    const filler = Array.from({ length: 40 }, (_v, i) => `para ${i}`).join('\n\n')
    // The link goes FIRST, so it is already in view at scroll 0. Clicking it must
    // not require Playwright's own scroll-into-view — otherwise the pane could
    // move for a reason that has nothing to do with the handler under test.
    await openNote(page, {
      doc: `[go](#same-2)\n\n# Same\n\n${filler}\n\n# Same\n\n${filler}\n\n# Same\n\n${filler}\n`,
    })
    await showRendered(page)

    const scroller = page.locator('.pane.rendered')
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0)

    // A real markdown link to the LAST heading's fragment — exactly what a
    // copied deep link looks like when pasted back into a note. Dispatched
    // directly so the assertion below can only be satisfied by the handler.
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('.pane.rendered .ProseMirror a')).find(
        (a) => a.textContent === 'go',
      ) as HTMLAnchorElement | undefined
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(250)

    // The third heading must be the topmost one in view. (Comparing the first
    // heading whose bottom is still below the pane's top is robust to the pane
    // bottoming out, which a stricter "near the top" window is not.)
    const landedIndex = await page.evaluate(() => {
      const headings = Array.from(
        document.querySelectorAll('.pane.rendered .nk-heading-content'),
      ) as HTMLElement[]
      const pane = document.querySelector('.pane.rendered') as HTMLElement
      const paneTop = pane.getBoundingClientRect().top
      return headings.findIndex((h) => h.getBoundingClientRect().bottom > paneTop + 4)
    })
    expect(landedIndex).toBe(2)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  })
})
