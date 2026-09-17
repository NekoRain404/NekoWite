import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The high-contrast axis against the colour-scheme axis.
 *
 * This file exists because the two used to be decided by which block came last
 * in palettes.css, and the scheme blocks do come last. Measured, before the fix
 * this pins: light + high contrast + any scheme resolved `--app-canvas` to that
 * scheme's own canvas (`#fbfaf6` for `default`), while dark + high contrast
 * resolved `#000000` — the same setting, honoured in one theme and switched off
 * in the other by nothing but source order.
 *
 * The assertions are about WHICH declaration wins, not about what the colours
 * are: every expected value is read out of the high-contrast rules themselves,
 * so retuning the high-contrast palette is allowed and unhooking it is not.
 */

const css = readFileSync(resolve(__dirname, './palettes.css'), 'utf8')

const THEMES = ['light', 'dark'] as const
const SCHEMES = ['default', 'sunset', 'forest', 'ocean', 'sakura', 'mist', 'graphite', 'midnight', 'lavender', 'desert', 'mint', 'coffee', 'plum', 'dusk', 'crimson']

/** The tokens a colour scheme declares AND the high-contrast blocks declare —
    the overlap is the whole question. `--app-warn` is deliberately not here:
    high contrast has no value for it, by design (see tokens.test.ts). */
const CONTESTED = ['--app-canvas', '--app-panel', '--app-elevated', '--app-border', '--app-text', '--app-muted', '--app-danger', '--app-danger-contrast', '--app-success', '--app-shadow-menu', '--app-shadow-dialog', '--app-shadow-card', '--app-code-keyword', '--app-code-string', '--app-code-number', '--app-code-fn', '--app-code-type', '--app-code-prop']

interface Scenario {
  theme: 'light' | 'dark'
  scheme: string
  accent: string
  highContrast: boolean
}

interface Resolved {
  value: string
  /** The selector whose declaration won — the check that the value did not
      arrive from somewhere else that happens to agree. */
  selector: string
}

/** Same cascade the browser runs: most specific wins, ties go to the later
    declaration. Comments are stripped first — they sit right above the
    selectors and would otherwise be read as part of one. */
function rules(text: string): { selector: string; body: string }[] {
  return [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }))
}

function matches(selector: string, s: Scenario): boolean {
  return selectorParts(selector).some((part) => partMatches(part, s))
}

function partMatches(part: string, s: Scenario): boolean {
  if (part === ':root') return true
  const attrs = part.match(/\[[^\]]+\]/g)
  if (!attrs || attrs.join('') !== part) return false
  return attrs.every((attr) => {
    const m = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(attr)
    if (!m) return false
    const present =
      m[1] === 'theme' ? s.theme
      : m[1] === 'color-scheme' ? s.scheme
      : m[1] === 'accent' ? s.accent
      : m[1] === 'contrast' ? (s.highContrast ? 'high' : 'normal')
      : undefined
    return m[2] === undefined ? present !== undefined : present === m[2]
  })
}

/** A selector list, one part at a time: `:root, [data-theme="light"]` is two selectors and one
    declaration list. The light baseline is written that way now — the second half is what lets an
    element inside another page's root draw the light palette (`PetSettingsPreview.vue`'s stage) —
    and a simulation that read the list as a single compound selector would stop seeing the light
    palette at all, which is the one thing this file must never do quietly. */
function selectorParts(selector: string): string[] {
  return selector.split(',').map((part) => part.trim())
}

