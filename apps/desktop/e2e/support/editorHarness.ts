import { expect, type Page } from '@playwright/test'

// Shared harness for the editor input suites. The app talks to Tauri over
// `window.__TAURI_INTERNALS__.invoke`; these fixtures stand in for the Rust
// backend with an in-memory vault so a test can drive the real editor without
// touching disk.

export const VAULT = 'test-fixtures'

/**
 * Deliberately non-canonical (doubled inner spaces, trailing newline) so a
 * serializer round-trip produces a DIFFERENT string. That difference is what
 * used to trigger the document-replacing echo.
 */
export const DEFAULT_DOC = '# Welcome\n\nalpha  one\n\nbeta   two\n\ngamma    three\n'

export const NOTE_NAME = 'welcome.md'

export interface HarnessOptions {
  /** Initial on-disk markdown for `welcome.md`. */
  doc?: string
  /** Autosave interval in ms, or 'off'. Defaults to 'off' for speed. */
  autosave?: number | 'off'
  /** Appearance settings merged over the store defaults. */
  appearance?: Record<string, unknown>
  /** Extra vault files, keyed by path (relative to the vault root). */
  files?: Record<string, string>
  /** Make `import_attachment` fail, to exercise the error path. */
  importFails?: boolean
  /** Make `pick_image_files` reject, as a broken native dialog would. */
  pickFails?: boolean
  /**
   * Attachment payloads, keyed by vault-relative path. `resolve_media_path`
   * turns these into data URLs so an image genuinely loads in the browser.
   */
  attachments?: Record<string, string>
  /** Artificial latency (ms) on `resolve_media_path`, to observe the
   *  pre-resolution state of an image. */
  resolveDelayMs?: number
}

interface InitPayload extends HarnessOptions {
  vault: string
  noteName: string
}

/** The document a harness boot starts from when the test does not supply one. */
export const HARNESS_DEFAULT_DOC = DEFAULT_DOC

/**
 * Boot the app against an in-memory vault and open `welcome.md`, waiting until
 * the rendered editor has parsed the document.
 */
