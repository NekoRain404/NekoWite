/**
 * E2 — the pet window's surfaces, in a browser.
 *
 * §11 gives this file to D3's 仅一轻量入口，关闭/重开无泄漏 and D9's 多任务、长中文、纯文本、点击准确
 * 路由, and §12 adds three more: 不同角色大小、气泡不越屏、菜单无重叠.
 *
 * **Everything here is Chromium, through Playwright.** The one thing that is not a browser's
 * opinion is `/desktop-pet.html` itself: that is the real page the real window loads, so the
 * isolation assertions in the first test are about the document the product ships. What no test
 * below can reach is the compositor — a browser will tell you what a page *declares* about
 * transparency and nothing about whether a window manager honours it (§12: 浏览器截图不能证明原生
 * 置顶/穿透/焦点正确).
 *
 * ## Which parts are mounted, and which are missing
 *
 * `DesktopPetRoot.vue` is the window's whole root, and it draws the sprite and its host connection —
 * nothing else. The bubble, the task list and the context menu are surfaces the *composition* puts
 * beside it, and that composition is `app/desktop-pet-composition.ts`: §10.1 gives it to D12, it has
 * not landed, and `desktop-pet-entry.ts` says so out loud rather than substituting a gateway that
 * would make the window look finished (`resolveDesktopPetDependencies()` returns nothing, and its
 * test asserts that).
 *
 * So nothing here runs "an agent event arrives → the bubble appears". What is here mounts the
 * surfaces with the states a host would hand them, which is what makes their own claims checkable —
 * 多任务, 长中文, 纯文本, 点击准确路由 and the geometry. The path from a real ACP event through the
 * Rust projection and the window host is D4/D5/D12's, is measured by `R1`–`R5`, and is **not**
 * verified by anything in this file.
 *
 * ## What is deliberately absent
 *
 * D11b's 上限、收回、绑定不影响其他库 is in §10's row for E2 and is not measurable from here: the cap
 * is enforced by the Rust window host, the ball is a window of its own, and "two characters and a
 * ball" is a count of Tauri windows rather than of components. D13's report records that row as
 * unverified, with the same reason as this paragraph.
 */
import { expect, test, type Page } from '@playwright/test'
import { MARKUP_AS_TEXT, SHEET, petPhrases, petTasks } from './support/petFixture'

/** What the page-side harness holds, one mount at a time. */
interface PetHarness {
  /** A `getImageData` digest of the sprite canvas: what is drawn, as a number to compare. */
  pixels(): Promise<{ hash: string; opaque: number; transparent: number; width: number; height: number }>
  /** The sprite's CSS box and its backing store, so a DPR claim is a pair of numbers. */
  geometry(): Promise<{ client: { width: number; height: number }; backing: { width: number; height: number } }>
  /** Every task emitted by a row's click, in the order the clicks happened. */
  selected(): Promise<string[]>
  /** Every position the bubble's right-click reported. */
  menuPoints(): Promise<{ x: number; y: number }[]>
  unmount(): void
}

declare global {
  interface Window {
    __pet?: PetHarness
    __petHit?: (x: number, y: number) => boolean
    __petSetState?: (state: string) => void
  }
}

/**
 * Mount something in the pet's own page.
 *
 * `mount` is the shape of the mount: `sprite` is D2's canvas alone, `surfaces` is a pet-sized window
 * holding the bubble (and a sprite at the character's size, when one is asked for), `menu` is the
 * context menu at a chosen anchor. Every one of them mounts the **real component from the dev
 * server**, with the props the composition would pass.
 */
