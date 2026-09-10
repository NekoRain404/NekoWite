import { test, expect, type Page } from '@playwright/test'

// Comprehensive input regression suite for every editing mode.
//
// Historical failure family: a canonicalized Markdown copy produced by the
// hidden rendered pane was echoed back into the tab, replacing the live
// document and collapsing the caret to position 0. Symptoms reported by users:
// "pressing Enter jumps to the start", "two Backspaces jump to the start",
// "pressing the same key repeatedly jumps to the start".
//
// Each test below drives ONE input path repeatedly and asserts the caret keeps
// moving in the expected direction. Nothing here may snap to line 0 while the
// user is editing the tail of the document.

const VAULT = 'test-fixtures'
const FIXTURES = [
  { name: 'welcome.md', path: `${VAULT}/welcome.md`, is_dir: false, is_mdx: true },
]
// Deliberately non-canonical (doubled inner spaces, trailing newline) so a
// serializer round-trip would produce a DIFFERENT string. That difference is
// what used to trigger the document-replacing echo.
const DOC = '# Welcome\n\nalpha  one\n\nbeta   two\n\ngamma    three\n'

interface FixtureOptions {
  /** Autosave interval in ms, or 'off'. Defaults to 'off' for speed. */
  autosave?: number | 'off'
}

async function openNote(page: Page, options: FixtureOptions = {}): Promise<void> {
  const autosave = options.autosave === undefined ? 'off' : options.autosave
  await page.addInitScript(({ vault, fixtures, doc, autosaveInterval }) => {
    localStorage.setItem('nekowite.vault', vault)
    localStorage.setItem('nekowite.settings.autosaveInterval', String(autosaveInterval))
    const registry: Record<string, unknown> = {}
    let n = 0
    let disk = doc
    const NOTE_PATH = `${vault}/welcome.md`
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        // Only the vault root lists the note; every other directory (`.tmp`,
        // `.nekowite/index`, …) is empty. Returning the fixture list for those
        // paths made the recovery scan surface phantom orphaned temp files and
        // made the app treat index writes as note writes.
        if (cmd === 'list_dir') {
          const path = typeof args.path === 'string' ? args.path : ''
          return path === '' || path === vault ? fixtures : []
        }
        if (cmd === 'read_file') {
          const path = typeof args.path === 'string' ? args.path : ''
          return path === NOTE_PATH ? disk : ''
        }
        if (cmd === 'stat_file') return { size: disk.length, mtime: 1 }
        if (cmd === 'write_file') {
          // Persist only the note. Index/plugin writes must not clobber it.
          const path = typeof args.path === 'string' ? args.path : ''
          if (path === NOTE_PATH && typeof args.content === 'string') disk = args.content
          return undefined
        }
        if (cmd === 'watch_folder') return undefined
        if (cmd === 'list_history') return []
        if (cmd === 'plugin:event|listen') return ++n
        return undefined
      },
      transformCallback: (cb: unknown) => { registry[++n] = cb; return n },
      unregisterCallback: () => {},
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  }, { vault: VAULT, fixtures: FIXTURES, doc: DOC, autosaveInterval: autosave })

  await page.goto('/')
  await page.locator('.nav-item', { hasText: '文件夹' }).click()
  await page.locator('.tree-name', { hasText: 'welcome.md' }).click()
  await expect(page.locator('.pane.rendered .ProseMirror h1')).toHaveText('Welcome')
}