export async function openNote(page: Page, options: HarnessOptions = {}): Promise<void> {
  const noteName = NOTE_NAME
  await page.addInitScript((payload: InitPayload) => {
    const { vault, noteName: name, doc, autosave, appearance, files } = payload
    const { importFails, pickFails, attachments, resolveDelayMs } = payload
    // Mutable at runtime so a spec can seed bytes after the app has loaded
    // (used to prove Retry re-resolves instead of replaying a failure).
    ;(window as unknown as { __NEKO_ATTACHMENTS__?: Record<string, string> }).__NEKO_ATTACHMENTS__ = {
      ...(attachments ?? {}),
    }
    localStorage.setItem('nekowite.vault', vault)
    localStorage.setItem(
      'nekowite.settings.autosaveInterval',
      String(autosave === undefined ? 'off' : autosave),
    )
    if (appearance) {
      const raw = localStorage.getItem('nekowite.appearance')
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      localStorage.setItem('nekowite.appearance', JSON.stringify({ ...parsed, ...appearance }))
    }

    // Mirrors the Rust default layout; the month is fixed so assertions are
    // stable regardless of when the suite runs.
    const attachmentDir = (dir: string) => (dir && dir.trim() ? dir.replace(/^\/+|\/+$/g, '') : 'attachments/2026-09')
    const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path

    const registry: Record<string, unknown> = {}
    let n = 0
    const disk = new Map<string, string>()
    for (const [path, content] of Object.entries(files ?? {})) disk.set(path, content)
    // Set the note last so an explicit `files` entry for the same path cannot
    // win over the document the test asked to open.
    if (doc !== undefined) disk.set(`${vault}/${name}`, doc)

    const list = [
      { name, path: `${vault}/${name}`, is_dir: false, is_mdx: true },
      ...Object.keys(files ?? {}).map((path) => ({
        name: path.split('/').pop() ?? path,
        path,
        is_dir: false,
        is_mdx: true,
      })),
    ]

    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        // Only the vault root lists notes; every other directory (`.tmp`,
        // `.nekowite/index`, …) is empty. Returning the note list for those
        // paths made the recovery scan surface phantom orphaned temp files and
        // made the app treat index writes as note writes.
        if (cmd === 'list_dir') {
          const path = typeof args.path === 'string' ? args.path : ''
          return path === '' || path === vault ? list : []
        }
        if (cmd === 'read_file') {
          const path = typeof args.path === 'string' ? args.path : ''
          return disk.get(path) ?? ''
        }
        if (cmd === '__disk_dump') {
          // Test-only: the whole in-memory vault, so a spec can assert on the
          // bytes that were actually persisted rather than on the live editor.
          return Object.fromEntries(disk)
        }
        if (cmd === 'stat_file') return { size: 1, mtime: 1 }
        if (cmd === 'resolve_media_path') {
          // The Rust command returns an absolute PATH, which the frontend turns
          // into an asset URL via convertFileSrc. In the browser there is no
          // asset protocol, so this stands in with a data URL (and
          // convertFileSrc below is the identity) — that is what lets these
          // specs assert that an image actually renders.
          const relPath = String(args.rel_path ?? '')
          if (resolveDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, resolveDelayMs))
          }
          const store = (window as { __NEKO_ATTACHMENTS__?: Record<string, string> })
            .__NEKO_ATTACHMENTS__
          const payload = store?.[relPath]
          if (payload === undefined) throw new Error(`no such attachment: ${relPath}`)
          return `data:image/png;base64,${payload}`
        }
        if (cmd === 'write_file') {
          // Persist only real notes. Index/plugin writes must not clobber them.
          const path = typeof args.path === 'string' ? args.path : ''
          if (disk.has(path) && typeof args.content === 'string') disk.set(path, args.content)
          return undefined
        }
        if (cmd === 'watch_folder') return undefined
        if (cmd === 'pick_image_files') {
          if (pickFails) throw new Error('dialog unavailable')
          // One-shot, like the native dialog: reopening starts empty.
          const queued = (window as { __NEKO_PICK_QUEUE__?: string[] }).__NEKO_PICK_QUEUE__ ?? []
          ;(window as { __NEKO_PICK_QUEUE__?: string[] }).__NEKO_PICK_QUEUE__ = []
          return queued
        }
        if (cmd === 'import_attachment') {
          if (importFails) throw new Error('import rejected')
          const sourcePath = String(args.source_path ?? '')
          const picked = (window as { __NEKO_PICKED__?: Record<string, string> }).__NEKO_PICKED__ ?? {}
          if (picked[sourcePath] === undefined) {
            throw new Error(`no queued payload for ${sourcePath}`)
          }
          return `${attachmentDir(String(args.dir ?? ''))}/${baseName(sourcePath)}`
        }
        if (cmd === 'save_attachment') {
          const dir = String(args.dir ?? '')
          return `${attachmentDir(dir)}/${String(args.file_name ?? 'image.png')}`
        }
        if (cmd === 'list_history') return []
        if (cmd === 'plugin:event|listen') return ++n
        return undefined
      },
      // Identity: the dev server has no asset protocol, and the stub above
      // already returns a loadable data URL.
      convertFileSrc: (filePath: string) => filePath,
      transformCallback: (cb: unknown) => {
        registry[++n] = cb
        return n
      },
      unregisterCallback: () => {},
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  }, { vault: VAULT, noteName, doc: DEFAULT_DOC, ...options } as InitPayload)

  await page.goto('/')
  await openFromTree(page, noteName)
}

/** Click a note in the file tree and wait for the rendered editor to parse it. */
export async function openFromTree(page: Page, name: string): Promise<void> {
  await page.locator('.nav-item', { hasText: '文件夹' }).click()
  await page.locator('.tree-name', { hasText: name }).first().click()
  await expect(page.locator('.pane.rendered .ProseMirror')).toBeVisible()
}

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