async function mountOnPetPage(
  page: Page,
  mount: 'sprite' | 'surfaces' | 'menu',
  payload: unknown,
): Promise<void> {
  await page.goto('/desktop-pet.html')
  await page.evaluate(
    async ({ which, data, sheetSpec }) => {
      // The entry pulls Vue in through the dev server; reading the served source is how the same
      // instance is reached by URL (a page has no import map).
      const entry = await (await fetch('/src/app/desktop-pet-entry.ts')).text()
      const vueUrl = entry.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
      if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
      const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')

      /**
       * The spritesheet, built here.
       *
       * **Dense, and that is not decoration:** `SpritePlayer.placement()` indexes the clips array
       * with the state's row (`clips[row]`), and clips are the sheet's *drawn* row blocks — so a
       * sheet with empty rows collapses the index space and state 7 draws whatever block is
       * seventh. Every row is drawn, three frames each, with a colour per row and a shape that
       * grows per frame: the row is what a state change moves, and the frame is what a repaint
       * moves, so both end up as pixel facts.
       */
      function buildSheet(spec: { cols: number; rows: number; cell: number; frames: number; inset: number }): string {
        const canvas = document.createElement('canvas')
        canvas.width = spec.cols * spec.cell
        canvas.height = spec.rows * spec.cell
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('the page has no 2d context')
        for (let row = 0; row < spec.rows; row += 1) {
          for (let frame = 0; frame < spec.frames; frame += 1) {
            const hue = (row * 40 + frame * 8) % 360
            ctx.fillStyle = `hsl(${hue} 70% 55%)`
            // Inset on every side: a transparent gutter is what separates one frame from the next
            // in the alpha-gutter slicer, so a sheet without one has exactly one frame per row.
            const grow = frame * 2
            ctx.fillRect(
              frame * spec.cell + spec.inset - grow / 2,
              row * spec.cell + spec.inset,
              spec.cell - spec.inset * 2 + grow,
              spec.cell - spec.inset * 2,
            )
          }
        }
        return canvas.toDataURL('image/png')
      }

      /** What is on a canvas, as a comparison. Alpha decides "drawn"; every channel decides "same". */
      function digest(canvas: HTMLCanvasElement) {
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('the canvas has no 2d context')
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = image.data
        let opaque = 0
        let transparent = 0
        let hash = 2166136261
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 16) opaque += 1
          else transparent += 1
          hash = Math.imul(hash ^ data[i], 16777619)
          hash = Math.imul(hash ^ data[i + 1], 16777619)
          hash = Math.imul(hash ^ data[i + 2], 16777619)
          hash = Math.imul(hash ^ data[i + 3], 16777619)
        }
        return {
          hash: (hash >>> 0).toString(16),
          opaque,
          transparent,
          width: canvas.width,
          height: canvas.height,
        }
      }

      const sheet = buildSheet(sheetSpec)
      const host = document.createElement('div')
      host.id = 'e2e-pet-surface'
      document.body.append(host)

      const selected: string[] = []
      const menuPoints: { x: number; y: number }[] = []
      const harness = (app: { unmount: () => void }): void => {
        window.__pet = {
          pixels: async () => {
            const canvas = document.querySelector<HTMLCanvasElement>('#e2e-pet-surface canvas.pet-sprite')
            if (!canvas) throw new Error('no sprite canvas is mounted')
            return digest(canvas)
          },
          geometry: async () => {
            const canvas = document.querySelector<HTMLCanvasElement>('#e2e-pet-surface canvas.pet-sprite')
            if (!canvas) throw new Error('no sprite canvas is mounted')
            return {
              client: { width: canvas.clientWidth, height: canvas.clientHeight },
              backing: { width: canvas.width, height: canvas.height },
            }
          },
          selected: async () => [...selected],
          menuPoints: async () => [...menuPoints],
          unmount: () => {
            app.unmount()
            host.remove()
          },
        }
      }

      if (which === 'sprite') {
        const sprite = (await import(
          /* @vite-ignore */ '/src/features/desktop-pet/components/PetSprite.vue'
        )) as { default: unknown }
        const options = data as { width: number; height: number; state: string }
        const mood = vue.ref(options.state)
        // `hitTest` is `defineExpose`d, so it lives on the component's exposed proxy rather than on
        // the DOM. Captured through a plain function because a component proxy is not something
        // `page.evaluate` can serialise.
        const spriteRef = vue.ref<{ hitTest: (x: number, y: number) => boolean } | null>(null)
        window.__petSetState = (next: string) => {
          mood.value = next
        }
        const app = vue.createApp({
          render: () =>
            vue.h('div', { style: `width:${options.width}px;height:${options.height}px` }, [
              vue.h(sprite.default as never, {
                ref: spriteRef,
                imageUrl: sheet,
                state: mood.value,
                width: options.width,
                height: options.height,
              }),
            ]),
        })
        app.mount(host)
        await vue.nextTick()
        window.__petHit = (x: number, y: number) => spriteRef.value?.hitTest(x, y) ?? false
        harness(app)
        return
      }

      const bubble = (await import(
        /* @vite-ignore */ '/src/features/desktop-pet/components/PetBubble.vue'
      )) as { default: unknown }

      if (which === 'surfaces') {
        const options = data as {
          /** The chat surface's own state. */
          tasks: unknown[]
          layout: Record<string, unknown>
          phrases: unknown
          /** The window, and the sprite in it. Null draws the bubble alone. */
          window: { width: number; height: number }
          sprite: { width: number; height: number } | null
        }
        const children = [
          vue.h(bubble.default as never, {
            tasks: options.tasks,
            layout: options.layout,
            phrases: options.phrases,
            now: 1_700_000_010_000,
            agentLabels: { memory: 'Memory', opencode: 'OpenCode' },
            onSelect: (task: { key: { agentId: string; sessionId: string; runId: string } }) => {
              selected.push(`${task.key.agentId}/${task.key.sessionId}/${task.key.runId}`)
            },
            onMenu: (point: { x: number; y: number }) => {
              menuPoints.push(point)
            },
          }),
        ]
        if (options.sprite) {
          const sprite = (await import(
            /* @vite-ignore */ '/src/features/desktop-pet/components/PetSprite.vue'
          )) as { default: unknown }
          children.push(
            vue.h(sprite.default as never, {
              imageUrl: sheet,
              state: 'working',
              width: options.sprite.width,
              height: options.sprite.height,
            }),
          )
        }
        const app = vue.createApp({
          render: () =>
            vue.h(
              'div',
              {
                style: `width:${options.window.width}px;height:${options.window.height}px;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;overflow:hidden`,
              },
              children,
            ),
        })
        app.mount(host)
        harness(app)
        return
      }

      const menu = (await import(
        /* @vite-ignore */ '/src/features/desktop-pet/components/PetContextMenu.vue'
      )) as { default: unknown }
      const options = data as { anchor: { x: number; y: number }; taskCount: number }
      const app = vue.createApp({
        render: () =>
          vue.h(menu.default as never, {
            open: true,
            anchor: options.anchor,
            capabilities: { taskCount: options.taskCount },
            onSelect: () => undefined,
            onClose: () => undefined,
          }),
      })
      app.mount(host)
      harness(app)
    },
    { which: mount, data: payload, sheetSpec: SHEET },
  )
}

