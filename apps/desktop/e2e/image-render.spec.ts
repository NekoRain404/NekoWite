import { expect, test, type Page } from '@playwright/test'
import { openNote, showRendered } from './support/editorHarness'

/** A real 1x1 PNG, so `naturalWidth` proves the browser decoded it. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const NOTE = 'test-fixtures/welcome.md'

/**
 * The rel path `resolve_media_path` is called with: vault-relative, so the
 * vault name itself is NOT part of it.
 */
const ATTACHMENT = 'welcome_assets/pic.png'

interface ImageState {
  src: string | null
  failed: string | null
  errorVisible: boolean
  naturalWidth: number
  complete: boolean
}

/** Everything needed to tell a rendered image from a failed one. */
function imageState(page: Page): Promise<ImageState> {
  return page.evaluate(() => {
    const figure = document.querySelector('.pane.rendered .neko-image') as HTMLElement | null
    const img = figure?.querySelector('img') as HTMLImageElement | null
    const overlay = figure?.querySelector('.neko-image-error') as HTMLElement | null
    return {
      src: img?.getAttribute('src') ?? null,
      failed: figure?.getAttribute('data-failed') ?? null,
      errorVisible: overlay ? !overlay.hasAttribute('hidden') : false,
      naturalWidth: img?.naturalWidth ?? 0,
      complete: img?.complete ?? false,
    }
  })
}

const DOC = `# Note with an image\n\n![pic](welcome_assets/pic.png)\n`

test.describe('image rendering on open', () => {
  test('an image renders on the first open, without Retry', async ({ page }) => {
    await openNote(page, {
      doc: DOC,
      attachments: { [ATTACHMENT]: PNG_1X1 },
    })
    await showRendered(page)

    // The regression: the raw vault-relative src was painted first, failed to
    // load, and left the error overlay on top of an image that then loaded.
    await expect
      .poll(async () => (await imageState(page)).naturalWidth, { timeout: 5000 })
      .toBeGreaterThan(0)

    const state = await imageState(page)
    expect(state.failed).toBe('false')
    expect(state.errorVisible).toBe(false)
    // And it points at the resolved display URL, not the document path.
    expect(state.src).toContain('data:image/png;base64,')
  })

  test('the raw vault-relative path is never left on the element', async ({ page }) => {
    await openNote(page, {
      doc: DOC,
      attachments: { [ATTACHMENT]: PNG_1X1 },
      // Holds resolution open so the intermediate state is observable.
      resolveDelayMs: 400,
    })
    await showRendered(page)

    // While the resolver is still in flight the element must not be pointed at
    // the document path: that is the URL that cannot load.
    const early = await imageState(page)
    expect(early.src ?? '').not.toBe('welcome_assets/pic.png')
    expect(early.errorVisible).toBe(false)

    await expect
      .poll(async () => (await imageState(page)).naturalWidth, { timeout: 5000 })
      .toBeGreaterThan(0)
    expect((await imageState(page)).errorVisible).toBe(false)
  })

  test('a missing attachment shows the recoverable overlay, and Retry clears it', async ({ page }) => {
    // Nothing seeded for this path, so resolution fails.
    await openNote(page, { doc: DOC })
    await showRendered(page)

    await expect.poll(async () => (await imageState(page)).errorVisible, { timeout: 5000 }).toBe(true)

    // Seed the bytes, then Retry: the retry must re-resolve rather than replay
    // the memoized failure.
    await page.evaluate(async (payload) => {
      const w = window as unknown as { __NEKO_ATTACHMENTS__?: Record<string, string> }
      w.__NEKO_ATTACHMENTS__ = { ...(w.__NEKO_ATTACHMENTS__ ?? {}), ...payload }
    }, { [ATTACHMENT]: PNG_1X1 })

    const retry = page.locator('.pane.rendered .neko-image-error-retry')
    await expect(retry).toBeVisible()
    await retry.click()

    await expect
      .poll(async () => (await imageState(page)).naturalWidth, { timeout: 5000 })
      .toBeGreaterThan(0)
    expect((await imageState(page)).errorVisible).toBe(false)
  })

  test('the attachment survives a mode round trip still rendering', async ({ page }) => {
    await openNote(page, { doc: DOC, attachments: { [ATTACHMENT]: PNG_1X1 } })
    await showRendered(page)
    await expect.poll(async () => (await imageState(page)).naturalWidth, { timeout: 5000 }).toBeGreaterThan(0)

    await page.locator('.switch-option', { hasText: '源码' }).click()
    await page.locator('[data-testid="source-pane"] .cm-content').waitFor({ state: 'visible' })
    await page.locator('.switch-option', { hasText: '渲染' }).click()

    await expect
      .poll(async () => (await imageState(page)).naturalWidth, { timeout: 5000 })
      .toBeGreaterThan(0)
    expect((await imageState(page)).errorVisible).toBe(false)
  })
})

test.describe('image resolution recovery', () => {
  test('a transient failure is retried when resolution is invalidated', async ({ page }) => {
    // The first attempt fails, as it does when the panel renders before an
    // attachment is resolvable. The failure must not be memoized, and the
    // app-level invalidation — fired once a vault is committed — must make the
    // already-mounted node view resolve again, with no manual Retry.
    await openNote(page, {
      doc: DOC,
      attachments: { [ATTACHMENT]: PNG_1X1 },
      resolveFailsTimes: 1,
    })
    await showRendered(page)
    await expect.poll(async () => (await imageState(page)).errorVisible, { timeout: 5000 }).toBe(true)

    await page.evaluate(async () => {
      const core = (await import(
        '/@fs/C:/Users/Lenovo/Documents/ChatGPT/NekoWrite/packages/editor-core/src/image/resolver.ts'
      )) as unknown as { invalidateImageResolution(): void }
      core.invalidateImageResolution()
    })

    await expect
      .poll(async () => (await imageState(page)).naturalWidth, { timeout: 5000 })
      .toBeGreaterThan(0)
    expect((await imageState(page)).errorVisible).toBe(false)
  })
})
