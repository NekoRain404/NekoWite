/**
 * E4 — the bubble inside the window the host builds for it.
 *
 * Three claims, all of them about the *product's* column rather than about the bubble component on
 * its own:
 *
 *  1. **The bubble is centred over the character.** `#pet-root` upstream is a column with
 *     `align-items: center` (`references/desktop-pet/windows/src/styles.css:20-28`) and its
 *     `.bubble` carries only a `max-width` (`:38-58`), so the bubble is centred by the container
 *     and lines up with the sprite under it. This port had `align-self: stretch` on the bubble,
 *     which overrides that centring: a stretched flex item that cannot reach its stretched size
 *     sits at the *start* edge, so in a 420px window the bubble was measured at `x=0…260` while the
 *     sprite it belongs to is centred at `50…370`. Two agents' worth of measurements did not see it
 *     because the instrument was not the product's column — see the mount below.
 *  2. **A real session id fits the bubble.** `PET_BUBBLE_FIXED_TOKEN_STYLE` makes every token but
 *     the message `white-space: nowrap`, and an ACP session id is a 36-character uuid. The width is
 *     `PET_BUBBLE_MAX_WIDTH` (260), which a 36-character uuid in the row's 11px monospace is wider
 *     than, so the row overflows the surface that holds it. The fixtures use ids like
 *     `shared-session`, which is why no assertion caught it.
 *  3. **The words the user wrote are the words the bubble draws** (§5.2's 自定义词句), and the
 *     layout settings decide what it draws.
 *
 * ## What is mounted, and why it is the product's own
 *
 * `DesktopPetRoot` — the component `desktop-pet-entry.ts` mounts — **into `#desktop-pet`**, the
 * element `desktop-pet.html` declares and the entry's own constant names. Both halves matter:
 *
 *   - The root, not `PetBubble`, because claim 1 is a fact about `.pet-root`'s flex column and the
 *     bubble's item in it. A spec that mounts the bubble into a `<div>` of its own supplies the
 *     centring the product is missing, and then measures what it supplied.
 *   - The page's own mount point, not a div written here, because a percentage height resolves
 *     against its containing block: `#desktop-pet` is `height: 100%` under a `height: 100%` body,
 *     and a bare `<div>` has no height at all.
 *
 * The host is `createMemoryPetGateway` and the settings are written through its own
 * `updateSettings`, so the path a phrase travels is the product's: the store, the appearance read,
 * `pet-appearance.ts`, `usePetWindow`, the root's props, the bubble. Everything below the gateway
 * is the shipped code.
 *
 * ## Engines
 *
 * Everything here is **Chromium, through Playwright**. The product engine is WebKitGTK
 * (`e2e/webkit/pet-probe.mjs` is that half, and its root step mounts the same component in the same
 * page); a reading taken here is not evidence about WebKitGTK and is not offered as any.
 */
import { expect, test, type Page } from '@playwright/test'
import type { PetSettingsValues } from '/src/platform/gateways/pet-contracts'
import { hostWindow, outside, type Box, type WindowBox } from './support/petWindow'

/**
 * The character size these cases run at, and why this one.
 *
 * `PET_NUMBER_RULES['character.size']` is `{ min: 64, max: 320, … }`, so 320 is the ceiling of the
 * slider — the widest window the host ever builds (`max(size + 100, 260)` = 420). The left-edge
 * deviation is only visible where there is slack to be wrongly distributed, so the case is written
 * at the size that has the most of it. The default size (160, a 260px window with no slack) is
 * swept as well, so a fix that centred the bubble by removing the cap rather than the stretch is
 * caught.
 */
const WIDE_SIZE = 320
const DEFAULT_SIZE = 160

/** A box as the page reports it, plus the two content widths an overflow is read from. */
interface OverflowingBox extends Box {
  scrollWidth: number
  clientWidth: number
}

/** One field of one row, as the page reports it. */
interface FieldMeasurement extends OverflowingBox {
  state: string | null
  token: string | null
  text: string
  /** How far this field reaches past the row that holds it: positive is outside the row. */
  pastRow: number
}