// ---------------------------------------------------------------------------
// The window's own page
// ---------------------------------------------------------------------------

test('the pet window is the pet and nothing else', async ({ page }) => {
  await page.goto('/desktop-pet.html')

  // §7.1: 「入口只初始化桌宠，不挂载 AppShell、编辑器、整套索引和 Agent 客户端」. `desktop-pet-entry.test.ts`
  // asserts that over the *import graph*; this is the same claim over the document that graph
  // produces, which is the half a change to the page could break without the graph changing.
  for (const selector of [
    '.panes',
    '.editor-container',
    '.cm-editor',
    '.status-bar',
    '.sidebar',
    '.settings-overlay',
  ]) {
    await expect(page.locator(selector), `${selector} is not part of this window`).toHaveCount(0)
  }
  await expect(page.locator('#desktop-pet')).toBeAttached()
  await expect(page.locator('.pet-root')).toBeAttached()

  // And it says what it has: no host connection, because §9's composition is §10.1's D12 and has
  // not landed. The sentence is asserted rather than tolerated — the day the composition arrives
  // this test has to be rewritten to name the gateway that arrived and where it came from, which is
  // what keeps "unwired" from quietly becoming "wired to something nobody named".
  await expect(page.locator('.pet-root__notice')).toHaveText('This window has no host connection.')
})

test('the page declares an unbacked window, and nothing here can say whether it gets one', async ({ page }) => {
  await page.goto('/desktop-pet.html')
  const declared = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    overflow: getComputedStyle(document.body).overflow,
    margin: getComputedStyle(document.body).margin,
  }))
  console.log(
    `[pet-tasks] page background: html ${declared.html}, body ${declared.body}, overflow ${declared.overflow}, margin ${declared.margin}`,
  )

  // What the page promises the window: transparent, no margin, no scrollbars — a frameless window
  // would otherwise be a rectangle around the pet. (The rules are `DesktopPetRoot.vue`'s unscoped
  // block: the only place this page declares anything.)
  expect(declared.html).toBe('rgba(0, 0, 0, 0)')
  expect(declared.body).toBe('rgba(0, 0, 0, 0)')
  expect(declared.overflow).toBe('hidden')
  expect(declared.margin).toBe('0px')

  // The other half is not a browser's to answer: whether GTK and the compositor give the toplevel a
  // transparent backing, and whether `always-on-top` and `no-focus-steal` are honoured, are window
  // properties and a compositor's answer. §7.2's matrix is where they are measured, and
  // `linux_capabilities.rs` keeps every one of them `unverified` until something observes them.
})

