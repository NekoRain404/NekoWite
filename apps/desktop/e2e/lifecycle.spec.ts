import { test, expect } from '@playwright/test'

const VAULT = 'test-fixtures'

const FIXTURES = [
  { name: 'welcome.md', path: `${VAULT}/welcome.md`, is_dir: false, is_mdx: true },
]

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ vault, fixtures }) => {
      localStorage.setItem('nekowite.vault', vault)
      const registry: Record<string, unknown> = {}
      let n = 0
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          if (cmd === 'list_dir') return fixtures
          if (cmd === 'read_file') return '# Welcome'
          if (cmd === 'write_file') return undefined
          if (cmd === 'open_folder_dialog') return null
          if (cmd === 'watch_folder') return undefined
          if (cmd === 'plugin:event|listen') return ++n
          if (cmd === 'plugin:event|unlisten') return undefined
          return undefined
        },
        transformCallback: (cb: unknown, once?: boolean) => {
          registry[++n] = cb
          void once
          return n
        },
        unregisterCallback: (id: number) => {
          delete registry[id]
        },
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: () => {},
      }
      ;(window as unknown as { __wordCounts: number[] }).__wordCounts = []
      window.addEventListener('nekowite:word-count', (e) => {
        ;(window as unknown as { __wordCounts: number[] }).__wordCounts.push(
          (e as CustomEvent<number>).detail,
        )
      })
    },
    { vault: VAULT, fixtures: FIXTURES },
  )
})

test('lifecycle hooks fire live: open, doc change, save, view mode', async ({ page }) => {
  const logs: string[] = []
  page.on('console', (msg) => logs.push(msg.text()))

  await page.goto('/')

  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()
  await expect(page.locator('.tab-name', { hasText: 'welcome.md' })).toBeVisible()
  await expect(page.locator('.pane.rendered .ProseMirror h1')).toHaveText('Welcome')

  await expect.poll(() => logs.some((l) => l.includes('[status.onEditorReady]'))).toBe(true)
  await expect.poll(() => logs.some((l) => l.includes('[status.onOpenDocument]'))).toBe(true)

  await page.locator('.pane.rendered .ProseMirror').click()
  await page.keyboard.type(' more words')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __wordCounts: number[] }).__wordCounts.length))
    .toBeGreaterThan(0)
  const count = await page.evaluate(
    () => (window as unknown as { __wordCounts: number[] }).__wordCounts.at(-1) ?? 0,
  )
  expect(count).toBeGreaterThanOrEqual(2)

  await page.keyboard.press('Control+s')
  await expect.poll(() => logs.some((l) => l.includes('[status.onSave]'))).toBe(true)
  await expect.poll(() => logs.some((l) => l.includes('[status.onSaved]'))).toBe(true)

  await page.locator('.vs-btn', { hasText: '源码' }).click()
  await expect.poll(() => logs.some((l) => l.includes('[status.onViewModeChange]'))).toBe(true)
})
