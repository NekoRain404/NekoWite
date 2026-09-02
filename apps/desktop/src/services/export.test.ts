import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { exportHtml, exportToPdf, buildComponentRenderers } from './export'

const writeMock = vi.hoisted(() => vi.fn())
vi.mock('./fs', () => ({ fsService: { write: writeMock } }))

describe('buildComponentRenderers', () => {
  it('renders Callout to aside', () => {
    const r = buildComponentRenderers()
    const out = r.Callout?.({ type: 'info' }, '<b>hi</b>') ?? ''
    expect(out).toContain('callout-info')
    expect(out).toContain('<b>hi</b>')
  })

  it('escapes callout type before interpolating into the class attribute', () => {
    const r = buildComponentRenderers()
    const out = r.Callout?.({ type: 'warn" onclick="x()' }, '') ?? ''
    // The quote is escaped so it cannot break out of the class attribute.
    expect(out).toContain('callout-warn&quot; onclick=&quot;x()')
    expect(out).not.toContain('class="callout callout-warn"') // no raw quote in the class value
  })
})

describe('exportHtml', () => {
  beforeEach(() => writeMock.mockReset())

  it('writes rendered html to disk', async () => {
    writeMock.mockResolvedValue(undefined)
    await exportHtml('# T\n', 'vault', 'out.html', { title: 'Doc' })
    expect(writeMock).toHaveBeenCalledWith('vault', 'out.html', expect.stringContaining('<!DOCTYPE html>'))
  })
})

describe('exportToPdf', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  interface FakeIframe {
    style: Record<string, string>
    srcdoc: string
    contentWindow: { print: () => void; focus: () => void } | null
    remove: ReturnType<typeof vi.fn>
    onload: (() => void) | null
    fireLoad: () => void
  }

  function makeIframe(print: () => void): FakeIframe {
    const iframe: FakeIframe = {
      style: {},
      srcdoc: '',
      contentWindow: { print, focus: vi.fn() },
      remove: vi.fn(),
      onload: null,
      fireLoad: () => iframe.onload?.call(iframe),
    }
    return iframe
  }

  function stubDom(iframe: FakeIframe): void {
    vi.spyOn(document, 'createElement').mockReturnValue(iframe as unknown as HTMLElement)
    vi.spyOn(document.body, 'appendChild').mockReturnValue(iframe as unknown as HTMLElement)
  }

  it('removes the iframe once and cancels the fallback timer on successful print', () => {
    const iframe = makeIframe(() => undefined)
    stubDom(iframe)
    exportToPdf('# T\n', { title: 'Doc' })
    expect(iframe.onload).not.toBeNull()
    iframe.fireLoad()
    expect(iframe.remove).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60001)
    expect(iframe.remove).toHaveBeenCalledTimes(1)
  })

  it('removes the iframe once when print throws', () => {
    const iframe = makeIframe(() => {
      throw new Error('print unavailable')
    })
    stubDom(iframe)
    exportToPdf('# T\n', {})
    iframe.fireLoad()
    expect(iframe.remove).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60001)
    expect(iframe.remove).toHaveBeenCalledTimes(1)
  })

  it('falls back to the timer to clean up the iframe when onload never fires', () => {
    const iframe = makeIframe(() => undefined)
    stubDom(iframe)
    exportToPdf('# T\n', {})
    expect(iframe.remove).not.toHaveBeenCalled()
    vi.advanceTimersByTime(59999)
    expect(iframe.remove).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(iframe.remove).toHaveBeenCalledTimes(1)
  })
})