async function showSource(page: Page): Promise<void> {
  await page.locator('.switch-option', { hasText: '源码' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()
}

async function showSplit(page: Page): Promise<void> {
  await page.locator('.switch-option', { hasText: '对照' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()
}

async function showRendered(page: Page): Promise<void> {
  await page.locator('.switch-option', { hasText: '渲染' }).click()
  await expect(page.locator('.pane.rendered .ProseMirror')).toBeVisible()
}

/** Caret position inside the CodeMirror source pane: line index + column. */
function sourceCaret(page: Page) {
  return page.evaluate(() => {
    const sel = window.getSelection()
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null
    const lines = Array.from(document.querySelectorAll('.source-pane .cm-line'))
    const node = range?.startContainer ?? null
    const el = node instanceof Node && node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node?.parentElement ?? null
    const lineEl = el?.closest?.('.cm-line') ?? null
    return {
      line: lineEl ? lines.indexOf(lineEl) : -1,
      column: range?.startOffset ?? -1,
      lineText: lineEl?.textContent ?? '',
      focused: document.activeElement?.classList.contains('cm-content') ?? false,
    }
  })
}

/** Caret position inside the rendered (ProseMirror) pane. */
function renderedCaret(page: Page) {
  return page.evaluate(() => {
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
      path,
      offset: range?.startOffset ?? -1,
      blocks: Array.from(root?.children ?? []).map((el) => ({
        tag: el.tagName,
        text: el.textContent ?? '',
      })),
    }
  })
}

/** Put the CodeMirror caret at the very end of the document. */
async function sourceCaretToEnd(page: Page): Promise<void> {
  await page.locator('[data-testid="source-pane"] .cm-content').click()
  await page.keyboard.press('Control+End')
  await waitForSourceFocus(page)
}

/** Wait until the CodeMirror pane owns the selection. */
async function waitForSourceFocus(page: Page): Promise<void> {
  await expect
    .poll(async () => (await sourceCaret(page)).line, { timeout: 5000 })
    .toBeGreaterThanOrEqual(0)
}

/**
 * Wait until the rendered pane's caret has stopped moving.
 *
 * ProseMirror coalesces DOM mutations and flushes them ~20ms after the last
 * one. A keystroke sent before that flush is resolved against a selection the
 * model has not adopted yet, so it lands in the wrong block. Requiring two
 * identical consecutive samples proves the flush has caught up, and costs
 * nothing once the editor is idle.
 */
async function waitForRenderedCaretSettle(page: Page): Promise<void> {
  let previous = ''
  await expect
    .poll(
      async () => {
        const sample = JSON.stringify(await renderedCaret(page))
        const settled = sample === previous
        previous = sample
        return settled
      },
      { timeout: 5000, intervals: [40] },
    )
    .toBe(true)
}

/** Press one key and let the rendered editor absorb it before the next one. */
async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
  await waitForRenderedCaretSettle(page)
}

/**
 * Put the caret at the end of the heading text.
 *
 * A click alone only starts focus transfer; pressing a key before ProseMirror
 * owns the selection drops the keystroke on the floor.
 *
 * The point is taken at the END OF THE TEXT, not at the end of the `<h1>`
 * element. The element spans the whole content column, so its right edge is
 * blank space — and ProseMirror resolves blank space to the nearest position,
 * which is the paragraph *below* the heading while the pane is still settling.
 * The text rect also only exists once the heading has been painted, so it is
 * polled rather than read once.
 */
async function focusHeadingEnd(page: Page): Promise<void> {
  const heading = page.locator('.pane.rendered .ProseMirror h1').first()
  await expect(heading).toBeVisible()
  let point: { x: number; y: number } | null = null
  await expect
    .poll(
      async () => {
        point = await heading.evaluate((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0)
          const last = rects[rects.length - 1]
          if (!last || !el.textContent) return null
          return { x: Math.max(last.left + 1, last.right - 2), y: last.top + last.height / 2 }
        })
        return point !== null
      },
      { timeout: 5000, intervals: [30] },
    )
    .toBe(true)
  const target = point as { x: number; y: number } | null
  if (!target) throw new Error('heading text never rendered')

  await page.mouse.click(target.x, target.y)
  await expect
    .poll(async () => (await renderedCaret(page)).path, { timeout: 5000 })
    .toMatch(/H1>(?:SPAN>)?#text$/)
  await waitForRenderedCaretSettle(page)
}

/** Click a paragraph and wait until the caret is inside the editor. */
async function focusParagraph(page: Page, index: number): Promise<void> {
  const paragraph = page.locator('.pane.rendered .ProseMirror p').nth(index)
  await paragraph.click()
  await expect
    .poll(async () => (await renderedCaret(page)).path, { timeout: 5000 })
    .toContain('P')
  await waitForRenderedCaretSettle(page)
}

/**
 * Place the rendered caret at a character offset inside the Nth paragraph,
 * through the editor's own model.
 *
 * Reaching an exact offset by clicking and then arrowing is a chain of input
 * events that each have to be resolved against an adopted selection; under
 * load one lost press moves the caret a paragraph away. Tests that assert on an
 * exact caret position start from here instead.
 */
async function placeRenderedCaretInParagraph(
  page: Page,
  paragraphIndex: number,
  offset: number,
): Promise<void> {
  await page.evaluate(
    async ({ index, at }) => {
      const mod = (await import('/src/features/editor/sessionManager.ts')) as unknown as {
        editorSessionManager: { getView(): unknown }
      }
      const view = mod.editorSessionManager.getView() as {
        dom: HTMLElement
        posAtDOM(node: Node, offset: number): number
        state: {
          doc: { resolve(position: number): unknown }
          selection: { constructor: { near(pos: unknown, bias?: number): unknown } }
          tr: { setSelection(selection: unknown): unknown }
        }
        dispatch(tr: unknown): void
        focus(): void
      } | null
      if (!view) return
      const paragraphs = Array.from(view.dom.querySelectorAll(':scope > p')) as HTMLElement[]
      const element = paragraphs[index]
      if (!element) return
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      let remaining = at
      let target: { node: Node; offset: number } | null = null
      while (node) {
        const length = node.textContent?.length ?? 0
        if (remaining <= length) {
          target = { node, offset: remaining }
          break
        }
        remaining -= length
        node = walker.nextNode()
      }
      if (!target) return
      const pos = view.posAtDOM(target.node, target.offset)
      const Selection = view.state.selection.constructor
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos), 1)))
      view.focus()
    },
    { index: paragraphIndex, at: offset },
  )
  await waitForRenderedCaretSettle(page)
}

