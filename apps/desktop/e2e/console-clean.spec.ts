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
 * Clear the overlays a previous click may have opened.
 *
 * Only elements the app does NOT own may be deleted here. `.math-overlay` and
 * `.table-overlay` are built by editor-core with `document.createElement`, so
 * they are outside the renderer and removing them is the same as the user
 * pressing Escape there. Everything Vue renders — `.dialog-overlay` (the
 * template picker, rename, settings…) and the palette's Teleport target — is
 * closed by pressing Escape and letting the app's own state machine do it:
 * deleting a node the renderer still holds makes its next patch throw
 * "Cannot read properties of null (reading 'insertBefore')", which says
 * nothing about the product.
 *
 * Escape goes first for the same reason: it must reach a dialog that is still
 * in the DOM.
 */
async function clearOverlays(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(30)
  await page.evaluate(() => {
    for (const cls of ['table-overlay', 'math-overlay']) {
      document.querySelectorAll(`.${cls}`).forEach((el) => el.remove())
    }
    document.body.classList.remove('is-layout-resizing')
  })
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

test('the tab bar, rail sections, templates and list views are clean', async ({ page }) => {
  const issues = watchConsole(page)
  // Extra notes so switching tabs has something to switch between.
  await openNote(page, {
    files: {
      'test-fixtures/second.md': '# Second\n\nbody two\n',
      'test-fixtures/third.md': '# Third\n\nbody three\n',
    },
  })

  // --- tab bar: open, switch, close ---------------------------------------
  for (const name of ['second.md', 'third.md']) {
    await page.locator('.tree-name', { hasText: name }).first().click()
    await page.waitForTimeout(150)
  }
  expect(await page.locator('.tab').count()).toBe(3)
  const tabCount = await page.locator('.tab').count()
  for (let i = 0; i < tabCount; i += 1) {
    await page.locator('.tab').nth(i).click()
    await page.waitForTimeout(120)
    expect(issues, `tab ${i}`).toEqual([])
  }
  for (let i = tabCount; i > 0; i -= 1) {
    const close = page.locator('.tab-close').first()
    if (!(await close.count())) break
    await close.click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape')
  }
  expect(issues, 'closing every tab').toEqual([])

  // --- every info-rail section --------------------------------------------
  await openNote(page)
  const expand = await label(page, 'rail.expand')
  const collapse = await label(page, 'rail.collapse')
  await page.locator(`.status-btn[title="${expand}"], .status-btn[title="${collapse}"]`).first().click()
  await page.locator('.info-rail').waitFor({ state: 'visible', timeout: 3000 })

  const railCount = await page.locator('.rail-tab').count()
  expect(railCount, 'info rail sections').toBeGreaterThan(3)
  for (let i = 0; i < railCount; i += 1) {
    const tab = page.locator('.rail-tab').nth(i)
    const name = (await tab.textContent())?.trim() ?? String(i)
    await tab.click()
    await page.waitForTimeout(150)
    // A missing i18n key renders as its raw id and logs an [intlify] warning,
    // so this also covers locale coverage for these panels.
    expect(issues, `rail section ${name}`).toEqual([])
  }

  // --- template picker (browse only: choosing writes a file) --------------
  const pickTitle = await label(page, 'template.pickTitle')
  const templateButton = page.locator(`.nav-item[title="${pickTitle}"]`).first()
  if (await templateButton.count()) {
    await templateButton.click()
    await page.locator('.template-dialog').waitFor({ state: 'visible', timeout: 3000 })
    const options = await page.locator('.template-option').count()
    expect(options, 'built-in templates').toBeGreaterThan(5)
    for (let i = 0; i < options; i += 1) {
      await page.locator('.template-option').nth(i).hover()
      await page.waitForTimeout(20)
    }
    await page.locator('.template-close').click()
    await page.waitForTimeout(150)
    expect(issues, 'template picker').toEqual([])
  }

  // --- file-tree context menu --------------------------------------------
  await page.locator('.tree-name', { hasText: 'welcome.md' }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  const menuItems = await page.locator('[role="menuitem"]').count()
  expect(menuItems, 'file context menu').toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  expect(issues, 'file tree context menu').toEqual([])

  // --- list views ---------------------------------------------------------
  for (const key of ['nav.attachments', 'nav.graph']) {
    const name = await label(page, key)
    const entry = page.locator('.nav-item').filter({ hasText: name }).first()
    if (!(await entry.count())) continue
    await entry.click()
    await page.waitForTimeout(500)
    expect(issues, `list view ${key}`).toEqual([])
  }
  const folders = await label(page, 'nav.folders')
  await page.locator('.nav-item').filter({ hasText: folders }).first().click()
  await page.waitForTimeout(200)
  expect(issues).toEqual([])
})