// ---------------------------------------------------------------------------
// The canvas: what the sprite draws, in a real compositor-bound surface
// ---------------------------------------------------------------------------

for (const dpr of [1, 2]) {
  test(`the sprite draws real pixels and hits them the same way at devicePixelRatio ${dpr}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 420, height: 320 },
      deviceScaleFactor: dpr,
    })
    const page = await context.newPage()
    try {
      await mountOnPetPage(page, 'sprite', { width: 160, height: 180, state: 'idle' })

      // §12's canvas clause, first half: a sheet that drew nothing and a sheet that filled the cell
      // would both "load". Non-empty *and* not filled are the two halves of 非空透明像素.
      const idle = await page.evaluate(() => window.__pet?.pixels())
      if (idle === undefined) throw new Error('the sprite harness is not mounted')
      console.log(
        `[pet-tasks] dpr ${dpr} idle: opaque ${idle.opaque}, transparent ${idle.transparent}, backing ${idle.width}x${idle.height}`,
      )
      expect(idle.opaque, 'the sprite drew something').toBeGreaterThan(0)
      expect(idle.transparent, 'and left the margins transparent').toBeGreaterThan(0)

      // The backing store is the CSS box times the ratio — D2's deviation, and what keeps the pixel
      // art from being resampled by the compositor.
      const geometry = await page.evaluate(() => window.__pet?.geometry())
      expect(geometry).toEqual({
        client: { width: 160, height: 180 },
        backing: { width: 160 * dpr, height: 180 * dpr },
      })

      // …and the hit test survives the ratio (DPR 命中一致): the same CSS point hits at 1x and at
      // 2x, because the rect is in backing-store pixels and the point is scaled into them.
      const centre = await page.evaluate(() => window.__petHit?.(80, 150))
      const corner = await page.evaluate(() => window.__petHit?.(2, 2))
      expect(centre, 'the middle of the sprite is on the character').toBe(true)
      expect(corner, 'the empty corner above it is not').toBe(false)

      // 不同状态: the state chooses the row, and the row is a different colour on the sheet — so a
      // repaint that ignored the state would leave the canvas identical.
      await page.evaluate(() => window.__petSetState?.('working'))
      await expect.poll(() => page.evaluate(() => window.__pet?.pixels())).not.toEqual(idle)

      // 播放前后像素变化: the frames advance on their own — the idle rate is 3fps — so the canvas
      // changes again without anything being asked of it. Comparing the digest is what makes this a
      // frame rather than a redraw of the same one.
      await page.evaluate(() => window.__petSetState?.('idle'))
      const settled = await page.evaluate(() => window.__pet?.pixels())
      await expect
        .poll(async () => (await page.evaluate(() => window.__pet?.pixels()))?.hash, { timeout: 3000 })
        .not.toBe(settled?.hash)
    } finally {
      await context.close()
    }
  })
}

// ---------------------------------------------------------------------------
// The task list
// ---------------------------------------------------------------------------

test('the list keeps every task, in Chinese, and routes a click to the row that was clicked', async ({ page }) => {
  await mountOnPetPage(page, 'surfaces', {
    tasks: petTasks(),
    // Six fixtures, six rows: the cap is the layout's own, and this test is about the list rather
    // than about the cap. The window is deliberately taller than any pet window would be — this test
    // is about routing, and the one that measures whether the list *fits* is below.
    layout: { maxTasks: 6 },
    phrases: petPhrases(),
    window: { width: 360, height: 560 },
    sprite: null,
  })

  const rows = page.locator('#e2e-pet-surface .pet-task__row')
  await expect(rows).toHaveCount(6)
  // §6.3: a task the user is being asked about is on the surface. The ranking puts it first; nothing
  // here asserts its position, only that it is not swallowed by the working task beside it (§3.1.3).
  await expect(page.locator('#e2e-pet-surface .pet-task__row[data-state="waiting-input"]')).toHaveCount(1)

  // 长中文: every row's content fits the row's own box. A row that overflowed is readable in the DOM
  // and unreadable on screen, which is the failure the message style exists to prevent — and here
  // it is measured with the wrapping the engine actually does, not with a style object.
  const rowsMeasured = await rows.evaluateAll((els) =>
    els.map((el) => ({
      state: el.getAttribute('data-state'),
      overflow: el.scrollWidth - el.clientWidth,
      height: Math.round(el.getBoundingClientRect().height),
    })),
  )
  console.log(`[pet-tasks] rows: ${JSON.stringify(rowsMeasured)}`)
  for (const row of rowsMeasured) {
    expect(row.overflow, `row ${row.state} fits its box`).toBeLessThanOrEqual(1)
  }
  // At least one row is taller than a single line: the long Chinese sentence wrapped rather than
  // being clipped to an ellipsis nobody asserted.
  expect(Math.max(...rowsMeasured.map((row) => row.height))).toBeGreaterThan(30)

  // 点击准确路由: click **every** row in DOM order and read the whole sequence back. An off-by-one is
  // not a row that does nothing — it is a row that opens its neighbour — and a test that clicks one
  // row cannot see it. Clicking the real element with a real mouse is the half the unit test cannot
  // have: a row covered by another element would still "click" under happy-dom.
  const clicked: string[] = []
  const count = await rows.count()
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i)
    const name = await row.getAttribute('aria-label')
    expect((name ?? '').length, 'every row is named for a screen reader').toBeGreaterThan(0)
    await row.click()
    clicked.push((await row.getAttribute('data-state')) ?? '')
  }
  const selected = (await page.evaluate(() => window.__pet?.selected())) ?? []
  expect(selected).toHaveLength(count)
  console.log(`[pet-tasks] clicked in order: ${clicked.join(' → ')}`)
  expect(new Set(selected).size, 'six different tasks were routed to').toBe(6)

  // 两 Agent 同 sessionId (§3.1.1's collision): `shared-session` belongs to two engines, and both got
  // their own row and their own click — upstream collapsed same-agent sessions into one row with a
  // `×N` badge that then clicked to the first session of the group.
  const shared = selected.filter((token) => token.includes('/shared-session/'))
  expect(shared).toHaveLength(2)
  expect(shared.some((token) => token.startsWith('memory/'))).toBe(true)
  expect(shared.some((token) => token.startsWith('opencode/'))).toBe(true)
})

test('a task message is shown as text and never interpreted', async ({ page }) => {
  // The fixture is the attack rather than a sentence about it: one task, whose phrase is a real
  // `<img onerror=…>`. §5.2 keeps the phrases plain text, and the acceptance is that the surface
  // cannot turn one into an element.
  await mountOnPetPage(page, 'surfaces', {
    tasks: petTasks().slice(0, 1),
    layout: { maxTasks: 6 },
    phrases: { memory: { working: [MARKUP_AS_TEXT] } },
    window: { width: 320, height: 260 },
    sprite: null,
  })

  const row = page.locator('#e2e-pet-surface .pet-task__row').first()
  await expect(row).toContainText('<img')
  await expect(page.locator('#e2e-pet-surface img')).toHaveCount(0)
  const ran = await page.evaluate(() => (window as unknown as { __petXss?: boolean }).__petXss === true)
  expect(ran, 'the handler never ran').toBe(false)
})

// ---------------------------------------------------------------------------
// Geometry: the window is small, and nothing may leave it
// ---------------------------------------------------------------------------

/*
 * The bubble's bounds, as numbers this file holds rather than ones it imports.
 *
 * **The copies are deliberate, and they are the whole point.** `PET_BUBBLE_MAX_HEIGHT` is
 * `min(240px, 40vh)` and `PET_BUBBLE_MAX_WIDTH` is the character window's 260px; the DOM tests pin
 * those declarations. This file must not import either one: a case that read the bound out of the
 * constant would follow every change to it and go on passing, which is exactly how this case
 * stopped measuring anything the first time. The bound is stated here, the geometry is measured
 * here, and changing either one fails the other — the reconciliation is a person's.
 */
const BUBBLE_CAP_PX = 240
const BUBBLE_CAP_FRACTION = 0.4

/**
 * The width of the character window at the schema's default character size: 260, which is
 * `window_host::character_window_size(160).0` and the floor the rule keeps at every smaller size.
 * The bubble is drawn *inside* the window rather than beside it. Not imported, for the reason above.
 */
const CHARACTER_WINDOW_WIDTH = 260

/**
 * What the bubble adds around the box that grows: its own padding and border, plus the rows that
 * report what the box holds — the count of rows a count cap left out, the fold, the pager — which
 * are deliberately outside that box. 14px of it is the padding and border — measured, at the three
 * sizes of the sweep below: a 164/200/240px box under a 178/214/254px bubble — and the rest is the
 * room those reports need. It is a ceiling and not a description: the case fails if the chrome grows past it.
 */
const BUBBLE_CHROME_MAX = 60

/** The cap a window of a given height implies, evaluated from the declaration's own shape. */
function bubbleCap(windowHeight: number): number {
  return Math.min(BUBBLE_CAP_PX, BUBBLE_CAP_FRACTION * windowHeight)
}

for (const size of [80, 160, 320]) {
  test(`a ${size}px character and the bubble both stay inside the window the host sizes`, async ({ browser }) => {
    // The frame is the window a host *would* build for this character: as wide as the largest
    // character (320px) needs and no wider, and — the part that matters — as tall as the sprite
    // plus the room the bubble's bound needs, which is `min(240, 0.4 * H) + the chrome above + the
    // 6px gap`. That budget is written down before the bubble is looked at, so the assertions below
    // can fail against it; the host built today is one fixed 260x320 that ignores the character's
    // size setting, and what that window can hold is measured by the next case.
    //
    // **The history of this number, because it is the reason the case is written this way.** The
    // frame used to be `spriteHeight + 620` — an allowance derived from the 561px the bubble
    // measured before it was capped. Once the rows were bounded, nothing the bubble did could
    // approach 620px, so the case passed whatever happened: it had been written to catch exactly
    // this defect and could no longer catch it or anything like it. A smaller frame is what makes
    // the containment assertions below able to fail again.
    const spriteHeight = Math.round((size * 180) / 160)
    const frame = { width: 360, height: spriteHeight + 320 }
    const context = await browser.newContext({ viewport: frame })
    const page = await context.newPage()
    try {
      await mountOnPetPage(page, 'surfaces', {
        tasks: petTasks(),
        layout: { maxTasks: 6 },
        phrases: petPhrases(),
        window: frame,
        sprite: { width: size, height: spriteHeight },
      })

      const window_ = page.locator('#e2e-pet-surface > div')
      const sprite = page.locator('#e2e-pet-surface canvas.pet-sprite')
      const bubble = page.locator('#e2e-pet-surface .pet-bubble')
      // The one element that grows: the rows scroll inside it, and it is what the cap is applied to.
      const rows = page.locator('#e2e-pet-surface .pet-task__scroll')
      await expect(sprite).toBeVisible()
      await expect(bubble).toBeVisible()
      await expect(rows).toBeVisible()

      const frameBox = await window_.boundingBox()
      const spriteBox = await sprite.boundingBox()
      const bubbleBox = await bubble.boundingBox()
      const rowsBox = await rows.boundingBox()
      expect(frameBox).not.toBeNull()
      expect(spriteBox).not.toBeNull()
      expect(bubbleBox).not.toBeNull()
      expect(rowsBox).not.toBeNull()
      if (!frameBox || !spriteBox || !bubbleBox || !rowsBox) return

      const cap = bubbleCap(frame.height)
      console.log(
        `[pet-tasks] ${size}px: window ${frame.width}x${frame.height} (cap ${cap}px), sprite ${Math.round(spriteBox.width)}x${Math.round(spriteBox.height)}, bubble ${Math.round(bubbleBox.width)}x${Math.round(bubbleBox.height)}, rows box ${Math.round(rowsBox.height)} (${Math.round(bubbleBox.height - rowsBox.height)}px of chrome)`,
      )

      // **The measurement this case exists for.** Six long-Chinese rows are 567px of content at
      // this 260px width (561px at the 280px width D13 measured), so the box is pinned at the cap
      // from both sides: a box that is *at* the cap is a bound that holds, and a box that is far
      // short of it means the fixture stopped being tall enough to test anything. Removing the cap
      // measures the 567 here and fails on the first line; raising it past the window fails the
      // same way.
      expect(rowsBox.height).toBeGreaterThanOrEqual(cap - 1)
      expect(rowsBox.height).toBeLessThanOrEqual(cap + 1)
      // And the surface around it is bounded too, which is what a host sizing a window has to
      // leave: the box, plus the chrome, plus nothing else.
      expect(bubbleBox.height).toBeLessThanOrEqual(cap + BUBBLE_CHROME_MAX + 1)

      // The sprite is drawn at exactly the character's size: the setting is the box, and the fit is
      // inside it (D2 scales the sheet into the canvas; it does not resize the canvas).
      expect(Math.round(spriteBox.width)).toBe(size)
      // 气泡不越屏: both surfaces are inside the window on every side, at every size.
      for (const box of [spriteBox, bubbleBox]) {
        expect(box.x).toBeGreaterThanOrEqual(frameBox.x - 1)
        expect(box.x + box.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1)
        expect(box.y).toBeGreaterThanOrEqual(frameBox.y - 1)
        expect(box.y + box.height).toBeLessThanOrEqual(frameBox.y + frameBox.height + 1)
      }
      // The bubble is not wider than the window the product gives it, even in a frame wide enough
      // to allow it: the cap is the character window's width, not a number of the surface's own.
      expect(bubbleBox.width).toBeLessThanOrEqual(CHARACTER_WINDOW_WIDTH)

      // …and the message is what wraps rather than what widens the surface: a `min-width: 0` that
      // went missing would show up here as a row wider than the bubble holding it.
      const overflows = await page
        .locator('#e2e-pet-surface .pet-task__row')
        .evaluateAll((els) => els.map((el) => el.scrollWidth - el.clientWidth))
      for (const overflow of overflows) expect(overflow).toBeLessThanOrEqual(1)
    } finally {
      await context.close()
    }
  })
}

