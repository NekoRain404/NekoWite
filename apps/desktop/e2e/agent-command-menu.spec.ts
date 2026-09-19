/**
 * The `/` menu, driven from the product's own mount points.
 *
 * `/` commands are the one surface whose state arrives *unasked*: the engine publishes its list
 * after `session/new` (P0 §2.2) and the panel offers it only while the composer's text is an
 * unfinished `/token`. Everything in that chain existed on its own — the composable, the view
 * type, the labels, the key handling, their tests — and the surface is where the chain is either
 * joined or not: a menu that is built, unit-tested and **mounted nowhere** looks exactly like a
 * working one from inside every file that mentions it. So this file drives the reader's own route
 * to it and asserts what is on screen at the end.
 *
 * ## The click path, hop by hop (each `file:line` is where the next hop is written)
 *
 *   `AppShell.vue:439-455` the status bar's first button (`App.vue:42` starts the rail closed)
 *   → `.rail-body`, `ui/InfoRail.vue:80`
 *   → `AppShell.vue:468` fills the rail's `body` slot with `app/AgentRailBody.vue` while the
 *     `agentPanel` setting is on (`AppShell.vue:463`)
 *   → `app/AgentRailBody.vue:176` mounts `features/agent/components/AgentPanel.vue` on the live
 *     runtime
 *   → `AgentPanel.vue:440` mounts `AgentCommandMenu.vue` — **the hop that had no test**
 *   → `AgentPanel.vue:228` `useAgentCommandMenu({ view, text: draft })`
 *   → `composables/use-agent-command-menu.ts:52` `useAgentCommands` (the state) and `:61`
 *     `store.observeEvents` (the frames)
 *   → `composables/use-agent-commands.ts:259` `accept(event)` keeps the published list, `:218`
 *     `view` decides what is drawn
 *   → typing: `components/AgentComposer.vue:366` `@keydown` → `AgentComposer.vue:291`'s
 *     `onKeydown` → `props.resolveKey` (`AgentPanel.vue:456`, which is the menu's own
 *     `onKeydown`) → `use-agent-commands.ts:298`
 *   → settling on a row: `AgentCommandMenu.vue:120`'s click or `use-agent-commands.ts:322`'s
 *     Enter → `use-agent-command-menu.ts:89` `choose` → the panel's draft.
 *
 * The panel is mounted here into the rail's own body element — the element the product mounts it
 * in, on the product's own page, through the same rail button a reader presses — rather than on
 * `document.body` (`e2e/agent-panel.spec.ts` explains why that older file mounts its own host).
 * The runtime behind it is T1's memory double, because a real engine is not something a browser
 * run may start, and the frame below is the shape P0 measured the engine pushing.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** The host the panel is mounted into, and the handle the spec drives it through. */
const HOST_ID = 'agent-command-e2e'

interface CommandHarness {
  /** Publish a list for this session, the way the engine does after `session/new`. */
  publish: (commands: Array<{ name: string, description?: string }>) => Promise<void>
  /** Every text the panel handed the gateway, so "Enter sent nothing" is a claim about a call. */
  prompts: string[]
}

