/**
 * The agent panel's three detached popups resolve the appearance the *shell* carries.
 *
 * The other half of the family `e2e/popup-host-scope.spec.ts` measures; this file is the three
 * surfaces that belong to the panel, and its claim, its instrument and its fences are that file's:
 * the equality of two independently measured values, read off the popup and off `.shell`, with
 * `:root` as the fence. See it for the table of what each teleport used to be and for why the
 * appearance must come from `.shell` at all (`AppShell.vue:285-292`).
 *
 * | surface                 | the teleport it used to make                       |
 * |-------------------------|----------------------------------------------------|
 * | the options menu        | `features/agent/components/AgentPanel.vue:453`     |
 * | the engine's sessions   | `features/agent/components/AgentPanel.vue:474`     |
 * | the config option list  | `features/agent/components/AgentConfigPicker.vue`  |
 *
 * ## Where the panel is mounted, and why that is the product's own mount point
 *
 * The panel's slot in the app is the right rail: `AppShell.vue:421` fills `InfoRail`'s `body` slot
 * with `AgentRailBody.vue`, which mounts `AgentPanel` on the runtime the shell opened. That
 * wiring needs a real engine — `agent_rail.ts` refuses in sentences when there is none — so this
 * file does what `agent-panel.spec.ts` does one layer in and mounts the panel against the memory
 * double instead. What it does *not* do, and the reason it is a separate file from that one, is
 * append the host to `document.body`: the panel is mounted **into the rail's own body element**,
 * which is the element the product mounts it in, on the product's own page, with the product's own
 * labels (`app/AgentRailBody.vue`'s `agentPanelLabels`). A host on `body` would be a page the
 * product never has, and — for this file specifically — a panel that never had a `.shell` to be
 * inside, which is the whole property under test.
 *
 * The rail is opened the way a user opens it (`AppShell.vue:439-455`'s status-bar button, which
 * `App.vue:42` starts false), so `.rail-body` exists because a press made it exist.
 *
 * ## The click path to each surface, hop by hop
 *
 *   the rail button → `.rail-body` → the mounted panel
 *   → `AgentSessionBar.vue:358` the history control (`[data-agent-history]`, drawn only when the
 *     engine's capability report says the harness answers `session/list`)
 *      → `AgentPanel.vue`'s `useAgentSessionHistory` → the list this file reads
 *   → `AgentSessionBar.vue:382` the options control (`[data-agent-menu]`)
 *      → `useAgentPanelMenu`'s `toggle` → the menu this file reads
 *   → `AgentConfigRow.vue`'s `.agent-config-trigger`
 *      → `AgentConfigPicker.vue`'s own press handler → the option list this file reads
 *
 * Nothing here claims anything about WebKitGTK; `e2e/webkit/pet-probe.mjs` carries the same
 * measurement in the engine that ships, and names it there.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The eight properties `AppShell.vue:271-280` publishes, in the order it writes them. */
const SHELL_PROPERTIES = [
  '--app-sidebar-width',
  '--app-rail-width',
  '--app-notelist-width',
  '--app-body-size',
  '--app-line-height',
  '--app-font',
  '--app-mono-font',
  '--app-editor-font',
] as const

/** The five the four `data-*` axes select out of `palettes.css`; all five are driven below. */
const PALETTE_PROPERTIES = [
  '--app-elevated',
  '--app-text',
  '--app-accent',
  '--app-border',
  '--app-shadow-menu',
] as const

const DRIVEN = ['--app-body-size', '--app-line-height', '--app-font'] as const

const BODY_SIZE = 17
const LINE_HEIGHT = 2
const UI_FONT = 'serif'
const LIGHT_TEXT = 'rgb(41, 42, 39)'
const DARK_TEXT = 'rgb(232, 243, 226)'
const LIGHT_FACE = 'color(srgb 0.998431 0.994353 0.982275)'
const LIGHT_SHADOW = 'rgba(37, 33, 27,'
const DARK_SHADOW = 'rgba(0, 0, 0,'

interface SurfaceReading {
  properties: Record<string, string>
  fontFamily: string
  color: string
  background: string
  boxShadow: string
  borderColor: string
}