test('the bubble is bounded in the window the host actually builds', async ({ browser }) => {
  // 260x320 is what `window_host::character_window_size` answers for a 160px character — the
  // schema's default size, and the window every existing install has — and it is the one window
  // this case is about. The sweep above sizes a frame per character by a *different* budget (as
  // wide as the largest character needs, and tall enough for the bubble's own cap); what the host
  // builds is the sprite's box plus a constant slack, floored at this width. Here the cap is 128px
  // and the box has to be measured rather than assumed.
  const frame = { width: CHARACTER_WINDOW_WIDTH, height: 320 }
  const context = await browser.newContext({ viewport: frame })
  const page = await context.newPage()
  try {
    await mountOnPetPage(page, 'surfaces', {
      tasks: petTasks(),
      layout: { maxTasks: 6 },
      phrases: petPhrases(),
      window: frame,
      // The bubble alone. With the 160x180 character in it too, the two surfaces do not both fit:
      // 128 + chrome + the 6px gap + 180 is past 320, which is the host's sizing question and is
      // written up in task-191's report rather than asserted here as if it held.
      sprite: null,
    })

    const bubble = page.locator('#e2e-pet-surface .pet-bubble')
    const rows = page.locator('#e2e-pet-surface .pet-task__scroll')
    // The stand-in for the window: the same box the composition gives the surfaces, and the thing
    // the containment assertions are measured against. Not the viewport — the page carries the
    // entry's own notice above this div (measured: 32.8px at this height), which is furniture of
    // the harness rather than of the window.
    const window_ = page.locator('#e2e-pet-surface > div')
    await expect(bubble).toBeVisible()
    await expect(rows).toBeVisible()
    const frameBox = await window_.boundingBox()
    const bubbleBox = await bubble.boundingBox()
    const rowsBox = await rows.boundingBox()
    expect(frameBox).not.toBeNull()
    expect(bubbleBox).not.toBeNull()
    expect(rowsBox).not.toBeNull()
    if (!frameBox || !bubbleBox || !rowsBox) return

    const cap = bubbleCap(frame.height)
    console.log(
      `[pet-tasks] host window ${frame.width}x${frame.height}: bubble ${Math.round(bubbleBox.width)}x${Math.round(bubbleBox.height)}, rows box ${Math.round(rowsBox.height)} of a ${cap}px cap`,
    )
    expect(cap).toBe(128)
    expect(rowsBox.height).toBeGreaterThanOrEqual(cap - 1)
    expect(rowsBox.height).toBeLessThanOrEqual(cap + 1)
    expect(bubbleBox.height).toBeLessThanOrEqual(cap + BUBBLE_CHROME_MAX + 1)
    // No width assertion here, and that is not an omission: this window *is* the bubble's
    // container, so `width: 100%` decides the width and any cap at or above 260 measures the same.
    // The cap is measured where it can fail — in the sweep above, whose frame is wide enough that
    // the bubble would grow past 260 if the constant allowed it.
    // What is asserted here is containment, the 气泡不越屏 acceptance in the window the product
    // actually opens.
    expect(bubbleBox.x).toBeGreaterThanOrEqual(frameBox.x - 1)
    expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1)
    expect(bubbleBox.y).toBeGreaterThanOrEqual(frameBox.y - 1)
    expect(bubbleBox.y + bubbleBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height + 1)
  } finally {
    await context.close()
  }
})