/** Type a value with the real keyboard, one physical press per character. */
async function typeChars(page: Page, value: string): Promise<void> {
  for (const ch of value) await page.keyboard.type(ch)
}

/** Paste `text` through the system clipboard (real Ctrl+V). */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value)
  }, text)
  await page.keyboard.press('Control+V')
}

// ---------------------------------------------------------------------------
// Source pane (CodeMirror)
// ---------------------------------------------------------------------------

test.describe('source pane', () => {
  test('typing a long burst advances the caret every keystroke', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)

    const columns: number[] = []
    for (let i = 0; i < 30; i++) {
      await page.keyboard.type('q')
      columns.push((await sourceCaret(page)).column)
    }
    for (let i = 1; i < columns.length; i++) {
      expect(columns[i]).toBeGreaterThan(columns[i - 1])
    }
  })

  test('typing with Shift, digits and symbols stays in place', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    const before = await sourceCaret(page)

    await page.keyboard.type('Hello World 123 !@#')
    await page.waitForTimeout(200)

    const after = await sourceCaret(page)
    expect(after.line).toBe(before.line)
    expect(after.column).toBe(before.column + 'Hello World 123 !@#'.length)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('Hello World 123 !@#')
  })

  test('CJK text (insertText path) lands at the caret', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    const before = await sourceCaret(page)

    await page.keyboard.insertText('这是一段中文测试')
    await page.waitForTimeout(200)

    const after = await sourceCaret(page)
    expect(after.line).toBe(before.line)
    expect(after.column).toBe(before.column + '这是一段中文测试'.length)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('这是一段中文测试')
  })

  test('repeated Enter inserts one line per press and never jumps', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    const start = await sourceCaret(page)

    for (let i = 0; i < 12; i++) await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    const end = await sourceCaret(page)
    expect(end.line).toBe(start.line + 12)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('# Welcome')
  })

  test('Enter at the start and middle of a line splits in place', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    const content = page.locator('[data-testid="source-pane"] .cm-content')
    await content.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    await page.waitForTimeout(120)
    const lineStart = await sourceCaret(page)

    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    const afterSplit = await sourceCaret(page)
    // Enter at column 0 splits the line: the text is pushed onto a new line and
    // CodeMirror standardly leaves the caret at the start of that pushed-down
    // text, not on the blank line above it. Either way it is the SAME line
    // index the user was on before, and never the document start.
    expect(afterSplit.line).toBe(lineStart.line + 1)
    expect(afterSplit.column).toBe(0)

    await page.keyboard.type('inserted-')
    await page.waitForTimeout(200)
    expect((await sourceCaret(page)).line).toBe(lineStart.line + 1)
    await expect(content).toContainText('inserted-')
    await expect(content).toContainText('alpha  one')
  })

  test('repeated Backspace deletes backwards without jumping to the top', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)

    const trail: string[] = []
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Backspace')
      const caret = await sourceCaret(page)
      trail.push(`${caret.line}:${caret.column}`)
    }
    // The trailing empty line is joined first (caret lands at the end of
    // "gamma    three"), then one character per press is eaten. The line never
    // changes and never becomes the document start.
    expect(trail[0]).toBe('6:14')
    expect(trail[trail.length - 1]).toBe('6:7')
    for (const entry of trail) expect(entry.startsWith('6:')).toBe(true)
  })

  test('Backspace at the start of a line joins it with the previous one', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    const content = page.locator('[data-testid="source-pane"] .cm-content')
    await content.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    await page.waitForTimeout(120)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)

    const after = await sourceCaret(page)
    // The line was joined upward: caret sits at the end of the (blank) line
    // above, never at the document start on a re-created document.
    expect(after.line).toBe(1)
    await expect(content).toContainText('# Welcome')
  })

  test('Delete key removes forward and keeps the caret', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    const content = page.locator('[data-testid="source-pane"] .cm-content')
    await content.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    await page.waitForTimeout(120)

    const before = await sourceCaret(page)
    for (let i = 0; i < 5; i++) await page.keyboard.press('Delete')
    await page.waitForTimeout(200)

    const after = await sourceCaret(page)
    expect(after.line).toBe(before.line)
    expect(after.column).toBe(0)
    await expect(content).not.toContainText('alpha')
  })

  test('arrow keys and Home/End move the caret without document changes', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    const content = page.locator('[data-testid="source-pane"] .cm-content')
    const textBefore = await content.innerText()

    // The document ends with a trailing newline, so Control+End lands on a final
    // empty line whose only valid column is 0. Test Home/End on a line that
    // actually has text.
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(80)
    await page.keyboard.press('Home')
    expect((await sourceCaret(page)).column).toBe(0)
    await page.keyboard.press('End')
    expect((await sourceCaret(page)).column).toBeGreaterThan(0)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Control+Home')
    expect((await sourceCaret(page)).line).toBe(0)
    await page.keyboard.press('Control+End')
    expect((await sourceCaret(page)).line).toBe(7)

    expect(await content.innerText()).toBe(textBefore)
  })

  test('select-all then typing replaces the whole document', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('replaced')
    await page.waitForTimeout(200)

    const content = page.locator('[data-testid="source-pane"] .cm-content')
    await expect(content).toContainText('replaced')
    await expect(content).not.toContainText('# Welcome')
  })

  test('undo and redo restore the edit without moving the caret to the top', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    await page.keyboard.type('XYZ')
    await page.waitForTimeout(200)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('XYZ')

    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).not.toContainText('XYZ')

    // Ctrl+Shift+Z is what every Windows editor uses for redo; CodeMirror's
    // bundled keymap only bound it under its `linux` flag, so this chord must
    // keep working (Mod-y is covered separately by the bundled history keymap).
    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(200)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('XYZ')

    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(200)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('XYZ')
  })

  test('pasting multi-line markdown inserts it at the caret', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)

    await pasteText(page, 'pasted line 1\npasted line 2')
    await page.waitForTimeout(300)

    const content = page.locator('[data-testid="source-pane"] .cm-content')
    await expect(content).toContainText('pasted line 1')
    await expect(content).toContainText('pasted line 2')
    const caret = await sourceCaret(page)
    expect(caret.line).toBeGreaterThan(4)
  })

  test('markdown punctuation typed one key at a time stays in order', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(120)

    await typeChars(page, '# heading')
    await page.keyboard.press('Enter')
    await typeChars(page, '- item')
    await page.keyboard.press('Enter')
    await typeChars(page, '> quote')
    await page.waitForTimeout(300)

    const content = page.locator('[data-testid="source-pane"] .cm-content')
    await expect(content).toContainText('# heading')
    await expect(content).toContainText('- item')
    await expect(content).toContainText('> quote')
  })

  test('Tab indents instead of moving focus away', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await page.locator('[data-testid="source-pane"] .cm-content').click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    await page.waitForTimeout(120)

    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    expect((await sourceCaret(page)).focused).toBe(true)
    expect((await sourceCaret(page)).lineText.startsWith('  ')).toBe(true)
  })

  test('autosave firing mid-editing does not reset the caret', async ({ page }) => {
    await openNote(page, { autosave: 5000 })
    await showSource(page)
    await sourceCaretToEnd(page)
    await page.keyboard.type('before-')
    const before = await sourceCaret(page)

    // Wait past the autosave interval so a save round-trip happens while the
    // pane keeps its selection.
    await page.waitForTimeout(5600)
    const duringSave = await sourceCaret(page)
    expect(duringSave.line).toBe(before.line)
    expect(duringSave.column).toBe(before.column)

    await page.keyboard.type('after-')
    await page.waitForTimeout(200)
    const after = await sourceCaret(page)
    expect(after.line).toBe(before.line)
    expect(after.column).toBe(before.column + 'after-'.length)
  })
})

