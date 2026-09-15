import { test, expect } from '@playwright/test'

/**
 * The mode switch has to hand over two things: the keyboard and the place the
 * user was reading.
 *
 * Browser-level on purpose. The unit suite runs without layout, so a write to a
 * pane that is still `display:none` (the flush that reveals it has not run yet)
 * looks fine there and lands nowhere in a real engine — that regression was
 * found by this file, not by the component tests.
 *
 * **Ask where the caret is with a keystroke, not with `window.getSelection()`.**
 * This file used to read the caret out of the DOM selection and reject an empty
 * `lineText`, on a recorded measurement that the caret "CARRIED TO THE END of
 * the document (line 242 of 242) — measured, not inferred". It was inferred, and
 * the inference was wrong: the assertion was red for 49 tasks over a defect the
 * app never had (task-108). `lineText` is `''` both for the empty last line AND
 * for a selection the DOM cannot place inside any `.cm-line`, and the second is
 * what this pane produces. Measured: the document's selection has
 * `anchorOffset: 0` on `.cm-content` itself with no `.cm-line` ancestor, while
 * CodeMirror's own selection is on a real line — the caret the switch carries is
 * written while the pane is not focused, and the document's selection describes
 * the browser's position rather than the editor's. Through that proxy the two
 * readings are indistinguishable, and the empty one was read for 49 tasks as the
 * end of the note.
 *
 * A keystroke cannot be misread that way: CodeMirror inserts at its own
 * selection, so where the text LANDS is where the caret was. Measured with this
 * fixture (rendered pane scrolled to `line 21 of the note`): the keystroke lands
 * on the line at the top of the source pane, between `line 21` and `line 22` —
 * the carried place, not the note's first line and not its last.
 */

const VAULT = 'test-fixtures'

/** Long enough that both panes have somewhere to be; the rendered pane is much
 *  taller than the source one, so the two positions cannot coincide. */
const BODY = Array.from({ length: 120 }, (_, i) => `line ${i + 1} of the note`).join('\n\n')
const NOTE = `# Welcome\n\n${BODY}\n`

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ vault, note }) => {
      localStorage.setItem('nekowite.vault', vault)
      const registry: Record<string, unknown> = {}
      let n = 0
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => {
          if (cmd === 'list_dir')
            return [{ name: 'welcome.md', path: `${vault}/welcome.md`, is_dir: false, is_mdx: true }]
          if (cmd === 'read_file') return note
          if (cmd === 'write_file') return undefined
          if (cmd === 'open_folder_dialog') return null
          if (cmd === 'watch_folder') return undefined
          if (cmd === 'plugin:event|listen') return ++n
          if (cmd === 'plugin:event|unlisten') return undefined
          return undefined
        },
        transformCallback: (cb: unknown, once?: boolean) => {
          registry[++n] = cb
          void once
          return n
        },
        unregisterCallback: (id: number) => {
          delete registry[id]
        },
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    },
    { vault: VAULT, note: NOTE },
  )
})

async function openNote(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')
  await page.locator('.nav-item', { hasText: '文件夹' }).click()
  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()
  await expect(page.locator('.pane.rendered .ProseMirror h1')).toHaveText('Welcome')
}

