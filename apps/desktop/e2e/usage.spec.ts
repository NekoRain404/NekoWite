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
    ;(window as unknown as { __saveAttachments: Array<Record<string, unknown>> }).__saveAttachments = []
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'register_vault') return undefined
        if (cmd === 'list_dir') return fixtures
        if (cmd === 'read_file') return '# Welcome\n\nSome body text.'
        if (cmd === 'stat_file') return { size: 1, mtime: 1 }
        if (cmd === 'write_file') { ;(window as unknown as { __saves: string[] }).__saves.push(String(args['path'])); return undefined }
        if (cmd === 'watch_folder') return undefined
        if (cmd === 'save_attachment') {
          ;(window as unknown as { __saveAttachments: Array<Record<string, unknown>> }).__saveAttachments.push(args)
          return 'attachments/2026-09/paste-x.png'
        }
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
  // pre-save step), then complete the rename: confirmed files are written via
  // save_attachment and inserted as a markdown image block at the caret.
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['QUJD'], 'paste-x.png', { type: 'image/png' }))
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: dt })
    document.querySelector('.editor-container')?.dispatchEvent(ev)
  })
  const rename = page.getByRole('dialog').first()
  await expect(rename).toBeVisible({ timeout: 4000 })
  await rename.locator('input').fill('saved-diagram.png')
  await rename.locator('.btn.btn-primary').click()
  // The file was persisted through the real attachment pipeline (mock):
  // save_attachment received the confirmed name and the vault that owns the note.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __saveAttachments: unknown[] }).__saveAttachments.length))
    .toBeGreaterThan(0)
  const attachmentArgs = await page.evaluate(() => (window as unknown as { __saveAttachments: Array<Record<string, unknown>> }).__saveAttachments[0])
  // The Rust command parameter is `file_name` (snake_case) — a camelCase key
  // makes the invoke reject in the real WebView.
  expect(attachmentArgs['file_name']).toBe('saved-diagram.png')
  expect(attachmentArgs['dir']).toBe('welcome_assets')
  expect(attachmentArgs['vault']).toBe(VAULT)
  // The image block was inserted into the rendered document (the mock's
  // resolve_media_path supplies the display URL; the node view still renders
  // its figure even though the src cannot load, like the existing image spec).
  const figure = page.locator('.pane.rendered .ProseMirror figure.neko-image').last()
  await expect(figure).toBeVisible({ timeout: 5000 })
  await expect(figure).toHaveAttribute('aria-label', 'saved-diagram.png')
  // ...and the markdown reference is what the model serializes: the source pane
  // (fed by the same tab content the editor syncs to) shows the image block.
  await page.locator('.switch-option', { hasText: '源码' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText(
    '![saved-diagram.png](attachments/2026-09/paste-x.png)',
  )
  expect(errs).toEqual([])
})

