/**
 * Surface motion: does every surface that arrives also leave, and can anything
 * be clicked through while it is on its way out?
 *
 * The instrument is the one this programme already paid for once (brief 62's
 * drawer bug), and it is three things at every frame of a transition:
 *
 *   - `getComputedStyle(el).opacity`, which says what the stylesheet asked for;
 *   - `document.elementFromPoint` at the surface's own centre, which says what
 *     the user actually gets — computed opacity cannot see a neighbour painting
 *     over the surface, and that is exactly how the sidebar's fade went missing
 *     while every value in it was correct;
 *   - the frame delta, so a stutter is never mistaken for a curve.
 *
 * "Rendered" is `display !== 'none'` on a box with a non-zero area. It is not
 * "in the document": a `v-show` panel stays in the document for the whole run
 * and is gone from the screen in one frame, and calling that "present for
 * 900ms" is the mistake the traces below exist to avoid.
 *
 * Run through `scripts/run-e2e.mjs` (it reserves its own port; 1420 is the
 * user's):
 *
 *   NEKOWITE_MOTION_OUT=/tmp/motion-before.json node scripts/run-e2e.mjs motion-surfaces
 */
import { test, expect, type Page } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { imageToolbarButton, openNote, queuePick, showSource } from './support/editorHarness'

const OUT = process.env.NEKOWITE_MOTION_OUT

/** One frame of a trace. */
interface Frame {
  t: number
  dt: number
  /** `display !== none` on a box with area: what the user can see. */
  rendered: boolean
  opacity?: number
  display?: string
  visibility?: string
  position?: string
  pointerEvents?: string
  left?: number
  right?: number
  width?: number
  cx?: number
  cy?: number
  /** The class of the topmost element at the surface's own centre — the element
   *  a click there would land on. `elementFromPoint`, so it honours
   *  `pointer-events` and it sees a neighbour painting over the surface. */
  atop?: string | null
  /** Whether that topmost element is outside the surface. */
  covered?: boolean | null
  /** The first four elements in paint order at that point, topmost first, and
   *  where the surface itself sits in that stack (-1 when it is not in it).
   *  `elementFromPoint` honours `pointer-events`, so it cannot answer "is this
   *  surface painted over" once the leaver stops taking the pointer; this can. */
  stack?: string[]
  depth?: number
  /** Whether hit testing could place the surface at its own centre at all.
   *  False means the reading below is *unmeasurable*, not that it is clear. */
  inStack?: boolean
  /** The first element in the paint order above this surface that is neither
   *  the surface, nor inside it, nor one of its ancestors — which is the only
   *  thing that counts as "painted over". Descendants legitimately come first
   *  in `elementsFromPoint`, and ancestors legitimately come after. */
  occluder?: string | null
}

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Two functions, not one: `elementsFromPoint` yields Elements and can never
    // yield null, so a nullable signature there would put a `null` in a name
    // that no surface can actually have. `atop` is the one reading that can be
    // null — its point may fall outside the viewport — and it means "no
    // reading", never "a surface called null".
    const name = (el: Element): string => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''
      return cls || el.tagName.toLowerCase()
    }
    const label = (el: Element | null): string | null => (el ? name(el) : null)
    ;(window as unknown as Record<string, unknown>).__probe = (
      selector: string,
      ms: number,
      occlusion = false,
      clampTo = '',
    ) =>
      new Promise<Frame[]>((resolve) => {
        const frames: Frame[] = []
        const t0 = performance.now()
        let last = t0
        const tick = (now: number): void => {
          const el = document.querySelector(selector)
          const frame: Frame = {
            t: Math.round(now - t0),
            dt: Math.round((now - last) * 10) / 10,
            rendered: false,
          }
          last = now
          if (el && occlusion) {
            // Paint order with the interactivity guards lifted. `elementsFromPoint`
            // is hit testing, so a leaver that has been made `inert` or
            // `pointer-events: none` is not in its answer at all — and "is this
            // surface painted over by something later in the DOM" is a question
            // about paint order, which is what is left once both guards are
            // taken off. Nothing else about the run is changed.
            ;(el as HTMLElement).inert = false
            ;(el as HTMLElement).style.pointerEvents = 'auto'
          }
          if (el) {
            const cs = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            frame.display = cs.display
            frame.visibility = cs.visibility
            frame.position = cs.position
            frame.pointerEvents = cs.pointerEvents
            frame.opacity = Math.round(Number(cs.opacity) * 1000) / 1000
            frame.left = Math.round(r.left)
            frame.right = Math.round(r.right)
            frame.width = Math.round(r.width)
            frame.rendered =
              cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
            if (frame.rendered) {
              let px = r.left + r.width / 2
              let py = r.top + r.height / 2
              // A box can be larger than the scroll container it is clipped by,
              // and `getBoundingClientRect` reports the unclipped box: sampling
              // its centre would then land outside the dialog entirely and
              // measure the scrim instead of the surface.
              const clip = clampTo ? document.querySelector(clampTo)?.getBoundingClientRect() : null
              if (clip) {
                px = Math.min(Math.max(px, clip.left + 8), clip.right - 8)
                py = Math.min(Math.max(py, clip.top + 8), clip.bottom - 8)
              }
              const cx = Math.round(px)
              const cy = Math.round(py)
              const inside = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight
              const atop = inside ? document.elementFromPoint(cx, cy) : null
              frame.cx = cx
              frame.cy = cy
              frame.atop = label(atop)
              frame.covered = atop ? !el.contains(atop) : null
              const stack = inside ? document.elementsFromPoint(cx, cy) : []
              frame.stack = stack.slice(0, 4).map(name)
              frame.depth = stack.indexOf(el)
              // Over the *whole* stack, not the display slice: a surface deep
              // inside its ancestors sits far down the array, and searching a
              // four-element window for it finds nothing and then reports the
              // element that happened to be first as an occluder.
              // `indexOf` fails when the surface is not in the stack at all,
              // and that is the *normal* case once it takes no pointer:
              // `elementsFromPoint` is hit testing, so a leaver the app has
              // made `pointer-events: none` is simply not in its answer, and
              // falling back to the whole stack would report whatever happened
              // to be first as an occluder. Absent means "not measurable here",
              // which is not the same reading as "nothing is over it".
              const at = stack.indexOf(el)
              const foreign =
                at === -1
                  ? null
                  : stack.slice(0, at).find((other) => !el.contains(other) && !other.contains(el))
              frame.inStack = at !== -1
              frame.occluder = foreign ? name(foreign) : null
            }
          }
          frames.push(frame)
          if (now - t0 < ms) requestAnimationFrame(tick)
          else resolve(frames)
        }
        requestAnimationFrame(tick)
      })
  })
}