/** Everything one mount reports. */
interface BubbleMeasurement {
  window: WindowBox
  viewport: WindowBox
  root: Box
  sprite: Box
  /** The bubble's surface, or null when the window drew none. */
  surface: OverflowingBox | null
  /**
   * The box `PET_BUBBLE_SCROLL_STYLE` is applied to — the one that scrolls.
   *
   * This is where a horizontal overflow is visible as one: `overflow-y: auto` computes
   * `overflow-x: auto` with it, so a row wider than the box gives the box a horizontal scrollbar
   * rather than spilling out of it. Nothing else in the surface has a scrollable overflow, which is
   * why `scrollWidth` alone on the fields measures nothing (a field sized to its own content has no
   * overflow of its own — its *parent* is what it is too wide for).
   */
  scroll: OverflowingBox | null
  fields: FieldMeasurement[]
  /** What the surface is showing, as the user reads it. */
  text: string
  /**
   * The mode the *surface* reports: `line` or `list`.
   *
   * Not the layout's `mode` — that one is the number of dots below, because the pager is a run of
   * buttons whose labels are their accessible names (`Page 1 of 3`) and carry no text a reader of
   * `textContent` can see.
   */
  mode: string | null
  /** The pager's dots: one per page, and none at all outside carousel mode. */
  pages: number
}

declare global {
  interface Window {
    /** What the page-side mount exposes. One mount at a time, like the pet window itself. */
    __petBubble?: {
      read(): Omit<BubbleMeasurement, 'window'>
      /**
       * Write the `message` domain *after* the mount, the way the settings page does while the pet
       * window is already up: one `updateSettings` call, then whatever the window does about it.
       */
      setMessage(values: Record<string, unknown>): Promise<void>
      unmount(): void
    }
  }
}

/** What one mount is asked for. */
interface MountOptions {
  size: number
  /** The runs the host is showing, by the session id each is filed under. */
  runs?: readonly string[]
  /**
   * The `message` domain the host stores, written through the double's own `updateSettings` — the
   * same call the settings page makes, so the case drives the product's path and not a prop.
   */
  message?: Partial<PetSettingsValues['message']>
}

/**
 * Mount the pet window's own root, at one character size, in a page box of one window's size.
 *
 * The viewport is set before the mount rather than after, so the layout is resolved once, at the
 * box it will be measured in: `setViewportSize` *is* the window resize.
 */