// A4: create -> rename -> delete -> trash-restore, end to end against a
// stateful gateway mock. The native-dialog path is intentionally NOT exercised
// here (covered by App.appearance.test.ts); this drives the file-tree UI.
test('file tree: create, rename, delete, trash-restore sequence', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))
  await page.addInitScript(() => {
    localStorage.setItem('nekowite.vault', 'test-fixtures')
    const registry: Record<string, unknown> = {}; let n = 0
    const files: Record<string, string> = {
      'test-fixtures/welcome.md': '# Welcome\n\nSome body text.',
    }
    const trash: Record<string, { name: string; trash_path: string; original_path: string }> = {}
    const encode = (p: string): string => p.replace(/\//g, '%2F')
    const listDir = (dir: unknown): Array<Record<string, unknown>> => {
      const base = dir === '.' || dir === null || dir === undefined ? 'test-fixtures' : String(dir)
      const prefix = `${base}/`
      const out = new Map<string, Record<string, unknown>>()
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (!rest) continue
        const seg = rest.split('/')[0]!
        const entry = rest.includes('/')
          ? { name: seg, path: `${prefix}${seg}`, is_dir: true, is_mdx: false }
          : { name: seg, path: key, is_dir: false, is_mdx: /\.(md|mdx)$/i.test(seg) }
        out.set(`${entry.name}-${entry.is_dir}`, entry)
      }
      return [...out.values()]
    }
    ;(window as unknown as { __trash: Record<string, unknown> }).__trash = trash
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'register_vault') return undefined
        if (cmd === 'list_dir') return listDir(args['path'])
        if (cmd === 'read_file') return files[String(args['path'])] ?? '# Default body.\n'
        if (cmd === 'stat_file') return { size: 1, mtime: 1 }
        if (cmd === 'write_file') { files[String(args['path'])] = String(args['content']); return undefined }
        if (cmd === 'create_dir') return String(args['path'])
        if (cmd === 'rename_entry') {
          const from = String(args['from']); const to = String(args['to'])
          const next: Record<string, string> = {}
          for (const [key, content] of Object.entries(files)) {
            const nk = key === from || key.startsWith(`${from}/`) ? to + key.slice(from.length) : key
            if (!(nk in next)) next[nk] = content
          }
          for (const k of Object.keys(files)) delete files[k]
          Object.assign(files, next)
          return to
        }
        if (cmd === 'delete_file') {
          const path = String(args['path'])
          // Only user files land in the user trash: the index coordinator also
          // deletes its .nekowite secret temp files through this command.
          if (path.startsWith('.nekowite')) {
            delete files[path]
            return encode(path)
          }
          const content = files[path]
          if (content === undefined) throw new Error('no such file: ' + path)
          delete files[path]
          const key = encode(path)
          trash[key] = { name: key, trash_path: key, original_path: path }
          return key
        }
        if (cmd === 'list_trash') return Object.values(trash)
        if (cmd === 'restore_from_trash') {
          const key = String(args['trash_path'])
          const entry = trash[key]
          if (!entry) throw new Error('no such trash: ' + key)
          files[entry.original_path] = 'Restored body.\n'
          delete trash[key]
          return entry.original_path
        }
        if (cmd === 'clear_trash') {
          const count = Object.keys(trash).length
          for (const k of Object.keys(trash)) delete trash[k]
          return count
        }
        if (cmd === 'watch_folder') return undefined
        if (cmd === 'save_attachment') return 'attachments/2026-09/paste.png'
        if (cmd === 'resolve_media_path') return '/abs/vault/attachments/2026-09/paste.png'
        if (cmd === 'list_history') return []
        if (cmd === 'plugin:event|listen') return ++n
        return undefined
      },
      transformCallback: (cb: unknown) => { registry[++n] = cb; return n },
      unregisterCallback: () => {},
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  })
  await page.goto('/')
  await page.locator('.nav-item', { hasText: '文件夹' }).click()

  // Create a note from the tree toolbar (新建文件).
  await page.locator('[title="新建文件"]').click()
  const createInput = page.locator('.tree-inline-input')
  await createInput.fill('draft.md')
  await createInput.press('Enter')
  await expect(page.locator('.tree-name', { hasText: 'draft.md' })).toBeVisible()
  await expect(page.locator('.pane.rendered')).toBeVisible()

  // Rename via the row context menu (重命名).
  await page.locator('.tree-row', { hasText: 'draft.md' }).click({ button: 'right' })
  await page.locator('.ctx-menu-item', { hasText: '重命名' }).click()
  const renameInput = page.locator('.tree-inline-input')
  await renameInput.fill('renamed.md')
  await renameInput.press('Enter')
  await expect(page.locator('.tree-name', { hasText: 'renamed.md' })).toBeVisible()
  await expect(page.locator('.tree-name', { hasText: 'draft.md' })).toHaveCount(0)

  // Delete (移入回收站 -> 确认): the row disappears and the trash lists it.
  await page.locator('.tree-row', { hasText: 'renamed.md' }).locator('.tree-del').click()
  await page.locator('.tree-del-confirm button', { hasText: '确认' }).click()
  await expect(page.locator('.tree-name', { hasText: 'renamed.md' })).toHaveCount(0)

  // Restore from the sidebar trash group (恢复).
  await page.locator('.group-header', { hasText: '回收站' }).click()
  await expect(page.locator('.trash-item')).toHaveCount(1)
  await page.locator('.trash-restore').click()
  await expect(page.locator('.trash-item')).toHaveCount(0)

  const trash = await page.evaluate(() => (window as unknown as { __trash: Record<string, unknown> }).__trash)
  expect(Object.keys(trash)).toHaveLength(0)
  expect(errs).toEqual([])
})