// ---------------------------------------------------------------------------
// Rendered pane (ProseMirror / Milkdown)
// ---------------------------------------------------------------------------

test.describe('rendered pane', () => {
  test('typing a long burst lands entirely in the new paragraph', async ({ page }) => {
    await openNote(page)
    await focusHeadingEnd(page)
    await pressKey(page, 'Enter')

    for (let i = 0; i < 25; i++) await page.keyboard.type('w')
    await page.waitForTimeout(300)

    const state = await renderedCaret(page)
    expect(state.blocks[0].text).toBe('Welcome')
    expect(state.blocks[1].text).toBe('w'.repeat(25))
  })

  test('Enter in the middle of a paragraph splits it', async ({ page }) => {
    await openNote(page)
    await placeRenderedCaretInParagraph(page, 0, 5)
    await pressKey(page, 'Enter')

    const state = await renderedCaret(page)
    const first = state.blocks.find((b) => b.text.startsWith('alpha'))
    expect(state.blocks.some((b) => b.text === 'alpha')).toBe(true)
    expect(state.blocks.some((b) => b.text === '  one')).toBe(true)
    expect(first).toBeTruthy()
  })

  test('Backspace merges a paragraph into the previous one', async ({ page }) => {
    await openNote(page)
    await focusParagraph(page, 2)
    await page.keyboard.press('Home')
    await page.waitForTimeout(120)

    await page.keyboard.press('Backspace')
    await page.waitForTimeout(250)

    const state = await renderedCaret(page)
    // The empty separator paragraph was removed; the caret stays above the
    // document start rather than being placed on the heading.
    expect(state.blocks[0].text).toBe('Welcome')
    expect(state.path).toMatch(/P/)
  })

  test('Delete removes forward and keeps the caret in the paragraph', async ({ page }) => {
    await openNote(page)
    await focusParagraph(page, 0)
    await page.keyboard.press('Home')
    await page.waitForTimeout(120)

    for (let i = 0; i < 5; i++) await page.keyboard.press('Delete')
    await page.waitForTimeout(250)

    const state = await renderedCaret(page)
    expect(state.blocks[0].text).toBe('Welcome')
    expect(state.path).toMatch(/P/)
    expect(state.blocks.some((b) => b.text.includes('one'))).toBe(true)
  })

  test('markdown shortcuts build a heading, a list and a quote', async ({ page }) => {
    await openNote(page)
    await focusParagraph(page, 2)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)

    await typeChars(page, '## second heading')
    await page.waitForTimeout(250)
    let html = await page.locator('.pane.rendered .ProseMirror').innerHTML()
    expect(html).toContain('<h2')

    await page.keyboard.press('Enter')
    await typeChars(page, '- bullet item')
    await page.waitForTimeout(250)
    html = await page.locator('.pane.rendered .ProseMirror').innerHTML()
    expect(html).toContain('<ul')

    // Two Enters leave the list: the first opens a new item, the second turns
    // that empty item back into a plain paragraph.
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await typeChars(page, '> quoted')
    await page.waitForTimeout(250)
    html = await page.locator('.pane.rendered .ProseMirror').innerHTML()
    expect(html).toContain('<blockquote')
  })

  test('slash menu opens on "/" and filters without losing the paragraph', async ({ page }) => {
    await openNote(page)
    await focusParagraph(page, 2)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)

    await typeChars(page, '/')
    await page.waitForTimeout(300)
    await typeChars(page, 'table')
    await page.waitForTimeout(300)

    const state = await renderedCaret(page)
    expect(state.blocks[0].text).toBe('Welcome')
    expect(state.path).toMatch(/P/)
  })

  test('select-all then typing replaces the document', async ({ page }) => {
    await openNote(page)
    await focusParagraph(page, 0)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('only text')
    await page.waitForTimeout(250)

    const state = await renderedCaret(page)
    expect(state.blocks.length).toBe(1)
    expect(state.blocks[0].text).toBe('only text')
  })

  test('undo and redo keep the model consistent', async ({ page }) => {
    await openNote(page)
    await focusParagraph(page, 0)
    await page.keyboard.press('End')
    await page.keyboard.type('XYZ')
    await page.waitForTimeout(250)
    await expect(page.locator('.pane.rendered .ProseMirror')).toContainText('XYZ')

    await page.keyboard.press('Control+z')
    await page.waitForTimeout(250)
    await expect(page.locator('.pane.rendered .ProseMirror')).not.toContainText('XYZ')

    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(250)
    await expect(page.locator('.pane.rendered .ProseMirror')).toContainText('XYZ')
  })

  test('pasting markdown text preserves the caret in the paragraph', async ({ page }) => {
    await openNote(page)
    await focusParagraph(page, 2)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)

    await pasteText(page, 'pasted text here')
    await page.waitForTimeout(300)

    const state = await renderedCaret(page)
    expect(state.blocks[0].text).toBe('Welcome')
    expect(state.blocks.some((b) => b.text === 'pasted text here')).toBe(true)
  })

  test('CJK text typed in the rendered pane stays out of the heading', async ({ page }) => {
    await openNote(page)
    await focusHeadingEnd(page)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)

    await page.keyboard.insertText('中文段落测试')
    await page.waitForTimeout(300)

    const state = await renderedCaret(page)
    expect(state.blocks[0].text).toBe('Welcome')
    expect(state.blocks[1].text).toBe('中文段落测试')
  })

  test('autosave firing mid-editing does not reset the caret', async ({ page }) => {
    await openNote(page, { autosave: 5000 })
    await focusHeadingEnd(page)
    await page.keyboard.press('Enter')
    await page.keyboard.type('before-')
    await page.waitForTimeout(200)

    await page.waitForTimeout(5600)
    await page.keyboard.type('after-')
    await page.waitForTimeout(300)

    const state = await renderedCaret(page)
    expect(state.blocks[1].text).toBe('before-after-')
  })
})

