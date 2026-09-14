import { expect, test, type Page } from '@playwright/test'
import { openNote, showSplit } from './support/editorHarness'

/**
 * Split-mode scroll synchronisation, in a real browser.
 *
 * Every unit test for this feature runs in happy-dom with faked geometry, where
 * `scrollTop` stores exactly the value it is given. A real engine does not: it
 * SNAPS an accepted offset — Chromium keeps a requested `500.5` as `501`. So a
 * pane that records the offset it ASKED for and compares the live offset
 * against it with a half-pixel tolerance sits exactly on the boundary at every
 * half-pixel target: the program's own echo reads as a scroll the user made,
 * the sync flips direction, and the pane the user is holding is yanked away
 * from where their own input left it. The happy-dom suites cannot see that
 * class of bug at all, so these cases drive the panes with real input and
 * assert the cross-pane offsets after the ease has explicitly settled.
 *
 * Two cases, because they cover different halves of the problem:
 *   - a real wheel in one pane, asserting the counterpart reaches the mapped
 *     offset and that the pair then stays put (the general case);
 *   - a scroll constructed to put the counterpart on an exact half-pixel
 *     boundary, which is the one place the old tolerance-based echo check
 *     failed, asserting the held pane is never written to (the regression).
 */

/**
 * 101 paragraphs — 201 source lines, no headings.
 *
 * Without headings the panes map by the ratio of their own scroll ranges (see
 * `renderedTopFor`/`sourceTopFor` in EditorPane.vue), and line 101 of 201 is
 * exactly half of the document: the boundary case below can then be
 * constructed rather than searched for.
 */
const FLAT_DOC = Array.from({ length: 101 }, (_, i) => `paragraph ${i + 1}`).join('\n\n') + '\n'

/** Line of the document's middle paragraph (paragraph 51 of 101). */
const MIDDLE_LINE = 101

interface PaneScroll {
  source: number
  rendered: number
  sourceRange: number
  renderedRange: number
}

/**
 * Both panes' offsets and ranges, read from the elements the app itself reads:
 * `SourcePane` scrolls CodeMirror's `.cm-scroller`, and the rendered pane is
 * its own scroll container.
 *
 * Each pane's trailing space is subtracted from the range, because that is the
 * range the app reports to the sync: the space is the PANEL's (80 % of its own
 * height, so the last line can be raised off the bottom edge), not the
 * document's, and the two panes lay the document out at different heights — a
 * pad folded into both ranges is what would misalign them. The pad is read from
 * the CSS variable the pane sets (`--nkw-tail-space`), so this follows the app
 * rather than restating it.
 */
function readPanes(page: Page): Promise<PaneScroll> {
  return page.evaluate(() => {
    const source = document.querySelector('.pane.source .cm-scroller') as HTMLElement | null
    const rendered = document.querySelector('.pane.rendered') as HTMLElement | null
    // Each pane writes the pad on its own content box: the rendered pane on
    // `.editor-container`, the source pane on its root. Read from there rather
    // than by walking up from the scroller (`.pane.rendered` carries an inline
    // width, so an ancestor walk would find the pane's own style attribute and
    // read no pad at all).
    const padOf = (selector: string): number => {
      const holder = document.querySelector(selector) as HTMLElement | null
      const raw = holder?.style.getPropertyValue('--nkw-tail-space') ?? ''
      return Number.parseFloat(raw) || 0
    }
    const sourcePad = padOf('.pane.source')
    const renderedPad = padOf('.pane.rendered .editor-container')
    const rangeOf = (el: HTMLElement | null, pad: number): number =>
      el ? Math.max(0, el.scrollHeight - el.clientHeight - pad) : -1
    return {
      source: source?.scrollTop ?? -1,
      rendered: rendered?.scrollTop ?? -1,
      sourceRange: rangeOf(source, sourcePad),
      renderedRange: rangeOf(rendered, renderedPad),
    }
  })
}

/**
 * Wait until neither pane has moved for eight consecutive reads.
 *
 * The ease is 100ms and writes a new offset every frame, so ~1/4s of complete
 * stillness is the pair having arrived. Every assertion that follows then reads
 * a settled position instead of racing the glide.
 */
