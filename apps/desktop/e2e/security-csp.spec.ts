import { test, expect } from '@playwright/test'

/**
 * Security E2E for debug.md G0 / I: under the Tauri runtime signal
 * (`__TAURI_INTERNALS__` — the same presence check that drives
 * `isPluginImportAllowedByCsp()`), the production CSP blocks in-window blob
 * imports, so the vault-plugin scan must be skipped entirely and exactly ONE
 * per-session notice surfaced. `isPluginImportAllowedByCsp()` itself is unit
 * tested (`services/security-regression.test.ts`); here we drive the real app
 * and assert the observable consequences via a DOM marker (the toast) recorded
 * by a MutationObserver installed before app boot — a toast inserted and later
 * dismissed is still captured — plus an invoke-call log proving the plugin
 * directory was never scanned.
 */

const VAULT = 'test-fixtures'

const NOTES: Record<string, string> = {
  [`${VAULT}/welcome.md`]: '# Welcome',
}

const FIXTURES = [
  { name: 'welcome.md', path: `${VAULT}/welcome.md`, is_dir: false, is_mdx: true },
]

test('CSP gate: plugin scan skipped, one per-session notice, no pageerror', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))

  await page.addInitScript(
    ({ vault, fixtures, notes }) => {
      localStorage.setItem('nekowite.vault', vault)
      localStorage.setItem('nekowite.locale', 'en')
      const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
      ;(window as unknown as { __invokeCalls: typeof calls }).__invokeCalls = calls
      // DOM marker: record every toast's text when it is inserted, even if the
      // toast is auto-dismissed later (AppToast dismisses after 3 s).
      const toastTexts: string[] = []
      ;(window as unknown as { __toastTexts: string[] }).__toastTexts = toastTexts
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('.toast')) {
          const text = el.textContent ?? ''
          if (!toastTexts.includes(text)) toastTexts.push(text)
        }
      }).observe(document, { childList: true, subtree: true })
      const registry: Record<string, unknown> = {}
      let n = 0
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          calls.push({ cmd, args })
          if (cmd === 'register_vault') return undefined
          if (cmd === 'list_dir') return fixtures
          if (cmd === 'read_file') return notes[String(args['path'])] ?? ''
          if (cmd === 'stat_file') return { size: 1, mtime: 1 }
          if (cmd === 'write_file') return undefined
          if (cmd === 'delete_file') return undefined
          if (cmd === 'watch_folder') return undefined
          if (cmd === 'list_history') return []
          if (cmd === 'open_folder_dialog') return null
          if (cmd === 'plugin:event|listen') return ++n
          return undefined
        },
        transformCallback: (cb: unknown) => {
          registry[++n] = cb
          return n
        },
        unregisterCallback: () => {},
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    },
    { vault: VAULT, fixtures: FIXTURES, notes: NOTES },
  )

  await page.goto('/')

  // The plugin-scan gate surfaces exactly ONE user-visible notice per session
  // (the CSP message), never a silent no-op and never a per-plugin repeat.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __toastTexts: string[] }).__toastTexts.filter(
              (t) => t.includes('CSP') && t.includes('disabled'),
            ).length,
        ),
      { timeout: 15000 },
    )
    .toBe(1)

  // The scan was skipped: no vault-plugin directory was ever listed or read.
  const calls = await page.evaluate(
    () => (window as unknown as { __invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__invokeCalls,
  )
  expect(calls.some((c) => c.cmd === 'list_dir' && String(c.args['path'] ?? '').includes('plugins'))).toBe(false)
  expect(calls.some((c) => c.cmd === 'read_file' && String(c.args['path'] ?? '').includes('plugins'))).toBe(false)

  // The vault itself still opened normally (the gate is scoped to plugins).
  await expect(page.locator('.nav-item', { hasText: 'All notes' })).toBeVisible()
  await expect(page.locator('.nl-search-input')).toBeVisible()

  expect(errs).toEqual([])
})
