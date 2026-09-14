import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

// One curve per *kind* of motion. A cubic bezier cannot ring, so the settle the
// arrival curve needs has to be a sampled spring; and a spring cannot be asked
// to behave like a state change, where it reads as mush. Collapsing these back
// onto one curve is the regression this guards.
const BEZIER_CURVES = ['--app-ease', '--app-ease-exit', '--app-ease-attention'] as const
const SPRING_CURVE = '--app-ease-surface'

// The two values that make a group arrive as a sequence: the gap between one
// member and the next, and how far a surface drifts while it settles.
const CHOREOGRAPHY = ['--app-motion-stagger', '--app-motion-travel'] as const

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

/**
 * A file with its prose removed, so an assertion can read declarations only.
 *
 * `//` is a comment in a `<script>` and not in CSS, so a .vue file is stripped
 * in two halves: line comments go up to the first `<style>` block, and nothing
 * inside the stylesheet is touched (a `//` in a `url()` is not a comment, and
 * stripping it there would eat the rest of the declaration).
 *
 * This is prose handling and not a relaxation. A script comment cannot reach an
 * element any more than a stylesheet comment can, and the check exists to stop
 * a raw duration *rendering* — a script comment that quotes the ladder to
 * explain itself is documentation, exactly like the ones in the stylesheets.
 * Code is untouched either way: a literal in a template string is still a
 * literal.
 */
const declarations = (source: string, file = ''): string => {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  if (!file.endsWith('.vue')) return withoutBlocks
  const styleAt = withoutBlocks.indexOf('<style')
  if (styleAt === -1) return withoutBlocks.replace(/\/\/[^\n]*/g, '')
  return (
    withoutBlocks.slice(0, styleAt).replace(/\/\/[^\n]*/g, '') + withoutBlocks.slice(styleAt)
  )
}

/** Every .vue under a directory, so a new dialog is covered without being listed. */
function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(resolve(__dirname, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...vueFiles(rel))
    else if (entry.name.endsWith('.vue')) out.push(rel)
  }
  return out
}

/** The spring, which is declared under its @supports guard rather than in :root. */
const guardedCurve = (token: string): string => {
  // Read from the comment-stripped text all the way through: the prose above
  // the fallback names the guard, so searching the raw file finds that mention
  // and then hands back the fallback declaration instead of the spring.
  const bare = declarations(tokens)
  const at = bare.indexOf('@supports')
  if (at === -1) throw new Error(`${token} is not behind a support guard`)
  const m = bare.slice(at).match(new RegExp(`${token}:\\s*([^;]+);`))
  if (!m) throw new Error(`${token} is not declared under @supports`)
  return m[1].replace(/\s+/g, ' ').trim()
}