async function waitForScrollSettle(page: Page): Promise<void> {
  let previous = ''
  let stable = 0
  await expect
    .poll(
      async () => {
        const sample = JSON.stringify(await readPanes(page))
        stable = sample === previous ? stable + 1 : 0
        previous = sample
        return stable
      },
      { timeout: 10000, intervals: [30] },
    )
    .toBeGreaterThanOrEqual(8)
}

/**
 * Wheel over a pane until its own scroll has actually moved.
 *
 * A synthetic wheel can be dropped under load. The retry only re-sends input —
 * it never changes what is asserted, because every expectation below is
 * computed from the position the pane ends up in.
 */
async function wheelPane(page: Page, selector: string, deltaY: number): Promise<void> {
  const pane = selector.includes('source') ? 'source' : 'rendered'
  await page.locator(selector).hover()
  const before = (await readPanes(page))[pane]
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(120)
    if ((await readPanes(page))[pane] !== before) return
  }
  throw new Error(`a wheel of ${deltaY}px never reached ${selector}`)
}

/**
 * The offset the engine KEEPS for a requested one, measured on a scratch
 * scroller.
 *
 * Measuring it keeps the case engine-agnostic: the assertion is "the pane sits
 * where the engine put the offset that was asked for", not a hard-coded
 * Chromium rounding. It is also what proves the case is a boundary at all — on
 * an engine that kept the fraction, the requested and kept offsets would be
 * equal and the case would prove nothing.
 */
function keptOffset(page: Page, requested: number): Promise<number> {
  return page.evaluate((value) => {
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:absolute;top:-9999px;left:0;width:40px;height:40px;overflow:auto'
    const inner = document.createElement('div')
    inner.style.cssText = 'width:10px;height:5000px'
    probe.appendChild(inner)
    document.body.appendChild(probe)
    probe.scrollTop = value
    const kept = probe.scrollTop
    probe.remove()
    return kept
  }, requested)
}

/** The markdown the source pane holds, as the app parses it for the mapping. */
async function sourceText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const mod = (await import('/src/services/source-view.ts')) as unknown as {
      getSourceView(): { state: { doc: { toString(): string } } } | null
    }
    return mod.getSourceView()?.state.doc.toString() ?? ''
  })
}

/**
 * The document's line count by the app's own rule
 * (`countDocumentLines` in `services/scrollSyncAnchors.ts`): a closing line
 * break terminates the last line rather than opening an empty one.
 */
function countLines(text: string): number {
  const lines = text.split(/\r\n|\n|\r/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/**
 * Put the source pane at the very top of `line`, the way a user's own scroll
 * would leave it, and report what the app can see from there: the offset the
 * engine kept, the 1-based line now at the top of the pane, and the document's
 * line count.
 *
 * The scroll goes through the pane's real element and the browser's own scroll
 * event — the pane cannot tell it apart from a wheel's.
 */
async function scrollSourceToLine(
  page: Page,
  line: number,
): Promise<{ offset: number; line: number }> {
  return page.evaluate(async (target) => {
    const mod = (await import('/src/services/source-view.ts')) as unknown as {
      getSourceView(): {
        state: { doc: { line(n: number): { from: number }; lineAt(pos: number): { number: number } } }
        lineBlockAt(pos: number): { top: number }
        lineBlockAtHeight(height: number): { from: number }
        scrollDOM: HTMLElement
        requestMeasure(): void
      } | null
    }
    const view = mod.getSourceView()
    if (!view) throw new Error('the source pane has no CodeMirror view')
    view.requestMeasure()
    const scroller = view.scrollDOM
    // One pixel into the block: both this pane and the app read the line at
    // `scrollTop + 1`, and landing exactly on a block's boundary can resolve to
    // the line above it.
    const top = view.lineBlockAt(view.state.doc.line(target).from).top
    scroller.scrollTop = Math.ceil(top) + 1
    scroller.dispatchEvent(new Event('scroll'))
    const visible = view.lineBlockAtHeight(Math.max(0, scroller.scrollTop + 1)).from
    return { offset: scroller.scrollTop, line: view.state.doc.lineAt(visible).number }
  }, line)
}

/**
 * Give the rendered pane an ODD scroll range.
 *
 * A one-pixel viewport change moves the pane's client height by one and leaves
 * its content height alone (the width, and so the wrapping, is unchanged),
 * which flips the range's parity. Half of an odd range is an exact `.5`.
 */
async function makeRenderedRangeOdd(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
  for (let step = 0; step < 6; step += 1) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height - step })
    await page.waitForTimeout(150)
    await waitForScrollSettle(page)
    if ((await readPanes(page)).renderedRange % 2 === 1) return
  }
  throw new Error('could not give the rendered pane an odd scroll range')
}

