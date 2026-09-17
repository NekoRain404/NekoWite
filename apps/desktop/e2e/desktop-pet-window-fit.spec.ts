/**
 * E3 — the sprite's box against the window the host builds it in.
 *
 * The sprite's box is the `character.size` setting: `size` wide and `round(size * 180 / 160)` tall —
 * 64x72 at the slider's floor, 160x180 at its default, 320x360 at its ceiling — and the window it is
 * drawn in is `window_host::character_window_size`, which until this change was one fixed 260x320 for
 * every character. At the ceiling the box is 60px wider and 100px taller than that window, and what a
 * browser *does* about that is a question about flexbox rather than about arithmetic: either the
 * layout engine shrinks the canvas's CSS box (scaling the drawn bitmap, and smearing pixel art across
 * it) or it leaves the box at its full size and lets it overflow (clipping it against the window
 * edge).
 *
 * **Measured, against the fixed window this file used to sweep**: it overflows. At `size: 320` in a
 * 260x320 window the canvas came out **30px past the left edge, 30px past the right and 40px past the
 * bottom** — and the drawn box was *not* scaled: its CSS box, its computed style and its backing
 * store all read 320x360, because a flex item does not shrink below its own content and this one had
 * no free space to be shrunk into. 64 and 160 fitted with room to spare. Those three sets of numbers
 * are what the rule below was written against, and the rule now in the product is what this file
 * sweeps: **`max(size + 100, 260)` by `round(size * 180 / 160) + 140`** — upstream's 260x320 window
 * minus upstream's 160x180 sprite at the default size, floored at the bubble's own cap
 * (`PET_BUBBLE_MAX_WIDTH`, 260) so a small character's window is never narrower than the reminders
 * drawn in it.
 *
 * **Everything here is Chromium, through Playwright, and the geometry it reports is the engine's.**
 * The one thing that is not a browser's opinion is the box the page is given: `setViewportSize()` is
 * the webview's content area, and in the real window that area *is* what the host's inner size
 * becomes — so a box past the viewport is a box the user cannot see, whatever the compositor does
 * with the toplevel. What is *not* measured here, and cannot be, is anything the compositor owns:
 * whether GTK hands back the size that was asked for (WebKitGTK measured 200x200 for an 80x80 ball
 * request, `ball-window.md` §5), and whether the surface is transparent, stay `unverified` (§7.2's
 * rows, §12's matrix), and no assertion below speaks to them.
 *
 * ## What is mounted, and the one seam
 *
 * `DesktopPetRoot` — the component `desktop-pet-entry.ts` mounts — rather than a wrapper written
 * here: the claim is about `.pet-root`'s flex column and its single flex item, so the flex column has
 * to be the product's. The size travels the product's own path, because the number under measurement
 * is the one that path produces: a `PetWindowGateway`'s `appearance()` read carries `size`, and
 * `pet-appearance.ts` turns it into the `width`/`height` props — a spec that computed
 * `round(size * 180 / 160)` for itself would measure its own arithmetic after the product's changed.
 * The host is `createMemoryPetGateway`, and the one seam is its sheet: the double answers
 * `memory://characters/…/sheet.png`, which no browser can load, so the read is wrapped to carry a
 * spritesheet built in the page.
 *
 * ## Where the window rule comes from, and what pins it
 *
 * The box is read **out of `window_host.rs`** rather than restated here. That is the opposite of what
 * `desktop-pet-tasks.spec.ts` does with the bubble's cap, and it is deliberate: what this file
 * measures is a *layout* property — "the browser puts this sprite inside this box" — and a copy of
 * the rule would keep measuring the box the product used to build. The numbers themselves are pinned
 * on the Rust side (`tests/desktop_pet_settings_test/geometry.rs`), which is where a rule change has
 * to come through; this file follows whatever that rule says and fails if the browser cannot hold the
 * sprite in it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { SHEET } from './support/petFixture'

/**
 * The Rust file that owns the character window's geometry. Resolved from this file's own location,
 * the way `support/repoFs.ts` does it, so a clone anywhere reads its own tree.
 */
const WINDOW_HOST_RS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src-tauri',
  'src',
  'desktop_pet',
  'window_host.rs',
)

