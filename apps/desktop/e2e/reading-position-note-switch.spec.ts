import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/**
 * Does a note switch leave the rendered pane at the previous note's offset?
 *
 * `RenderedPane` is kept alive under `v-show`, so nothing the app does remounts
 * its scroll container when the document behind it changes. The audit that
 * raised this enumerated every writer of `.rendered-pane`'s `scrollTop` and
 * found none that runs on an `activeId` change; what it could not settle by
 * reading is whether the ENGINE resets the scroller when the content subtree is
 * replaced, which is the difference between a real defect and a void lead.
 *
 * So this file is a measurement first and an assertion second: it prints the
 * numbers it read, and its assertions are about which WORLD it is in. The
 * engine that ships is WebKitGTK, not this one — `e2e/webkit/probe-note-switch`
 * asks the same question there, with the same instrument.
 *
 * Three readings, because they are the three halves of the contract:
 *   - a note with NO remembered position (first visit this session) — the lead's
 *     case, where the honest answer is the top of the note;
 *   - a note WITH one (visited and left earlier) — the restore that already
 *     works and must keep winning;
 *   - and, for both, every program write the switch produced. An empty log
 *     during a switch is what says the offset was the ENGINE's rather than the
 *     app's, which no amount of reading could have told us.
 */

/** Long enough that a carried offset and a reset one are unmistakably different
 *  numbers, and that the arriving note can still hold the offset carried from
 *  the one being left (so "carried" is never disguised as "clamped"). */
const FIRST_DOC = Array.from({ length: 200 }, (_, i) => `first paragraph ${i + 1}`).join('\n\n') + '\n'
const SECOND_DOC = Array.from({ length: 320 }, (_, i) => `second paragraph ${i + 1}`).join('\n\n') + '\n'

const OFFSET = 2500
const SECOND_OFFSET = 6000

/** The source pane keeps its own scroller (CodeMirror's `.cm-scroller`), and in
 *  split mode it stays mounted across a note switch exactly as the rendered one
 *  does. The same question one pane over, so it is asked in the same file. */
function readSource(page: Page): Promise<{ top: number; range: number; firstLine: string }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="source-pane"] .cm-scroller') as HTMLElement | null
    const first = document.querySelector('[data-testid="source-pane"] .cm-line')?.textContent ?? ''
    return {
      top: el ? Math.round(el.scrollTop * 100) / 100 : -1,
      range: el ? el.scrollHeight - el.clientHeight : -1,
      firstLine: first,
    }
  })
}

/**
 * Record every PROGRAM write to the pane's `scrollTop`.
 *
 * The element keeps its own scroll offset, so an offset after the switch is
 * either a program write (this log names the writer) or the engine's own doing
 * (the log is empty, and the value survived the content swap untouched). The
 * prototype's accessor is called through, so the engine still scrolls and only
 * the writes are recorded.
 */
async function tapScrollWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('.rendered-pane') as HTMLElement | null
    if (!el) throw new Error('the rendered pane is not mounted')
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    const w = window as unknown as { __nkwWrites?: Array<{ value: number; stack: string }> }
    w.__nkwWrites = []
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => proto.get!.call(el) as number,
      set: (value: number) => {
        w.__nkwWrites!.push({
          value,
          stack: String(new Error().stack ?? '')
            .split('\n')
            .slice(1, 4)
            .join(' | '),
        })
        proto.set!.call(el, value)
      },
    })
  })
}

function takeWrites(page: Page): Promise<Array<{ value: number; stack: string }>> {
  return page.evaluate(() => {
    const w = window as unknown as { __nkwWrites?: Array<{ value: number; stack: string }> }
    const out = w.__nkwWrites ?? []
    w.__nkwWrites = []
    return out
  })
}

interface Reading {
  top: number
  range: number
  contentHeight: number
  firstParagraph: string
}

/** The rendered pane IS `.rendered-pane` (`EditorPane` adds `pane rendered` to
 *  it), so this reads the same element the audit enumerated writers for. */
function readRendered(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const el = document.querySelector('.rendered-pane') as HTMLElement | null
    const root = el?.querySelector('.ProseMirror') as HTMLElement | null
    return {
      top: el ? Math.round(el.scrollTop * 100) / 100 : -1,
      range: el ? el.scrollHeight - el.clientHeight : -1,
      contentHeight: root ? Math.round(root.getBoundingClientRect().height) : -1,
      firstParagraph: root?.querySelector('p')?.textContent ?? '',
    }
  })
}

/** Samples taken as a switch settles: a position that is only carried for one
 *  frame and then corrected is a different finding from one that stays. */
async function sample(
  page: Page,
  offsetsMs: number[],
): Promise<Array<{ afterMs: number } & Reading>> {
  const out: Array<{ afterMs: number } & Reading> = []
  let elapsed = 0
  for (const after of offsetsMs) {
    await page.waitForTimeout(after - elapsed)
    elapsed = after
    out.push({ afterMs: after, ...(await readRendered(page)) })
  }
  return out
}

