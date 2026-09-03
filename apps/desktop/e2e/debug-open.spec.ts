import { test } from '@playwright/test'

const VAULT = 'test-fixtures'

const FIXTURES = [
  { name: 'welcome.md', path: `${VAULT}/welcome.md`, is_dir: false, is_mdx: true },
]

test('debug open flow', async ({ page }) => {
  const consoleLogs: string[] = []
  page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => consoleLogs.push(`[PAGEERROR] ${e.message}`))

  await page.addInitScript(
    ({ vault, fixtures }) => {
      localStorage.setItem('nekowite.vault', vault)
      const registry: Record<string, unknown> = {}
      let n = 0
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          console.log('INVOKE', cmd, JSON.stringify(args))
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

  await page.goto('/')

  // wait for app to settle
  await page.waitForTimeout(1500)

  // Click 文件夹 nav to show the tree
  await page.locator('.nav-item', { hasText: '文件夹' }).click()
  await page.waitForTimeout(500)

  // Click welcome.md
  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()

  // Wait and observe state at multiple points
  await page.waitForTimeout(1000)

  const state = await page.evaluate(() => {
    const pm = document.querySelector('.pane.rendered .ProseMirror')
    const h1 = document.querySelector('.pane.rendered .ProseMirror h1')
    const statusBar = document.querySelector('.status-bar, footer, [class*="status"]')
    const editorHost = document.querySelector('.pane.rendered .editor-host, .pane.rendered > div')
    return {
      pmExists: !!pm,
      pmHtml: pm ? pm.innerHTML.slice(0, 300) : 'NO PROSEMIRROR',
      h1Text: h1 ? h1.textContent : 'NO H1',
      statusText: statusBar ? statusBar.textContent : '',
      hostHtml: editorHost ? editorHost.innerHTML.slice(0, 500) : 'NO HOST',
      renderedChildren: document.querySelector('.pane.rendered')?.children.length ?? -1,
    }
  })
  console.log('STATE:', JSON.stringify(state, null, 2))
  console.log('CONSOLE LOGS:')
  for (const l of consoleLogs) console.log('  ', l.slice(0, 2000))
})