// ---------------------------------------------------------------------------
// Split pane and mode switching
// ---------------------------------------------------------------------------

test.describe('split pane and mode switching', () => {
  test('typing in the source pane keeps its caret and updates the rendered pane', async ({ page }) => {
    await openNote(page)
    await showSplit(page)
    await sourceCaretToEnd(page)
    const before = await sourceCaret(page)

    for (let i = 0; i < 12; i++) {
      await page.keyboard.type('s')
      const caret = await sourceCaret(page)
      expect(caret.line).toBe(before.line)
      expect(caret.column).toBeGreaterThan(before.column)
    }
    await page.waitForTimeout(300)
    await expect(page.locator('.pane.rendered .ProseMirror')).toContainText('s'.repeat(12))
  })

  test('source-pane edits survive a round trip through rendered mode', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    await page.keyboard.type('tail-marker')
    await page.waitForTimeout(250)

    await showRendered(page)
    await expect(page.locator('.pane.rendered .ProseMirror')).toContainText('tail-marker')

    await showSource(page)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('tail-marker')
  })

  test('rendered-pane edits survive a round trip through source mode', async ({ page }) => {
    await openNote(page)
    await focusHeadingEnd(page)
    await page.keyboard.press('Enter')
    await page.keyboard.type('rendered-marker')
    await page.waitForTimeout(300)

    await showSource(page)
    await expect(page.locator('[data-testid="source-pane"] .cm-content')).toContainText('rendered-marker')

    await showRendered(page)
    await expect(page.locator('.pane.rendered .ProseMirror')).toContainText('rendered-marker')
  })

  test('switching modes repeatedly keeps the caret usable', async ({ page }) => {
    await openNote(page)
    await showSource(page)
    await sourceCaretToEnd(page)
    await page.keyboard.type('mode-check')
    await page.waitForTimeout(200)

    await showRendered(page)
    await showSplit(page)
    await showSource(page)
    await showRendered(page)
    await showSource(page)

    const content = page.locator('[data-testid="source-pane"] .cm-content')
    await expect(content).toContainText('mode-check')
    await content.click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await page.waitForTimeout(200)
    await expect(content).toContainText('mode-check!')
  })
})