test('the menu is placed inside the window from every corner', async ({ browser }) => {
  // 320x260 — the smallest window the pet is likely to be given. The menu is at least 150px wide and
  // taller than half that height, so both of its clamps are exercised at the corners.
  const context = await browser.newContext({ viewport: { width: 320, height: 260 } })
  const page = await context.newPage()
  try {
    for (const anchor of [
      { x: 4, y: 4 },
      { x: 316, y: 4 },
      { x: 4, y: 256 },
      { x: 316, y: 256 },
      { x: 160, y: 130 },
    ]) {
      await mountOnPetPage(page, 'menu', { anchor, taskCount: 3 })

      const menu = page.locator('#e2e-pet-surface .pet-menu')
      await expect(menu).toBeVisible()
      const box = await menu.boundingBox()
      expect(box).not.toBeNull()
      if (!box) continue
      console.log(
        `[pet-tasks] anchor ${anchor.x},${anchor.y} → menu ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`,
      )
      expect(box.x, 'inside the window on the left').toBeGreaterThanOrEqual(0)
      expect(box.y, 'inside the window on the top').toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, 'inside the window on the right').toBeLessThanOrEqual(320)
      expect(box.y + box.height, 'inside the window at the bottom').toBeLessThanOrEqual(260)

      // 菜单无重叠: three items, three boxes, and no item shares a pixel with the one before it. Rows
      // that overlapped would still be clickable in the DOM and ambiguous on screen.
      const items = await page
        .locator('#e2e-pet-surface .pet-menu__item')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))
      expect(items).toHaveLength(3)
      for (let i = 1; i < items.length; i += 1) {
        expect(
          items[i].top,
          `item ${i} starts where item ${i - 1} ended`,
        ).toBeGreaterThanOrEqual(items[i - 1].bottom - 0.5)
      }
    }
  } finally {
    await context.close()
  }
})