async function mountAt(page: Page, options: MountOptions): Promise<void> {
  const window_ = hostWindow(options.size)
  await page.setViewportSize(window_)
  await page.evaluate(
    async ({ size, runs, message, sheetSpec }) => {
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

      // The page's own mount point. Its own root is unmounted first rather than removed:
      // `app.mount()` empties the container, and leaving a second app attached to an element this
      // one now owns would be two windows in one page.
      window.__petBubble?.unmount()
      const host = document.getElementById('desktop-pet')
      if (!host) throw new Error('desktop-pet.html declares no #desktop-pet to mount into')

      const double = gatewayModule.createMemoryPetGateway({ visible: true })
      // The runs, filed under the session ids the case asked for. A run's id reaches the bubble
      // through the same projection a real session's does.
      for (const sessionId of runs) double.startRun({ sessionId })

      // The settings the case asked for, through the double's own write path — the call the settings
      // page makes. Read first, so the write carries the revision the store is at.
      if (message) {
        const loaded = await double.readSettings('message')
        if (loaded.status !== 'current') throw new Error('the double would not read its message record')
        if (loaded.record.domain !== 'message') throw new Error('the double answered for another domain')
        await double.updateSettings({
          domain: 'message',
          revision: loaded.record.revision,
          values: { ...loaded.record.values, ...message },
        })
      }

      // The same object twice, as the real entry hands it over. Only `appearance` differs, and only
      // in the two things a browser page cannot supply: a character the double's library does not
      // hold, and a sheet it could not load (`memory://` is not a scheme a page fetches).
      //
      // The double's own arm is read first and spread in, so every field that is a *setting* —
      // `bubbleOpacity` today, the bubble's layout with it — still travels the host's path from the
      // `message` write above. A case that spelled the whole arm out here would be measuring its own
      // payload, which is what the previous instrument did and why it could not see this.
      const connection: typeof double = {
        ...double,
        appearance: async () => ({
          ...(await double.appearance()),
          status: 'ready' as const,
          characterId: 'e2e-bubble',
          name: 'E2E Bubble',
          sheetPath: image,
          sheet: { columns: sheetSpec.cols, rows: sheetSpec.rows },
          size,
          bindings: { idle: 0, working: 7 },
          idleClips: [0],
          idleMode: 'sequential' as const,
          idleIntervalMs: 250,
        }),
      }

      const app = vue.createApp({
        render: () => vue.h(root.default as never, { gateway: connection, connection, platform: null }),
      })
      app.mount(host)
      await vue.nextTick()

      const boxOf = (e: Element): Box => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
      const over = (e: Element): OverflowingBox => ({ ...boxOf(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth })

      window.__petBubble = {
        unmount: () => app.unmount(),
        setMessage: async (values) => {
          const loaded = await double.readSettings('message')
          if (loaded.status !== 'current' || loaded.record.domain !== 'message') {
            throw new Error('the double would not read its message record')
          }
          await double.updateSettings({
            domain: 'message',
            revision: loaded.record.revision,
            values: { ...loaded.record.values, ...values },
          })
          await vue.nextTick()
        },
        read: () => {
          const petRoot = host.querySelector('.pet-root')
          if (!petRoot) throw new Error('the pet window drew no root to measure')
          const canvas = host.querySelector<HTMLCanvasElement>('canvas.pet-sprite')
          if (!canvas) throw new Error('the pet window drew no sprite to measure')
          const page_ = document.documentElement
          const surface = host.querySelector<HTMLElement>('.pet-bubble')
          const scroll = host.querySelector<HTMLElement>('.pet-task__scroll')
          // One entry per field of every task row, so a field that overflowed is named rather than
          // counted: the token and the text are the two things that say which one it was. `pastRow`
          // is the unambiguous reading — a field whose right edge is past its row's right edge is
          // past the surface, whatever the two `scrollWidth`s say.
          const fields: FieldMeasurement[] = []
          for (const row of host.querySelectorAll<HTMLElement>('.pet-task__row')) {
            const rowBox = boxOf(row)
            for (const field of row.querySelectorAll<HTMLElement>('.pet-task__field')) {
              const box = over(field)
              fields.push({
                ...box,
                state: row.getAttribute('data-state'),
                token: field.getAttribute('data-token'),
                text: field.textContent ?? '',
                pastRow: box.right - rowBox.right,
              })
            }
          }
          return {
            viewport: { width: page_.clientWidth, height: page_.clientHeight },
            root: boxOf(petRoot),
            sprite: boxOf(canvas),
            surface: surface ? over(surface) : null,
            scroll: scroll ? over(scroll) : null,
            fields,
            text: surface ? (surface.textContent ?? '').trim() : '',
            mode: surface ? surface.getAttribute('data-mode') : null,
            pages: host.querySelectorAll('.pet-task__page').length,
          }
        },
      }
    },
    { size: options.size, runs: options.runs ?? [], message: options.message ?? null, sheetSpec: { cols: 8, rows: 9, cell: 24, frames: 3, inset: 4 } },
  )
  // The appearance read is a promise, so the sprite arrives a tick after the mount rather than
  // during it. Waiting on the canvas rather than on a timeout: a box that never arrived is a
  // failure to report, not to wait out.
  await expect(page.locator('#desktop-pet canvas.pet-sprite')).toBeAttached()
}

/** Mount, read, and hand back the numbers with the window they were taken in. */
async function measure(page: Page, options: MountOptions): Promise<BubbleMeasurement> {
  await mountAt(page, options)
  const read = await page.evaluate(() => window.__petBubble?.read())
  if (!read) throw new Error('the pet window is not mounted')
  return { ...read, window: hostWindow(options.size) }
}

/** One line of raw numbers, so a failure is read against the measurement rather than a guess. */
function line(which: string, m: BubbleMeasurement): string {
  const rect = (box: Box | null) =>
    box ? [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] : null
  return (
    `[pet-bubble] ${which}: window ${m.window.width}x${m.window.height}, ` +
    `viewport ${m.viewport.width}x${m.viewport.height}, ` +
    `root ${JSON.stringify(rect(m.root))}, sprite ${JSON.stringify(rect(m.sprite))}, ` +
    `surface ${JSON.stringify(rect(m.surface))} (${m.mode}), ` +
    `scroll ${JSON.stringify(rect(m.scroll))} ${m.scroll ? `${m.scroll.scrollWidth}/${m.scroll.clientWidth}` : ''}, ` +
    `pastRow ${JSON.stringify(m.fields.filter((f) => Math.round(f.pastRow) > 1).map((f) => [f.token, Math.round(f.pastRow)]))}, ` +
    `pages ${m.pages}, text ${JSON.stringify(m.text.slice(0, 80))}`
  )
}

/**
 * A real ACP session id, at the length a real one has: 8-4-4-4-12 hex, thirty-six characters.
 *
 * Deliberately not a fixture-shaped `session-1`: the fixtures are the reason this escaped every
 * assertion, and a shorter id would not exercise the width the row has to survive. It is written
 * out rather than generated so the failure message names a fixed string.
 */
const REAL_SESSION_ID = '0193c0de-4f2a-7c31-9b6e-2d2f0a7b41c8'

// ---------------------------------------------------------------------------
// The bubble in the product's column
// ---------------------------------------------------------------------------

test('the bubble is centred over the character, in the window the host builds', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  const measured: BubbleMeasurement[] = []
  for (const size of [WIDE_SIZE, DEFAULT_SIZE]) {
    const one = await measure(page, { size, runs: ['cycle-1'] })
    measured.push(one)
    console.log(line(`${size}px character`, one))
  }

  for (const one of measured) {
    if (!one.surface) throw new Error('the bubble is not drawn')
    const past = outside(one.surface, one.window)
    // 气泡不越屏, the horizontal half, at the window the host really builds.
    for (const side of ['left', 'right'] as const) {
      expect
        .soft(past[side], `the bubble is inside the window's ${side} edge — it is ${past[side]}px past it`)
        .toBeLessThanOrEqual(0)
    }
    // The claim this case exists for: the surface is centred, so it lines up with the sprite under
    // it. `align-items: center` is what upstream's column does; `align-self: stretch` on the item
    // takes it away, and an item that cannot reach its stretched size lands at the start edge —
    // which is the left edge of the window, and stays there however wide the window is.
    const leftGap = one.surface.left
    const rightGap = one.window.width - one.surface.right
    expect(
      Math.abs(leftGap - rightGap),
      `the bubble's two side gaps are equal — left ${leftGap}, right ${rightGap}`,
    ).toBeLessThanOrEqual(1)
    // And the sprite it has to line up with is centred too, so the two are not both drifting.
    const spriteGaps = one.sprite.left - (one.window.width - one.sprite.right)
    expect(Math.abs(spriteGaps), 'the character is centred in the window').toBeLessThanOrEqual(1)
  }
})

