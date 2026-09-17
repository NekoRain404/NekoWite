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

/**
 * What the page resolves for the bubble's theme.
 *
 * `attribute` is read off the element rather than through `color-scheme`, because the attribute is
 * what `palettes.css`'s selectors match; `elevated` is the palette's own surface colour at that
 * theme, read from the same element, so a case can say the bubble is drawn from *this page's*
 * palette rather than from a colour the component carries — a `data-theme` value no block in
 * `palettes.css` matches falls back to `:root` and draws the light palette while the setting claims
 * otherwise.
 */
interface ThemeMeasurement {
  attribute: string | null
  colorScheme: string
  elevated: string
  /** The bubble's computed background, which the stylesheet mixes from `elevated`. */
  background: string
}

/**
 * The bubble's own two drawn settings: the text size and the state dot's shape.
 *
 * `rowFontSize` is read as well as the surface's, because the size has to reach the *rows* and not
 * only the box around them — upstream writes it to the document root so everything inherits
 * (`references/desktop-pet/windows/src/main.ts:104`), and a component that set `font-size` on
 * itself alone would leave the rows at the app's body size. The dot's colour is deliberately not
 * read: both styles use the same state colours, and the shape is what the setting is about.
 */
interface ChromeMeasurement {
  fontSize: string
  rowFontSize: string | null
  /** The dot's corner radius: a disc is `50%`, upstream's glyph is a square box. */
  dot: string | null
  /** The glyph's generated content: `none` on the disc, a character on the other style. */
  dotGlyph: string | null
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
      /** What the page resolved for the theme, after whatever write the case made. */
      theme(): ThemeMeasurement
      /** The bubble's text size and dot shape, after whatever write the case made. */
      chrome(): ChromeMeasurement
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
        theme: () => {
          const page_ = document.documentElement
          const resolved = getComputedStyle(page_)
          const surface = host.querySelector<HTMLElement>('.pet-bubble')
          if (!surface) throw new Error('the pet window drew no bubble to measure the theme on')
          return {
            attribute: page_.getAttribute('data-theme'),
            colorScheme: resolved.colorScheme,
            elevated: resolved.getPropertyValue('--app-elevated').trim(),
            background: getComputedStyle(surface).backgroundColor,
          }
        },
        chrome: () => {
          const surface = host.querySelector<HTMLElement>('.pet-bubble')
          const row = host.querySelector<HTMLElement>('.pet-task__row')
          const dot = host.querySelector<HTMLElement>('.pet-task__dot')
          if (!surface) throw new Error('the pet window drew no bubble to measure')
          return {
            fontSize: getComputedStyle(surface).fontSize,
            rowFontSize: row ? getComputedStyle(row).fontSize : null,
            dot: dot ? getComputedStyle(dot).borderRadius : null,
            dotGlyph: dot ? getComputedStyle(dot, '::before').content : null,
          }
        },
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

/**
 * The bubble's theme, as the *window* resolves it — the defect this case exists for.
 *
 * `message.theme` was stored, had a three-way control on 气泡与消息, and was read by that page's own
 * preview and by nothing on the desktop: a user picked Light, watched the preview change, and the
 * bubble beside their character did not. The fix is not a class on the surface — it is the page's
 * own `data-theme`, because a theme is a page-level choice (see
 * `features/desktop-pet/services/pet-bubble-theme.ts`), and this case reads it there.
 *
 * **The measurement is against the page's own palette, not against a colour written here.** The
 * claim is that the bubble on the desktop is drawn in the app's palette for the theme the user
 * chose — so each reading compares the bubble's computed background to `--app-elevated` as the same
 * page declares it at the same moment. A bubble that painted its own colours (which is what the
 * settings page's preview does, with its own hard-coded pair) would pass a "light and dark differ"
 * check and fail this one.
 */
test('the theme the user picks is the palette the bubble on the desktop is drawn in', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  // Written before the mount, so the first frame is the one under test; the write while the window
  // is up is the next half of the same case, and is the settings page's own path.
  await mountAt(page, { size: DEFAULT_SIZE, runs: ['theme-run'], message: { theme: 'light' } })

  const light = await page.evaluate(() => window.__petBubble?.theme())
  if (!light) throw new Error('the pet window is not mounted')
  console.log(`[pet-bubble] theme light: ${JSON.stringify(light)}`)
  // Light is *named*, not omitted. The theme composable used to spell it as the absence of the
  // attribute — `:root` is where `palettes.css` declares the light palette, and no block matched a
  // `light` value — but the pet window now writes the same four attributes the app shell writes on
  // its own root, and `light` is one of the two names. The light half of the table answers
  // `[data-theme="light"]` as well as `:root` (`styles/palettes.css:16`), and it has to: the
  // settings page's preview is an element *inside* the app's root and has to be able to name the
  // palette it draws, and the light high-contrast block
  // (`[data-theme="light"][data-color-scheme][data-contrast="high"]`) reads the attribute as a
  // value rather than as "not dark". A window that omitted it would draw one palette in this
  // window and another in the app's, for the same settings.
  expect(light.attribute).toBe('light')
  expect(light.colorScheme).toBe('light')
  // The bubble's background is that colour at the setting's alpha, so the channels are compared and
  // the alpha is not.
  expect(channelsOf(light.background)).toEqual(hexChannels(light.elevated))

  await page.evaluate(() => window.__petBubble?.setMessage({ theme: 'dark' }))
  const dark = await page.evaluate(() => window.__petBubble?.theme())
  if (!dark) throw new Error('the pet window is not mounted')
  console.log(`[pet-bubble] theme dark: ${JSON.stringify(dark)}`)
  expect(dark.attribute).toBe('dark')
  expect(dark.colorScheme).toBe('dark')
  expect(channelsOf(dark.background)).toEqual(hexChannels(dark.elevated))

  // The two palettes are the app's own two baselines, so they cannot be the same drawing; and the
  // dark one is the darker of the two. A `data-theme` value no block matches would leave both
  // readings on `:root`, which is what this pair refuses.
  expect(dark.elevated).not.toBe(light.elevated)
  expect(luminance(dark.elevated)).toBeLessThan(luminance(light.elevated))

  // And back to light: a window that only ever wrote the attribute would stay dark for a user who
  // returned to Light.
  await page.evaluate(() => window.__petBubble?.setMessage({ theme: 'light' }))
  const back = await page.evaluate(() => window.__petBubble?.theme())
  expect(back?.attribute).toBe('light')
  expect(channelsOf(back?.background ?? '')).toEqual(hexChannels(light.elevated))
})