/**
 * Open the settings dialog on Appearance and drive it to values the token block cannot produce —
 * the same door, the same four clicks and the same two fields `popup-host-scope.spec.ts` uses.
 */
async function driveAppearance(page: Page): Promise<void> {
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.dialog-nav .nav-row').nth(1).click()
  const content = page.locator('.dialog-content')
  await content.locator('.view-modes .switch-option').nth(1).click()
  await content.locator('.color-scheme-card[data-scheme="forest"]').click()
  await content.locator('.accent-swatch[aria-label="teal"]').click()
  const size = content.locator('input[type="number"]').first()
  await size.fill(String(BODY_SIZE))
  await size.press('Enter')
  const leading = content.locator('input[type="number"]').nth(1)
  await leading.fill(String(LINE_HEIGHT))
  await leading.press('Enter')
  await content.locator('#settings-ui-font').click()
  await page.locator('.select-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.select-popup .select-option[data-value="' + UI_FONT + '"]').click()
  await page.locator('.select-popup').waitFor({ state: 'detached', timeout: 5000 })
  await page.waitForFunction(
    ({ size: wanted, leading: wantedLeading, font }) => {
      const shell = document.querySelector('.shell')
      if (!shell) return false
      const style = getComputedStyle(shell)
      return style.getPropertyValue('--app-body-size').trim() === wanted
        && style.getPropertyValue('--app-line-height').trim() === wantedLeading
        && style.fontFamily.includes(font)
    },
    { size: `${BODY_SIZE}px`, leading: String(LINE_HEIGHT), font: 'Source Serif' },
    { timeout: 5000 },
  )
  await page.keyboard.press('Escape')
  await page.locator('.settings-overlay').waitFor({ state: 'detached', timeout: 5000 })
}

/** The dev server's URLs for the two dependencies the page's modules already use. */
async function viewDeps(page: Page): Promise<{ vue: string, pinia: string }> {
  return page.evaluate(async () => {
    const source = await (await fetch('/src/main.ts')).text()
    const find = (name: string): string => {
      const match = source.match(new RegExp(`["']([^"']*/deps/${name}\\.js[^"']*)["']`))
      if (match === null) throw new Error(`the dev server serves no ${name} dependency`)
      return match[1]
    }
    return { vue: find('vue'), pinia: find('pinia') }
  })
}

/**
 * Mount the real panel into the rail's own body element.
 *
 * The gateway declares `session-list`, because the history control is gated on the capability
 * report (`AgentSessionBar.vue:354`) and a case that read an element which never rendered would
 * pass for the wrong reason. The keys `__agentPopups` publishes are for the teardown below; the
 * session record lives in the Pinia store, which is created here and kept for the run.
 */
async function mountPanel(page: Page): Promise<void> {
  const deps = await viewDeps(page)
  await page.evaluate(async ({ deps: urls }) => {
    const vue = (await import(/* @vite-ignore */ urls.vue)) as typeof import('vue')
    const pinia = (await import(/* @vite-ignore */ urls.pinia)) as typeof import('pinia')
    const { AgentPanel } = await import('/src/features/agent/index.ts')
    const { createMemoryAgentGateway } = await import('/src/platform/gateways/memory-agent.ts')
    const { useAgentSessionStore } = await import('/src/features/agent/stores/agent-session.ts')
    const { agentPanelLabels } = await import('/src/app/AgentRailBody.vue')

    const gateway = createMemoryAgentGateway({
      agentId: 'memory-e2e',
      profileId: 'e2e',
      capabilities: { 'session-list': { status: 'available' } },
    })
    await gateway.start()
    const session = await gateway.openSession({ vaultId: 'e2e-vault', cwd: '/vault' })

    const piniaInstance = pinia.createPinia()
    pinia.setActivePinia(piniaInstance)
    useAgentSessionStore()

    const rail = document.querySelector('.rail-body')
    if (rail === null) throw new Error('the rail drew no body element to mount the panel in')
    const host = document.createElement('div')
    host.id = 'agent-e2e-popups'
    host.style.cssText = 'height: 600px; display: flex;'
    rail.append(host)

    const app = vue.createApp(AgentPanel, {
      gateway,
      session,
      cwd: '/vault',
      openable: true,
      settingsOpenable: true,
      chatOpenable: true,
      labels: agentPanelLabels('memory-e2e'),
    })
    app.use(piniaInstance)
    app.mount(host)
    ;(window as unknown as { __agentPopups?: unknown }).__agentPopups = { app, host }
  }, { deps })
  await page.locator('[data-agent-panel]').waitFor({ state: 'visible', timeout: 5000 })
}

