import { test, expect } from '@playwright/test'

/**
 * Real-usage E2E for debug.md sections E (search + graph): with a Tauri mock
 * serving a small vault of notes carrying frontmatter tags and [[wikilinks]],
 * drive the app as a user would — open a note, run a full-text content search
 * whose hit sits deep in a note body, open the graph panel, and assert the
 * rendered graph state and its filter controls. No internal APIs are forced:
 * every assertion is against deterministic DOM output; the graph's force layout
 * lives on Canvas, so nodes/edges are asserted through the panel's count text
 * (4 notes · 3 links) rather than pixels.
 */

const VAULT = 'test-fixtures'

const NOTES: Record<string, string> = {
  [`${VAULT}/welcome.md`]: [
    '---',
    'title: Welcome',
    'tags: [start]',
    '---',
    '# Welcome',
    '',
    'Hello, a [[note-a]] link down here.',
    '',
    'The word "topology" hides deep in this body.',
  ].join('\n'),
  [`${VAULT}/note-a.md`]: [
    '---',
    'title: Graph Theory',
    'tags: [graph]',
    '---',
    '# Graph Theory',
    '',
    'Links onward to [[note-b]].',
  ].join('\n'),
  [`${VAULT}/note-b.md`]: [
    '---',
    'title: Note B',
    '---',
    '# Note B',
    '',
    'Back to [[note-a]].',
  ].join('\n'),
  [`${VAULT}/note-c.md`]: [
    '---',
    'title: Orphan Note',
    'tags: [graph]',
    '---',
    '# Orphan Note',
    '',
    'Linked to nothing.',
  ].join('\n'),
}

const FIXTURES = Object.keys(NOTES).map((path) => ({
  name: path.split('/').pop() ?? path,
  path,
  is_dir: false,
  is_mdx: true,
}))

test('real usage: open note, full-text content search, graph panel; no pageerror', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))

  await page.addInitScript(
    ({ vault, fixtures, notes }) => {
      // English UI for deterministic selectors (the default locale is zh).
      localStorage.setItem('nekowite.locale', 'en')
      localStorage.setItem('nekowite.vault', vault)
      const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
      ;(window as unknown as { __invokeCalls: typeof calls }).__invokeCalls = calls
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
          if (cmd === 'create_dir') return 'attachments'
          if (cmd === 'save_attachment') return 'attachments/2026-09/paste-x.png'
          if (cmd === 'resolve_media_path') return '/abs/attachments/2026-09/paste-x.png'
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

  // (a) Open a note: click the welcome.md card in the default note list.
  const card = page.locator('.note-card', { hasText: 'Welcome' }).first()
  await expect(card).toBeVisible({ timeout: 15000 })
  await card.locator('.card-main').click()
  await expect(page.locator('.pane.rendered .ProseMirror h1')).toHaveText('Welcome')

  // (b) Content search: the hit only exists deep in welcome.md's body, so a
  // metadata prefilter could never find it — the full-body scan must.
  const searchInput = page.locator('.nl-search-input')
  await expect(searchInput).toBeVisible()
  await page.locator('.nl-search-toggle').click()
  await searchInput.fill('topology')
  const results = page.locator('.content-result')
  await expect(results).toHaveCount(1, { timeout: 15000 })
  await expect(results.first().locator('.content-result-name')).toHaveText('welcome.md')
  await expect(results.first().locator('.content-result-snippet')).toContainText('topology')

  // (c) Graph panel: the full vault renders (nodes + edges from [[wikilinks]]),
  // and the filter controls (cap/directory/tag/link-type) are present.
  await page.locator('.nav-group .nav-item', { hasText: 'Graph' }).click()
  await expect(page.locator('.graph-panel')).toBeVisible()
  const graphCount = page.locator('.graph-count')
  await expect(graphCount).toHaveText('4 notes · 3 links', { timeout: 15000 })
  await expect(page.locator('.graph-canvas')).toBeVisible()
  // Filter controls exist: node cap + directory + tag + link type selects.
  expect(await page.locator('.graph-select').count()).toBeGreaterThanOrEqual(3)
  // The tag filter is populated from the frontmatter of the loaded notes.
  // The control is a SelectMenu now, not a native <select>: its rows exist only
  // while the list is up, because the OS no longer draws them outside the DOM.
  await page.locator('.graph-select').nth(2).click()
  await expect(page.getByRole('option', { name: 'graph' })).toHaveCount(1)
  await page.keyboard.press('Escape')

  // (d) The whole flow must not raise an uncaught page error.
  expect(errs).toEqual([])
})