test.describe('split scroll sync', () => {
  test('a wheel in the rendered pane brings the source pane to the mapped offset', async ({
    page,
  }) => {
    await openNote(page, { doc: FLAT_DOC })
    await showSplit(page)
    await waitForScrollSettle(page)

    const start = await readPanes(page)
    expect(start.sourceRange).toBeGreaterThan(1000)
    expect(start.renderedRange).toBeGreaterThan(1000)

    await wheelPane(page, '.pane.rendered', 300)
    await waitForScrollSettle(page)

    const afterFirst = await readPanes(page)
    // The wheel really moved the pane, and away from both of its ends: a pane
    // sitting on its own edge is carried to the counterpart's edge instead of
    // through the mapping, which is a different case.
    expect(afterFirst.rendered).toBeGreaterThan(1)
    expect(afterFirst.rendered).toBeLessThan(afterFirst.renderedRange - 1)

    // No headings in this document, so the rendered offset is carried onto the
    // source pane by the ratio of the two ranges. A whole pixel of slack for
    // the engine's snap of the fractional target; the ratio being wrong at all
    // (the drift the anchors exist to fix, or a pane that never moved) is far
    // larger than that.
    const expectedSource =
      (afterFirst.rendered / afterFirst.renderedRange) * afterFirst.sourceRange
    expect(Math.abs(afterFirst.source - expectedSource)).toBeLessThanOrEqual(1)

    // The user scrolls again. A pane left stuck by a swallowed event, or an
    // echo that flipped the sync, would fail to follow this one.
    await wheelPane(page, '.pane.rendered', 300)
    await waitForScrollSettle(page)

    const afterSecond = await readPanes(page)
    expect(afterSecond.rendered).toBeGreaterThan(afterFirst.rendered)
    expect(afterSecond.rendered).toBeLessThan(afterSecond.renderedRange - 1)
    const expectedSecond =
      (afterSecond.rendered / afterSecond.renderedRange) * afterSecond.sourceRange
    expect(Math.abs(afterSecond.source - expectedSecond)).toBeLessThanOrEqual(1)

    // And then nothing keeps moving: an echo loop that had survived the inputs
    // above would still be writing offsets here.
    await page.waitForTimeout(400)
    expect(await readPanes(page)).toEqual(afterSecond)
  })

  test('a scroll onto a half-pixel boundary does not feed its echo back as user input', async ({
    page,
  }) => {
    await openNote(page, { doc: FLAT_DOC })
    await showSplit(page)
    await makeRenderedRangeOdd(page)

    const before = await readPanes(page)
    expect(before.renderedRange % 2).toBe(1)
    expect(before.rendered).toBe(0)

    // A user scroll that leaves the middle paragraph's line at the top of the
    // source pane.
    const placed = await scrollSourceToLine(page, MIDDLE_LINE)
    expect(placed.line).toBe(MIDDLE_LINE)

    // The offset that scroll asks the rendered pane to take: the line's place
    // in the document carried onto the rendered pane's range. Half of an odd
    // range, so the request is an exact `.5`.
    const lines = countLines(await sourceText(page))
    const expected = ((placed.line - 1) / (lines - 1)) * before.renderedRange
    expect(expected % 1).toBe(0.5)

    const kept = await keptOffset(page, expected)
    // The engine moved the half pixel: requested and kept differ, which is what
    // makes this the boundary the tolerance sat on.
    expect(kept).not.toBe(expected)

    await waitForScrollSettle(page)
    const settled = await readPanes(page)

    // The counterpart followed, landing exactly where the engine put the
    // requested offset.
    expect(settled.rendered).toBe(kept)
    // And the pane the user scrolled was never written by the program: the echo
    // of the write above arriving as a user scroll would flip the sync and drag
    // this pane toward the rendered pane's own ratio position, hundreds of
    // pixels away.
    expect(settled.source).toBe(placed.offset)

    // Nothing keeps moving either.
    await page.waitForTimeout(400)
    expect(await readPanes(page)).toEqual(settled)
  })
})