/** The dev server can still hand the page a full reload of its own (Vite's
 *  dependency optimiser, which is not the watcher the frozen config switches
 *  off). A reload replaces `window` and the sampler with it, so it is checked
 *  for immediately before each trace rather than assumed to have survived. */
async function ensureProbe(page: Page): Promise<void> {
  const present = await page.evaluate(
    () => typeof (window as unknown as Record<string, unknown>).__probe === 'function',
  )
  if (!present) await installProbe(page)
}

/** Starts the sampler; the returned thunk resolves with the trace. */
function probe(
  page: Page,
  selector: string,
  ms: number,
  occlusion = false,
  clampTo = '',
): () => Promise<Frame[]> {
  const running = page.evaluate(
    ([sel, duration, paintOrderOnly, clip]) =>
      (
        window as unknown as {
          __probe: (s: string, m: number, o?: boolean, c?: string) => Promise<Frame[]>
        }
      ).__probe(sel, duration, paintOrderOnly, clip),
    [selector, ms, occlusion, clampTo] as [string, number, boolean, string],
  )
  return () => running
}

interface Trace {
  label: string
  frames: Frame[]
}

const traces: Trace[] = []

test.afterAll(() => {
  if (OUT && traces.length) {
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, JSON.stringify(traces, null, 2))
  }
})

/** The frames in which the surface can actually be seen, plus the two after the
 *  last one — the disappearance is the half being measured. */
function window_(frames: Frame[]): Frame[] {
  const last = frames.reduce((acc, f, i) => (f.rendered ? i : acc), -1)
  return frames.slice(0, Math.min(frames.length, last + 3))
}

