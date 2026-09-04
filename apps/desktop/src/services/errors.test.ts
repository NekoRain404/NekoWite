import { describe, expect, it } from 'vitest'
import { decideConflict, describeExportError, describePluginError } from './errors'

describe('decideConflict', () => {
  it('reloads silently when tab is clean', () => {
    expect(decideConflict({ dirty: false, hasDiskChange: true })).toBe('reload')
  })
  it('keeps local content on save when clean', () => {
    expect(decideConflict({ dirty: false, hasDiskChange: false })).toBe('none')
  })
  it('asks user when dirty and disk changed', () => {
    expect(decideConflict({ dirty: true, hasDiskChange: true })).toBe('ask')
  })
})

describe('describeExportError', () => {
  it('maps the out-of-vault rejection to a user-facing hint', () => {
    expect(describeExportError('path escapes vault')).toBe('请选择 vault 内的路径导出')
  })
  it('passes through Error instances', () => {
    expect(describeExportError(new Error('boom'))).toBe('导出失败：boom')
  })
  it('passes through plain strings', () => {
    expect(describeExportError('boom')).toBe('导出失败：boom')
  })
})

describe('describePluginError', () => {
  it('joins the message with the recovery hint', () => {
    expect(
      describePluginError({
        code: 'PLUGIN_PERMISSION_DENIED',
        message: 'Plugin needs fs.',
        recovery: 'Grant it in settings.',
      }),
    ).toBe('Plugin needs fs. Grant it in settings.')
  })
  it('returns just the message when there is no recovery hint', () => {
    expect(describePluginError({ message: 'boom' })).toBe('boom')
  })
  it('falls back to a code-based label when there is no message', () => {
    expect(describePluginError({ code: 'PLUGIN_LOAD_FAILED' })).toContain('PLUGIN_LOAD_FAILED')
  })
})