export async function showSource(page: Page): Promise<void> {
  await page.locator('.switch-option', { hasText: '源码' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()
}

export async function showSplit(page: Page): Promise<void> {
  await page.locator('.switch-option', { hasText: '对照' }).click()
  await expect(page.locator('[data-testid="source-pane"] .cm-content')).toBeVisible()
}

export async function showRendered(page: Page): Promise<void> {
  await page.locator('.switch-option', { hasText: '渲染' }).click()
  await expect(page.locator('.pane.rendered .ProseMirror')).toBeVisible()
}

// ---------------------------------------------------------------------------
// Caret / content readers
// ---------------------------------------------------------------------------

export interface SourceCaret {
  line: number
  column: number
  lineText: string
  lineCount: number
  focused: boolean
}

/** Caret position inside the CodeMirror source pane. */
export function sourceCaret(page: Page): Promise<SourceCaret> {
  return page.evaluate(() => {
    const sel = window.getSelection()
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null
    const lines = Array.from(document.querySelectorAll('.source-pane .cm-line'))
    const node = range?.startContainer ?? null
    const el =
      node instanceof Node && node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : (node?.parentElement ?? null)
    const lineEl = el?.closest?.('.cm-line') ?? null
    return {
      line: lineEl ? lines.indexOf(lineEl) : -1,
      column: range?.startOffset ?? -1,
      lineText: lineEl?.textContent ?? '',
      lineCount: lines.length,
      focused: document.activeElement?.classList.contains('cm-content') ?? false,
    }
  })
}

export interface RenderedCaret {
  /** nodeName chain from `document.body` down to the selection anchor. */
  path: string
  offset: number
  blocks: Array<{ tag: string; text: string }>
}

/** Caret position inside the rendered (ProseMirror) pane. */
export function renderedCaret(page: Page): Promise<RenderedCaret> {
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

/** Top-level block tag names in the rendered pane, e.g. `['DIV','P','UL']`. */
export function renderedTags(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelector('.pane.rendered .ProseMirror')?.children ?? [],
    ).map((el) => el.tagName),
  )
}

/** Block texts in the rendered pane, ignoring the wrapper elements. */
export function renderedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelector('.pane.rendered .ProseMirror')?.children ?? [],
    ).map((el) => el.textContent ?? ''),
  )
}

/** Raw markdown currently held by the source pane. */
export function sourceText(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector('[data-testid="source-pane"] .cm-content') as HTMLElement)?.innerText ?? '',
  )
}

/** The markdown the live editor serializes to (the authoritative model). */
export function modelMarkdown(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const mod = (await import('/src/features/editor/sessionManager.ts')) as unknown as {
      editorSessionManager: { getActiveEditor(): { save(): Promise<string> } | null }
    }
    const editor = mod.editorSessionManager.getActiveEditor()
    return editor ? await editor.save() : ''
  })
}

/** The live ProseMirror selection head (UTF-16 offset into the model). */
export function modelHead(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const mod = (await import('/src/features/editor/sessionManager.ts')) as unknown as {
      editorSessionManager: { getView(): { state: { selection: { head: number } } } | null }
    }
    return mod.editorSessionManager.getView()?.state.selection.head ?? -1
  })
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the rendered pane's caret has stopped moving.
 *
 * ProseMirror coalesces DOM mutations and flushes them ~20ms after the last
 * one. A keystroke sent before that flush is resolved against a selection the
 * model has not adopted yet, so it lands in the wrong block. Requiring two
 * identical consecutive samples proves the flush has caught up, and costs
 * nothing once the editor is idle.
 */
export async function waitForRenderedCaretSettle(page: Page): Promise<void> {
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
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
  await waitForRenderedCaretSettle(page)
}

/** Put the CodeMirror caret at the very end of the document. */
export async function sourceCaretToEnd(page: Page): Promise<void> {
  await page.locator('[data-testid="source-pane"] .cm-content').click()
  await page.keyboard.press('Control+End')
  await expect
    .poll(async () => (await sourceCaret(page)).line, { timeout: 5000 })
    .toBeGreaterThanOrEqual(0)
}

/**
 * Click a rendered paragraph and wait until the caret is inside the editor.
 *
 * A paragraph spans the whole content column, so a click near its right edge
 * lands in blank space whose caret mapping is only unambiguous once the pane
 * has settled. The click is retried so a lost race cannot turn into a caret in
 * the wrong block.
 */
export async function focusParagraph(page: Page, index: number): Promise<void> {
  const paragraph = page.locator('.pane.rendered .ProseMirror p').nth(index)
  await expect(paragraph).toBeVisible()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await paragraph.click()
    try {
      await expect
        .poll(async () => (await renderedCaret(page)).path, { timeout: 1000, intervals: [40] })
        .toContain('P')
      break
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  await waitForRenderedCaretSettle(page)
}

/**
 * Put the caret at the end of the heading text.
 *
 * The click targets the last character's right edge rather than the `<h1>`
 * element's: an `<h1>` spans the whole content column, so its far-right edge is
 * blank space, and ProseMirror resolves blank space to the nearest position —
 * during the frame that follows, that can be the paragraph *below* the heading.
 *
 * The element appears with the model but its text is painted a frame later, so
 * the measurement is polled until the heading actually has text. Measuring
 * earlier silently falls back to the element's full-width box, which is exactly
 * the ambiguous point this avoids.
 */
export async function focusHeadingEnd(page: Page): Promise<void> {
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

/**
 * Place the rendered caret at a character offset inside the Nth paragraph,
 * through the editor's own model.
 *
 * Reaching a specific offset by clicking and then arrowing is a chain of
 * six input events, each of which must be resolved against a selection
 * ProseMirror has already adopted; under load a single lost press moves the
 * caret a paragraph away. Tests that assert on an exact caret position use
 * this instead, so the starting point is exact by construction.
 */
export async function placeRenderedCaretInParagraph(
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
      const paragraphs = Array.from(
        view.dom.querySelectorAll(':scope > p'),
      ) as HTMLElement[]
      const element = paragraphs[index]
      if (!element) return
      // Walk to the character at `at` within the paragraph's text, then let
      // ProseMirror map that DOM position back into the document.
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
export async function typeChars(page: Page, value: string): Promise<void> {
  for (const ch of value) await page.keyboard.type(ch)
}

/** Put `text` on the system clipboard (granting the permission first). */
export async function setClipboard(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value)
  }, text)
}