/** The text after `marker` on the same line, or a throw naming what moved. */
function declaredAfter(text: string, marker: string): string {
  const at = text.indexOf(marker)
  if (at < 0) throw new Error(`${marker} is not in window_host.rs`)
  const rest = text.slice(at + marker.length)
  const end = rest.indexOf('\n')
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

/** `CHARACTER_WINDOW_SLACK` and `CHARACTER_WINDOW_MIN_WIDTH`, as the rule declares them. */
function windowRule(): { slack: [number, number]; floor: number } {
  const text = readFileSync(WINDOW_HOST_RS, 'utf8')
  const slack = declaredAfter(text, 'const CHARACTER_WINDOW_SLACK: (f64, f64) = (')
    .replace(/\)\s*;.*$/, '')
    .split(',')
    .map((part) => Number(part.trim()))
  const floor = Number(
    declaredAfter(text, 'const CHARACTER_WINDOW_MIN_WIDTH: f64 = ').replace(/;.*$/, ''),
  )
  if (slack.length !== 2 || slack.some((n) => !Number.isFinite(n)) || !Number.isFinite(floor)) {
    throw new Error(`the window rule could not be read: slack ${slack}, floor ${floor}`)
  }
  return { slack: [slack[0] as number, slack[1] as number], floor }
}

/**
 * The sizes this file sweeps: `PET_NUMBER_RULES['character.size']` is `{ min: 64, max: 320, …,
 * fallback: 160 }`, so these are its floor, its default and its ceiling — the range the slider can
 * reach, at the three places a layout can behave differently.
 */
const SIZES = [64, 160, 320] as const

/** A box in viewport coordinates, as `getBoundingClientRect()` gives it. */
type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
/** A window box, the thing every other box below is judged against. */
type WindowBox = { width: number; height: number }

/** The sprite box a size implies: `pet-appearance.ts`'s `box()`, at the sheet's 160x180 aspect. */
function spriteBox(size: number): WindowBox {
  return { width: size, height: Math.round((size * 180) / 160) }
}

/**
 * The window the host builds for a character of this size: `character_window_size`, read out of
 * `window_host.rs` above — the sprite's own box plus the slack upstream's window had, floored at the
 * width the bubble's cap needs.
 */
function hostWindow(size: number): WindowBox {
  const { slack, floor } = windowRule()
  return {
    width: Math.max(size + slack[0], floor),
    height: spriteBox(size).height + slack[1],
  }
}

/** The bubble's own box, and the box inside it that scrolls. Null when the window shows none. */
interface BubbleMeasurement {
  surface: Box
  rows: Box
  /** The rows' content height: past the box's own height exactly when the list is scrolling. */
  rowsScrollHeight: number
}

/** Everything one mount reports, plus the two facts this side of the boundary knows. */
interface Measurement {
  size: number // the `character.size` the appearance read carried
  window: WindowBox // the box the page was given
  viewport: WindowBox // what the page says its own box is — the webview's content area
  canvas: Box
  root: Box
  body: Box
  /** The bubble the tasks produced, or null when the window drew none. */
  bubble: BubbleMeasurement | null
  client: WindowBox // the canvas's CSS box as the layout engine resolved it
  backing: WindowBox // the backing store, from the props times `devicePixelRatio`
  asked: WindowBox // the inline style: what the page *asked* the box to be
  computed: { width: string; height: string } // the used value, from `getComputedStyle`
  dpr: number
  document: WindowBox & { scrollLeft: number; scrollTop: number }
}

declare global {
  interface Window {
    /** What the page-side mount exposes. One mount at a time, like the pet window itself. */
    __petFit?: { fit(): Omit<Measurement, 'size' | 'window'>; unmount(): void }
  }
}

/**
 * Mount the pet window's own root at one character size, in a page box of one window's size.
 *
 * The viewport is set before the mount rather than after, so the layout is resolved once, at the box
 * it will be measured in: `setViewportSize` *is* the window resize, and a mount measured across one
 * would be measuring a reflow.
 *
 * **Into the page's own mount point, and not into a div written here.** The host used to be
 * `#e2e-pet-window`, a bare `<div>` appended to the body — which has no height, and a percentage
 * height against a parent without one resolves to `auto`. So the instrument supplied, silently, the
 * one thing the product's page was missing, and every measurement below was taken of a layout the
 * window never has: `.pet-root` sized itself to its content and `justify-content: flex-end` had no
 * free space to distribute. The page's own element is the only host whose height the product's
 * rules decide, and that is what makes the bottom-edge assertions at the end of this file able to
 * fail. `createApp().mount()` empties the container it is given, so the entry's own no-host root —
 * which draws a sentence and holds nothing else — is replaced by this one.
 *
 * `runs` is how many tasks the host is showing: zero mounts the window with no bubble at all, and
 * anything above the bubble's own row cap pins the list at its ceiling.
 */