/** A `linear()` easing as the samples it is made of: value, and where it sits. */
function springSamples(curve: string): { value: number; at: number }[] {
  const body = curve.replace(/^linear\(/, '').replace(/\)$/, '')
  return body.split(',').map((stop, i, all) => {
    const [value, position] = stop.trim().split(/\s+/)
    return {
      value: Number(value),
      at: position ? Number(position.replace('%', '')) : i === 0 ? 0 : i === all.length - 1 ? 100 : NaN,
    }
  })
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
  // The dialogs moved onto the shared arrival this round. The first two also
  // carry a direction of their own, being anchored to a bottom edge where the
  // rest are centred.
  '../components/AiWriteDialog.vue',
  '../components/ConflictDialog.vue',
  '../components/PermissionDialog.vue',
  '../components/PluginIntegrityDialog.vue',
  '../components/RenameDialog.vue',
  '../ui/AttachmentsPanel.vue',
  '../ui/AppSidebar.vue',
  '../features/chat/components/ChatComposer.vue',
  '../features/chat/components/ChatMessageRow.vue',
  '../features/chat/components/ChatSessionBar.vue',
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
    for (const token of [...LADDER, ...CYCLIC, ...BEZIER_CURVES, SPRING_CURVE, ...CHOREOGRAPHY]) {
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

describe('easing vocabulary', () => {
  it('gives each kind of motion its own curve', () => {
    // `--app-ease` is the one the existing contract pins as a bezier, and it is
    // the right shape for a state change: the control is barely moving, and a
    // curve that overshoots there is the mush the brief warns about.
    for (const token of BEZIER_CURVES) {
      expect(curveOf(token), `${token} is a bezier`).toMatch(/^cubic-bezier\(/)
    }
    expect(guardedCurve(SPRING_CURVE), 'the arrival curve is a sampled spring').toMatch(/^linear\(/)
  })

  it('keeps a plain arrival curve for engines that cannot sample one', () => {
    // A `linear()` that an engine cannot parse takes the whole animation
    // shorthand down with it — the declaration is dropped, not degraded — so
    // the fallback is what keeps dialogs animating at all on an older WebKit.
    // It is a once-overshooting bezier: not the settle, but an arrival.
    const fallback = curveOf(SPRING_CURVE)
    expect(fallback).toMatch(/^cubic-bezier\(/)
    expect(fallback, 'the fallback is not the state-change curve').not.toBe(
      curveOf('--app-ease'),
    )
  })

  it('samples the spring on a timeline that never runs backwards', () => {
    // `linear()` interpolates between its stops in the order given. A stop that
    // sits earlier than the one before it makes the curve jump backwards — the
    // surface would visibly stutter — so the sample positions must ascend.
    const samples = springSamples(guardedCurve(SPRING_CURVE))
    expect(samples.length, 'enough samples to be a curve, not a corner').toBeGreaterThan(8)
    expect(samples[0].value, 'a spring starts at rest').toBe(0)
    expect(samples.at(-1)!.value, '...and ends at rest').toBe(1)
    expect(samples.at(-1)!.at, '...at the end of its own timeline').toBe(100)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].at, `sample ${i} moves forward`).toBeGreaterThan(samples[i - 1].at)
    }
  })

  it('lets the spring overshoot, which is the whole reason it is a spring', () => {
    // A bezier can overshoot once, but it cannot ring — it has no way to come
    // back through its target and settle. Sampling a damped oscillator is what
    // buys that, so a "spring" with no sample above 1 is a bezier in disguise
    // and should have been deleted in favour of one.
    const samples = springSamples(guardedCurve(SPRING_CURVE))
    const peak = Math.max(...samples.map((s) => s.value))
    expect(peak, 'the spring overshoots').toBeGreaterThan(1)
    // ...but only just. A bounce you can see is a bounce competing with the
    // text the user is writing; this is tuned to settle, not to flex.
    expect(peak - 1, 'the overshoot stays a settle, not a bounce').toBeLessThan(0.06)
  })
})

describe('choreography', () => {
  it('keeps the stagger shorter than the fastest rung', () => {
    const stagger = durationOf(tokens, '--app-motion-stagger')
    expect(stagger).toBeGreaterThan(0)
    // A gap longer than the shortest rung stops being a cascade and becomes a
    // queue: the last member of the group would still be arriving long after
    // the surface it belongs to has finished and read as settled.
    expect(stagger).toBeLessThan(durationOf(tokens, '--app-motion-micro'))
  })

  it('keeps the travel a distance, and short enough to never be a slide', () => {
    const m = tokens.match(/--app-motion-travel:\s*(\d+(?:\.\d+)?)px/)
    expect(m, '--app-motion-travel is declared as a length').not.toBeNull()
    const px = Number(m![1])
    expect(px).toBeGreaterThan(0)
    // "Come from where the thing lives" is a few pixels. Past this the surface
    // is sliding, which the brief rules out and which also makes every arrival
    // cost the user a wait they did not ask for.
    expect(px, 'travel is a nudge, not a slide').toBeLessThanOrEqual(8)
  })

  it('spends the stagger on arrivals only', () => {
    // The stagger may only ever be an `animation-delay`, and only on something
    // that is still arriving. A `transition-delay` on the same value would put
    // the wait between the user's input and its effect — the one place motion
    // is never allowed to be.
    let spent = 0
    for (const file of MOTION_SURFACE) {
      // Prose is allowed to name the token — the token file documents it, and
      // so do the rules that spend it. Only declarations are checked.
      for (const line of declarations(read(file), file).split('\n')) {
        if (!line.includes('--app-motion-stagger')) continue
        if (/--app-motion-stagger:\s*[\d.]+m?s/.test(line)) continue // the declaration
        spent++
        expect(line, `${file}: ${line.trim()}`).toMatch(/animation-delay:/)
      }
    }
    expect(spent, 'the stagger token must actually be spent').toBeGreaterThan(0)
  })

  it('never centres a dialog with `transform`, which the arrival scale multiplies', () => {
    // `transform: translate(-50%, -50%)` reads as centring and is not: the
    // `scale` in the arrival keyframe multiplies the whole transform, so the
    // centring is scaled with it and the dialog enters two per cent of its own
    // width off-centre — nine-odd pixels on a wide prompt — then slides home.
    // `translate` sits outside the scale and is measured from the box, so it
    // holds. A one-line mistake with a nine-pixel symptom, hence the pin.
    //
    // Scanned over every .vue this round may write rather than a list, so a
    // dialog added tomorrow is covered without anyone remembering to add it.
    // src/ui is outside these files and is not scanned; TemplatePicker.vue is
    // still centring with a transform and is recorded as a follow-up.
    const centring = /transform:\s*translate(?:X|Y)?\(-50%/
    for (const file of vueFiles('../components')) {
      expect(declarations(read(file), file), `${file} centres itself with a transform`).not.toMatch(
        centring,
      )
    }
  })

  it('never keys a stagger on position inside a dialog', () => {
    // Renumbering a sibling changes its `animation-delay`, and changing the
    // delay of a finished animation that carries `backwards` fill puts it back
    // into its delay phase — where it is invisible — and plays it again. A
    // dialog that reveals a validation error while the user types would blink
    // its own action row on every keystroke. So a dialog steps by *role*
    // (`.dialog-actions`), which cannot renumber; `:nth-child` is only safe on
    // a group that is created whole and never edited while it is open.
    expect(declarations(motion)).not.toMatch(/\.dialog[^{}]*:nth-child/)
  })

  it('does not delay a transition anywhere', () => {
    for (const file of MOTION_SURFACE) {
      expect(declarations(read(file), file), `${file} holds a transition open behind a delay`).not.toMatch(
        // `\s*` inside the lookahead, not outside it: outside, the engine can
        // backtrack the whitespace to empty and match the very declaration the
        // guard is about.
        /transition-delay:(?!\s*0ms)/,
      )
    }
  })
})

describe('compositing discipline', () => {
  it('takes out a promotion only where it is about to be spent', () => {
    // Promotion is a loan against memory and against text rendering: a promoted
    // layer is composited on its own and loses subpixel antialiasing, so a
    // dialog held on its own layer for its whole life renders its text worse
    // than one that is not. Taken out on a transitioning state, though, it buys
    // the exact frame it is for — the element is about to move and the browser
    // would otherwise promote it one frame late.
    let loans = 0
    for (const file of MOTION_SURFACE) {
      for (const [, selector, body] of declarations(read(file), file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/will-change:/.test(body)) continue
        loans++
        expect(selector, `${file}: ${selector.trim()} holds a promotion at rest`).toMatch(
          /-(?:enter|leave)-active/,
        )
      }
    }
    expect(loans, 'the promotion must actually be used somewhere').toBeGreaterThan(0)
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

  it('sweeps the stagger as well as the durations', () => {
    // The duration alone is not enough once anything is staggered. A stepped
    // child carries `backwards` fill, so neutralising its duration but leaving
    // its delay would hold it at the first keyframe — invisible — for the whole
    // delay and then snap it in. That is exactly the thing the preference
    // exists to prevent: content appearing late for no reason the user chose.
    expect(motion).toContain('animation-delay: 0ms !important')
  })

  it('switches the press movement off, rather than only making it instant', () => {
    // Neutralising a duration still lands the end state — a control that
    // shrinks under the finger with no animation at all is *more* jarring than
    // one that eases, not less, and it is still movement. So the press
    // transform is the one thing this round added that the sweep cannot cover
    // by itself, and it is switched off by name.
    const reduced = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced, 'the press movement must be switched off, not just sped up').toMatch(
      /transform:\s*none/,
    )
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
    // Prose may quote a duration to explain the scale, in a script no less than
    // in a stylesheet; that is documentation, not a value that reaches an
    // element. See `declarations`.
    const css = declarations(read(file), file)
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