declare global {
  interface Window {
    __agentCommand?: CommandHarness & { app: { unmount(): void }, host: HTMLElement }
  }
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
 * Open the rail the way a reader does, then mount the real panel into its body element.
 *
 * `gateway.emit` is the double's own door for a notification, which is what the engine's list is
 * (it is not a reply to anything this window asked for). `prompt` is wrapped so the spec can say
 * that settling on a row *inserted* a name instead of sending it.
 */
async function mountPanelInRail(page: Page): Promise<void> {
  const deps = await viewDeps(page)
  await page.evaluate(async ({ deps: urls, hostId }: { deps: { vue: string, pinia: string }, hostId: string }) => {
    const vue = (await import(/* @vite-ignore */ urls.vue)) as typeof import('vue')
    const pinia = (await import(/* @vite-ignore */ urls.pinia)) as typeof import('pinia')
    const { AgentPanel } = await import('/src/features/agent/index.ts')
    const { createMemoryAgentGateway } = await import('/src/platform/gateways/memory-agent.ts')
    const { useAgentSessionStore } = await import('/src/features/agent/stores/agent-session.ts')
    const { agentPanelLabels } = await import('/src/app/AgentRailBody.vue')

    const gateway = createMemoryAgentGateway({
      agentId: 'memory-e2e',
      profileId: 'e2e',
      capabilities: { 'slash-commands': { status: 'available' } },
    })
    await gateway.start()
    const session = await gateway.openSession({ vaultId: 'e2e-vault', cwd: '/vault' })

    const piniaInstance = pinia.createPinia()
    pinia.setActivePinia(piniaInstance)
    useAgentSessionStore()

    const prompts: string[] = []
    const prompt = gateway.prompt.bind(gateway)
    gateway.prompt = (target, text, attachments = []) => {
      prompts.push(text)
      return prompt(target, text, attachments)
    }

    const rail = document.querySelector('.rail-body')
    if (rail === null) throw new Error('the rail drew no body element to mount the panel in')
    const host = document.createElement('div')
    host.id = hostId
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
    window.__agentCommand = {
      app,
      host,
      prompts,
      publish: async (commands) => {
        gateway.emit(session, { kind: 'commands-changed', payload: { commands } })
        // The store commits frames into Vue's queue; one turn of the loop lets the panel redraw.
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    }
  }, { deps, hostId: HOST_ID })
  await page.locator('[data-agent-panel]').waitFor({ state: 'visible', timeout: 5000 })
}

/**
 * Type into the panel's own field, through the keyboard rather than by assigning a value.
 *
 * The field is emptied first, with a selection and a keystroke, because the point of every call
 * below is what a *particular* text makes the menu do — a test that appended to whatever was
 * there would be asserting about a token nobody chose.
 */
async function type(page: Page, text: string): Promise<void> {
  const field = page.locator('.agent-composer-field')
  await field.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
}

test('the `/` menu is drawn over the composer and settles on a row without sending', async ({ page }) => {
  await openNote(page)

  // The rail button, and then the body element the shell fills: everything below is inside what
  // a reader's own press drew.
  await page.locator('.status-btn').first().click()
  await page.locator('.rail-body').waitFor({ state: 'visible', timeout: 5000 })
  await mountPanelInRail(page)

  const menu = page.locator('.agent-command-menu')
  const field = page.locator('.agent-composer-field')

  // Nothing published yet: the menu is still there, and it says which kind of nothing this is
  // (`waiting` rather than `empty`), which is the distinction the composable keeps and the
  // store's reduced view cannot.
  await type(page, '/')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-view', 'waiting')

  // The list the engine publishes for this session, in the frame P0 measured it pushing.
  await page.evaluate(() => window.__agentCommand?.publish([
    { name: 'review', description: 'Review what changed' },
    { name: 'refactor', description: 'Rewrite a selection' },
    { name: 'init', description: 'Scaffold the vault' },
  ]))

  // The token filters the engine's list and the rows carry the engine's own names.
  await type(page, '/re')
  await expect(menu).toHaveAttribute('data-view', 'rows')
  await expect(page.locator('.agent-command-item')).toHaveCount(2)
  await expect(page.locator('.agent-command-item').first()).toContainText('/review')

  // On screen, not merely in the DOM: the box floats over the field it belongs to, which is the
  // rule the panel's own stylesheet states (`AgentPanel.vue:563`'s `bottom: calc(100% + 4px)`).
  const box = await menu.boundingBox()
  const fieldBox = await field.boundingBox()
  expect(box, 'the menu is drawn with no box at all').not.toBeNull()
  expect(fieldBox, 'the composer field is drawn with no box at all').not.toBeNull()
  expect(box!.width, 'the menu has no width').toBeGreaterThan(0)
  expect(box!.y + box!.height, 'the menu does not sit above the field it belongs to')
    .toBeLessThanOrEqual(fieldBox!.y + 4)

  // ArrowDown moves the row Enter would take; the highlight is the component's own claim.
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.agent-command-item.is-active')).toContainText('/refactor')

  // Enter settles on the highlighted row: the token becomes the command's published name and a
  // separator, the menu closes, and **nothing was sent** — a command runs by the message being
  // sent, not by the row being chosen (§4.1).
  await page.keyboard.press('Enter')
  await expect(field).toHaveValue('/refactor ')
  await expect(menu).toBeHidden()
  expect(await page.evaluate(() => window.__agentCommand?.prompts ?? ['<no harness>']))
    .toEqual([])

  // And a click is the same settlement on the row that was clicked — the other half of the pair
  // the composable hands one function to (`use-agent-command-menu.ts:86`).
  await type(page, '/re')
  await page.locator('.agent-command-item').first().click()
  await expect(field).toHaveValue('/review ')
  expect(await page.evaluate(() => window.__agentCommand?.prompts ?? ['<no harness>']))
    .toEqual([])
})

test('a reader who never opened a switch reaches the agent rail, not the chat panel', async ({ page }) => {
  // The hop this case guards was the whole of the maintainer's report: 「AI 界面没有 / 命令提示」.
  // Everything about the menu was wired and covered — this file's other two cases walk to it — but
  // the rail drew `ChatPanel` until `agentPanel` was switched on, and the chat panel has no `/`
  // menu. So the two cases above passed while the reader saw nothing, because both of them mount
  // the panel into `.rail-body` themselves. This one presses the same button and mounts nothing:
  // whatever is in the rail afterwards is what a fresh profile gets.
  //
  // No `localStorage` is written and none is needed — a page Playwright opened has never stored
  // this key — so the assertion is about the *default* and nothing else.
  await openNote(page)
  await page.locator('.status-btn').first().click()
  await page.locator('.rail-body').waitFor({ state: 'visible', timeout: 5000 })

  await expect(page.locator('.chat-panel')).toHaveCount(0)
  // The browser path has no Tauri, so `AgentRailBody` cannot reach `'live'` and states the refusal
  // instead — which is the panel's own answer, and the point: the rail is the agent's, and it is
  // the agent that cannot start here, not a chat panel that replaced it.
  await expect(page.locator('[data-agent-rail]')).toHaveCount(1)
})

test('the menu closes on anything that is no longer an unfinished `/token`', async ({ page }) => {
  await openNote(page)
  await page.locator('.status-btn').first().click()
  await page.locator('.rail-body').waitFor({ state: 'visible', timeout: 5000 })
  await mountPanelInRail(page)
  // One command with no description: the contract allows that and the row must not grow an
  // empty second line for it (the validator refuses an empty *string*, so the field is absent).
  await page.evaluate(() => window.__agentCommand?.publish([{ name: 'review' }]))

  const menu = page.locator('.agent-command-menu')
  await type(page, '/')
  await expect(menu).toBeVisible()

  // A space ends the token: from there on the reader is typing arguments, and the menu is done.
  await page.keyboard.type(' ')
  await expect(menu).toBeHidden()

  // A token no published command matches says so rather than drawing an empty box.
  await page.locator('.agent-composer-field').fill('/zzz')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-view', 'no-match')
})