test('a real session id does not overflow the bubble', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  const one = await measure(page, { size: WIDE_SIZE, runs: [REAL_SESSION_ID] })
  console.log(line('one 36-character session id', one))

  if (!one.surface || !one.scroll) throw new Error('the bubble is not drawn')
  // 长中文 and 长 id: the surface is what the user reads, and a row wider than it is a row that is
  // simply not readable — the pet window does not scroll and its root is `overflow: hidden`. The
  // scrolling box is where the overflow shows up as one, because that is the box that scrolls.
  expect(
    one.scroll.scrollWidth - one.scroll.clientWidth,
    'the box that scrolls holds its own content',
  ).toBeLessThanOrEqual(1)

  // Per field, and on every row: the session token is the one that was `nowrap`, and the message is
  // the one that wraps, so naming the token is what makes a failure say which rule was wrong.
  for (const field of one.fields) {
    expect
      .soft(
        Math.round(field.pastRow),
        `the ${field.token} field of a ${field.state} row stays inside its row — it is ${Math.round(field.pastRow)}px past it`,
      )
      .toBeLessThanOrEqual(1)
  }
  // The id is really on screen, and really the whole one: a fix that truncated it would otherwise
  // read as a fix.
  expect(one.text).toContain(REAL_SESSION_ID)
})

// ---------------------------------------------------------------------------
// The words the user wrote, and the layout they chose
// ---------------------------------------------------------------------------

/**
 * A phrase in the user's own words, at the length and script a real one has.
 *
 * Deliberately not `Hello`: the surface under test is a 260px bubble, and a Chinese sentence is the
 * content that decides whether a line wraps or is clipped.
 */
const USER_PHRASE = '要不要先喝口水，再继续整理引用？'

test('a phrase the user typed is the phrase the bubble shows', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  // Nothing is running, so the bubble has nothing to report — which is the one state the user's
  // own line is for. Before the `message` payload existed this case could not be written at all:
  // `PetBubble` had a `line` prop, nothing in the product passed one, and the surface simply did
  // not render.
  const one = await measure(page, {
    size: DEFAULT_SIZE,
    message: { quickBubbles: [USER_PHRASE], idle: true },
  })
  console.log(line('a user’s own phrase, nothing running', one))

  expect(one.mode).toBe('line')
  expect(one.text).toBe(USER_PHRASE)
})