async function mountAt(page: Page, size: number, window_: WindowBox, runs = 0): Promise<void> {
  await page.setViewportSize(window_)
  await page.evaluate(
    async ({ size: characterSize, sheetSpec, runs: runCount }) => {
      // The entry pulls Vue through the dev server, and reading the served source is how the same
      // instance is reached by URL — a page has no import map (`pet-tasks.spec.ts` set this).
      const entry = await (await fetch('/src/app/desktop-pet-entry.ts')).text()
      const vueUrl = entry.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
      if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
      const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')
      const rootUrl = '/src/features/desktop-pet/components/DesktopPetRoot.vue'
      const root = (await import(/* @vite-ignore */ rootUrl)) as { default: unknown }
      const gatewayUrl = '/src/platform/gateways/memory-pet.ts'
      const gatewayModule = (await import(/* @vite-ignore */ gatewayUrl)) as typeof import('/src/platform/gateways/memory-pet.ts')

      // The sheet, drawn here: a data URL because it is the one thing this page can load, and
      // because a sheet that failed would be replaced by a sentence about it — a sentence with no
      // canvas under it. Every row is drawn, three frames each; `petFixture.SHEET` has the reason.
      const sheet = document.createElement('canvas')
      sheet.width = sheetSpec.cols * sheetSpec.cell
      sheet.height = sheetSpec.rows * sheetSpec.cell
      const ctx = sheet.getContext('2d')
      if (!ctx) throw new Error('the page has no 2d context')
      for (let row = 0; row < sheetSpec.rows; row += 1) {
        for (let frame = 0; frame < sheetSpec.frames; frame += 1) {
          ctx.fillStyle = `hsl(${(row * 40 + frame * 8) % 360} 70% 55%)`
          const inset = sheetSpec.inset
          ctx.fillRect(frame * sheetSpec.cell + inset, row * sheetSpec.cell + inset, sheetSpec.cell - inset * 2, sheetSpec.cell - inset * 2)
        }
      }
      const image = sheet.toDataURL('image/png')

      // The page's own mount point — see this function's header. Its own root is unmounted first
      // rather than removed: `app.mount()` empties the container, and leaving a second app attached
      // to an element this one now owns would be two windows in one page.
      window.__petFit?.unmount()
      const host = document.getElementById('desktop-pet')
      if (!host) throw new Error('desktop-pet.html declares no #desktop-pet to mount into')

      const double = gatewayModule.createMemoryPetGateway({ visible: true })
      // The tasks this window is showing, from the host's own view of a session — the route
      // `usePetLifecycle`'s subscription takes, so the bubble below is drawn from the same data a
      // real window draws it from. More runs than the bubble's row cap leaves the list scrolling.
      for (let index = 0; index < runCount; index += 1) double.startRun()
      // The same object twice, as the real entry hands it over. Only `appearance` differs, and only
      // in the sheet's address: the double's own `memory://` path is not something a browser loads.
      const connection: typeof double = {
        ...double,
        appearance: async () => ({
          status: 'ready',
          characterId: 'e2e-fit',
          name: 'E2E Fit',
          sheetPath: image,
          sheet: { columns: sheetSpec.cols, rows: sheetSpec.rows },
          size: characterSize,
          bindings: { idle: 0, working: 7 },
          idleClips: [0],
          idleMode: 'sequential',
          idleIntervalMs: 250,
        }),
      }

      const app = vue.createApp({
        render: () => vue.h(root.default as never, { gateway: connection, connection, platform: null }),
      })
      app.mount(host)
      await vue.nextTick()

      window.__petFit = {
        unmount: () => app.unmount(),
        fit: () => {
          const canvas = host.querySelector<HTMLCanvasElement>('canvas.pet-sprite')
          const petRoot = host.querySelector('.pet-root')
          if (!canvas || !petRoot) throw new Error('the pet window drew no sprite to measure')
          // One line on purpose: four fields off a `DOMRect` are not worth five lines of signature.
          const boxOf = (e: Element): Box => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
          const style = getComputedStyle(canvas)
          const page_ = document.documentElement
          // The bubble is optional — a window with no tasks draws none — so both of its boxes are
          // reported as one object or as null rather than as four nullable fields.
          const surface = host.querySelector('.pet-bubble')
          const rows = host.querySelector('.pet-task__scroll')
          return {
            viewport: { width: page_.clientWidth, height: page_.clientHeight },
            canvas: boxOf(canvas),
            root: boxOf(petRoot),
            body: boxOf(document.body),
            bubble: surface && rows
              ? { surface: boxOf(surface), rows: boxOf(rows), rowsScrollHeight: rows.scrollHeight }
              : null,
            client: { width: canvas.clientWidth, height: canvas.clientHeight },
            backing: { width: canvas.width, height: canvas.height },
            asked: { width: Number.parseFloat(canvas.style.width), height: Number.parseFloat(canvas.style.height) },
            computed: { width: style.width, height: style.height },
            dpr: window.devicePixelRatio,
            document: {
              width: page_.scrollWidth, height: page_.scrollHeight,
              scrollLeft: page_.scrollLeft, scrollTop: page_.scrollTop,
            },
          }
        },
      }
    },
    { size, sheetSpec: SHEET, runs },
  )
  // The appearance read is a promise, so the sprite arrives a tick after the mount rather than during
  // it. Waiting on the canvas rather than on a timeout: a box that never arrived is a failure to
  // report, not to wait out.
  await expect(page.locator('#desktop-pet canvas.pet-sprite')).toBeAttached()
}