/**
 * The channels of a computed `background-color`, as 0..255.
 *
 * Both engines this project reads report a `color-mix` in **CSS Color 4 syntax** — measured:
 * `color(srgb 1 0.996078 0.984314 / 0.92)` in Chromium here and in WebKitGTK through
 * `e2e/webkit/pet-probe.mjs` — so the older `rgb()`/`rgba()` form is here for a computed value that
 * came out of a plain declaration. A syntax neither of these matches throws rather than comparing
 * `undefined`, because a colour this spec cannot read is a measurement it must not report as a pass.
 */
function channelsOf(value: string): number[] {
  const modern = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value)
  if (modern) return modern.slice(1).map((part) => Math.round(Number(part) * 255))
  const legacy = /rgba?\(([^)]+)\)/.exec(value)
  if (legacy) return legacy[1].split(',').slice(0, 3).map((part) => Math.round(parseFloat(part)))
  throw new Error(`the engine reported no colour this spec can read: ${JSON.stringify(value)}`)
}

/** A `#rrggbb` palette value, as the same three channels. */
function hexChannels(hex: string): number[] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) throw new Error(`the page declared no plain hex colour: ${JSON.stringify(hex)}`)
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** How light a `#rrggbb` colour is, for the one comparison that is about the two of them together. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) throw new Error(`the page declared no plain hex colour: ${JSON.stringify(hex)}`)
  const value = parseInt(match[1], 16)
  return 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)
}

/**
 * The other two fields 气泡与消息 stored and nothing drew: the bubble's text size and the style of
 * the row's state dot.
 *
 * Both are the same shape of defect as the theme and both are fixed the same way — the field rides
 * the `message` payload on the appearance read, the surface takes it, and the case writes each one
 * through the host while the pet window is already up, which is the path a settings save takes.
 */
test('the text size and the dot style the user picks are what the bubble draws', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  await mountAt(page, { size: DEFAULT_SIZE, runs: ['chrome-run'], message: { fontSize: 10, dot: 'plain' } })

  const plain = await page.evaluate(() => window.__petBubble?.chrome())
  if (!plain) throw new Error('the pet window is not mounted')
  console.log(`[pet-bubble] chrome plain: ${JSON.stringify(plain)}`)
  // The size reaches the surface *and* the rows inside it, which is the half a component that set
  // `font-size` on itself would get wrong.
  expect(plain.fontSize).toBe('10px')
  expect(plain.rowFontSize).toBe('10px')
  // And the dot is a disc: round, with nothing generated into it.
  expect(plain.dot).toBe('50%')
  expect(plain.dotGlyph).toBe('none')

  await page.evaluate(() => window.__petBubble?.setMessage({ fontSize: 14, dot: 'claude' }))
  const claude = await page.evaluate(() => window.__petBubble?.chrome())
  if (!claude) throw new Error('the pet window is not mounted')
  console.log(`[pet-bubble] chrome claude: ${JSON.stringify(claude)}`)
  expect(claude.fontSize).toBe('14px')
  expect(claude.rowFontSize).toBe('14px')
  // Upstream's `claude` dot is a glyph on a square box (`windows/src/styles.css:149-158`), so both
  // halves of the change are read: the disc's `border-radius` is gone and something is drawn.
  expect(claude.dot).toBe('0px')
  expect(claude.dotGlyph).not.toBe('none')
})
