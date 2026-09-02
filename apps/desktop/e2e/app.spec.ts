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
    },
    { vault: VAULT, fixtures: FIXTURES },
  )
})

test('opens vault, opens welcome.md, edits, and toggles views', async ({ page }) => {
  await page.goto('/')

  const tree = page.locator('.file-tree')
  await expect(tree).toBeVisible()
  await expect(page.locator('.tree-name', { hasText: 'welcome.md' })).toBeVisible()

  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()

  const tab = page.locator('.tab-name', { hasText: 'welcome.md' })
  await expect(tab).toBeVisible()

  const renderedHeading = page.locator('.pane.rendered .ProseMirror h1')
  await expect(renderedHeading).toHaveText('Welcome')

  const toolbar = page.locator('.word-toolbar')
  await expect(toolbar).toBeVisible()
  await expect(toolbar.locator('.toolbar-btn').first()).toBeVisible()

  await page.locator('.switch-option', { hasText: '源码' }).click()
  const source = page.locator('.source-textarea')
  await expect(source).toBeVisible()
  await expect(source).toHaveValue(/# Welcome/)
  await expect(renderedHeading).not.toBeVisible()

  await page.locator('.switch-option', { hasText: '渲染' }).click()
  await expect(renderedHeading).toBeVisible()

  await page.locator('.switch-option', { hasText: '对照' }).click()
  const split = page.locator('.panes.split')
  await expect(split).toBeVisible()
  await expect(split.locator('.source-textarea')).toBeVisible()
  await expect(split.locator('.pane.rendered .ProseMirror h1')).toHaveText('Welcome')
})
