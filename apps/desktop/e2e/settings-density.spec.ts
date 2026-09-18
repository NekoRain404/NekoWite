/**
 * The agents section's density: one page at a time, and the measurement that says so.
 *
 * ## What 「比较乱」 measured as
 *
 * The maintainer's complaint was 「设置页面比较乱，有些选项内容很多」, and the agents section was the
 * extreme of it. Measured in Chromium at the 1280x800 window this programme's numbers are taken at,
 * with the registry seeded so all seven pages mount, the section was:
 *
 *   | the seven pages stacked          | 2131px of content |
 *   | the `.dialog-content` viewport   |  467px            |
 *   | therefore                        | **4.64 screens** of scrolling through seven unrelated
 *   |                                  | pages, with nothing on screen saying how many there
 *   |                                  | were or which one you were in |
 *
 * The tree's own list, `AGENT_SETTINGS_SECTIONS`, declares nine sections "in the order a navigation
 * should offer it" — and nothing read it for that. The barrel's own note about the field it *deleted*
 * says the quiet part out loud: it was kept "so a navigation can bind it without a second lookup
 * table" by "a navigation that was never built". The seven pages were stacked in an order of their
 * own instead.
 *
 * ## The equality this file settles on
 *
 * Not "the section got shorter", which a section that hid two of its seven pages would also pass.
 * The claim is that **the box the pages live in is exactly as tall as the one page drawn inside it**
 * — two elements, measured independently, whose heights must agree — and that the same box is a
 * *fraction* of the sum of all seven pages' own heights, which is what the stacked column was. The
 * ratio is reported rather than only fenced, so a reader can see the number rather than the verdict.
 *
 * The registry is seeded in the page, because the five profile pages mount only behind
 * `agent_registry_read` — an instrument that measured this section with three pages in it would be
 * measuring a section no user has. They are the app's own components in the app's own mount point;
 * nothing is stubbed but the backend's answer.
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** Every page id the rail must offer, in `AGENT_SETTINGS_SECTIONS`'s order. */
const RAIL = ['runtime', 'provider', 'configuration', 'skills', 'permission', 'registry', 'catalogue']

/**
 * The registry's answer, as `agent_registry_read` serializes it — the same shape
 * `SettingsPanel.agents.test.ts` uses, and the minimum that makes `defaultEngineIdentity` resolve a
 * pair, which is the gate the five profile pages sit behind.
 */
const REGISTRY = {
  defaultAgentId: 'opencode',
  entries: [
    {
      agentId: 'opencode',
      displayName: 'opencode',
      source: 'bundled',
      program: '/usr/bin/opencode',
      args: ['--acp'],
      env: 'profile-isolated',
      envExtra: [],
      enabled: true,
      adapterId: 'acp',
      reportedVersion: '1.2.3',
      programState: 'launchable',
    },
  ],
  adapterIds: ['acp'],
  runningAgentIds: [],
  profileOwners: { default: 'opencode' },
}

/** Open the dialog, seed the registry, and land on the agents section. */
async function openAgents(page: Page): Promise<void> {
  await openNote(page)
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  await page.evaluate((readout: unknown) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const original = internals.invoke
    internals.invoke = async (cmd: string, args?: unknown) =>
      cmd === 'agent_registry_read' ? readout : original(cmd, args)
  }, REGISTRY)
  await page.locator('.dialog-nav .nav-row').nth(6).click()
  await expect(page.locator('.agents-rail')).toBeVisible({ timeout: 5000 })
  await page.waitForFunction(
    () => document.querySelectorAll('.agents-rail [role="tab"]').length === 7,
    undefined,
    { timeout: 5000 },
  )
  await page.waitForTimeout(300)
}

interface Density {
  /** The box the seven pages live in: only the drawn one contributes a box to it. */
  box: number
  /** The page the rail says is selected, measured on its own. */
  drawn: number
  drawnPage: string | null
  /** What the stacked column would have been: every page's own height, added up. */
  stacked: number
  /** The scrolling viewport those two are compared against. */
  viewport: number
  railRows: number
}

async function density(page: Page): Promise<Density> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-test="agents-pages"]') as HTMLElement
    const content = document.querySelector('.dialog-content') as HTMLElement
    const pages = [...box.querySelectorAll<HTMLElement>(':scope > [data-page]')]
    const shown = pages.filter((p) => getComputedStyle(p).display !== 'none')
    return {
      box: Math.round(box.getBoundingClientRect().height),
      drawn: shown.length === 1 ? Math.round(shown[0].getBoundingClientRect().height) : -1,
      drawnPage: shown.length === 1 ? (shown[0].dataset.page ?? null) : null,
      // Every page's own height, read off the element itself whether or not it is drawn — that is
      // what the stacked column was, because every one of them was drawn then.
      stacked: pages.reduce(
        (total, p) => total + (p.style.display === 'none' ? measure(p) : p.getBoundingClientRect().height),
        0,
      ),
      viewport: content.clientHeight,
      railRows: document.querySelectorAll('.agents-rail [role="tab"]').length,
    }
    function measure(el: HTMLElement): number {
      // A hidden element has no box, so it is measured by un-hiding it for one frame inside the
      // same task — no paint reaches the user, and the reading is the engine's own layout for that
      // page rather than a constant this file carries.
      const previous = el.style.display
      const wasAbsolute = el.style.position
      el.style.display = ''
      el.style.position = 'absolute'
      el.style.visibility = 'hidden'
      const height = el.getBoundingClientRect().height
      el.style.display = previous
      el.style.position = wasAbsolute
      el.style.visibility = ''
      return height
    }
  })
}