function specificity(selector: string): number {
  return Math.max(
    ...selectorParts(selector).map((part) => (part === ':root' ? 1 : (part.match(/\[/g) ?? []).length)),
  )
}

function resolveToken(text: string, s: Scenario, name: string): Resolved {
  let best: { spec: number; order: number; value: string; selector: string } | undefined
  rules(text).forEach((rule, order) => {
    if (!matches(rule.selector, s)) return
    const value = new RegExp(`${name}:\\s*([^;]+);`).exec(rule.body)?.[1]?.trim()
    if (value === undefined) return
    const spec = specificity(rule.selector)
    if (!best || spec > best.spec || (spec === best.spec && order > best.order)) {
      best = { spec, order, value, selector: rule.selector }
    }
  })
  if (!best) throw new Error(`${name} is not declared for ${JSON.stringify(s)}`)
  return best
}

/** What a theme resolves to under high contrast with no scheme in play — the
    row every scheme has to agree with. */
function baseline(theme: 'light' | 'dark', text = css): Record<string, Resolved> {
  const out: Record<string, Resolved> = {}
  for (const token of CONTESTED) {
    out[token] = resolveToken(text, { theme, scheme: 'default', accent: 'ink', highContrast: true }, token)
  }
  return out
}

describe('high contrast outranks the colour scheme', () => {
  it('resolves every scheme to the high-contrast values, in both themes', () => {
    // The defect this replaces was invisible per-theme, which is why it is
    // asserted per-theme: dark won the cascade by accident of file order and
    // light lost it, so anything that only ever looks at one of them approves
    // half the bug.
    const wrong: string[] = []
    for (const theme of THEMES) {
      const want = baseline(theme)
      for (const scheme of SCHEMES) {
        for (const token of CONTESTED) {
          const got = resolveToken(css, { theme, scheme, accent: 'ink', highContrast: true }, token)
          if (got.value !== want[token].value) {
            wrong.push(`${theme}/${scheme}/high ${token}=${got.value} ≠ ${want[token].value} (from ${got.selector})`)
          }
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('is actually reading the high-contrast rules, not a scheme that agrees', () => {
    // Anti-vacuity. The test above compares a scheme against a baseline, so if
    // the high-contrast blocks were deleted the baseline would BE the scheme
    // value and every comparison would pass while high contrast did nothing.
    // This says the baseline came from a rule that names the contrast axis.
    for (const theme of THEMES) {
      const won = baseline(theme)
      for (const token of CONTESTED) {
        expect(won[token].selector, `${theme}: ${token} when high contrast is on`).toContain(
          '[data-contrast="high"]',
        )
      }
    }
  })

  it('lets the accent keep following the user, which high contrast does not own', () => {
    // High contrast overrides the surfaces and the semantics. It does not
    // override the hue the user picked, so the accent rules stay free to
    // outrank the high-contrast fallback — the reason those three tokens are
    // not in the same block as the other eighteen.
    for (const [theme, accent, want] of [
      ['light', 'coral', '#c22818'],
      ['dark', 'coral', '#ff6b52'],
      ['light', 'cyan', '#006e96'],
      ['dark', 'cyan', '#66d2f5'],
    ] as const) {
      const s: Scenario = { theme, scheme: 'default', accent, highContrast: true }
      expect(resolveToken(css, s, '--app-accent').value, `${theme}/${accent}`).toBe(want)
    }
  })

  it('keeps every colour-scheme rule to two attribute selectors', () => {
    // The premise of the fix, pinned rather than described: a scheme is written
    // at two attribute selectors at most, so the three in the high-contrast
    // blocks outrank it wherever either is placed. A scheme that reached three
    // would tie and could win on order, which is the defect this file exists to
    // keep out — so it fails here, at the one place that says why.
    const schemes = rules(css).filter(
      (r) => r.selector.includes('[data-color-scheme=') && !r.selector.includes('data-contrast'),
    )
    expect(schemes.length, 'the scheme rules were not found at all').toBeGreaterThan(0)
    const overreaching = schemes
      .filter((r) => specificity(r.selector) > 2)
      .map((r) => r.selector)
    expect(overreaching).toEqual([])
  })

  it('cannot be outranked by a colour scheme appended after the last rule', () => {
    // The next person to add a colour scheme appends to the end of the file,
    // in the two forms the fifteen existing ones use — and may reach for the
    // light form too, which none of them needed. All three are simulated here
    // rather than argued about.
    const appended = `${css}
[data-color-scheme="future"] { --app-canvas: #123456; --app-text: #123456; --app-border: #123456; --app-muted: #123456; --app-danger: #123456; --app-danger-contrast: #123456; --app-success: #123456; --app-panel: #123456; --app-elevated: #123456; --app-shadow-menu: 0 0 #123456; --app-shadow-dialog: 0 0 #123456; --app-shadow-card: 0 0 #123456; --app-code-keyword: #123456; --app-code-string: #123456; --app-code-number: #123456; --app-code-fn: #123456; --app-code-type: #123456; --app-code-prop: #123456; }
[data-theme="light"][data-color-scheme="future"] { --app-canvas: #654321; --app-text: #654321; }
[data-theme="dark"][data-color-scheme="future"] { --app-canvas: #654321; --app-text: #654321; }
`
    const lost: string[] = []
    for (const theme of THEMES) {
      const want = baseline(theme)
      for (const token of CONTESTED) {
        const got = resolveToken(appended, { theme, scheme: 'future', accent: 'ink', highContrast: true }, token)
        if (got.value !== want[token].value) {
          lost.push(`${theme}/future/high ${token}=${got.value} ≠ ${want[token].value} (from ${got.selector})`)
        }
      }
    }
    expect(lost).toEqual([])
  })
})
