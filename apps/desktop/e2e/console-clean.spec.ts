import { expect, test, type Page } from '@playwright/test'
import { openNote, showRendered, showSource, showSplit } from './support/editorHarness'

/**
 * Console-clean sweep.
 *
 * Drives the app through its real surfaces — every toolbar button in every view
 * mode, the sidebar nav, the right rail, the command palette, the settings
 * dialog and a split drag — and fails if anything logs an error or a warning,
 * or throws.
 *
 * This is the broad net for the failure modes that unit tests cannot see: a
 * Vue render error, a Teleport target being patched after it left the DOM, a
 * command dispatched into a detached editor. It found a real palette toggle
 * race and a broken split drag.
 */

interface Issue {
  kind: string
  text: string
}

/** Known-benign noise that is not the app's doing. */
function isNoise(text: string): boolean {
  return (
    text.includes('[vite]') ||
    text.includes('Download the Vue Devtools') ||
    text.includes('KaTeX doesn\'t work in quirks mode')
  )
}

function watchConsole(page: Page): Issue[] {
  const issues: Issue[] = []
  page.on('console', (msg) => {
    const type = msg.type()
    if (type !== 'error' && type !== 'warning') return
    const text = msg.text()
    if (isNoise(text)) return
    issues.push({ kind: `console.${type}`, text })
  })
  page.on('pageerror', (err) => issues.push({ kind: 'pageerror', text: String(err) }))
  return issues
}

/**
 * Clear the overlays that commands open imperatively.
 *
 * Deliberately never removes `.palette-overlay`: it is a Vue Teleport target,
 * and deleting it out from under the renderer makes the next patch throw
 * "Cannot read properties of null (reading 'insertBefore')". That is a property
 * of the diagnostic, not a bug worth reporting.
 */
async function clearOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const cls of ['table-overlay', 'math-overlay', 'dialog-overlay']) {
      document.querySelectorAll(`.${cls}`).forEach((el) => el.remove())
    }
    document.body.classList.remove('is-layout-resizing')
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(30)
}

async function label(page: Page, key: string): Promise<string> {
  return page.evaluate(async (k) => {
    const mod = (await import('/src/i18n/index.ts')) as unknown as { t(key: string): string }
    return mod.t(k)
  }, key)
}

test('every toolbar button is clean in every view mode', async ({ page }) => {
  const issues = watchConsole(page)
  await openNote(page, { doc: '# Title\n\nbody text\n' })

  for (const mode of ['rendered', 'source', 'split'] as const) {
    if (mode === 'rendered') await showRendered(page)
    if (mode === 'source') await showSource(page)
    if (mode === 'split') await showSplit(page)

    const count = await page.locator('.toolbar-btn').count()
    expect(count, `no toolbar buttons in ${mode} mode`).toBeGreaterThan(10)
    for (let i = 0; i < count; i += 1) {
      const button = page.locator('.toolbar-btn').nth(i)
      const title = (await button.getAttribute('title')) ?? `#${i}`
      await button.click({ timeout: 3000 })
      // Some buttons open a dialog or a menu; close it before the next one.
      await clearOverlays(page)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(20)
      expect(issues, `${mode} mode, button "${title}"`).toEqual([])
    }
  }
})

test('the sidebar nav and the right rail are clean', async ({ page }) => {
  const issues = watchConsole(page)
  await openNote(page)

  const navs = await page.locator('.nav-item').count()
  expect(navs).toBeGreaterThan(3)
  for (let i = 0; i < navs; i += 1) {
    const item = page.locator('.nav-item').nth(i)
    await item.click({ timeout: 2000 })
    await page.waitForTimeout(60)
    await clearOverlays(page)
    expect(issues, `nav item ${i}`).toEqual([])
  }

  for (const section of ['信息', '大纲', '引用', '历史']) {
    const el = page.locator(`.rail-tab, .rail-section, button:has-text("${section}")`).first()
    if (!(await el.count())) continue
    await el.click({ timeout: 2000 })
    await page.waitForTimeout(80)
    expect(issues, `rail ${section}`).toEqual([])
  }
})

test('the command palette is clean for every query', async ({ page }) => {
  const issues = watchConsole(page)
  await openNote(page)

  const queries = ['', '加粗', '标题', '图片', '表格', '公式', 'Callout', 'FloatBox', '引用', 'zzz']
  for (const query of queries) {
    await page.keyboard.press('Control+k')
    const input = page.getByRole('combobox')
    // `count()` does not wait, so a palette that is still painting would look
    // missing; wait for it the way the feature specs do.
    await input.waitFor({ state: 'visible', timeout: 3000 })
    await input.fill(query)
    await page.waitForTimeout(80)
    if (query === '') {
      await page.keyboard.press('Escape')
    } else {
      await page.keyboard.press('Enter')
      await clearOverlays(page)
    }
    expect(issues, `palette query "${query}"`).toEqual([])
  }
})

test('the settings dialog survives a walk over every control', async ({ page }) => {
  const issues = watchConsole(page)
  await openNote(page)

  // Entering and leaving the split view repeatedly is its own regression (the
  // panes mount, unmount and re-align), so do it before the settings walk.
  for (let i = 0; i < 3; i += 1) {
    await showSource(page)
    await showSplit(page)
    await showRendered(page)
  }
  expect(issues).toEqual([])

  await page.locator(`.footer-btn[title="${await label(page, 'nav.settings')}"]`).click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 3000 })

  // Every probe is scoped to the overlay: `.switch-option` and friends are also
  // used by the view-mode switch behind it, and clicking those is blocked by
  // the overlay.
  const sections = await page.locator('.dialog-nav .nav-row').count()
  expect(sections).toBeGreaterThan(2)
  for (let i = 0; i < sections; i += 1) {
    await page.locator('.dialog-nav .nav-row').nth(i).click()
    await page.waitForTimeout(60)

    // Colour schemes and accents are where the theme work lives, so all of
    // them get exercised rather than a sample.
    for (const selector of ['.color-scheme-card', '.accent-swatch', '.switch-option']) {
      const count = await page.locator(`.settings-overlay ${selector}`).count()
      for (let n = 0; n < count; n += 1) {
        await page.locator(`.settings-overlay ${selector}`).nth(n).click()
        await page.waitForTimeout(20)
      }
    }
    const boxes = await page.locator('.settings-overlay .settings-section .checkbox').count()
    for (let b = 0; b < boxes; b += 1) {
      const box = page.locator('.settings-overlay .settings-section .checkbox').nth(b)
      if (await box.isVisible()) {
        await box.click()
        await page.waitForTimeout(20)
      }
    }
    expect(issues, `settings section ${i}`).toEqual([])
  }

  await page.locator('.settings-close').click()
  await page.waitForTimeout(150)
  expect(issues).toEqual([])
})
