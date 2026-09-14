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
 * Everything in source that reaches a message key — collected in ONE walk,
 * because the two directions have to agree about which files count. A file the
 * used→defined scan reads and the defined→used one skips would show up as a
 * reader in one test and as an orphan in the other.
 *
 * `used` is the old narrow set: `t('…')` arguments, mapped to the files that
 * use them. That is what a *missing* definition is reported against, so it must
 * stay narrow — a dotted string that is not a key (a path, a version) would
 * otherwise be reported as an undefined message.
 *
 * `literals` is every quoted string that could be a key. A `t('…')` argument is
 * one such string, but not the only one: the app also keeps keys as values in
 * tables (COMMAND_KEYS, KIND_KEYS, LABEL_KEYS) and hands the value to `t()`
 * later, and those are readers too.
 *
 * `prefixes` is every `t(`head${…}`)` head — keys the app builds rather than
 * writes out (a namespace plus a suffix, or a prefix plus a name, either side of
 * the dot). A defined key that starts with one of these is reached. A
 * construction the scan cannot see (the dynamic half first, say) leaves its keys
 * looking unused, which is deliberately the loud direction: it surfaces for a
 * decision instead of disappearing.
 *
 * Test files are skipped in every direction: a key named in an assertion is not
 * a reader, and this file names several.
 */
interface Readership {
  used: Map<string, string[]>
  literals: Set<string>
  prefixes: string[]
}

function collectReadership(): Readership {
  const used = new Map<string, string[]>()
  const literals = new Set<string>()
  const prefixes: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'i18n' || entry === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.(ts|vue)$/.test(entry) || entry.includes('.test.')) continue
      // Comments are dropped before the key scan: a key named in a comment is
      // prose, not a reader. Both patterns are anchored to the start of a line,
      // and that is load-bearing — an unanchored `/*` reads `accept="image/*"`
      // as the start of a comment and eats the code up to the next `*/`, which
      // is how this scan first reported a component's own keys as orphans.
      const text = readFileSync(full, 'utf8')
        .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const m of text.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.\-:[\]]+)['"]/g)) {
        const list = used.get(m[1]) ?? []
        list.push(full.replace(/.*[\\/]src[\\/]/, ''))
        used.set(m[1], list)
      }
      // One pass per quote character, not one combined alternation: in
      // `:title="$t('a.b')"` an alternation matches the whole double-quoted
      // attribute first and the key inside it is never seen. An interpolated
      // template is not a literal — the `[^`$]` above leaves those to the
      // prefix pass.
      for (const m of [
        ...text.matchAll(/'([^'\n]*)'/g),
        ...text.matchAll(/"([^"\n]*)"/g),
        ...text.matchAll(/`([^`$]*)`/g),
      ]) {
        if (m[1].includes('.')) literals.add(m[1])
      }
      // `t`/`$t` cover the call sites; `translate` is the injected translator
      // interface in services/ai-edit.ts (`d.translate(`aiperm.action.${a}`)`),
      // which is a message call like any other. A third shape would leave its
      // keys looking unused — loud, not silent.
      for (const m of text.matchAll(/\b(?:t|\$t|translate|[\w$]+\.translate)\(\s*`([^`$]*)\$\{/g))
        prefixes.push(m[1])
    }
  }
  walk(join(process.cwd(), 'src'))
  return { used, literals, prefixes }
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
    for (const [key, files] of collectReadership().used) {
      if (!zhKeys.has(key)) missing.push(`${key} (zh) <- ${[...new Set(files)].join(', ')}`)
      if (!enKeys.has(key)) missing.push(`${key} (en) <- ${[...new Set(files)].join(', ')}`)
    }
    expect(missing).toEqual([])
  })

  it('reads every key the catalogue defines', () => {
    // The direction above is half a guard, and the missing half is invisible:
    // it checks every key READ has a definition and never that every key
    // DEFINED has a reader, so a key nothing consumes sits in both locales
    // forever, translated twice, costing nothing and saying nothing. That is
    // the same shape as tokens.test.ts checking that --app-* tokens were
    // declared but not that the declared ones were ever read.
    //
    // Deletion is the wrong answer for a key reached by a constructed name, so
    // the readers collected here include table values and `t(`head${…}`)` heads
    // (see collectReadership) — an apparent orphan that survives those two is
    // the real thing, and it gets deleted or wired up, never silenced.
    const { literals, prefixes } = collectReadership()
    const orphans = flatten(messages.zh).filter(
      (key) => !literals.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)),
    )
    expect(
      orphans,
      `no reader in src (construction heads seen: ${[...new Set(prefixes)].join(' ') || 'none'})`,
    ).toEqual([])
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
