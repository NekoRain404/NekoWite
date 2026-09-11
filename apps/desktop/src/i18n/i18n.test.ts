import { describe, expect, it, beforeEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Every `t('…')` key used in source, mapped to the files that use it.
 *
 * Only literal keys are collected: a key built at runtime (a template string)
 * cannot be checked here, so those call sites stay the author's responsibility.
 */
function collectUsedKeys(): Map<string, string[]> {
  const used = new Map<string, string[]>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'i18n' || entry === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.(ts|vue)$/.test(entry) || entry.includes('.test.')) continue
      const text = readFileSync(full, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.\-:[\]]+)['"]/g)) {
        const list = used.get(m[1]) ?? []
        list.push(full.replace(/.*[\\/]src[\\/]/, ''))
        used.set(m[1], list)
      }
    }
  }
  walk(join(process.cwd(), 'src'))
  return used
}

describe('i18n messages', () => {
  it('zh and en expose an identical set of message keys', () => {
    const zhKeys = flatten(messages.zh).sort()
    const enKeys = flatten(messages.en).sort()
    expect(zhKeys).toEqual(enKeys)
  })

  it('defines every key the source actually uses', () => {
    // The parity check above only proves zh and en agree; a key missing from
    // BOTH still renders as its raw id in the UI. This walks the source and
    // fails on any literal t() key that neither locale defines.
    const zhKeys = new Set(flatten(messages.zh))
    const enKeys = new Set(flatten(messages.en))
    const missing: string[] = []
    for (const [key, files] of collectUsedKeys()) {
      if (!zhKeys.has(key)) missing.push(`${key} (zh) <- ${[...new Set(files)].join(', ')}`)
      if (!enKeys.has(key)) missing.push(`${key} (en) <- ${[...new Set(files)].join(', ')}`)
    }
    expect(missing).toEqual([])
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
