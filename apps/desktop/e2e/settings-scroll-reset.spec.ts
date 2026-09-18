/**
 * Where the reader lands when the settings dialog swaps what it is showing.
 *
 * ## The defect this file exists for
 *
 * `.dialog-content` (`SettingsPanel.vue`) is the dialog's one scroll container, and it is reused
 * across every swap: the rail replaces the section inside it, and the agents section's own rail
 * replaces one page with another inside it. Nothing put it back at the top, so a switch kept the
 * previous content's offset — and because the new content is usually shorter than the old offset,
 * the browser clamps it to the *bottom* of the new section. Measured in Chromium at the 1280x800
 * window these numbers are always taken at, with the AI page scrolled to `1194/1230` and the
 * `editor` row pressed: the reader arrived at `186/186` — the last row of a page they had not seen
 * the top of. It is the same complaint the maintainer made about this dialog an hour before
 * (「比较乱」) and it is the one that survives every attempt to tidy the dialog's contents: no
 * amount of layout fixes a reader who is put down in the middle of the answer.
 *
 * ## The evidence each case carries
 *
 * Not "the section changed" — that was already true. Each case takes to the bottom a page that is
 * really taller than the viewport, presses the row that opens another one, and then measures **two
 * things that must agree**: the container's own `scrollTop` (read off the element), and where the
 * page that was opened actually landed (its first element's `getBoundingClientRect()` against the
 * container's box, compared with the same number taken from a container that had never scrolled).
 * A container that stayed put fails the first; a container reset to 0 in front of content that
 * rendered somewhere else fails the second. Both are reported whether they pass or not, so a run
 * says what the numbers were rather than only the verdict.
 *
 * Both swaps are covered because they are two rails with one container:
 *
 *   `AppShell.vue` status bar's settings button (`.status-btn`, the last one)
 *     → `AppDialogs.vue` mounts `SettingsPanel`
 *     → `SettingsNavigation.vue:50` a `.dialog-nav .nav-row`      (the dialog's rail)
 *     → `AgentSettingsNavigation.vue:69` an `.agents-rail [role="tab"]`  (the agents tree's rail)
 */
import { expect, test, type Page } from '@playwright/test'
import { openNote } from './support/editorHarness'

/** Every page id the agents rail must offer, in `AGENT_SETTINGS_SECTIONS`'s order. */
const AGENT_PAGES = ['runtime', 'provider', 'configuration', 'skills', 'permission', 'registry', 'catalogue']

/** The dialog rail's rows, in `SettingsNavigation.vue`'s order — the ids the spec clicks by index. */
const SECTIONS = ['general', 'appearance', 'editor', 'export', 'ai', 'plugins', 'agents', 'desktopPet']

/**
 * The registry's answer, as `agent_registry_read` serializes it — the same shape
 * `settings-density.spec.ts` seeds, and the minimum that makes the five profile pages mount, so
 * the rails compared here are the seven a user with a configured engine sees.
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

/** One reading of the container, of the row the rail says is selected, and of where the drawn
 *  page's own top edge ended up. */
interface Landing {
  /** The container's offset, and the largest offset it can hold for this content. */
  scrollTop: number
  scrollMax: number
  viewport: number
  /** The height of everything inside the container, which is how a page is known to be taller
   *  than the box before the switch is asked to mean anything. */
  contentHeight: number
  /** Which rail row claims to be open, read from ARIA rather than from this file's list. */
  selected: string | null
  /** The drawn page's first line, in the container's coordinates: 0 means its top is the
   *  container's top. `null` when the page has nothing drawn. */
  firstLineOffset: number | null
}

/** Read the container, the rail's own selection and the drawn page's first line, in one pass. */
async function landing(page: Page, selector: string, rail: string): Promise<Landing> {
  return page.evaluate(
    ([shownSelector, railSelector]: [string, string]) => {
      const content = document.querySelector('.dialog-content') as HTMLElement
      const shown = [...document.querySelectorAll<HTMLElement>(shownSelector)].find(
        (el) => getComputedStyle(el).display !== 'none',
      )
      const first = shown?.querySelector<HTMLElement>('*') ?? shown ?? null
      const box = content.getBoundingClientRect()
      const selected = document.querySelector(`${railSelector}[aria-selected="true"]`)
      return {
        scrollTop: Math.round(content.scrollTop),
        scrollMax: Math.round(content.scrollHeight - content.clientHeight),
        viewport: Math.round(content.clientHeight),
        contentHeight: Math.round(content.scrollHeight),
        selected:
          selected === null
            ? null
            : ((selected as HTMLElement).dataset.page ?? (selected.textContent ?? '').trim()),
        firstLineOffset:
          first === null ? null : Math.round(first.getBoundingClientRect().top - box.top),
      }
    },
    [selector, rail] as [string, string],
  )
}

/** Put the container at the bottom and answer what it landed on, so a case can prove the page it
 *  started from really was taller than the box. */
async function scrollToBottom(page: Page): Promise<{ top: number; max: number }> {
  return page.evaluate(() => {
    const content = document.querySelector('.dialog-content') as HTMLElement
    content.scrollTop = content.scrollHeight
    return { top: Math.round(content.scrollTop), max: Math.round(content.scrollHeight - content.clientHeight) }
  })
}