test('the idle switch off leaves the bubble silent, and a list still wins over a line', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  // `message.idle` is upstream's 「Show idle message」. Off means the surface draws nothing when
  // there is no task — which is what a fresh install does, its phrase list being empty.
  const off = await measure(page, {
    size: DEFAULT_SIZE,
    message: { quickBubbles: [USER_PHRASE], idle: false },
  })
  expect(off.surface).toBeNull()

  // And a task is a task: §6.3's rule that the list is what the user has to answer, so the pet
  // does not speak over it.
  const busy = await measure(page, {
    size: DEFAULT_SIZE,
    runs: ['cycle-1'],
    message: { quickBubbles: [USER_PHRASE], idle: true },
  })
  expect(busy.mode).toBe('list')
  expect(busy.text).not.toContain(USER_PHRASE)
})

test('the layout the user chose is the layout the bubble draws', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  // Six runs, which is one more than the schema's default cap of five — so every case below is a
  // number a change to the stored value actually moves.
  const runs = ['cycle-1', 'cycle-2', 'cycle-3', 'cycle-4', 'cycle-5', 'cycle-6']

  const byDefault = await measure(page, { size: DEFAULT_SIZE, runs })
  console.log(line('the stored defaults', byDefault))
  expect(byDefault.fields.filter((f) => f.token === 'separator')).toHaveLength(5)
  // The default separator is `·` (`PET_SETTINGS_DEFAULTS.message.separator` is `dot`).
  expect(byDefault.text).toContain('·')
  expect(byDefault.text).toContain('+1 more')

  const capped = await measure(page, {
    size: DEFAULT_SIZE,
    runs,
    message: { layoutMaxRows: 2 },
  })
  console.log(line('layoutMaxRows 2', capped))
  // The cap is the layout's, and what it hid is reported rather than dropped: six runs at a cap of
  // two is four rows the surface says it is not showing.
  expect(capped.fields.filter((f) => f.token === 'separator')).toHaveLength(2)
  expect(capped.text).toContain('+4 more')

  const filtered = await measure(page, {
    size: DEFAULT_SIZE,
    runs,
    message: { filter: 'attention' },
  })
  console.log(line('filter attention', filtered))
  // `attention` keeps the states whose `PET_ALERT_BY_STATE` is `needs-attention`. Every run this
  // double starts is `working`, so the filter keeps none of them — and the surface is not drawn at
  // all rather than shown as an empty box, which is the same answer a fresh install gives when its
  // phrase list is empty.
  expect(filtered.surface).toBeNull()

  const arrowed = await measure(page, {
    size: DEFAULT_SIZE,
    runs,
    message: { separator: 'arrow' },
  })
  console.log(line('separator arrow', arrowed))
  // The schema stores the *name*; the character is the renderer's table
  // (`PET_BUBBLE_SEPARATORS`), which is upstream's own four buttons.
  expect(arrowed.text).toContain('→')
  expect(arrowed.text).not.toContain('·')

  const paged = await measure(page, {
    size: DEFAULT_SIZE,
    runs,
    message: { layoutMode: 'carousel', layoutMaxRows: 2 },
  })
  console.log(line('layoutMode carousel', paged))
  // `carousel` shows one page at a time and the pager is how the rest are reached — the one mode
  // where the cap is a page rather than a truncation. Six runs at a page of two is three dots, and
  // `list` above drew none at all with the same cap: that pair is what makes this a claim about the
  // mode rather than about the cap.
  expect(paged.fields.filter((f) => f.token === 'separator')).toHaveLength(2)
  expect(paged.pages).toBe(3)
  expect(capped.pages).toBe(0)
})

test('a phrase written while the window is up reaches the bubble, which is the settings page’s own path', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  // The click path item 1 is judged by ends here: the settings page writes the `message` domain,
  // the host publishes the applied write, `usePetWindow`'s subscription re-reads what it draws, and
  // the bubble is redrawn. A case that only ever wrote before the mount would not exercise the
  // subscription at all — and a window that ignores another window's write is exactly the shape of
  // "I changed it and nothing happened".
  await mountAt(page, { size: DEFAULT_SIZE })
  expect((await page.evaluate(() => window.__petBubble?.read()))?.surface).toBeNull()

  await page.evaluate((values) => window.__petBubble?.setMessage(values), {
    quickBubbles: [USER_PHRASE],
  })
  const after = await page.evaluate(() => window.__petBubble?.read())
  if (!after) throw new Error('the pet window is not mounted')
  console.log(line('after a write from another window', { ...after, window: hostWindow(DEFAULT_SIZE) }))
  expect(after.mode).toBe('line')
  expect(after.text).toBe(USER_PHRASE)
})