/** Paste `text` through the system clipboard (real Ctrl+V). */
export async function pasteText(page: Page, text: string): Promise<void> {
  await setClipboard(page, text)
  await page.keyboard.press('Control+V')
}

/** Read the system clipboard back out. */
export function readClipboard(page: Page): Promise<string> {
  return page.evaluate(async () => navigator.clipboard.readText())
}

// ---------------------------------------------------------------------------
// Attachments / image intake
// ---------------------------------------------------------------------------

/**
 * Queue what the next `pick_image_files` call returns, with each file's base64
 * payload keyed by its absolute source path (mirroring the real contract: the
 * picker hands back paths and the backend reads the bytes).
 */
export async function queuePick(page: Page, files: Record<string, string>): Promise<void> {
  await page.evaluate((payload) => {
    const w = window as {
      __NEKO_PICKED__?: Record<string, string>
      __NEKO_PICK_QUEUE__?: string[]
    }
    w.__NEKO_PICKED__ = { ...(w.__NEKO_PICKED__ ?? {}), ...payload }
    w.__NEKO_PICK_QUEUE__ = Object.keys(payload)
  }, files)
}

/**
 * The insert-image toolbar button, resolved through the app's own i18n label so
 * the selector survives a locale change.
 */
export async function imageToolbarButton(page: Page): Promise<ReturnType<Page['getByRole']>> {
  const label = await page.evaluate(async () => {
    const mod = (await import('/src/i18n/index.ts')) as unknown as { t(key: string): string }
    return mod.t('toolbar.image')
  })
  return page.getByRole('button', { name: label }).first()
}

/** Raw markdown held by the live CodeMirror source view. */
export function sourceDoc(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const mod = (await import('/src/services/sourceView.ts')) as unknown as {
      getSourceView(): { state: { doc: { toString(): string } } } | null
    }
    return mod.getSourceView()?.state.doc.toString() ?? ''
  })
}

/** Dispatch an image paste on the shared pane container (both editors listen). */
export async function pasteImageFiles(page: Page, names: string[]): Promise<void> {
  await page.evaluate((fileNames) => {
    const dt = new DataTransfer()
    for (const name of fileNames) {
      dt.items.add(
        new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' }),
      )
    }
    const target = document.querySelector('.panes') ?? document.body
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  }, names)
}

/** Dispatch an image drop on the shared pane container. */
export async function dropImageFiles(page: Page, names: string[]): Promise<void> {
  await page.evaluate((fileNames) => {
    const dt = new DataTransfer()
    for (const name of fileNames) {
      dt.items.add(
        new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' }),
      )
    }
    const target = document.querySelector('.panes') ?? document.body
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, names)
}

/** Paste one image and complete the rename dialog it opens. */
export async function pasteImage(page: Page, renameTo = 'clip.png'): Promise<void> {
  await pasteImageFiles(page, ['image.png'])
  const input = page.locator('.rename-dialog .input')
  await expect(input).toBeVisible()
  await input.fill(renameTo)
  await page.locator('.rename-dialog .btn-primary').click()
  await expect(page.locator('.rename-dialog')).toHaveCount(0)
}

/**
 * The whole in-memory vault as the app has persisted it.
 *
 * Reading the editor's own model only proves the model is consistent with
 * itself; this is the text that would be on disk, which is what a save →
 * reload round trip has to preserve.
 */
export function diskFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const invoke = (window as unknown as {
      __TAURI_INTERNALS__: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }
    }).__TAURI_INTERNALS__.invoke
    return (await invoke('__disk_dump')) as Record<string, string>
  })
}
