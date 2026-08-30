import { describe, expect, it, vi, beforeEach } from 'vitest'
import { exportHtml, buildComponentRenderers } from './export'

const writeMock = vi.hoisted(() => vi.fn())
vi.mock('./fs', () => ({ fsService: { write: writeMock } }))

describe('buildComponentRenderers', () => {
  it('renders Callout to aside', () => {
    const r = buildComponentRenderers()
    const out = r.Callout?.({ type: 'info' }, '<b>hi</b>') ?? ''
    expect(out).toContain('callout-info')
    expect(out).toContain('<b>hi</b>')
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