async function unmountPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = (window as unknown as { __agentPopups?: { app: { unmount(): void }, host: HTMLElement } })
      .__agentPopups
    held?.app.unmount()
    held?.host.remove()
  })
}

/** One popup's cascade against the shell's and the page root's. */
async function readPopup(page: Page, popup: string): Promise<{
  shell: SurfaceReading
  token: SurfaceReading
  popup: SurfaceReading
  parent: string
  inShell: boolean
}> {
  return page.evaluate(
    ({ properties, popup }: { properties: readonly string[], popup: string }) => {
      const surface = (selector: string): SurfaceReading => {
        const el = selector === ':root'
          ? document.documentElement
          : document.querySelector(selector)
        if (!el) throw new Error(`no element for ${selector}`)
        const cs = getComputedStyle(el)
        const out: Record<string, string> = {}
        for (const name of properties) out[name] = cs.getPropertyValue(name).trim()
        return {
          properties: out,
          fontFamily: cs.fontFamily,
          color: cs.color,
          background: cs.backgroundColor,
          boxShadow: cs.boxShadow,
          borderColor: cs.borderTopColor,
        }
      }
      const element = document.querySelector(popup)
      if (!element) throw new Error(`no element for ${popup}`)
      return {
        shell: surface('.shell'),
        token: surface(':root'),
        popup: surface(popup),
        parent: element.parentElement?.className ?? '',
        inShell: element.closest('.shell') !== null,
      }
    },
    { properties: [...SHELL_PROPERTIES, ...PALETTE_PROPERTIES], popup },
  )
}

/** The same four claims `popup-host-scope.spec.ts` makes, with the popup named in each message. */
function assertSurface(
  read: Awaited<ReturnType<typeof readPopup>>,
  where: string,
  options: { face?: boolean, shadow?: boolean } = {},
): void {
  expect(read.inShell, `${where}: the popup is drawn inside the element that carries the appearance`)
    .toBe(true)
  for (const name of [...SHELL_PROPERTIES, ...PALETTE_PROPERTIES]) {
    expect(
      read.popup.properties[name],
      `${where}: the popup resolves ${name} to what the shell published`,
    ).toBe(read.shell.properties[name])
  }
  expect(read.shell.properties['--app-body-size'], `${where}: the shell publishes the driven size`)
    .toBe(`${BODY_SIZE}px`)
  expect(read.token.properties['--app-body-size'], `${where}: the page root's fallback`)
    .toBe('15px')
  expect(read.shell.properties['--app-line-height'], `${where}: the shell publishes the leading`)
    .toBe(String(LINE_HEIGHT))
  expect(read.token.properties['--app-line-height'], `${where}: the page root's fallback`)
    .toBe('1.8')
  for (const name of [...DRIVEN, ...PALETTE_PROPERTIES]) {
    expect(read.popup.properties[name], `${where}: ${name} is not the page root's`)
      .not.toBe(read.token.properties[name])
  }
  if (options.face === true) {
    expect(read.popup.background, `${where}: the face is not the light palette's elevated`)
      .not.toBe(LIGHT_FACE)
    const channels = read.popup.background.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
    expect(channels, `${where}: the face is a mix, read as ${read.popup.background}`).toHaveLength(3)
    expect(Math.max(...channels), `${where}: the face is dark, read as ${read.popup.background}`)
      .toBeLessThan(0.5)
  }
  if (options.shadow === true) {
    expect(read.popup.boxShadow, `${where}: the shadow is not the light palette's`)
      .not.toContain(LIGHT_SHADOW)
    expect(read.popup.boxShadow, `${where}: the shadow is the dark one`).toContain(DARK_SHADOW)
  }
}