/** Open the dialog on the agents section, with the registry seeded so all seven pages mount. */
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
  await page.locator('.dialog-nav .nav-row').nth(SECTIONS.indexOf('agents')).click()
  await page.locator('.agents-rail').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForFunction(
    () => document.querySelectorAll('.agents-rail [role="tab"]').length === 7,
    undefined,
    { timeout: 5000 },
  )
  await page.waitForTimeout(300)
}

test.describe('the settings dialog, when its content is swapped', () => {
  test('puts the reader at the top of the new section, not at the bottom of it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openNote(page)
    await page.locator('.status-btn').last().click()
    await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })

    // Where the `editor` section stands when the container is at rest, taken the one way that
    // cannot be the thing under test: opening it from `general`, whose content is shorter than the
    // box, so the offset can only be 0. This is the independently measured half — the container's
    // own `scrollTop` is the other.
    await page.locator('.dialog-nav .nav-row').nth(SECTIONS.indexOf('editor')).click()
    await page.waitForTimeout(650)
    const rest = await landing(page, '.settings-section', '.dialog-nav .nav-row')
    expect(rest.scrollTop).toBe(0)

    // A page that really is taller than the box, scrolled as far as it goes. Without this the case
    // would pass on a container that could not have been anywhere else.
    await page.locator('.dialog-nav .nav-row').nth(SECTIONS.indexOf('ai')).click()
    await page.waitForTimeout(300)
    const from = await scrollToBottom(page)
    expect(from.max).toBeGreaterThan(0)
    expect(from.top).toBe(from.max)

    await page.locator('.dialog-nav .nav-row').nth(SECTIONS.indexOf('editor')).click()
    await page.waitForTimeout(650)

    const to = await landing(page, '.settings-section', '.dialog-nav .nav-row')
    // Reported, so a run says which page was left and where the reader was put down.
    console.log(
      `editor after the swap: ${to.scrollTop}/${to.scrollMax} of ${to.contentHeight}px, first line at ${to.firstLineOffset} (at rest ${rest.firstLineOffset})`,
    )
    expect(to.scrollTop).toBe(0)
    expect(to.firstLineOffset).toBe(rest.firstLineOffset)
  })

  test('does the same for every row of the dialog rail', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openNote(page)
    await page.locator('.status-btn').last().click()
    await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })

    const seen: string[] = []
    for (const id of SECTIONS) {
      const index = SECTIONS.indexOf(id)
      // Read every section from a page that had somewhere to scroll to, so no case can pass for
      // the trivial reason.
      await page.locator('.dialog-nav .nav-row').nth((index + 4) % SECTIONS.length).click()
      await page.waitForTimeout(250)
      await scrollToBottom(page)
      await page.locator('.dialog-nav .nav-row').nth(index).click()
      await page.waitForTimeout(350)
      const to = await landing(page, '.settings-section', '.dialog-nav .nav-row')
      seen.push(`${id}:${to.scrollTop}`)
      expect(to.scrollTop).toBe(0)
    }
    console.log(`the dialog rail: ${seen.join(' ')}`)
  })

  test('does the same for every row of the agents tree’s rail', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openAgents(page)

    // Where a page stands when the container is at rest: the section has just opened on `runtime`
    // and nothing has been scrolled, so this number cannot be the thing under test.
    const rest = await landing(page, '[data-test="agents-pages"] > [data-page]', '.agents-rail [role="tab"]')
    expect(rest.scrollTop).toBe(0)

    const seen: string[] = []
    for (const id of AGENT_PAGES) {
      // Every row is opened from *another* page, and from the bottom of it. Pressing the row that
      // is already selected is not a swap — the section opens on `runtime`, so the first pass of a
      // loop that pressed each row where it stood would measure a no-op against itself and report
      // whatever offset the case had just set. The one after it is always a different page.
      const from_ = AGENT_PAGES[(AGENT_PAGES.indexOf(id) + 1) % AGENT_PAGES.length]
      await page.locator(`.agents-rail [role="tab"][data-page="${from_}"]`).click()
      await page.waitForTimeout(200)
      const from = await scrollToBottom(page)
      expect(from.max, `the page before ${id} had nothing to scroll`).toBeGreaterThan(0)
      await page.locator(`.agents-rail [role="tab"][data-page="${id}"]`).click()
      await page.waitForTimeout(250)
      const to = await landing(page, '[data-test="agents-pages"] > [data-page]', '.agents-rail [role="tab"]')
      seen.push(`${id}:${to.scrollTop}/${to.firstLineOffset}`)
      // Two measurements that must agree, the same pair the first case takes: the container's own
      // offset, and where the page that was opened actually landed. Before the fix the first of
      // these read **108** — 108px down a page the reader had just opened — and the second read 108
      // less than the at-rest number below.
      expect(to.selected).toBe(id)
      expect(to.scrollTop).toBe(0)
      expect(to.firstLineOffset).toBe(rest.firstLineOffset)
    }
    console.log(`the agents rail (scrollTop/firstLine): ${seen.join(' ')} at rest ${rest.firstLineOffset}`)
  })
})
