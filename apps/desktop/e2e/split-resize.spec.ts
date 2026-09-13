import { expect, test, type Page } from '@playwright/test'
import { openNote, showSplit } from './support/editorHarness'

/**
 * The split divider is a ratio handle: `splitRatio` is 0..1 of the pane
 * container. Its drag has to scale the pointer delta by the track width, or a
 * single pixel of movement is a whole ratio unit and every drag snaps to a
 * bound — the divider only ever lands on one of two fixed positions.
 *
 * These cases drive real mouse input, so they cover the wiring in EditorPane as
 * well as the handle's arithmetic.
 */

interface Geometry {
  /** Source pane width divided by the pane container width. */
  ratio: number
  containerWidth: number
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const panes = document.querySelector('.panes') as HTMLElement | null
    const source = document.querySelector('.panes .pane.source') as HTMLElement | null
    return {
      ratio: panes && source ? source.getBoundingClientRect().width / panes.getBoundingClientRect().width : -1,
      containerWidth: panes ? panes.getBoundingClientRect().width : -1,
    }
  })
}

/** Grab the divider, move it `dx` pixels, release. */
async function dragDividerBy(page: Page, dx: number): Promise<void> {
  const handle = page.locator('.split-handle')
  await expect(handle).toBeVisible()
  const box = (await handle.boundingBox())!
  const y = box.y + box.height / 2
  const startX = box.x + box.width / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  // Several steps, like a real hand: the handle is guide-line based and commits
  // on release, so the intermediate moves must not corrupt the final value.
  await page.mouse.move(startX + dx / 2, y, { steps: 5 })
  await page.mouse.move(startX + dx, y, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(120)
}

test.describe('split divider drag', () => {
  test('moves proportionally to the pointer instead of snapping to a bound', async ({ page }) => {
    await openNote(page)
    await showSplit(page)

    const before = await geometry(page)
    expect(before.ratio).toBeGreaterThan(0.3)
    expect(before.ratio).toBeLessThan(0.7)

    const dx = 140
    await dragDividerBy(page, dx)

    const after = await geometry(page)
    // It moved right, but nowhere near the maximum: the bug clamped straight to
    // 0.85 on the first pixel of movement.
    expect(after.ratio).toBeGreaterThan(before.ratio + 0.05)
    expect(after.ratio).toBeLessThan(0.8)
    // And it followed the pointer, rather than taking a fixed size.
    const expected = before.ratio + dx / before.containerWidth
    expect(Math.abs(after.ratio - expected)).toBeLessThan(0.08)
  })

  test('drags back to the left as well', async ({ page }) => {
    await openNote(page)
    await showSplit(page)

    await dragDividerBy(page, 140)
    const widened = await geometry(page)
    await dragDividerBy(page, -220)

    const after = await geometry(page)
    expect(after.ratio).toBeLessThan(widened.ratio - 0.05)
    // Not pinned to the minimum either.
    expect(after.ratio).toBeGreaterThan(0.2)
  })

  test('still clamps at the extremes when dragged far past them', async ({ page }) => {
    await openNote(page)
    await showSplit(page)

    await dragDividerBy(page, 4000)
    const far = await geometry(page)
    expect(far.ratio).toBeGreaterThan(0.75)

    await dragDividerBy(page, -4000)
    const back = await geometry(page)
    expect(back.ratio).toBeLessThan(0.25)
  })

  test('double click restores the default split', async ({ page }) => {
    await openNote(page)
    await showSplit(page)
    await dragDividerBy(page, 200)
    expect((await geometry(page)).ratio).toBeGreaterThan(0.6)

    await page.locator('.split-handle').dblclick()
    await page.waitForTimeout(120)

    const restored = await geometry(page)
    expect(Math.abs(restored.ratio - 0.5)).toBeLessThan(0.08)
  })

  test('arrow keys nudge the divider by the configured step', async ({ page }) => {
    await openNote(page)
    await showSplit(page)
    const before = await geometry(page)

    await page.locator('.split-handle').focus()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(120)

    const after = await geometry(page)
    expect(after.ratio).toBeGreaterThan(before.ratio)
    // The split handle passes step=0.02, so one press is a small nudge rather
    // than a jump to the end of the range.
    expect(after.ratio - before.ratio).toBeLessThan(0.1)
  })
})
