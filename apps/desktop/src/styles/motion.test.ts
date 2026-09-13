import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')

const tokens = read('./tokens.css')
const motion = read('./motion.css')
const main = read('../main.ts')

// The motion ladder, ordered by how far a thing travels and how much of the
// screen it owns. A step only earns its place if the class above or below it
// would be visibly wrong on it.
const LADDER = [
  '--app-motion-micro',
  '--app-motion-fast',
  '--app-motion',
  '--app-motion-slow',
] as const

// Constant-rate motion is not a transition — a steady rotation or a text
// caret has no arrival to decelerate, so it sits outside the ladder.
const CYCLIC = ['--app-motion-spin', '--app-motion-blink', '--app-motion-pulse'] as const

const durationOf = (css: string, token: string): number => {
  const m = css.match(new RegExp(`${token}:\\s*([\\d.]+)m?s\\b`))
  if (!m) throw new Error(`${token} is not defined with a time value`)
  return Number(m[1]) * (m[0].trimEnd().endsWith('ms') ? 1 : 1000)
}

const curveOf = (token: string): string => {
  const m = tokens.match(new RegExp(`${token}:\\s*([^;]+);`))
  if (!m) throw new Error(`${token} is not defined`)
  return m[1].trim()
}

// Every file that renders motion. The three panel components still being split
// (SettingsPanel, FileTree, NoteListPanel) are deliberately absent: their
// ad-hoc literals are migrated by the follow-up pass, once the split lands.
// Add each here as it is cleaned up — this list only ever grows.
const MOTION_SURFACE = [
  './tokens.css',
  './components.css',
  './editor-content.css',
  './motion.css',
  '../style.css',
  '../components/AppToast.vue',
  '../components/WordToolbar.vue',
  '../ui/AttachmentsPanel.vue',
  '../ui/AppSidebar.vue',
  '../ui/ChatPanel.vue',
  '../ui/CommandPalette.vue',
  '../ui/ContextMenu.vue',
  '../ui/InfoRail.vue',
  '../ui/StatusBar.vue',
  '../ui/TabBar.vue',
  '../ui/TitleBar.vue',
]

describe('motion scale', () => {
  it('defines every ladder step, in strictly increasing order', () => {
    const values = LADDER.map((t) => durationOf(tokens, t))
    for (const [i, v] of values.entries()) {
      expect(v, `${LADDER[i]} has a usable duration`).toBeGreaterThan(0)
    }
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i],
        `${LADDER[i]} (${values[i]}ms) must be slower than ${LADDER[i - 1]} (${values[i - 1]}ms)`,
      ).toBeGreaterThan(values[i - 1])
    }
  })

  it('documents which interaction class each step is for', () => {
    // A scale without a stated intent is just numbers: the next person to add
    // a transition has to be able to pick a step without guessing.
    const comments = [...tokens.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]).join('\n')
    for (const token of [...LADDER, ...CYCLIC]) {
      expect(comments, `${token} is named in a comment`).toContain(token)
    }
  })

  it('ships one arriving curve and a distinct accelerating one for exits', () => {
    const enter = curveOf('--app-ease')
    const exit = curveOf('--app-ease-exit')
    expect(enter).toMatch(/^cubic-bezier\(/)
    expect(exit).toMatch(/^cubic-bezier\(/)
    expect(exit, 'exits must not reuse the arriving curve').not.toBe(enter)
  })

  it('defines a cyclic rate for spinners and the caret', () => {
    for (const token of CYCLIC) {
      expect(durationOf(tokens, token), `${token} is a sane cycle`).toBeGreaterThanOrEqual(500)
    }
  })
})

describe('reduced motion', () => {
  it('is honoured globally, not per component', () => {
    expect(motion).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    // Universal selector: a component added tomorrow is covered without its
    // author having to remember. `!important` is required because every Vue
    // scoped style is more specific than `*`.
    expect(motion).toMatch(/\*::before[\s\S]{0,40}\*::after/)
    expect(motion).toContain('animation-duration: 0.01ms !important')
    expect(motion).toContain('animation-iteration-count: 1 !important')
    expect(motion).toContain('transition-duration: 0.01ms !important')
    expect(motion).toContain('scroll-behavior: auto !important')
  })

  it('leaves the reduced-motion user the final state, not a stuck frame', () => {
    // Neutralising an animation this way makes it finish instantly, and with
    // the default `animation-fill-mode: none` the element falls back to its
    // base style. `forwards`/`both` would instead freeze it on the last
    // keyframe — so a rule must always state its resting look outside the
    // keyframes, never inherit it from the animation.
    for (const file of MOTION_SURFACE) {
      const css = read(file)
      expect(css, `${file} must not freeze on the last keyframe`).not.toMatch(
        /animation(?:-fill-mode)?:[^;]*\b(?:forwards|both)\b/,
      )
    }
  })

  it('is the last layer loaded, so it governs every component', () => {
    const imports = [...main.matchAll(/^import\s+'([^']+)'$/gm)].map((m) => m[1])
    expect(imports.indexOf('./styles/motion.css')).toBe(imports.length - 1)
  })
})

describe('no ad-hoc motion values', () => {
  it.each(MOTION_SURFACE)('%s animates only through tokens', (file) => {
    const css = read(file)
      // Prose may quote a duration to explain the scale; that is documentation,
      // not a value that ever reaches an element.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // The token definitions themselves: the one place a raw millisecond
      // value is allowed to appear.
      .replace(/--app-motion[\w-]*:\s*[\d.]+m?s\b/g, '')
      // The reduced-motion switch is the deliberate exception — its whole job
      // is to write a near-zero over every other duration.
      .replace(/[^;{}]*!important[^;{}]*/g, '')
    const literals = css.match(/[\d.]+m?s\b/g) ?? []
    expect(literals, `${file} still animates with raw durations`).toEqual([])
  })
})

describe('responsiveness rules', () => {
  it('never transitions the caret', () => {
    // A caret that eases in lags the keystroke that moved it.
    for (const file of MOTION_SURFACE) {
      expect(read(file), `${file} must not transition caret-color`).not.toMatch(
        /transition:[^;]*caret-color/,
      )
    }
  })

  it('drives every spinner at a constant rate', () => {
    // A rotation that eases in and out reads as a stutter at this speed; the
    // cycle is constant-rate by definition, so it must stay `linear`.
    let spinners = 0
    for (const file of MOTION_SURFACE) {
      for (const line of read(file).split('\n')) {
        if (!line.includes('animation:') || !line.includes('--app-motion-spin')) continue
        spinners++
        expect(line, `${file}: spinner must be linear`).toContain('linear')
      }
    }
    expect(spinners, 'the spinner token must actually be used').toBeGreaterThan(0)
  })
})