test('a right-click is reported at the point it happened, and the browser menu never opens', async ({ page }) => {
  await mountOnPetPage(page, 'surfaces', {
    tasks: petTasks().slice(0, 2),
    layout: { maxTasks: 6 },
    phrases: petPhrases(),
    // Tall enough for the two-row bubble: the first run of this test used 260 and the click timed
    // out, because the bubble's own top — which is where a right-click on a heading lands — was
    // outside the window and clipped. Two rows of long Chinese plus a group heading need ~270px.
    window: { width: 360, height: 480 },
    sprite: null,
  })

  const bubble = page.locator('#e2e-pet-surface .pet-bubble')
  const box = await bubble.boundingBox()
  expect(box).not.toBeNull()
  if (box) {
    // Element-based, like every other right-click in this suite (`usage.spec.ts:187`,
    // `motion-surfaces.spec.ts:540`): a raw `page.mouse.click` at the same coordinates dispatched no
    // `contextmenu` at all — measured, one run — while the locator's own click does.
    await bubble.click({ button: 'right', position: { x: 20, y: 10 } })
    const points = (await page.evaluate(() => window.__pet?.menuPoints())) ?? []
    expect(points, 'the bubble reported exactly one point').toHaveLength(1)
    // Within a couple of pixels rather than exact: Playwright's `position` is measured from the
    // element's *padding* box while `boundingBox()` is the border box, and the bubble has a 1px
    // border — so the reported point is one pixel in from where the position asked for. What the
    // menu needs is a point inside itself, which is what this checks.
    expect(Math.abs((points[0]?.x ?? 0) - (box.x + 20))).toBeLessThanOrEqual(2)
    expect(Math.abs((points[0]?.y ?? 0) - (box.y + 10))).toBeLessThanOrEqual(2)
    // The bubble calls `preventDefault` on its own context menu: a frameless window has no chrome to
    // put a browser menu under, and two menus for one surface is one too many.
  }
})
