import { test, expect } from '@playwright/test'

/**
 * Real-usage E2E for docs/debug.md sections B (image) + C (table), carried in a
 * single document so the flows meet the same way they do in real notes.
 *
 * With the Tauri mock (list_dir/read_file returning a doc that carries
 * frontmatter + a GFM table + an image reference, save_attachment,
 * register_vault, watch_folder, resolve_media_path) the spec opens a note and
 * drives the rendered editor as a user would:
 *
 *  (a) selects the image (clicking the rendered figure) and opens the ImagePanel,
 *      edits the alt text, and closes the panel with Escape (focus flow);
 *  (b) clicks the table actions (toolbar) and inserts one row and one column;
 *  (c) edits a table cell with the keyboard.
 *
 * Assertions are against deterministic DOM state — row/cell counts, the image
 * wrapper's aria-label, the toolbar/panel visibility — never internal APIs.
 * The one interaction that cannot be driven natively (column-width mouse drag:
 * it needs real layout underneath `posAtCoords`) is asserted at the affordance
 * level (the handle that appears when a divider is hovered) instead of being
 * forced, matching the unit coverage in editor-core instead of duplicating it.
 */

const VAULT = 'test-fixtures'

const DOC = [
  '---',
  'title: Image and Table',
  '---',
  '',
  '# Note with table and image',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| one | 1 |',
  '| two | 2 |',
  '',
  '![pic](attachments/2026-09/pic.png){width=120}',
].join('\n')

const FIXTURES = [
  { name: 'image-table.md', path: `${VAULT}/image-table.md`, is_dir: false, is_mdx: true },
]

test('real usage: table + image doc — image panel, table row/col insert, cell edit', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))

  await page.addInitScript(
    ({ vault, fixtures, doc }) => {
      localStorage.setItem('nekowite.vault', vault)
      localStorage.setItem('nekowite.locale', 'en')
      const registry: Record<string, unknown> = {}
      let n = 0
      ;(window as unknown as { __saves: string[] }).__saves = []
      // The attachment write path is observable too (B1's save step): images
      // pasted/dropped go through save_attachment (the rename flow maps to it).
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          if (cmd === 'register_vault') return undefined
          // A `.tmp` dir scan at startup must come back empty: fixtures served
          // for every path would make the crash-recovery prompt appear and
          // overlay the editor (a real vault with no `.tmp` dir returns []/err).
          if (cmd === 'list_dir') return String(args['path']) === '.tmp' ? [] : fixtures
          if (cmd === 'read_file') return String(args['path']).endsWith('image-table.md') ? doc : ''
          if (cmd === 'stat_file') return { size: 1, mtime: 1 }
          if (cmd === 'write_file') {
            ;(window as unknown as { __saves: string[] }).__saves.push(String(args['path']))
            return undefined
          }
          if (cmd === 'delete_file') return 'trash/x'
          if (cmd === 'watch_folder') return undefined
          if (cmd === 'save_attachment') return 'attachments/2026-09/paste-x.png'
          if (cmd === 'resolve_media_path') return '/abs/vault/attachments/2026-09/pic.png'
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

  // Open the note from the folder tree.
  await page.locator('.nav-item', { hasText: 'Folders' }).click()
  await page.locator('.tree-name', { hasText: 'image-table.md' }).click()

  // A1 (frontmatter stripped from the model) + the body renders: h1 is visible.
  await expect(page.locator('.pane.rendered .ProseMirror h1')).toHaveText('Note with table and image')

  const editor = page.locator('.pane.rendered .ProseMirror')
  const table = editor.locator('table').first()
  await expect(table).toBeVisible()
  // C1 baseline: header row + two data rows (GFM keeps the header in the model).
  await expect(table.locator('tr')).toHaveCount(3)
  await expect(table.locator('th')).toHaveCount(2)

  // The image reference renders as the image node view (its src cannot load
  // under the package mock — the graceful error overlay is part of that view).
  const figure = editor.locator('figure.neko-image').first()
  await expect(figure).toBeVisible()

  // ---- (a) image: select -> ImagePanel opens, alt edit round-trips, Escape closes.
  // The failed-load error overlay (a sibling of the <img>) is the only region of
  // the figure that does not arm a resize drag, so click its message span: the
  // editor turns the click into a NodeSelection and the panel opens.
  await figure.locator('.neko-image-error-msg').click()
  const panel = page.locator('.neko-image-panel')
  await expect(panel).toBeVisible({ timeout: 5000 })
  await expect(panel).toHaveAttribute('aria-modal', 'false')

  // The panel shows the node's current attrs.
  const alt = page.locator('#neko-image-alt')
  await expect(alt).toHaveValue('pic')

  // Editing alt percolates to the document model and back into the node view —
  // and the panel must stay open across the write (B3: one field after another).
  await alt.fill('pic-from-panel')
  await expect(figure).toHaveAttribute('aria-label', 'pic-from-panel')
  await expect(alt).toBeVisible()
  await expect(panel).toBeVisible()

  // Escape closes the panel (its own keydown path, focus returns to the editor).
  await panel.press('Escape')
  await expect(panel).not.toBeVisible()

  // ---- (b) table actions: toolbar appears inside a table, inserts row + column.
  await table.locator('td').first().click()
  const menu = page.locator('.neko-table-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('role', 'toolbar')

  await menu.getByRole('button', { name: 'Add row below' }).click()
  await expect(table.locator('tr')).toHaveCount(4)
  // The toolbar stays live (cursor still in the table) — insert a column too.
  await menu.getByRole('button', { name: 'Add column right' }).click()
  await expect(table.locator('tr').first().locator('th')).toHaveCount(3)

  // ---- (c) cell editing: keyboard edit lands in the cell.
  const cell = table.locator('td', { hasText: 'one' }).first()
  await cell.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  await expect(cell).toHaveText('one edited')

  // The row/gesture work is committed into the model: saving (Ctrl+S) happens
  // through the real disk-write path of the mock.
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __saves: string[] }).__saves.length))
    .toBeGreaterThan(0)

  // C2 affordance: hovering a column divider arms the visual resize handle.
  // The drag itself cannot be driven reliably here (it needs the real layout
  // `posAtCoords` must measure; the commit/undo semantics are unit-covered in
  // editor-core table/ops+resize), so we assert the affordance is present.
  const firstHeader = table.locator('th').first()
  const box = await firstHeader.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width - 2, box!.y + box!.height / 2)
  await expect(page.locator('.column-resize-handle').first()).toBeVisible({ timeout: 5000 })

  // The earlier image deselection stuck: the figure is no longer selected.
  await expect(figure).toHaveAttribute('data-selected', 'false')

  expect(errs).toEqual([])
})