/** How far a box is past each edge of the window: positive is outside, zero or less is inside. */
function outside(box: Box, window_: WindowBox): Record<string, number> {
  return { left: -box.left, top: -box.top, right: box.right - window_.width, bottom: box.bottom - window_.height }
}

/** One line of raw numbers, so a failure is read against the measurement rather than a guess. */
function line(m: Measurement): string {
  const pair = (box: WindowBox) => `${box.width}x${box.height}`
  const rect = (box: Box) => [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)]
  return JSON.stringify({
    size: m.size, window: pair(m.window), viewport: pair(m.viewport),
    canvasRect: rect(m.canvas), rootRect: rect(m.root),
    bubbleRect: m.bubble ? rect(m.bubble.surface) : null,
    rowsRect: m.bubble ? rect(m.bubble.rows) : null,
    rowsContent: m.bubble?.rowsScrollHeight ?? null,
    canvasOutside: outside(m.canvas, m.window), rootOutside: outside(m.root, m.window),
    asked: pair(m.asked), client: pair(m.client), backing: pair(m.backing),
    computed: `${m.computed.width} x ${m.computed.height}`,
    body: pair(m.body), document: pair(m.document),
    scrolled: `${m.document.scrollLeft},${m.document.scrollTop}`,
  })
}

/**
 * The claim, as one assertion per side: the sprite's box is fully inside the window box.
 *
 * A window is not a scroll container — `DesktopPetRoot`'s own unscoped block sets `overflow: hidden`
 * on the page — so a box past an edge is not a box the user can scroll to. That makes this the
 * acceptance rather than a preference, and it is asserted per side so a failure names the edge and
 * the number rather than reporting that two rectangles differ.
 *
 * Soft, and only here: a run where three edges overflow at once should report three edges, and a
 * hard assertion would stop at the first. The test still fails — this is a report, not a tolerance.
 */
function expectInside(m: Measurement, which: string): void {
  const past = outside(m.canvas, m.window)
  for (const side of ['left', 'top', 'right', 'bottom']) {
    expect.soft(
      past[side],
      `${which}: a ${m.size}px character's sprite is fully inside the ${m.window.width}x${m.window.height} window — it is ${past[side]}px past the ${side} edge`,
    ).toBeLessThanOrEqual(0)
  }
}

