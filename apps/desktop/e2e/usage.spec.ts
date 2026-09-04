import { test, expect } from '@playwright/test'
const VAULT = 'test-fixtures'
const FIXTURES = [{ name: 'welcome.md', path: `${VAULT}/welcome.md`, is_dir: false, is_mdx: true }]
test('real usage: open, edit, save, views, drop-image -> rename prompt', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))
  await page.addInitScript(({ vault, fixtures }) => {
    localStorage.setItem('nekowite.vault', vault)
    const registry: Record<string, unknown> = {}; let n = 0
    ;(window as unknown as { __saves: string[] }).__saves = []
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'register_vault') return undefined
        if (cmd === 'list_dir') return fixtures
        if (cmd === 'read_file') return '# Welcome\n\nSome body text.'
        if (cmd === 'stat_file') return { size: 1, mtime: 1 }
        if (cmd === 'write_file') { ;(window as unknown as { __saves: string[] }).__saves.push(String(args['path'])); return undefined }
        if (cmd === 'watch_folder') return undefined
        if (cmd === 'save_attachment') return 'attachments/2026-09/paste-x.png'
        if (cmd === 'resolve_media_path') return '/abs/vault/attachments/2026-09/paste-x.png'
        if (cmd === 'create_dir') return 'attachments'
        if (cmd === 'list_history') return []
        if (cmd === 'plugin:event|listen') return ++n
        return undefined
      },
      transformCallback: (cb: unknown) => { registry[++n] = cb; return n }, unregisterCallback: () => {},
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  }, { vault: VAULT, fixtures: FIXTURES })
  await page.goto('/')
  await page.locator('.nav-item', { hasText: '文件夹' }).click()
  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()
  await expect(page.locator('.pane.rendered .ProseMirror h1')).toHaveText('Welcome')
  await page.locator('.pane.rendered .ProseMirror').click()
  await page.keyboard.type(' more words')
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+s'); await page.waitForTimeout(300)
  expect(await page.evaluate(() => (window as unknown as { __saves: string[] }).__saves.length)).toBeGreaterThan(0)
  await page.locator('.switch-option', { hasText: '源码' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()
  await page.locator('.switch-option', { hasText: '渲染' }).click()
  // drop an image; the paste pipeline must reach the rename prompt (the correct
  // pre-save step). We assert it appears, then cancel (Escape) so nothing hangs.
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['QUJD'], 'paste-x.png', { type: 'image/png' }))
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: dt })
    document.querySelector('.editor-container')?.dispatchEvent(ev)
  })
  const rename = page.getByRole('dialog').first()
  await rename.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  const renameVisible = await rename.isVisible().catch(() => false)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  console.log('RENAME_VISIBLE:', renameVisible, 'PAGEERRORS:', errs.length)
  expect(renameVisible).toBe(true)
})
