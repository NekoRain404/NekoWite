import { test, expect } from '@playwright/test'

const VAULT = 'test-fixtures'
const FIXTURES = [
  { name: 'welcome.md', path: `${VAULT}/welcome.md`, is_dir: false, is_mdx: true },
]

test('diagnose heading blank edge Enter / delete slash', async ({ page }) => {
  await page.addInitScript(({ vault, fixtures }) => {
    localStorage.setItem('nekowite.vault', vault)
    const registry: Record<string, unknown> = {}
    let n = 0
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === 'list_dir') return fixtures
        if (cmd === 'read_file') return '# Welcome\n\nSome body text.\n'
        if (cmd === 'stat_file') return { size: 1, mtime: 1 }
        if (cmd === 'write_file') return undefined
        if (cmd === 'watch_folder') return undefined
        if (cmd === 'list_history') return []
        if (cmd === 'plugin:event|listen') return ++n
        return undefined
      },
      transformCallback: (cb: unknown) => { registry[++n] = cb; return n },
      unregisterCallback: () => {},
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  }, { vault: VAULT, fixtures: FIXTURES })

  await page.goto('/')
  await page.locator('.nav-item', { hasText: '文件夹' }).click()
  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()
  const pm = page.locator('.pane.rendered .ProseMirror')
  await expect(pm.locator('h1')).toHaveText('Welcome')
  // The heading wrapper spans the full content column, so its far-right blank
  // area is still editable h1 content. That edge is where Chromium used to
  // place the DOM caret outside ProseMirror's contentDOM.
  const heading = pm.locator('.nk-heading')
  const box = (await heading.boundingBox())!
  const edge = { x: box.width - 2, y: box.height / 2 }

  const snap = async (label: string) => {
    const state = await page.evaluate(() => {
      const root = document.querySelector('.pane.rendered .ProseMirror') as HTMLElement | null
      const sel = window.getSelection()
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null
      let path = ''
      let cur: Node | null = range?.startContainer ?? null
      while (cur && cur !== document.body) {
        path = (cur.nodeName || '') + (path ? '>' + path : '')
        cur = cur.parentNode
      }
      return {
        html: root?.outerHTML ?? '',
        texts: Array.from(root?.children ?? []).map((el) => el.textContent ?? ''),
        path,
        selOffset: range?.startOffset ?? -1,
        active: document.activeElement?.className ?? '',
      }
    })
    console.log('SNAP', label, JSON.stringify(state))
    return state
  }

  // What the engine's own hit test finds at the point this spec aims at, read in
  // the page: `elementFromPoint` is the question the click answers, so a caret
  // that went elsewhere can be attributed instead of guessed at.
  const hitAtEdge = () =>
    page.evaluate(() => {
      const wrapper = document.querySelector('.pane.rendered .ProseMirror .nk-heading')
      if (!wrapper) return 'no .nk-heading'
      const rect = wrapper.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2)
      return hit ? `${hit.nodeName}.${(hit as HTMLElement).className}` : 'no element'
    })

  // Aim, then check that the aim is where the caret went, and re-aim only when it is
  // not. This click has been seen to arrive below the heading, in the blank space
  // under the document, where the caret belongs to the end of the last paragraph
  // (`...DIV>P>#text`) rather than to the heading's edge (`...DIV>H1>#text`): run
  // 35174117944, on a runner whose other worker was still cold. The property this
  // spec holds is what happens *after* the caret is at the heading's edge, so a miss
  // is printed and re-taken rather than asserted — and a miss can only be the point
  // having moved, which is why the point is read at the moment it is aimed as well as
  // after the click. A point that reads as the heading with the caret somewhere else
  // is the editor answering a click at its own edge with the wrong caret: that is a
  // defect and not an aim, and the assertion below prints the reading so a red is
  // never pinned on the wrong one of the two. Bounded at three attempts, with no
  // timeout widened: a heading edge that resists all three is red here.
  const clickHeadingEdge = async () => {
    const aimed = await hitAtEdge()
    await heading.click({ position: edge })
    await page.waitForTimeout(100)
    return { aimed, state: await snap('heading-text-end') }
  }

  let at = await clickHeadingEdge()
  for (let attempt = 1; attempt <= 3 && !/H1(?:>#text)?$/.test(at.state.path); attempt++) {
    console.log(
      `MISS attempt ${attempt}: the point read as ${at.aimed} and the caret went to ${at.state.path}`,
    )
    at = await clickHeadingEdge()
  }
  expect(
    at.state.path,
    `the caret is not in the heading after clicking its blank right edge (the point read as ${at.aimed} when it was aimed)`,
  ).toMatch(/H1(?:>#text)?$/)

  await page.keyboard.press('Enter')
  await page.waitForTimeout(250)
  await snap('after-enter')
  await page.keyboard.type('abc')
  await page.waitForTimeout(250)
  await snap('after-abc')
  const before = await snap('before-backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  const after = await snap('after-backspace')
  await page.keyboard.type('/')
  await page.waitForTimeout(250)
  const slash = await snap('after-slash')
  // textContent concatenates heading + body, so assert per top-level node
  // instead. The heading stays intact and the typed text always belongs to the
  // paragraph created by Enter.
  expect(before.texts).toEqual(['Welcome', 'abc', 'Some body text.'])
  expect(after.texts).toEqual(['Welcome', '', 'Some body text.'])
  expect(slash.texts).toEqual(['Welcome', '/', 'Some body text.'])
  expect(slash.path).toMatch(/P>#text$/)
  expect(slash.selOffset).toBe(1)
  expect(slash.html).toContain('<p>/</p>')
  expect(before.path).toMatch(/P>(?:SPAN>)?#text$/)
  expect(after.path).toMatch(/>P$/)
})