/**
 * The other half, and the one a reader would not think to ask for: the box was not *shrunk*.
 *
 * The canvas's CSS box and its backing store come from the same two numbers, so a layout engine that
 * squeezed the box to fit would leave the backing store at full size and the compositor would scale
 * the drawn bitmap down — which for a 320px sprite is pixel art smeared across 260px, and reads as
 * "the pet looks blurry" rather than as "the window is too small". The used height is read from the
 * computed style as well as from the layout box, so neither half can be true alone.
 */
function expectNotSquashed(m: Measurement, which: string): void {
  const wanted = spriteBox(m.size)
  expect(m.asked.width, `${which}: the page asked for the ${m.size}px box`).toBe(wanted.width)
  expect(m.asked.height, `${which}: at the sheet's aspect`).toBe(wanted.height)
  expect(m.client.width, `${which}: the layout engine left the canvas's width alone`).toBe(wanted.width)
  expect(m.client.height, `${which}: and its height`).toBe(wanted.height)
  expect(m.computed.height, `${which}: the used height is the height the page asked for`).toBe(`${wanted.height}px`)
  expect(m.backing.width, `${which}: the backing store is the CSS box at the pixel ratio`).toBe(Math.round(wanted.width * m.dpr))
  expect(m.backing.height, `${which}: and so is its height`).toBe(Math.round(wanted.height * m.dpr))
  // Nothing here moves the window, and a scrolled box would report a rect inside the viewport while
  // the drawing under it was not.
  expect(m.document.scrollLeft, `${which}: the page did not scroll sideways`).toBe(0)
  expect(m.document.scrollTop, `${which}: the page did not scroll down`).toBe(0)
}

/** Mount at every size, log the numbers, and only then judge them — a failure keeps all three. */
async function sweep(page: Page, which: string, windowFor: (size: number) => WindowBox): Promise<void> {
  await page.goto('/desktop-pet.html')
  const measured: Measurement[] = []
  for (const size of SIZES) {
    const window_ = windowFor(size)
    await mountAt(page, size, window_)
    const fit = await page.evaluate(() => window.__petFit?.fit())
    if (!fit) throw new Error('the pet window is not mounted')
    const one: Measurement = { ...fit, size, window: window_ }
    measured.push(one)
    console.log(`[pet-fit] ${which}: ${line(one)}`)
  }
  // Judged only after every size has been logged, so a failure keeps all three sets of numbers.
  for (const one of measured) { expectInside(one, which); expectNotSquashed(one, which) }
}

test('the window the host builds holds the sprite at every size the slider offers', async ({ page }) => {
  // The shipped rule, at the three sizes the slider can reach. The claim is the one the fixed window
  // failed: at every one of them the sprite's box is inside the box the host asked the compositor
  // for, and the canvas was not quietly scaled to make that true.
  await sweep(page, 'the window the host builds', hostWindow)
})

test('the rule still reproduces the window this build has always opened, at the default size', async () => {
  // 160 is `character.size`'s default and 260x320 is upstream's window at all four of its builder
  // sites, so a rule that moved either number would be a change to every existing install rather than
  // the fix this is. Asserted here as well as in Rust because this file is where the rule is *read*:
  // a parse that quietly produced something else would make the sweep above measure a window the
  // product never asks for.
  expect(hostWindow(160)).toEqual({ width: 260, height: 320 })
  expect(hostWindow(320).width).toBeGreaterThan(hostWindow(160).width)
})

// ---------------------------------------------------------------------------
// The window's own column
// ---------------------------------------------------------------------------

/**
 * The bubble's own row cap, and therefore the number of runs that leaves it scrolling.
 *
 * `PET_BUBBLE_LAYOUT_DEFAULTS.maxTasks` is 5, so six is one more than the surface will ever draw —
 * the same one-past-the-cap arithmetic `petFixture.petTasks()` uses. Not imported: this is the
 * product's stored default being copied into a payload, and the two are reconciled by the assertion
 * below that the list really is scrolling.
 */
const RUNS_PAST_THE_CAP = 6

/**
 * What the sprite sits above, and what the bubble may not cross: the gap `.pet-root` puts between
 * its two children. Two places have to agree on this number — the stylesheet and this measurement —
 * and the assertion below is what makes a change to the rule land here rather than cancel out.
 */
const ROOT_GAP = 4