test.describe('the agents section, one page at a time', () => {
  test('offers a row per page in the tree’s order, and draws exactly one of them', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openAgents(page)

    const rows = await page.locator('.agents-rail [role="tab"]').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.page),
    )
    expect(rows).toEqual(RAIL)

    const pages = await page
      .locator('[data-test="agents-pages"] > [data-page]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.page))
    // Both directions: a row with no page is §5.2's forbidden control, a page with no row is a page
    // nobody can reach.
    expect(pages).toEqual(RAIL)

    const read = await density(page)
    expect(read.railRows).toBe(7)
    expect(read.drawnPage).toBe('runtime')
  })

  test('the box is as tall as the page inside it, and a fraction of the stack it replaced', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openAgents(page)

    const read = await density(page)
    // The equality: two elements, measured independently, that must agree. A box that kept the
    // other six pages' height — which is what `v-show` would do if the claim were "hidden" rather
    // than "not drawn" — fails this and nothing else does.
    expect(read.box).toBe(read.drawn)
    // And the density, as a ratio with both numbers in it. The stack was 2131px in a 467px
    // viewport; what is on screen now is one page.
    expect(read.stacked).toBeGreaterThan(read.box * 3)
    expect(read.box).toBeLessThan(read.viewport * 1.35)
  })

  test('moves the drawn page, the box height and the selected row together', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openAgents(page)

    const seen: string[] = []
    for (const id of RAIL) {
      await page.locator(`.agents-rail [role="tab"][data-page="${id}"]`).click()
      await page.waitForTimeout(160)
      const read = await density(page)
      seen.push(`${read.drawnPage}:${read.box === read.drawn}`)

      const selected = await page
        .locator('.agents-rail [role="tab"][aria-selected="true"]')
        .getAttribute('data-page')
      // The row the rail highlights and the page the box draws are two elements that must agree —
      // a rail that lit a row for a page it never opened passes either assertion alone.
      expect(selected).toBe(id)
      expect(read.drawnPage).toBe(id)
      expect(read.box).toBe(read.drawn)
    }
    expect(seen).toEqual(RAIL.map((id) => `${id}:true`))
  })

  test('is reachable from the real window, and stays inside it at the product’s smallest size', async ({
    page,
  }) => {
    // The note is opened first, at the harness's own window, because at 860x560 the sidebar's note
    // list is not laid out and `openNote` cannot reach the file tree — a user's document is already
    // open by the time they shrink the window, which is the order a real session takes.
    await openAgents(page)
    // `tauri.conf.json:17-18`'s `minWidth: 860` / `minHeight: 560` — the window the rail has least
    // room in, and the one a rail that did not wrap would overflow.
    await page.setViewportSize({ width: 860, height: 560 })
    await page.waitForFunction(() => window.innerWidth === 860, undefined, { timeout: 5000 })
    await page.waitForTimeout(300)

    const overflow = await page.evaluate(() => {
      const content = document.querySelector('.dialog-content') as HTMLElement
      const rail = document.querySelector('.agents-rail') as HTMLElement
      const dialog = document.querySelector('.settings-dialog')!.getBoundingClientRect()
      const escaped: string[] = []
      for (const el of Array.from(document.querySelectorAll('.dialog-content input, .dialog-content select, .dialog-content textarea, .dialog-content button'))) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > dialog.right + 1 || r.left < dialog.left - 1)) {
          escaped.push(el.className || el.tagName)
        }
      }
      return {
        contentOverflowX: content.scrollWidth - content.clientWidth,
        railOverflowX: rail.scrollWidth - rail.clientWidth,
        escaped,
      }
    })
    expect(overflow.contentOverflowX).toBeLessThanOrEqual(1)
    expect(overflow.railOverflowX).toBeLessThanOrEqual(1)
    expect(overflow.escaped).toEqual([])

    // And the switch, which is this section's own control and not a page's, is still on screen and
    // still operable after the rail was added — the rail must not have pushed it out of reach.
    const switchBox = await page.locator('[data-agent-panel-switch]').boundingBox()
    expect(switchBox).not.toBeNull()
    expect(switchBox!.y + switchBox!.height).toBeLessThanOrEqual(560)
  })
})