/**
 * The frames in which the surface is part-way out — visible, and neither fully
 * opaque nor fully transparent.
 *
 * This is the whole difference between a departure and a cut, and it is what
 * the `v-if` hosts produced none of: measured on the settings dialog before its
 * `<Transition>` existed, the last frame it was rendered in read `opacity 1`
 * and the node was gone on the next one, after an arrival of 460ms. A surface
 * removed in one frame has no such frame, so this is false for it and true for
 * every one that fades.
 */
function fadedOut(frames: Frame[]): boolean {
  const seen = frames.filter((f) => f.rendered && f.opacity !== undefined)
  // Intermediate *and* on the way down: a trace that also contains the arrival
  // passes through the middle on the way up, and counting that would make the
  // assertion true of a surface that fades in and is then cut.
  return seen.some(
    (f, i) =>
      f.opacity! > 0.05 &&
      f.opacity! < 0.95 &&
      seen.slice(i + 1).some((later) => later.opacity! < f.opacity!),
  )
}

/** How many frames of the exit the surface spent taking no pointer at all. */
function untouched(frames: Frame[]): number {
  return frames.filter((f) => f.rendered && f.pointerEvents === 'none').length
}

function report(label: string, frames: Frame[]): void {
  const seen = window_(frames)
  const rendered = seen.filter((f) => f.rendered)
  const dts = seen.slice(1).map((f) => f.dt).sort((a, b) => a - b)
  const line = (f: Frame): string => {
    if (!f.rendered) return `  t${f.t} GONE (dt ${f.dt})`
    const bits = [`op ${f.opacity}`, `${f.display}`, f.position === 'static' ? 'static' : f.position]
    if (f.pointerEvents !== 'auto') bits.push(`pe:${f.pointerEvents}`)
    if (f.position === 'absolute' || f.position === 'fixed') bits.push(`[${f.left},${f.right}]`)
    if (f.covered) bits.push(`covered by .${f.atop}`)
    if (f.occluder) bits.push(`painted over by .${f.occluder}`)
    else if (f.inStack) bits.push('nothing foreign above it')
    else bits.push('outside hit testing — occlusion not measurable here')
    return `  t${f.t} ${bits.join(' ')}`
  }
  console.log(
    [
      `\n=== ${label}`,
      `  rendered ${rendered.length} frames; first t=${rendered[0]?.t ?? '-'} last t=${rendered.at(-1)?.t ?? '-'}`,
      `  frame delta p50 ${dts[Math.floor(dts.length * 0.5)] ?? 0} p95 ${dts[Math.floor(dts.length * 0.95)] ?? 0} max ${dts.at(-1) ?? 0}`,
      ...seen.map(line),
    ].join('\n'),
  )
  traces.push({ label, frames: seen })
}

// The dev server can still hand the page a reload of its own (another agent is
// editing this same checkout while the run is in flight), which replaces the
// context the sampler lives in. It is environmental and it is not what these
// tests are about, so a test that dies on it is retried; an assertion that is
// actually wrong fails all three attempts.
test.describe.configure({ retries: 2 })

test.beforeEach(async ({ page }) => {
  await openNote(page)
  await installProbe(page)
  // The editor's first parse and the tree's first read both land after the
  // note is visible, and a click that races them measures the app starting up
  // rather than the surface it was aimed at.
  await page.waitForTimeout(400)
})

// ---------------------------------------------------------------------------
// The three panels that open and close (the drawer pattern, already converted)
// ---------------------------------------------------------------------------

test('sidebar column: exit length and what a click hits while it leaves', async ({ page }) => {
  await ensureProbe(page)
  const done = probe(page, '.layout-col.sidebar', 1000)
  await page.locator('.tb-left .tb-btn').click()
  const frames = await done()
  report('sidebar column — close', frames)
  expect(fadedOut(frames), 'the column fades rather than disappearing').toBe(true)
  expect(untouched(frames), 'and the exit takes the pointer off it').toBeGreaterThan(2)
})

