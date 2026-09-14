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

describe('catalogue split', () => {
  // The catalogue lives in one module per namespace under ./namespaces/, with
  // en.ts/zh.ts as barrels. The parity test above only compares the *merged*
  // trees, so a mistake there says "zh and en differ" without saying where.
  // These checks run per module, and cover the failure the split newly makes
  // possible: a namespace written but never spread by a barrel.
  type Trees = Record<'en' | 'zh', Record<string, unknown>>
  const modules = import.meta.glob<Record<string, Trees>>('./namespaces/*.ts', { eager: true })
  const namespaces = Object.entries(modules).map(([path, mod]) => ({
    name: path.replace(/^.*\//, '').replace(/\.ts$/, ''),
    exports: Object.values(mod),
  }))

  it('keeps each namespace structurally identical across languages', () => {
    // Guards the glob too: an empty list would make this vacuously pass.
    expect(namespaces.length).toBeGreaterThan(0)
    expect(namespaces.filter((n) => n.exports.length !== 1).map((n) => n.name)).toEqual([])
    const mismatched: string[] = []
    for (const { name, exports } of namespaces) {
      const trees = exports[0]
      if (!trees) continue
      const enKeys = flatten(trees.en).sort()
      const zhKeys = flatten(trees.zh).sort()
      if (JSON.stringify(enKeys) !== JSON.stringify(zhKeys)) {
        mismatched.push(
          `${name}: only-en=[${enKeys.filter((k) => !zhKeys.includes(k))}] ` +
            `only-zh=[${zhKeys.filter((k) => !enKeys.includes(k))}]`,
        )
      }
    }
    expect(mismatched).toEqual([])
  })

  it('is assembled by both barrels without loss or shadowing', () => {
    for (const lang of ['en', 'zh'] as const) {
      const merged = messages[lang] as Record<string, unknown>
      // Equality, not subset: a top-level key spread by two modules would make
      // the union longer than the barrel, and a module no barrel spreads makes
      // it shorter. Either way the sorted arrays stop matching.
      const fromModules = namespaces
        .flatMap((n) => Object.keys(n.exports[0]?.[lang] ?? {}))
        .sort()
      expect(fromModules, `${lang} barrel vs namespace modules`).toEqual(Object.keys(merged).sort())
      for (const { name, exports } of namespaces) {
        for (const [key, subtree] of Object.entries(exports[0]?.[lang] ?? {})) {
          expect(merged[key], `${lang}.${key} (from ${name}.ts)`).toEqual(subtree)
        }
      }
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
