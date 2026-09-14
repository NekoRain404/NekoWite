import { test, expect } from '@playwright/test'

/**
 * The mode switch has to hand over two things: the keyboard and the place the
 * user was reading.
 *
 * Browser-level on purpose. The unit suite runs without layout, so a write to a
 * pane that is still `display:none` (the flush that reveals it has not run yet)
 * looks fine there and lands nowhere in a real engine — that regression was
 * found by this file, not by the component tests.
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

  const caret = await page.evaluate(() => {
    const content = document.querySelector('[data-testid="source-pane"] .cm-content')
    const selection = window.getSelection()
    const line = selection?.anchorNode?.parentElement?.closest('.cm-line')
    return {
      inSource: !!(content && selection && content.contains(selection.anchorNode)),
      lineText: line?.textContent ?? '',
    }
  })
  expect(caret.inSource).toBe(true)
  // On a line from the middle of the note, not the heading it starts with.
  // LEFT RED ON PURPOSE (task-59 report §3): it fails deterministically on this
  // tree, with the caret CARRIED TO THE END of the document (line 242 of 242,
  // the empty last line, because this fixture ends in a newline) while the
  // viewport lands on the mapped line and the keyboard does arrive — measured,
  // not inferred. Whether that carry is the contract or the bug is brief 61's
  // call; the assertion is untouched so the signal survives.
  expect(caret.lineText).not.toBe('')
  expect(caret.lineText).not.toContain('Welcome')

  // And the keys go to the document: this is what "the first keystrokes are
  // swallowed" meant.
  await page.keyboard.type('X')
  await page.waitForTimeout(200)
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('X')
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