test('info rail: exit length and what a click hits while it leaves', async ({ page }) => {
  const toggle = page.locator('.status-btn').nth(0)
  await toggle.click()
  await page.waitForTimeout(800)
  await ensureProbe(page)
  const done = probe(page, '.info-rail', 1000)
  await toggle.click()
  const frames = await done()
  report('info rail — close', frames)
  expect(fadedOut(frames), 'the rail fades rather than disappearing').toBe(true)
  expect(untouched(frames), 'and the exit takes the pointer off it').toBeGreaterThan(2)
})

// ---------------------------------------------------------------------------
// The dialogs
// ---------------------------------------------------------------------------

test('settings dialog: the arrival beside the frame it disappears in', async ({ page }) => {
  await ensureProbe(page)
  const open = probe(page, '.settings-overlay', 1000)
  await page.locator('.status-btn').last().click()
  report('settings dialog — open', await open())
  await page.waitForTimeout(1000)

  await ensureProbe(page)
  const leave = probe(page, '.settings-overlay', 1000)
  await page.keyboard.press('Escape')
  const frames = await leave()
  report('settings dialog — close', frames)
  expect(fadedOut(frames), 'the dialog leaves over frames, not in one').toBe(true)
  expect(untouched(frames), 'and takes the pointer off the full-screen scrim').toBeGreaterThan(2)
})

test('template picker: entrance time versus the frame it disappears in', async ({ page }) => {
  await ensureProbe(page)
  const done = probe(page, '.template-dialog', 2200)
  await page.locator('.quick-action').nth(1).click()
  await page.waitForTimeout(900)
  await page.keyboard.press('Escape')
  const frames = await done()
  report('template picker — open then close', frames)
  expect(fadedOut(frames), 'the picker leaves over frames, not in one').toBe(true)
})

// ---------------------------------------------------------------------------
// The reversal, the tab order, and the occlusion search
// ---------------------------------------------------------------------------

test('settings dialog: closed and reopened inside its own exit', async ({ page }) => {
  await page.locator('.status-btn').last().click()
  await page.waitForTimeout(700)

  await ensureProbe(page)
  const done = probe(page, '.settings-overlay', 1200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(40)
  await page.locator('.status-btn').last().click()
  const frames = await done()
  report('settings dialog — Escape, then reopened inside its own exit', frames)

  // The reversal, as a property and not as a taste: after the reopen the dialog
  // is interactive again (`pointer-events` is back the moment the leave classes
  // go) while its opacity is still part-way down, and everything after that is
  // it climbing. A `v-if` that destroyed the element, or a keyframe that
  // restarted, would have no such frame — the value would be 1 on the first
  // frame back and stay there.
  const back = frames.filter(
    (f) => f.rendered && f.pointerEvents === 'auto' && f.opacity !== undefined && f.opacity < 0.95,
  )
  console.log(
    `=== frames still part-way out after the reopen: ${back.map((f) => `t${f.t}:${f.opacity}`).join(' ')}`,
  )
  expect(back.length, 'the reopened dialog continued from where it was').toBeGreaterThan(0)
})

test('the departing panel takes no pointer, and the tab order gets it back', async ({ page }) => {
  // Closed: the leaver is inert, so nothing inside it can take focus.
  await page.locator('.tb-left .tb-btn').click()
  // Wait for the leave to *start* rather than guessing how long the click takes
  // to land: collapsing the sidebar is the heaviest frame in the app (measured
  // at 50–100ms), and a fixed wait reads the panel before its leave classes are
  // on it. It was flaky in exactly that window and passed on retry.
  await page.waitForFunction(
    () => Boolean(document.querySelector<HTMLElement>('.layout-col.sidebar')?.inert),
    undefined,
    { timeout: 3000 },
  )
  const during = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.layout-col.sidebar')!
    const button = el.querySelector<HTMLElement>('button')!
    button.focus()
    return {
      inert: el.inert,
      pointerEvents: getComputedStyle(el).pointerEvents,
      focusedInside: el.contains(document.activeElement),
    }
  })
  console.log(`\n=== departing sidebar: ${JSON.stringify(during)}`)

  // Reopened: the very same element is a normal, focusable panel again.
  await page.waitForTimeout(400)
  await page.locator('.tb-left .tb-btn').click()
  await page.waitForTimeout(600)
  const after = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.layout-col.sidebar')!
    const button = el.querySelector<HTMLElement>('button')!
    button.focus()
    return {
      inert: el.inert,
      pointerEvents: getComputedStyle(el).pointerEvents,
      focusedInside: el.contains(document.activeElement),
      rendered: getComputedStyle(el).display !== 'none',
    }
  })
  console.log(`=== reopened sidebar: ${JSON.stringify(after)}\n`)

  expect(during.inert, 'the leaver is inert').toBe(true)
  expect(during.pointerEvents, 'the leaver takes no pointer').toBe('none')
  expect(during.focusedInside, 'nothing in the leaver can be focused').toBe(false)
  expect(after.inert, 'the reopened panel is interactive again').toBe(false)
  expect(after.focusedInside, 'and its controls can take focus').toBe(true)
})

