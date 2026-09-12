import { expect, test } from '@playwright/test'

// The rendered view draws the task checkbox with a pseudo-element (see
// editor-content.css), so the click target is the item's left padding. Before
// this spec existed, clicking that box did nothing at all: the only way to
// check a task off was to switch to the source view and retype `[ ]` as `[x]`.

import { NOTE_NAME, VAULT, diskFiles, openNote } from './support/editorHarness'

test.describe('task checkbox in the rendered view', () => {
  test('clicking the box toggles the task and the save writes [x]', async ({ page }) => {
    await openNote(page, { doc: '# Tasks\n\n- [ ] todo\n- [x] done\n' })

    const item = page.locator('.pane.rendered li[data-item-type="task"]').first()
    await expect(item).toHaveAttribute('data-checked', 'false')

    const box = await item.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + 4, box!.y + box!.height / 2)

    await expect(item).toHaveAttribute('data-checked', 'true')
    await page.keyboard.press('Control+s')
    await expect
      .poll(async () => (await diskFiles(page))[`${VAULT}/${NOTE_NAME}`])
      .toContain('- [x] todo')
  })

  test('clicking the text does not toggle the task', async ({ page }) => {
    await openNote(page, { doc: '# Tasks\n\n- [ ] todo\n' })

    const item = page.locator('.pane.rendered li[data-item-type="task"]').first()
    const box = await item.boundingBox()
    expect(box).not.toBeNull()
    // Well inside the text, past the checkbox column.
    await page.mouse.click(box!.x + box!.width - 10, box!.y + box!.height / 2)

    await expect(item).toHaveAttribute('data-checked', 'false')
  })
})