test('a note opened for the first time starts at its own top', async ({ page }) => {
  await openNote(page, {
    doc: FIRST_DOC,
    files: { 'test-fixtures/second.md': SECOND_DOC },
  })
  await tapScrollWrites(page)

  const pane = page.locator('.rendered-pane')
  await pane.evaluate((el, top) => {
    el.scrollTop = top
  }, OFFSET)
  await page.waitForTimeout(200)

  const before = await readRendered(page)
  console.log(`[measure] before the switch: ${JSON.stringify(before)}`)
  expect(before.firstParagraph).toBe('first paragraph 1')
  expect(before.top).toBe(OFFSET)
  // The offset has to be small relative to both notes' extents, or a carried
  // reading and a clamped one would be the same number.
  expect(before.range).toBeGreaterThan(OFFSET * 2)

  // Click the other note in the tree, the way a user does.
  await takeWrites(page)
  await page.locator('.tree-name', { hasText: 'second.md' }).first().click()
  await expect(page.locator('.pane.rendered .ProseMirror p').first()).toHaveText(
    'second paragraph 1',
  )
  const carried = await sample(page, [0, 100, 300, 700, 1500])
  const switchWrites = await takeWrites(page)
  console.log(`[measure] after switching to a note with no remembered position: ${JSON.stringify(carried)}`)
  console.log(`[measure] program writes during that switch: ${JSON.stringify(switchWrites)}`)

  // The whole complaint: the arriving note is at the previous note's offset.
  // The content has swapped (asserted above) and the arriving note's own range
  // is far larger than 2500, so neither a stale document nor a clamp can
  // produce these numbers.
  for (const row of carried) expect(row.top).toBe(0)

  // Now move the second note somewhere ELSE, so the value it would carry back
  // and the value the first note remembers are different numbers. Without this
  // the two are 2500 either way and the reading below cannot tell a restore
  // from a carry — the proxy defect the task before this one was written from.
  await pane.evaluate((el, top) => {
    el.scrollTop = top
  }, SECOND_OFFSET)
  await page.waitForTimeout(200)
  expect((await readRendered(page)).top).toBe(SECOND_OFFSET)

  // Then go back to the first note, which now HAS a remembered position, and
  // was left at 2500. A carry would land on 6000.
  await takeWrites(page)
  await page.locator('.tree-name', { hasText: 'welcome.md' }).first().click()
  await expect(page.locator('.pane.rendered .ProseMirror p').first()).toHaveText(
    'first paragraph 1',
  )
  const restored = await sample(page, [0, 100, 300, 700, 1500])
  const restoreWrites = await takeWrites(page)
  console.log(`[measure] back to the first note (which remembers): ${JSON.stringify(restored)}`)
  console.log(`[measure] program writes during that switch: ${JSON.stringify(restoreWrites)}`)

  // The regression this fix must not cause: a note the reader HAS been in gets
  // the line they left it on. The carried value here is 6000, so a restore is
  // the only thing that can produce something else — and the write log names
  // it, which the offset alone cannot.
  for (const row of restored) expect(row.top).toBeLessThan(SECOND_OFFSET / 2)
  expect(restoreWrites).toHaveLength(1)
  expect(restoreWrites[0].stack).toContain('setScrollToLine')

  console.log(
    `[measure] summary: firstLeftAt=${OFFSET} firstRange=${before.range} ` +
      `carriedTop=${carried[carried.length - 1].top} arrivedRange=${carried[0].range} ` +
      `secondLeftAt=${SECOND_OFFSET} restoredTop=${restored[restored.length - 1].top} ` +
      `writesOnFirstSwitch=${switchWrites.length} writesOnReturn=${restoreWrites.length}`,
  )
})

test('the same switch, on the source pane, in split mode', async ({ page }) => {
  // Split as the configured DEFAULT, not as a click: `App.vue` puts the live
  // mode back to the default on every note switch, so a default of `rendered`
  // would unmount this pane on the way and reset it to the top by construction
  // — measuring the teardown rather than the carry.
  await page.addInitScript(() => localStorage.setItem('nekowite.view.defaultMode', 'split'))
  await openNote(page, {
    doc: FIRST_DOC,
    files: { 'test-fixtures/second.md': SECOND_DOC },
  })
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()

  const scroller = page.locator('[data-testid="source-pane"] .cm-scroller')
  await scroller.evaluate((el, top) => {
    el.scrollTop = top
  }, OFFSET)
  await page.waitForTimeout(200)
  const before = await readSource(page)
  console.log(`[measure] source pane before the switch: ${JSON.stringify(before)}`)
  // Not an equality: CodeMirror owns this scroller and snaps the offset it was
  // handed to its own line geometry, so the setup is asserted as "well down the
  // note" rather than as the exact number that was requested.
  expect(before.top).toBeGreaterThan(OFFSET / 2)
  expect(before.range).toBeGreaterThan(before.top * 2)

  await page.locator('.tree-name', { hasText: 'second.md' }).first().click()
  await expect(page.locator('.pane.rendered .ProseMirror p').first()).toHaveText(
    'second paragraph 1',
  )
  await page.waitForTimeout(700)
  const after = await readSource(page)
  console.log(`[measure] source pane after switching to a note with no remembered position: ${JSON.stringify(after)}`)

  // The other half of the finding, and the reason the fix is in the rendered
  // pane alone: CodeMirror resets its own scroller when the document is
  // replaced, so this pane never carried the defect. If that ever changes, this
  // is where it shows.
  expect(after.top).toBe(0)
  expect(after.firstLine).toBe('second paragraph 1')
})