test('the note-list column: exit length and paint order', async ({ page }) => {
  await ensureProbe(page)
  const done = probe(page, '.note-list-col', 1000)
  await page.locator('.tb-left .tb-btn').click()
  const frames = await done()
  report('note-list column — close', frames)
  expect(fadedOut(frames), 'the column fades rather than disappearing').toBe(true)
  expect(untouched(frames), 'and the exit takes the pointer off it').toBeGreaterThan(2)
})

// ---------------------------------------------------------------------------
// Occlusion: is a leaving surface painted over by something later in the DOM?
//
// This is the class the drawer bug belonged to, and it is invisible in half the
// cases — the rail never had it because it is the last column and nothing
// paints over it. The instrument is `elementsFromPoint` at the surface's own
// centre, with the two interactivity guards lifted (see `occlusion` in the
// probe), because the question is paint order and not hit testing.
// ---------------------------------------------------------------------------

test('occlusion: the two columns against the content that glides over them', async ({ page }) => {
  await ensureProbe(page)
  const sidebar = probe(page, '.layout-col.sidebar', 900, true)
  const noteList = probe(page, '.note-list-col', 900, true)
  await page.locator('.tb-left .tb-btn').click()
  const [a, b] = await Promise.all([sidebar(), noteList()])
  report('OCCLUSION sidebar column — close', a)
  report('OCCLUSION note-list column — close', b)
})

// A case for the rail's section swap stood here and is gone with the surface it measured.
//
// It drove `.rail-tab` nth(1) → nth(5) — outline → stats — over a rail whose six sections stayed
// mounted at once so that a leaver and an arriver were in the DOM together. `afd0b89` reduced that
// rail to the chat alone, at the user's decision, and nothing replaced the mechanism: the four
// panels moved into the note-list column as modes of a `v-else-if` chain keyed on the mode, so a
// switch there unmounts the leaver instead of fading it, and there is no second rail section to
// swap to. The concern the case existed for — a leaving section fades, and the exit takes the
// pointer off it while the arriver is already beneath — is still asserted, on the surface that
// still has it: `the settings section swap, and what the leaving page still exposes`, below.

// ---------------------------------------------------------------------------
// The popups: two surfaces whose exit was never measured, because the
// instrument could not see them until the toolbar's own clip was found.
// ---------------------------------------------------------------------------

test('the heading dropdown: exit, and whether the leaver takes the pointer', async ({ page }) => {
  // The dropdown hangs off a button inside a toolbar that scrolls horizontally,
  // and until this round the toolbar clipped it away entirely: measured with it
  // open, the toolbar's scrollport was y 86–128 and the menu's box y 127–324 —
  // an overlap of one pixel, and `elementFromPoint` at the centre of an option
  // answered `div.editor-container`. (A Playwright click on that option still
  // worked, which is how the defect stayed invisible: `click()` scrolls its
  // target into view first, and scrolling a 197px menu into a 42px scrollport
  // brings it on screen for the machine and for nobody else.) See
  // WordToolbar.vue's `placementFor` for the fix.
  await page.locator('.toolbar-menu-wrap .toolbar-btn').first().click()
  await page.waitForTimeout(500)
  await ensureProbe(page)
  const done = probe(page, '.toolbar-menu', 700)
  await page.locator('.toolbar-menu-wrap .toolbar-btn').first().click()
  const frames = await done()
  report('heading dropdown — close', frames)

  expect(fadedOut(frames), 'the menu fades rather than disappearing').toBe(true)
  // The exit takes the pointer off it, one frame in: before that frame the menu
  // is still the resting surface, and from it onward it is not a target.
  expect(untouched(frames), 'the exit takes the pointer off the menu').toBeGreaterThan(3)
})

