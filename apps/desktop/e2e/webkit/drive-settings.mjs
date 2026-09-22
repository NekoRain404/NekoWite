/**
 * The settings dialog, walked page by page.
 *
 * It is eight pages of the app's own surface, and none of them had ever been rendered by an instrument that
 * runs the shipping engine: the Playwright suite is Chromium against a stubbed host, and nothing else opens
 * this dialog at all. A page that throws on mount looks exactly like a page with nothing in it, so each one
 * is read — its text, its control count, the `data-test` markers it carries, and the toast stack.
 *
 * Split out of `drive-app.mjs`, which owns the session and supplies `run`, `script` and `findElement`; that
 * file's budget is 800 lines and this is a stage of its own.
 */
import { sleep, until } from './webdriver.mjs'

/** The page swap is a cross-fade (see `SettingsPanel.vue`), so the destination needs a moment to land. */
const SETTLE_MS = 500

/**
 * What one settings page is showing.
 *
 * `markers` reads the `data-test` attributes the pages already carry (the version row, the vault path, the
 * blocked-plugin notice, the agent profile), so the readings name the page's own landmarks rather than
 * whatever text happens to be first. `toasts` is the app's own report of a failure: a page that threw on
 * mount would put one there rather than leave a blank panel behind.
 */
const PAGE_SCRIPT = `
const content = document.querySelector('.dialog-content')
const text = (content ? content.innerText : '').replace(/\\s+/g, ' ').trim()
return {
  text: text.slice(0, 140),
  textLength: text.length,
  controls: content ? content.querySelectorAll('input, select, textarea, button').length : 0,
  markers: Array.from((content && content.querySelectorAll('[data-test]')) || []).map((el) => el.getAttribute('data-test')),
  toasts: Array.from(document.querySelectorAll('.toast')).map((t) => (t.textContent || '').trim()).join(' | '),
}
`

/** Walk the dialog, filling `readings` in place. */
export async function walkSettingsDialog({ run, script, findElement, readings }) {
  // Opened the way a user opens it: the sidebar's own footer button, by its title. Matched on both languages
  // because the app's language is a user setting, and `Settings` is the icon's name rather than the button's.
  const opener = await findElement(
    'xpath',
    '//button[contains(@class, "footer-btn")][@title="设置" or @title="Settings"]',
  )
  readings.settingsOpenerFound = opener !== null
  if (!opener) return
  await run('POST', `/element/${opener}/click`, {})
  readings.settingsNavRows = await until(
    async () => {
      const count = await run('POST', '/execute/sync', script('return document.querySelectorAll(".nav-row").length'))
      return Number(count) > 0 ? Number(count) : null
    },
    { timeout: 15_000, what: 'the settings dialog to open' },
  ).catch(() => 0)
  readings.settingsPages = []
  for (let index = 0; index < (readings.settingsNavRows || 0); index += 1) {
    // The nth row, clicked natively: the nav is rendered from one list, so its order is the app's.
    const row = await findElement('xpath', `(//button[contains(@class, "nav-row")])[${index + 1}]`)
    if (!row) continue
    await run('POST', `/element/${row}/click`, {})
    const settled = await until(
      async () => {
        const active = await run(
          'POST',
          '/execute/sync',
          script(`const rows = Array.from(document.querySelectorAll('.nav-row'))
            return rows.findIndex((row) => row.classList.contains('active'))`),
        )
        return Number(active) === index ? true : null
      },
      { timeout: 10_000, what: `settings page ${index} to become active` },
    ).catch(() => false)
    await sleep(SETTLE_MS)
    const page = await run('POST', '/execute/sync', script(PAGE_SCRIPT)).catch((e) => ({
      unreadable: String(e?.message ?? e).slice(0, 160),
    }))
    readings.settingsPages.push({ index, active: settled === true, ...(page ?? {}) })
  }
  // Closed again, so a stage after this one is not reading through a dialog that owns the keyboard.
  const close = await findElement('xpath', '//button[contains(@class, "settings-close")]')
  if (close) await run('POST', `/element/${close}/click`, {})
  readings.settingsClosed = await until(
    async () => {
      const open = await run('POST', '/execute/sync', script('return document.querySelectorAll(".settings-dialog").length'))
      return Number(open) === 0 ? true : null
    },
    { timeout: 10_000, what: 'the settings dialog to close' },
  ).catch(() => false)
}