/**
 * The acceptance this file's window was always about, in the two halves a user would state it.
 *
 * **The sprite is on the bottom edge.** `.pet-root` is a column with `justify-content: flex-end`, and
 * that rule only has free space to work with if the root is as tall as the window. It is not a
 * decoration: everything the bubble does is measured against the character's own box, so a sprite
 * that floats to the top of a 320px window is a pet that does not stand where the user put it.
 *
 * **And a bubble does not push it past it.** The bubble is the surface with a bound of its own
 * (`PET_BUBBLE_MAX_HEIGHT`), and that bound was written against a window whose height *tracks* the
 * character's size while the room above the sprite does not: the host gives the window
 * `round(size * 180 / 160) + 140` px of height (`window_host::CHARACTER_WINDOW_SLACK`), so what is
 * left for the bubble and the gap is 136 px at every size the slider offers — while `40vh` of the
 * window's own height is 128 px at the default size and 200 px at the ceiling. Both of those are
 * past the room the smaller one of them has to live in, so the bound and the room have to be read
 * together, and the second half of this case is what reads them.
 *
 * Measured rather than argued, and the numbers are logged before they are judged — a failure keeps
 * all three sizes' worth.
 */
test('the sprite stands on the bottom edge of the window, and a full bubble does not push it off', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  const measured: Measurement[] = []
  // Both halves of the window's life: a pet with nothing to say, and a pet whose bubble is at its
  // bound. The first is the alignment rule on its own — `justify-content: flex-end` with room to
  // spare — and the second is the same rule with the room taken.
  for (const runs of [0, RUNS_PAST_THE_CAP]) {
    for (const size of SIZES) {
      const window_ = hostWindow(size)
      await mountAt(page, size, window_, runs)
      const fit = await page.evaluate(() => window.__petFit?.fit())
      if (!fit) throw new Error('the pet window is not mounted')
      const one: Measurement = { ...fit, size, window: window_ }
      measured.push(one)
      console.log(`[pet-fit] ${runs} runs: ${line(one)}`)
    }
  }

  for (const one of measured) {
    const which = `${one.size}px character, ${one.bubble ? `a bubble showing ${RUNS_PAST_THE_CAP} runs` : 'no bubble'}`

    // The bottom edge: the sprite's box ends where the window ends, and not below it. This is the
    // whole of what `justify-content: flex-end` promises, and it is the assertion the mount point
    // without a height could not satisfy — the sprite sat at the window's *top* instead, with 140px
    // of empty window under it, because a percentage against an auto-height parent is `auto`.
    expect.soft(
      Math.abs(one.window.height - one.canvas.bottom),
      `${which}: the sprite's lower edge is the window's lower edge — it is at ${one.canvas.bottom} in a ${one.window.height}px window`,
    ).toBeLessThanOrEqual(1)

    // Every surface, inside the window on every side — 气泡不越屏, asserted where the window is the
    // box the host actually builds rather than a frame this file chose. Soft, and one side at a
    // time, so a window that overflows in two directions reports both numbers.
    const boxes: readonly (readonly [string, Box])[] = [
      ['the sprite', one.canvas],
      ...(one.bubble ? ([['the bubble', one.bubble.surface]] as const) : []),
    ]
    for (const [name, box] of boxes) {
      const past = outside(box, one.window)
      for (const side of ['left', 'top', 'right', 'bottom']) {
        expect.soft(
          past[side],
          `${which}: ${name} is inside the window's ${side} edge — it is ${past[side]}px past it`,
        ).toBeLessThanOrEqual(0)
      }
    }

    if (!one.bubble) continue
    // The list is at its bound, which is what makes the containment above the hard case: a bubble
    // that fits is a bubble that never asks the column for the character's room. The rows box has to
    // be scrolling, and the surface above it has to have given the height back rather than the
    // character having given up its own.
    expect(
      one.bubble.rowsScrollHeight,
      `${which}: the rows are past the box that holds them, so the list is at its bound`,
    ).toBeGreaterThan(one.bubble.rows.height)
    // The column is the order the window's own stylesheet declares: bubble, gap, character.
    expect(
      one.bubble.surface.bottom,
      `${which}: the bubble ends above the sprite`,
    ).toBeLessThanOrEqual(one.canvas.top - ROOT_GAP + 1)
  }
})
