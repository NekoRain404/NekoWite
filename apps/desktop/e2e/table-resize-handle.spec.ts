import { test, expect } from '@playwright/test'

/**
 * Where the column-resize handle is DRAWN, which is not where it was.
 *
 * `.column-resize-handle` is a ProseMirror widget rendered inside the cell and
 * laid out at `right: -2px` (styles/renderedPane.css). That only means "on this
 * cell's right edge" if the cell is its containing block — and `th`/`td` were
 * `position: static`, so every column's handle resolved against
 * `.editor-container` instead: 4px wide, full height, stacked on the editor's
 * RIGHT edge whichever divider the pointer was on. Hovering a divider in the
 * middle of a table lit up the far side of the editor; the handle never moved.
 *
 * The unit suites cannot see this. happy-dom lays nothing out — every rect is
 * zero and `posAtCoords` has no coordinates — which is why
 * `usage-image-table.spec.ts` asserts only that the handle APPEARS, and why
 * that assertion was true while the handle was drawn 491 px from its divider.
 * So this file measures the handle against the divider it belongs to, in a real
 * browser, which is the only place the numbers exist.
 *
 * The same one-line cause had a second symptom, asserted at the end: a cell is
 * also the containing block for its own `.selectedCell::after` tint.
 */

const VAULT = 'test-fixtures'

const DOC = [
  '---',
  'title: Resize handle',
  '---',
  '',
  '# Resize handle',
  '',
  '| Alpha | Bravo | Charlie |',
  '| --- | --- | --- |',
  '| 111111 | 222222 | 333333 |',
  '| 444444 | 555555 | 666666 |',
].join('\n')

const FIXTURES = [{ name: 'handle.md', path: `${VAULT}/handle.md`, is_dir: false, is_mdx: true }]

/**
 * The handle sits `right: -2px` and is 4px wide, so its right edge lands about
 * 2px past the cell's own right edge. Anything under a few px is "on the
 * divider"; the defect measured 491, so the tolerance has room to be generous
 * and still fail.
 */
const ON_THE_DIVIDER_PX = 4

test('the column-resize handle is drawn on the divider the pointer is on', async ({ page }) => {
  await page.addInitScript(
    ({ vault, fixtures, doc }) => {
      localStorage.setItem('nekowite.vault', vault)
      localStorage.setItem('nekowite.locale', 'en')
      const registry: Record<string, unknown> = {}
      let n = 0
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          if (cmd === 'register_vault') return undefined
          if (cmd === 'list_dir') return String(args['path']) === '.tmp' ? [] : fixtures
          if (cmd === 'read_file') return String(args['path']).endsWith('handle.md') ? doc : ''
          if (cmd === 'stat_file') return { size: 1, mtime: 1 }
          if (cmd === 'write_file') return undefined
          if (cmd === 'delete_file') return 'trash/x'
          if (cmd === 'watch_folder') return undefined
          if (cmd === 'save_attachment') return 'attachments/x.png'
          if (cmd === 'resolve_media_path') return '/abs/x.png'
          if (cmd === 'create_dir') return 'attachments'
          if (cmd === 'list_history') return []
          if (cmd === 'open_folder_dialog') return null
          if (cmd === 'save_file_dialog') return `${vault}/untitled.md`
          if (cmd === 'plugin:event|listen') return ++n
          return undefined
        },
        transformCallback: (cb: unknown) => {
          registry[++n] = cb
          return n
        },
        unregisterCallback: () => {},
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    },
    { vault: VAULT, fixtures: FIXTURES, doc: DOC },
  )

  await page.goto('/')
  await page.locator('.nav-item', { hasText: 'Folders' }).click()
  await page.locator('.tree-name', { hasText: 'handle.md' }).click()

  const editor = page.locator('.pane.rendered .ProseMirror')
  const table = editor.locator('table').first()
  await expect(table).toBeVisible()
  await table.locator('td').first().click()

  /** The right edge of each header cell — the dividers, in the same order. */
  const dividers = await page.evaluate(() =>
    [...document.querySelectorAll('.pane.rendered .ProseMirror th')].map((c) =>
      Math.round(c.getBoundingClientRect().right),
    ),
  )
  expect(dividers.length).toBeGreaterThanOrEqual(3)

  const handleRights = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.column-resize-handle')].map((h) =>
        Math.round(h.getBoundingClientRect().right),
      ),
    )

  // The header row's vertical middle — inside the table, not above or below it.
  const headerY = await page.evaluate(() => {
    const r = document.querySelector('.pane.rendered .ProseMirror th')!.getBoundingClientRect()
    return Math.round(r.top + r.height / 2)
  })

  // Each divider in turn: the handle must land on THAT one. Asserting the move
  // rather than a single hover is what kills the old behaviour — there every
  // handle sat on the editor's right edge, so the highlight never moved at all.
  for (const divider of dividers.slice(0, -1)) {
    await page.mouse.move(divider, headerY)
    await page.waitForTimeout(150)

    const rights = await handleRights()
    expect(rights.length).toBeGreaterThan(0)
    for (const right of rights) {
      expect(
        Math.abs(right - divider),
        `a resize handle was drawn at x=${right} while the pointer was on the divider at x=${divider}`,
      ).toBeLessThanOrEqual(ON_THE_DIVIDER_PX)
    }
  }

  // And the editor's own right edge is not where it belongs: the old position.
  const containerRight = await page.evaluate(() =>
    Math.round(document.querySelector('.pane.rendered .editor-container')!.getBoundingClientRect().right),
  )
  await page.mouse.move(dividers[0], headerY)
  await page.waitForTimeout(150)
  const firstRights = await handleRights()
  await expect
    .poll(() => Math.abs(firstRights[0] - containerRight) > ON_THE_DIVIDER_PX)
    .toBe(true)
})

