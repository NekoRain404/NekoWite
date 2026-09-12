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
 * dismissed is still captured — plus an invoke-call log proving no plugin CODE
 * was ever read.
 *
 * The vault seeded here HAS a `plugins/` directory on purpose. Listing it is
 * allowed (and necessary: an empty listing is how the app tells "this vault has
 * plugins that cannot load" from "this vault has no plugins at all"), while
 * reading or importing anything inside it must not happen. A vault without a
 * plugins directory gets no notice at all — telling someone about a security
 * restriction for a feature they never used is noise, and that case is covered
 * in `services/plugins.test.ts`.
 */

const VAULT = 'test-fixtures'

const NOTES: Record<string, string> = {
  [`${VAULT}/welcome.md`]: '# Welcome',
}

/**
 * A real directory tree, not one canned list.
 *
 * The mock must answer `list_dir` with the CHILDREN of the requested directory.
 * Returning a fixed array for every path made `plugins/quote` look like it
 * contained another `plugins/quote`, so the vault walk never terminated and the
 * renderer hung — a property of the mock, and exactly the kind of thing that
 * costs an hour if left unexplained.
 */
const TREE: Record<string, Array<{ name: string; is_dir: boolean }>> = {
  // Keyed by VAULT-RELATIVE path: the plugin loader asks for `plugins`, while
  // the vault walk asks for the absolute spelling, so the mock normalizes.
  '.': [
    { name: 'welcome.md', is_dir: false },
    { name: 'plugins', is_dir: true },
  ],
  plugins: [{ name: 'quote', is_dir: true }],
  'plugins/quote': [
    { name: 'package.json', is_dir: false },
    { name: 'index.js', is_dir: false },
  ],
}

test('CSP gate: plugin scan skipped, one per-session notice, no pageerror', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))

  await page.addInitScript(
    ({ vault, tree, notes }) => {
      localStorage.setItem('nekowite.vault', vault)
      localStorage.setItem('nekowite.locale', 'en')
      const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
      ;(window as unknown as { __invokeCalls: typeof calls }).__invokeCalls = calls
      const entriesFor = (dir: string): Array<Record<string, unknown>> => {
        // Both spellings arrive: `plugins` (the loader, vault-relative) and
        // `test-fixtures/plugins` (the vault walk, absolute).
        const rel = dir.startsWith(vault + '/') ? dir.slice(vault.length + 1) : dir
        const key = rel === '' || rel === '.' ? '.' : rel
        const list = (tree as Record<string, Array<{ name: string; is_dir: boolean }>>)[key] ?? []
        return list.map((entry) => ({
          name: entry.name,
          path: dir + '/' + entry.name,
          is_dir: entry.is_dir,
          is_mdx: !entry.is_dir && entry.name.endsWith('.md'),
        }))
      }
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
          if (cmd === 'list_dir') return entriesFor(String(args['path'] ?? ''))
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
    { vault: VAULT, tree: TREE, notes: NOTES },
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

  // The gate returned before touching any plugin CODE: the directory is listed
  // (that listing is what makes the notice accurate), but nothing inside it was
  // read, and no manifest was ever parsed.
  const calls = await page.evaluate(
    () => (window as unknown as { __invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> }).__invokeCalls,
  )
  expect(calls.some((c) => c.cmd === 'list_dir' && String(c.args['path'] ?? '').includes('plugins'))).toBe(true)
  expect(calls.some((c) => c.cmd === 'read_file' && String(c.args['path'] ?? '').includes('plugins'))).toBe(false)
  expect(calls.some((c) => c.cmd === 'stat_file' && String(c.args['path'] ?? '').includes('plugins'))).toBe(false)

  // The vault itself still opened normally (the gate is scoped to plugins).
  await expect(page.locator('.nav-item', { hasText: 'All notes' })).toBeVisible()
  await expect(page.locator('.nl-search-input')).toBeVisible()

  expect(errs).toEqual([])
})
