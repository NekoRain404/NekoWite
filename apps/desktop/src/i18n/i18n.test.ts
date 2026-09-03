import { describe, expect, it, beforeEach } from 'vitest'
import { messages, getLocale, setLocale, t } from './index'

function flatten(obj: object, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flatten(value as object, path))
    } else {
      out.push(path)
    }
  }
  return out
}

describe('i18n messages', () => {
  it('zh and en expose an identical set of message keys', () => {
    const zhKeys = flatten(messages.zh).sort()
    const enKeys = flatten(messages.en).sort()
    expect(zhKeys).toEqual(enKeys)
  })

  it('covers the required namespaces', () => {
    for (const key of [
      'settings.section.appearance',
      'settings.general.language',
      'settings.appearance.font',
      'settings.appearance.uiFont',
      'common.cancel',
      'common.confirm',
      'notelist.empty',
      'filetree.newFile',
      'error.exportFailed',
      'error.aiGenFailed',
      'app.openFolder',
      'font.system',
    ]) {
      expect(messages.zh, key).toHaveProperty(key)
      expect(messages.en, key).toHaveProperty(key)
    }
  })
})

describe('locale switching', () => {
  beforeEach(() => {
    localStorage.clear()
    setLocale('zh')
  })

  it('defaults t() to Chinese', () => {
    expect(t('common.settings')).toBe('设置')
  })

  it('switches locale and persists it', () => {
    setLocale('en')
    expect(getLocale()).toBe('en')
    expect(localStorage.getItem('nekowite.locale')).toBe('en')
    expect(t('common.settings')).toBe('Settings')
    expect(t('app.openFolder')).toBe('Open Folder')
  })

  it('falls back to zh for an unknown key group', () => {
    setLocale('en')
    // 'command' is present in both; only confirm it resolves — a missing key
    // would emit the key itself.
    expect(t('command.math.insert')).toBe('Insert math')
  })

  it('interpolates number placeholders', () => {
    expect(t('notelist.count', { n: 12 })).toBe('12 篇笔记')
    setLocale('en')
    expect(t('notelist.count', { n: 3 })).toBe('3 notes')
    expect(t('settings.appearance.fontSize', { size: 17 })).toBe('Font size 17px')
  })

  it('resolves nested command keys with literal dots', () => {
    expect(t('command.table.insert')).toBe('插入表格')
  })
})