test('渲染 → 源码 keeps the place and hands over the keyboard', async ({ page }) => {
  await openNote(page)

  // Scroll the rendered pane well into the note, then switch the way a user
  // does: click the 源码 button (which leaves the focus on the button).
  await page.locator('.pane.rendered').evaluate((el) => {
    el.scrollTop = 900
  })
  await page.waitForTimeout(100)
  await page.locator('.switch-option', { hasText: '源码' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()
  await page.waitForTimeout(150)

  // The source pane is on the line the rendered pane was showing, not at its
  // own top — the whole complaint was landing at line 1 with the caret at 0.
  const sourceScrollTop = await page
    .locator('[data-testid="source-pane"] .cm-scroller')
    .evaluate((el) => Math.round(el.scrollTop))
  expect(sourceScrollTop).toBeGreaterThan(0)

  // And the keys go to the document: this is what "the first keystrokes are
  // swallowed" meant.
  await page.keyboard.type('X')
  await page.waitForTimeout(200)
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('X')

  // ...AND THEY GO TO THE PLACE THE READER WAS, which is what "keeps the place"
  // means. The keystroke is the only instrument that can answer WHERE: CodeMirror
  // inserts at its own selection, so where the text arrives IS where the caret
  // was when the mode changed.
  //
  // Two readings, and neither is the DOM selection (see this file's header for
  // why that one cannot answer this). The place: the inserted line is the one at
  // the top of the pane the user is looking at, which is where the
  // handoff put the carried line — a caret that had been carried from the
  // document's end would arrive hundreds of lines below this. The content: the
  // text around it is two consecutive paragraphs of the body, so it is not the
  // heading the note opens with and not the empty line it ends with, which are
  // the only two places a caret carried from a position nobody asked for can
  // land and still be near the top of something.
  const landing = await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="source-pane"] .cm-scroller')
    const text = document.querySelector('[data-testid="source-pane"] .cm-content')?.textContent ?? ''
    const at = text.indexOf('X')
    const marker = Array.from(scroller?.querySelectorAll('.cm-line') ?? []).find((line) =>
      line.textContent.includes('X'),
    )
    const markerRect = marker?.getBoundingClientRect()
    const viewportRect = scroller?.getBoundingClientRect()
    return {
      before: at < 0 ? '' : text.slice(0, at),
      after: at < 0 ? '' : text.slice(at + 1),
      // Where the inserted line sits relative to the top of the pane the reader
      // is looking at. One line of slack: the carried position is a fraction of
      // a line, so the line it floors onto can start up to a line above it.
      fromViewportTop:
        markerRect && viewportRect ? Math.round(markerRect.top - viewportRect.top) : null,
    }
  })
  expect(landing.fromViewportTop).not.toBeNull()
  expect(Math.abs(landing.fromViewportTop!)).toBeLessThan(30)
  const previous = /line (\d+) of the note$/.exec(landing.before)
  expect(previous).not.toBeNull()
  const following = /^line (\d+) of the note/.exec(landing.after)
  expect(following).not.toBeNull()
  expect(Number(following![1])).toBe(Number(previous![1]) + 1)
  expect(Number(previous![1])).toBeGreaterThan(1)
  expect(Number(previous![1])).toBeLessThan(120)
})

test('源码 → 渲染 keeps the place and hands over the keyboard', async ({ page }) => {
  await openNote(page)
  await page.locator('.switch-option', { hasText: '源码' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()
  await page.waitForTimeout(150)

  await page.locator('[data-testid="source-pane"] .cm-scroller').evaluate((el) => {
    el.scrollTop = 1200
  })
  await page.waitForTimeout(120)
  await page.locator('.switch-option', { hasText: '渲染' }).click()
  await expect(page.locator('.pane.rendered .ProseMirror')).toBeVisible()
  await page.waitForTimeout(200)

  // The rendered pane is showing the source line the user left, and it stays
  // there: the model is re-serialized on the way back, and a position the
  // rebuild wipes is no better than never writing one.
  const renderedScrollTop = await page.locator('.pane.rendered').evaluate((el) => Math.round(el.scrollTop))
  expect(renderedScrollTop).toBeGreaterThan(0)
  await page.waitForTimeout(250)
  expect(await page.locator('.pane.rendered').evaluate((el) => Math.round(el.scrollTop))).toBe(
    renderedScrollTop,
  )

  // The editor itself owns the keyboard: focus on the pane around it would leave
  // the first keystroke swallowed, which is the complaint this file was written
  // for, so "somewhere under .pane.rendered" cannot see it.
  const focused = await page.evaluate(
    () => !!document.activeElement?.classList.contains('ProseMirror'),
  )
  expect(focused).toBe(true)
})