test('a toast: exit, and whether the leaver takes the pointer', async ({ page }) => {
  await openNote(page, { importFails: true })
  await showSource(page)
  await queuePick(page, { 'C:/pics/cat.png': 'QUJD' })
  await (await imageToolbarButton(page)).click()
  await expect(page.locator('.toast-stack .toast').first()).toBeVisible()
  await page.waitForTimeout(500)

  await ensureProbe(page)
  const done = probe(page, '.toast-stack .toast', 700)
  await page.locator('.toast-stack .toast').first().click()
  const frames = await done()
  report('toast — dismissed', frames)

  expect(fadedOut(frames), 'the toast fades rather than disappearing').toBe(true)
  expect(untouched(frames), 'the exit takes the pointer off the toast').toBeGreaterThan(3)
})

test('a context menu: the exit every host used to cut', async ({ page }) => {
  await page.locator('.pane.rendered .ProseMirror').click({ button: 'right' })
  await page.locator('.ctx-menu').waitFor({ state: 'visible', timeout: 3000 })
  await page.waitForTimeout(500)

  await ensureProbe(page)
  const done = probe(page, '.ctx-menu', 700)
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  const frames = await done()
  report('context menu — closed with Escape', frames)

  expect(fadedOut(frames), 'the menu fades rather than being cut').toBe(true)
  expect(untouched(frames), 'and its exit takes the pointer off it').toBeGreaterThan(3)
})

// ---------------------------------------------------------------------------
// The settings body
// ---------------------------------------------------------------------------

test('the settings section swap, and what the leaving page still exposes', async ({ page }) => {
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 3000 })
  await page.waitForTimeout(700)
  // Appearance has colour schemes and accents; Editor has neither, so anything
  // the selector still finds after the switch is the page that is leaving.
  await page.locator('.dialog-nav .nav-row').nth(1).click()
  await page.waitForTimeout(700)
  await page.locator('.dialog-nav .nav-row').nth(2).click()
  await page.waitForTimeout(60)

  const during = await page.evaluate(() => {
    const leaver = document.querySelector<HTMLElement>('.dialog-content > .page-leave-active')
    const cs = leaver ? getComputedStyle(leaver) : null
    return {
      present: Boolean(leaver),
      pointerEvents: cs?.pointerEvents ?? null,
      position: cs?.position ?? null,
      inert: leaver ? (leaver as HTMLElement).inert : null,
      colourSchemesStillMatched: document.querySelectorAll(
        '.settings-overlay .color-scheme-card',
      ).length,
    }
  })
  console.log(`\n=== the leaving settings page, 60ms after the switch: ${JSON.stringify(during)}`)
  await page.waitForTimeout(600)
  const after = await page.evaluate(() => ({
    stillThere: Boolean(document.querySelector('.dialog-content > .page-leave-active')),
    colourSchemesStillMatched: document.querySelectorAll('.settings-overlay .color-scheme-card').length,
  }))
  console.log(`=== and 660ms after it: ${JSON.stringify(after)}\n`)

  // It goes when the exit is over, rather than accumulating in the scroll
  // container...
  expect(after.stillThere, 'the exit finishes and the previous section is gone').toBe(false)
  expect(after.colourSchemesStillMatched, 'and nothing of it is left behind').toBe(0)
  // ...and it is out of the user's reach for the whole of the exit. It stays
  // *findable by a selector* — a cross-fade keeps both pages in the document,
  // which is what `console-clean`'s walk trips over — so the walk has to wait
  // for the swap to settle rather than count during it.
  expect(during.pointerEvents, 'the leaving page takes no pointer').toBe('none')
  expect(during.inert, 'and is out of the tab order').toBe(true)
})
