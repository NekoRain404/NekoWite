// Screenshot harness: boots the vite dev server page with the Tauri IPC mock
// (same stubbing the e2e suite uses) and captures the redesigned shell.
const { chromium } = require('@playwright/test')

const VAULT = 'test-fixtures'

const FIXTURES = [
  { name: 'welcome.md', path: `${VAULT}/welcome.md`, is_dir: false, is_mdx: true },
  { name: 'notes', path: `${VAULT}/notes`, is_dir: true, is_mdx: false },
  { name: 'research.mdx', path: `${VAULT}/notes/research.mdx`, is_dir: false, is_mdx: true },
]

const WELCOME = `# Welcome\n\n这是一段中文段落，用于检查字数统计与排版。Markdown 支持 **加粗**、*斜体*、\`行内代码\` 以及 [链接](https://example.com)。\n\n## 列表\n\n- [ ] 写测试\n- [x] 读题\n- 普通项\n\n> 引用块：思维的质量取决于输入的质量。\n\n\`\`\`ts\nconst answer = 42\n\`\`\`\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n`

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.addInitScript(({ vault, fixtures, welcome }) => {
    localStorage.setItem('nekowite.vault', vault)
    let n = 0
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === 'list_dir') return fixtures
        if (cmd === 'read_file') return welcome
        if (cmd === 'watch_folder') return undefined
        if (cmd === 'plugin:event|listen') return ++n
        if (cmd === 'plugin:event|unlisten') return undefined
        return undefined
      },
      transformCallback: (cb, once) => {
        void once
        return ++n
      },
      unregisterCallback: () => {},
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  }, { vault: VAULT, fixtures: FIXTURES, welcome: WELCOME })
  await page.goto('http://localhost:1420/')
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'test-results/ui-light.png' })
  // open a file
  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'test-results/ui-light-doc.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => {
    const raw = localStorage.getItem('nekowite.appearance')
    const parsed = raw ? JSON.parse(raw) : {}
    parsed.theme = 'dark'
    localStorage.setItem('nekowite.appearance', JSON.stringify(parsed))
  })
  await page.reload()
  await page.waitForTimeout(2500)
  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'test-results/ui-dark-doc.png' })
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
