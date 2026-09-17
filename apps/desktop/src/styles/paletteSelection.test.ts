/**
 * Which element a palette is selected on, and that the answer is the same on both of them.
 *
 * `palettes.css` is one table and two selectors for the light half (`:root, [data-theme="light"]`).
 * The second selector is not decoration: this app draws palettes on **two** elements now.
 *
 *  - the pet window's page root, and the app shell's own root — the element that is `:root` for the
 *    document or the one `AppShell.vue:207-210` puts the four attributes on;
 *  - the settings page's preview of the pet's bubble
 *    (`features/desktop-pet-settings/components/PetSettingsPreview.vue`), which is an element
 *    **inside** the app's root: the user is in a dark app and may have pinned the bubble to Light,
 *    and the preview has to draw the bubble the way the pet window would — otherwise the preview
 *    lies about the one surface the user is setting, which is what it did with a table of its own.
 *
 * A subtree is not the page root, so `:root` does not match it and neither does anything inherited
 * *declared* on the root: what a subtree resolves is the attribute selectors it matches plus what
 * the page around it declares. The claim below is exactly that: resolve the whole table as a
 * subtree — every `:root` half of a selector list removed — and every token comes out with the same
 * value the page root resolves. Before the light half had an attribute selector, a light subtree
 * simply had no light palette to draw (`--app-warn`, which no colour scheme declares, resolved to
 * the *dark* page's value, and `color-scheme` stayed dark: native scrollbars and form controls
 * inside the bubble would have followed the app rather than the bubble).
 *
 * The simulation is the same one `tokens.test.ts` and `highContrast.test.ts` run - specificity
 * first, then source order — kept short here because this file asks one question of it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Comments are stripped once, at the source: a comment sits between two rules with nothing but
    whitespace around it, so a pattern that reads "everything up to the next `{`" reads the comment
    as part of the selector it precedes — which is how `:root` inside a sentence stopped being
    rewritten below the first time this file was run. */
const css = readFileSync(resolve(__dirname, './palettes.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

interface Scenario {
  theme: 'light' | 'dark'
  scheme: string
  accent: string
  highContrast: boolean
}

/** One scenario per combination that reaches the stylesheet, which is what the app can be set to. */
const SCENARIOS: Scenario[] = [
  { theme: 'light', scheme: 'default', accent: 'ink', highContrast: false },
  { theme: 'dark', scheme: 'default', accent: 'ink', highContrast: false },
  { theme: 'light', scheme: 'forest', accent: 'coral', highContrast: false },
  { theme: 'dark', scheme: 'forest', accent: 'coral', highContrast: false },
  { theme: 'light', scheme: 'sunset', accent: 'teal', highContrast: true },
  { theme: 'dark', scheme: 'sunset', accent: 'teal', highContrast: true },
]

/**
 * The tokens a scenario has to resolve, and the reason each one is here: the light block is one of
 * several places they are declared, and each of them is a different *kind* of place.
 *
 *  - `--app-canvas`, `--app-text`: surfaces, which the fifteen colour schemes also declare.
 *  - `--app-accent`: the user's hue, which only the theme blocks and the accent rules declare — a
 *    scheme never does.
 *  - `--app-warn`: the status colour **no scheme declares at all**, so it comes from the theme
 *    block or from nowhere. It is the token that says most plainly whether a palette was selected.
 */
const TOKENS = ['--app-canvas', '--app-text', '--app-accent', '--app-warn', '--app-shadow-card']

interface Rule {
  selector: string
  body: string
  order: number
}

function rules(text: string): Rule[] {
  return [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (match, order) => ({ selector: match[1].trim(), body: match[2], order }),
  )
}

/** A selector list is matched one part at a time — the same reading the browser does. */
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

function specificity(part: string): number {
  return part === ':root' ? 1 : (part.match(/\[/g) ?? []).length
}

function resolveToken(text: string, s: Scenario, name: string): { value: string; selector: string } {
  let best: { spec: number; order: number; value: string; selector: string } | undefined
  for (const rule of rules(text)) {
    const value = new RegExp(`${name}:\\s*([^;]+);`).exec(rule.body)?.[1]?.trim()
    if (value === undefined) continue
    for (const part of rule.selector.split(',').map((p) => p.trim())) {
      if (!partMatches(part, s)) continue
      const spec = specificity(part)
      if (!best || spec > best.spec || (spec === best.spec && rule.order > best.order)) {
        best = { spec, order: rule.order, value, selector: part }
      }
    }
  }
  if (!best) throw new Error(`${name} is not declared for ${JSON.stringify(s)}`)
  return { value: best.value, selector: best.selector }
}

/**
 * The same table, read as a subtree of a page rather than as the page's own root.
 *
 * Every `:root` half of a selector list is replaced by an attribute no element carries, which is
 * how a selector that can only ever match the html element stops matching. The rest of the list is
 * left alone: `:root, [data-theme="light"]` becomes a rule an element inside a page is matched by,
 * and a rule that was `:root` alone stops matching altogether.
 */
function asSubtree(text: string): string {
  return text.replace(/([^{}]+)\{/g, (whole, selector: string) => {
    const kept = selector
      .split(',')
      .map((part) => part.trim())
      .map((part) => (part === ':root' ? '[data-page-root]' : part))
    return kept.length === 0 ? whole : `${kept.join(', ')} {`
  })
}

describe('the light palette is selectable on an element that is not the page root', () => {
  const subtree = asSubtree(css)

  it('resolves every token to what the page root resolves, scenario for scenario', () => {
    // "The same numbers appear in both places", asserted as equality of the two measured values and
    // not as "they are both light" or "they differ": the whole point of the shared table is that a
    // preview and a pet window cannot come apart, and the only way this fails is if a light token
    // is declared somewhere a subtree cannot reach.
    const differed: string[] = []
    for (const scenario of SCENARIOS) {
      for (const token of TOKENS) {
        const root = resolveToken(css, scenario, token)
        const inside = resolveToken(subtree, scenario, token)
        if (root.value !== inside.value) {
          differed.push(
            `${JSON.stringify(scenario)} ${token}: root=${root.value} (${root.selector}) ≠ subtree=${inside.value} (${inside.selector})`,
          )
        }
      }
    }
    expect(differed).toEqual([])
  })

  it('is the light block that answers, and it answers by attribute', () => {
    // Anti-vacuity: `--app-warn` is declared by no colour scheme, so the equality above could only
    // hold because *something* a subtree matches declares it — and that something has to be the
    // light block's attribute half rather than the constant `:root` half.
    const won = resolveToken(
      subtree,
      { theme: 'light', scheme: 'forest', accent: 'coral', highContrast: false },
      '--app-warn',
    )
    expect(won.selector).toBe('[data-theme="light"]')
  })

  it('carries `color-scheme` with it, which is a property and not a token', () => {
    // The one thing on this list that is not a custom property, and the reason a light bubble inside
    // a dark app cannot simply inherit: `color-scheme` is inherited, so a subtree that does not
    // declare it keeps the *page's* answer, and the scrollbars and form controls inside the bubble
    // are drawn from it.
    const block = rules(css).find((rule) =>
      rule.selector.split(',').some((part) => part.trim() === '[data-theme="light"]'),
    )
    expect(block?.body, 'the light block declares the native colour scheme').toContain(
      'color-scheme: light',
    )
  })
})