test('the agent panel’s three popups resolve the shell’s appearance', async ({ page }) => {
  await openNote(page)
  await driveAppearance(page)

  // `AppShell.vue:439-455` — the status bar's first button, whose `toggle-rail` is what draws the
  // rail and its body element (`App.vue:42` starts `railOpen` false).
  await page.locator('.status-btn').first().click()
  await page.locator('.rail-body').waitFor({ state: 'visible', timeout: 5000 })
  await mountPanel(page)

  // ---- The options menu: `AgentSessionBar.vue:382`, through the panel's own toggle. -----------
  await page.locator('[data-agent-menu]').click()
  await page.locator('[data-agent-menu-popup]').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(400)
  const menu = await readPopup(page, '[data-agent-menu-popup]')
  assertSurface(menu, 'the options menu', { face: true, shadow: true })
  // The rows carry `color: var(--app-text)` (`AgentPanelMenu.vue`) and so does the panel behind
  // them (`AgentPanel.vue:524`), so the pair is the engine's answer rather than a literal.
  const menuRow = await page.evaluate(() => {
    const row = document.querySelector('.agent-menu-row')
    const panel = document.querySelector('.agent-panel')
    if (!row || !panel) throw new Error('the menu drew no row')
    return { row: getComputedStyle(row).color, panel: getComputedStyle(panel).color }
  })
  expect(menuRow.row, 'the options menu: a row draws the colour the panel behind it draws')
    .toBe(menuRow.panel)
  expect(menuRow.row, 'the options menu: which is the dark palette’s text').toBe(DARK_TEXT)
  expect(menuRow.row, 'the options menu: and not the light one').not.toBe(LIGHT_TEXT)
  await page.keyboard.press('Escape')
  await page.locator('[data-agent-menu-popup]').waitFor({ state: 'detached', timeout: 5000 })

  // ---- The engine's sessions: `AgentSessionBar.vue:358`, drawn on the capability report. ------
  await page.locator('[data-agent-history]').click()
  await page.locator('.agent-history-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(400)
  const history = await readPopup(page, '.agent-history-popup')
  assertSurface(history, 'the session list', { face: true, shadow: true })
  const historyRow = await page.evaluate(() => {
    // The **row**, and the option inside it as well. The row is the element that carries the states
    // (`is-active`, `is-current`, `is-confirming`) and the box a reader's eye is on, and until this
    // case read it, it declared no colour at all: its computed value was the UA's `rgb(0, 0, 0)`,
    // which no palette has, and every future child that forgot to declare its own would have drawn
    // it. Both are read because both have to be the palette's text — the row because it is the
    // surface, the option because it is the text — and the option now inherits rather than
    // restating it, so a pair that drifted apart would be two answers to one question.
    const row = document.querySelector('.agent-history-row')
    const option = document.querySelector('.agent-history-option')
    const panel = document.querySelector('.agent-panel')
    if (!row || !option || !panel) throw new Error('the history list drew no row')
    return {
      row: getComputedStyle(row).color,
      option: getComputedStyle(option).color,
      panel: getComputedStyle(panel).color,
    }
  })
  expect(historyRow.row, 'the session list: the row draws the colour the panel behind it draws')
    .toBe(historyRow.panel)
  expect(historyRow.row, 'the session list: which is the dark palette’s text').toBe(DARK_TEXT)
  expect(historyRow.option, 'the session list: and the option inside it draws the row’s text')
    .toBe(historyRow.row)

  // The one state in that list that is drawn in a colour, and the one that was dead: `is-current`
  // is put on the *row* (`AgentSessionHistoryRow.vue`'s class binding) and the rule that reads it
  // asked for it on the option, so the session the reader is in wore the same colour as every other
  // row. The accent is measured rather than restated — a probe styled with the token, put in the
  // shell and taken out again — so this is two independently read values and not this file's copy
  // of a palette.
  const current = await page.evaluate(() => {
    const title = document.querySelector('.agent-history-row.is-current .agent-history-option-title')
    const shell = document.querySelector('.shell')
    if (!title || !shell) throw new Error('the history list drew no current row')
    const probe = document.createElement('span')
    probe.style.color = 'var(--app-accent)'
    shell.append(probe)
    const accent = getComputedStyle(probe).color
    probe.remove()
    return { title: getComputedStyle(title).color, accent }
  })
  expect(current.title, 'the session list: the session on screen is drawn in the accent')
    .toBe(current.accent)
  expect(current.title, 'the session list: which is not the colour of an ordinary row')
    .not.toBe(DARK_TEXT)
  await page.keyboard.press('Escape')
  await page.locator('.agent-history-popup').waitFor({ state: 'detached', timeout: 5000 })

  // ---- The config option's list: `AgentConfigRow.vue`'s trigger, in the composer's control row.
  await page.locator('.agent-config-trigger').first().click()
  await page.locator('.agent-config-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(400)
  const config = await readPopup(page, '.agent-config-popup')
  assertSurface(config, 'the config option list', { face: true, shadow: true })
  const configRow = await page.evaluate(() => {
    const row = document.querySelector('.agent-config-option')
    const trigger = document.querySelector('.agent-config-trigger')
    if (!row || !trigger) throw new Error('the option list drew no row')
    return {
      row: getComputedStyle(row).color,
      trigger: getComputedStyle(trigger).color,
      rowFont: getComputedStyle(row).fontFamily,
    }
  })
  expect(configRow.rowFont, 'the config option list: a row draws the face the shell draws')
    .toBe(config.shell.fontFamily)
  expect(configRow.rowFont, 'the config option list: which is Source Serif 4')
    .toContain('Source Serif 4')
  // The row is drawn at the trigger's colour when the engine says it is the current value
  // (`AgentConfigOptionsPopup.vue`), so the pair is read as an inequality against the light
  // palette instead: the *property* equality above is what carries the claim here, and this is
  // the fence that says the drawing moved.
  expect(configRow.row, 'the config option list: a row is not the light palette’s text')
    .not.toBe(LIGHT_TEXT)

  await page.keyboard.press('Escape')
  await page.locator('.agent-config-popup').waitFor({ state: 'detached', timeout: 5000 })
  await unmountPanel(page)
})

/**
 * The panel's controls, pressed **while the rail carrying them is still arriving** — the placement
 * half of the same recipe, which the three cases above never measure because they read at rest.
 *
 * `useDetachedPopup` re-placed on the window's `resize`/`scroll` and on either box *changing size*,
 * and a `ResizeObserver` cannot see a movement: the rail arrives on a `translate`
 * (`appShell.css:181-185`, `--app-motion-drawer-offset`), which moves the control without changing
 * one number of its box. So a press made during the drawer was placed against a control that went
 * on moving, and stayed where that control had been — **55px** in Chromium, measured here before
 * the fix.
 *
 * ## Why the rail, and why the picker
 *
 * The drawer is the one transform in the product that carries a panel control: every other motion
 * an agent popup could sit through is either a size change (the history list arriving, which the
 * `ResizeObserver` does catch — measured, `AgentSessionHistory.test.ts`'s own family) or an opacity
 * fade (`rail-panel-enter-active`, which moves nothing). The *config* picker is the control that
 * can show it: the rail is pinned to the window's right edge, so the history list and the options
 * menu are clamped back to their floor and a horizontal drift is invisible in them, while the
 * picker's list is narrow enough to sit beside its trigger unclamped.
 *
 * ## The instrument, and the half of it that had to change
 *
 * **The press is forced, and the run is warmed.** `click()` waits for an element to hold still for
 * two frames, so an unforced press lands after the drawer has finished and reads the correct 0 on
 * an unfixed tree — measured: 0 unforced, 55 forced. The warm pass exists because the module graph
 * has to be resolved before the drawer can be caught at all: the mount costs ~6ms warm against a
 * 300ms drawer, and leaving the imports cold put the whole animation behind the mount.
 *
 * **The instrument reports whether it caught the drawer**, and the case fails if it did not. That
 * is the half that keeps this from being a check that passes for the wrong reason: a press that
 * landed after the rail had settled would read a correct `dx` on any tree at all. The control's
 * own left edge, read at the press and again at rest, is the number that says the press was inside
 * the movement.
 *
 * ## The click path, hop by hop
 *
 *   `AppShell.vue:488-490` the status bar's rail button → `App.vue:42`'s `railOpen`
 *   → `AppShell.vue:450-455` the `<Transition name="rail">`, whose enter state is the translate
 *   → `AppShell.vue:421` `InfoRail`'s body slot → this file's own mount into `.rail-body`
 *   → `AgentConfigRow.vue`'s `.agent-config-trigger`
 *   → `AgentConfigPicker.vue:261` its own press handler → `useDetachedPopup`'s `place()`
 *
 * The gateway is the memory double, exactly as the three cases above use it, and for the same
 * reason: a live engine refuses in sentences on this page.
 */
test('the config picker’s list follows its trigger while the rail is still arriving', async ({ page }) => {
  await openNote(page)

  /** Open the rail, mount the panel, and take the mount down again — the warm pass. */
  const openRailAndMount = async (): Promise<void> => {
    await page.locator('.status-btn').first().click()
    await page.locator('.rail-body').waitFor({ state: 'visible', timeout: 5000 })
    await mountPanel(page)
  }

  await openRailAndMount()
  // Warm: every dynamic import above resolved, and the components compiled. The measurement below
  // is a race against a 300ms drawer and this is the half that makes the race winnable.
  await page.waitForTimeout(800)
  await unmountPanel(page)
  await page.locator('.status-btn').first().click()
  await page.locator('.rail-body').waitFor({ state: 'detached', timeout: 5000 })
  await page.waitForTimeout(600)

  await openRailAndMount()
  const atPress = await page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>('.agent-config-trigger')
    return { left: trigger?.getBoundingClientRect().left ?? null }
  })
  // Read once more the instant the press returns: the two together are what say the press landed
  // while the control was still moving, which the placement assertions below cannot say themselves.
  // The reader's press: the moment the control is on screen, with nothing waited for.
  await page.locator('.agent-config-trigger').first().click({ force: true })
  const justAfter = await page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>('.agent-config-trigger')
    return { left: trigger?.getBoundingClientRect().left ?? null }
  })
  await page.locator('.agent-config-popup').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(1200)

  const read = await page.evaluate(() => {
    const popup = document.querySelector('.agent-config-popup') as HTMLElement | null
    const trigger = document.querySelector('.agent-config-trigger') as HTMLElement | null
    if (!popup || !trigger) throw new Error('the list or its trigger is not in the document')
    const a = trigger.getBoundingClientRect()
    const b = popup.getBoundingClientRect()
    const side = b.top + b.height / 2 < a.top + a.height / 2 ? 'above' : 'below'
    return {
      gap: side === 'above' ? a.top - b.bottom : b.top - a.bottom,
      dx: b.left - a.left,
      side,
      inside: b.left >= 0 && b.right <= window.innerWidth && b.top >= 0
        && b.bottom <= window.innerHeight,
      rect: { top: b.top, left: b.left, right: b.right, bottom: b.bottom },
      triggerRect: { top: a.top, left: a.left, bottom: a.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })

  // The instrument first: without this the placement assertions below are satisfied by a press that
  // landed after the rail had come to rest, on any tree at all.
  //
  // The number that says so is the control's *remaining* travel read as the press returns, not the
  // distance it moved overall: a press made after the drawer finished leaves nothing ahead of it,
  // and one made inside the draw leaves most of the drawer. Read at the press rather than at the
  // end because a control that moved and then moved back would satisfy the total too. It is a
  // threshold rather than an equality — the drawer is still running while this is read, and the
  // first version of this guard compared two readings of a moving element for equality and flaked.
  const ahead = Math.abs((justAfter.left ?? 0) - (read.triggerRect.left ?? 0))
  expect(
    ahead,
    `the press landed inside the draw: the control still had ${ahead}px to travel when it was pressed (${atPress.left} → ${justAfter.left} → ${read.triggerRect.left}), and a press made after the drawer settles measures nothing`,
  ).toBeGreaterThan(10)
  expect(
    read.gap,
    `the list hangs ${read.gap}px off its trigger on the ${read.side}, list ${JSON.stringify(read.rect)} of trigger ${JSON.stringify(read.triggerRect)} in a ${read.viewport.width}x${read.viewport.height} window`,
  ).toBeCloseTo(4, 1)
  expect(Math.abs(read.dx), `the list’s left edge is ${read.dx}px off the trigger’s`).toBeLessThanOrEqual(2)
  expect(read.inside, `the list is inside the window: ${JSON.stringify(read.rect)}`).toBe(true)
})