test('the cell-selection tint stays on the cells it belongs to', async ({ page }) => {
  // The same containing block, the other thing a cell positions: without it
  // `.selectedCell::after` covered `.editor-container` and selecting two cells
  // tinted the whole editor. Measured as the computed `position` of the cell,
  // because the tint is a pseudo-element and a rect is not readable from one;
  // `position: relative` on the cell is the single property both symptoms rest
  // on, and the one a future change would have to take away.
  await page.addInitScript(
    ({ vault, fixtures, doc }) => {
      localStorage.setItem('nekowite.vault', vault)
      localStorage.setItem('nekowite.locale', 'en')
      let n = 0
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          if (cmd === 'register_vault') return undefined
          if (cmd === 'list_dir') return String(args['path']) === '.tmp' ? [] : fixtures
          if (cmd === 'read_file') return String(args['path']).endsWith('handle.md') ? doc : ''
          if (cmd === 'stat_file') return { size: 1, mtime: 1 }
          if (cmd === 'write_file') return undefined
          if (cmd === 'delete_file') return 'trash/x'
          if (cmd === 'watch_folder') return undefined
          if (cmd === 'save_attachment') return 'attachments/x.png'
          if (cmd === 'resolve_media_path') return '/abs/x.png'
          if (cmd === 'create_dir') return 'attachments'
          if (cmd === 'list_history') return []
          if (cmd === 'open_folder_dialog') return null
          if (cmd === 'save_file_dialog') return `${vault}/untitled.md`
          if (cmd === 'plugin:event|listen') return ++n
          return undefined
        },
        transformCallback: () => ++n,
        unregisterCallback: () => {},
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    },
    { vault: VAULT, fixtures: FIXTURES, doc: DOC },
  )

  await page.goto('/')
  await page.locator('.nav-item', { hasText: 'Folders' }).click()
  await page.locator('.tree-name', { hasText: 'handle.md' }).click()

  const editor = page.locator('.pane.rendered .ProseMirror')
  await expect(editor.locator('table')).toBeVisible()

  // Drag across the first two data cells → a CellSelection.
  const first = (await editor.locator('td').nth(0).boundingBox())!
  const second = (await editor.locator('td').nth(1).boundingBox())!
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 5 })
  await page.mouse.up()

  const selected = page.locator('.pane.rendered .ProseMirror .selectedCell')
  await expect(selected.first()).toBeVisible()
  const positions = await page.evaluate(() =>
    [...document.querySelectorAll('.pane.rendered .ProseMirror .selectedCell')].map(
      (c) => getComputedStyle(c).position,
    ),
  )
  expect(positions.length).toBeGreaterThan(0)
  for (const position of positions) expect(position).toBe('relative')
})
