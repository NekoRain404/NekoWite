import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { declarations, motion, read } from './motion-source'
import { MOTION_SURFACE, SCALED_ARRIVAL, wearsArrival } from './motion-surfaces'
import { AMPLITUDES, CURVE_SURFACE, tokens } from './motion-tokens'

/**
 * Choreography: how an arrival is composed — one animation, from the edge the
 * thing lives on, with the arrival curve spent only on movement.
 *
 * Split out of `motion.test.ts` when that file crossed the line budget with 70
 * tests in it; the old file's choreography suite is this file. It is the
 * largest domain because its guards are the ones that have to read across files:
 * a keyframe is named in one and defined in another, a placement is measured in
 * script and worn as a class, and a dialog is a third file away from both. The
 * two readers it needs for that — `vueFiles` and `keyframesAcross` — are local,
 * because no other file asks those questions. The tests are unchanged in the
 * move; only the file is.
 */

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

/**
 * Every `@keyframes` the motion layer defines, keyed by name, resolved across
 * the whole listed set rather than one file at a time.
 *
 * Resolving a name against the file the *rule* lives in was a real hole and not
 * a hypothetical one. `@keyframes surface-in` is defined exactly once, in
 * `surface-motion.css`, and named by three rules that live in other files:
 * `surfaces.css`'s two editor-core passthroughs and `appShell.css`'s settings
 * dialog. Looked up per-file, every one of those answered `undefined`, the body
 * read as `''`, and the property loop iterated zero times — so the three rules
 * that spend the arrival curve on an opacity, which is the one thing the guard
 * below exists to catch, were precisely the three it could not see. A lookup
 * that misses is not a guard that passes; it is a guard that is not there.
 *
 * The map is built from the same list the guard scans, so a keyframe is
 * resolvable exactly where it is checkable, and the guard turns a missed lookup
 * into a failure rather than into silence. An `animation:` shorthand naming a
 * keyframe nothing in the layer defines is not a rule to check — it is a rule
 * the engine will drop whole.
 *
 * First definition wins. A second `@keyframes` under the same name is a defect
 * of its own, and silently keeping the last one would let the two disagree about
 * which body this guard is reading.
 */
function keyframesAcross(files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of files) {
    const css = declarations(read(file), file)
    for (const [, name, body] of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
      if (!out.has(name)) out.set(name, body)
    }
  }
  return out
}

describe('choreography', () => {
  it('never cascades a group, in any file this app renders motion from', () => {
    // Supersedes `keeps the stagger shorter than the fastest rung` and `spends
    // the stagger on arrivals only`. Those two required a stagger to exist and
    // to be spent; this one is the rule that replaced them. An `animation-delay`
    // on a member of an arriving group is a second animation stacked on the one
    // its parent is already running — the same fade twice — and it is the half
    // that cannot be reversed: interrupting the animation cancels the delay with
    // it and the child snaps to its resting state while the parent eases back.
    //
    // Written as a scan rather than a token check on purpose: the failure this
    // prevents does not need a token to happen, and a `:nth-child` rule with a
    // literal delay in it would be the same defect wearing different clothes.
    //
    // The two lines in `./surfaces.css` are the one exception, and they are
    // named here rather than waved through: `.math-dialog > .math-actions` and
    // `.table-dialog > .table-dialog-actions` are the editor-core passthroughs.
    // They are the same defect as the dialog-actions rule that was removed from
    // motion.css, and they are the remaining half of the same fix — reported,
    // not tolerated. Any *third* delay fails this, wherever it appears. The key
    // is a file path, so it moved with them when the component layer was split;
    // the reason it exists did not change and the exception was not dropped.
    const UNCONVERTED = new Set([
      '  animation-delay: calc(var(--app-motion-stagger) * 2);',
    ])
    for (const file of MOTION_SURFACE) {
      for (const line of declarations(read(file), file).split('\n')) {
        if (!/animation-delay:/.test(line)) continue
        if (file === './surfaces.css' && UNCONVERTED.has(line)) continue
        expect(line, `${file} delays an animation: ${line.trim()}`).toMatch(
          // The one honest use: zeroing the delay rather than setting one. The
          // reduced-motion sweep is the only place allowed to say it.
          /animation-delay:\s*0ms/,
        )
      }
    }
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

  it('keeps every amplitude a token, in the band the design names', () => {
    // The amplitudes live beside the durations so that "make it subtler" is one
    // edit in one file. Each band is the design's, not the test's: a dialog that
    // scales from more than 1% is a window inflating under text that is trying
    // to be read (the value this replaced was 4%, called out by name as the
    // reason text looked soft while it settled), and a press that gives more
    // than 2% stops reading as a press.
    for (const [token, [lo, hi]] of Object.entries(AMPLITUDES)) {
      const m = tokens.match(new RegExp(`${token}:\\s*([\\d.]+)`))
      expect(m, `${token} is declared in tokens.css`).not.toBeNull()
      const value = Number(m![1])
      expect(value, `${token} is a fraction under 1`).toBeGreaterThan(lo)
      expect(value, `${token} is a fraction under 1`).toBeLessThanOrEqual(hi)
    }
    // The surface amplitude is the one the brief names, so it gets the tighter
    // floor: it may not drift back up towards the 4% it was.
    expect(Number(tokens.match(/--app-motion-scale-surface:\s*([\d.]+)/)![1])).toBeGreaterThanOrEqual(
      0.98,
    )
  })

  it('never puts the arrival curve on an opacity, which has nothing to settle', () => {
    // The arrival curve is shaped for something with mass: it covers most of its
    // distance early and then spends a long tail creeping the last per cent home.
    // An opacity has no mass and no per cent to creep — it is the same 1 either
    // way — so on that curve the fade is effectively over in its first third
    // while the movement is still going, and the surface finishes *appearing*
    // while it is still visibly growing.
    //
    // Scanned over every listed file rather than the ones this round rewrote, so
    // a component that reintroduces it is caught wherever it lives. Both
    // spellings count: a `transition` names the property in its own declaration,
    // and an `animation` names the keyframes, whose body has to be read to find
    // out what moves. (A surface arrival is two animations for exactly this
    // reason — the fade on `--app-ease`, the movement on `--app-ease-surface`.)
    //
    // The keyframe bodies are resolved over the WHOLE listed set, which is a fix
    // and not a detail: this guard used to read them out of the file the rule
    // lived in, and `@keyframes surface-in` lived in a third file. Three dialogs
    // named it, the lookup answered `undefined`, the body read as `''`, and the
    // property loop ran zero times — so the guard's one job, on the three rules
    // that were doing the thing it forbids, was silently not done. Worse than
    // silent: they still incremented `checked` below, so they also helped prove
    // the guard was checking something. See `keyframesAcross`.
    const arrival = `var(${CURVE_SURFACE})`
    // Commas inside `rgb(...)`/`var(--x, y)` are not separators.
    const parts = (value: string) => value.split(/,(?![^(]*\))/).map((p) => p.trim())
    const NON_SPATIAL = ['opacity', 'background', 'color', 'border-color', 'box-shadow', 'caret-color']
    let checked = 0
    // `animation` comes in two halves that live in different files — the rule
    // names the keyframes, the keyframes say what moves — and a dialog is a
    // third file away from both. So the bodies are resolved across the whole
    // listed set, once, before any rule is read. See `keyframesAcross`.
    const keyframes = keyframesAcross(MOTION_SURFACE)
    for (const file of MOTION_SURFACE) {
      const css = declarations(read(file), file)
      for (const [, shorthand, value] of css.matchAll(
        // The shorthands only: `transition-duration: 90ms` carries no curve.
        /(?:^|[;{\s])(transition|animation)\s*:\s*([^;}]+)/g,
      )) {
        for (const part of parts(value)) {
          if (!part.includes(arrival)) continue
          checked++
          if (shorthand === 'transition') {
            expect(NON_SPATIAL, `${file}: transition ${part} — the arrival curve is for movement`).not.toContain(
              part.split(/\s+/)[0],
            )
            continue
          }
          // `animation: <name> <duration> <curve>`. Whatever the keyframes move
          // is what the curve is being spent on.
          const name = part.split(/\s+/)[0]
          // Before anything is asked about the body: was there a body to ask
          // about? This is the assertion whose absence made the guard vacuous —
          // every check below it is inside a loop that a missing body runs zero
          // times, and an empty loop cannot fail.
          expect(
            keyframes.has(name),
            `${file}: animation ${part} names @keyframes ${name}, which no listed file defines`,
          ).toBe(true)
          const body = keyframes.get(name) ?? ''
          const properties = [...body.matchAll(/([\w-]+)\s*:/g)].map(([, p]) => p)
          expect(
            properties.length,
            `${file}: @keyframes ${name} declares nothing to move, so nothing was checked`,
          ).toBeGreaterThan(0)
          for (const property of properties) {
            expect(NON_SPATIAL, `${file}: @keyframes ${name} moves ${property} on the arrival curve`).not.toContain(
              property,
            )
          }
        }
      }
    }
    expect(checked, 'the arrival curve is still spent, or this guard checks nothing').toBeGreaterThan(3)
  })

  it('drives an overlay from the edge it is anchored to, and flips it with the placement', () => {
    // "Come from where the thing lives." A popup that flipped above its trigger
    // near the bottom of the window but kept travelling up from below would be
    // arriving from a gap it never occupied — both halves are fine on their own
    // and the pair reads as a bug. The placement is measured in script and worn
    // as a class, so what this pins is the *pair*: a rule that flips the origin
    // and a rule that flips the travel, both keyed on the same class.
    for (const file of ['../components/SelectMenu.vue', '../components/ComboBoxList.vue', '../ui/ContextMenu.vue']) {
      const css = declarations(read(file), file)
      expect(css, `${file} flips its origin with the placement`).toMatch(
        /\.(is-above|is-flipped)[^{}]*\{[^}]*transform-origin:/,
      )
      expect(css, `${file} flips the travel with it`).toMatch(
        /translateY\(var\(--app-motion-travel\)\)/,
      )
    }
  })

  it('never centres a dialog with `transform`, which the arrival scale multiplies', () => {
    // `transform: translate(-50%, -50%)` reads as centring and is not: the
    // `scale` in the arrival keyframe multiplies the whole transform, so the
    // centring is scaled with it and the dialog enters two per cent of its own
    // width off-centre — nine-odd pixels on a wide prompt — then slides home.
    // `translate` sits outside the scale and is measured from the box, so it
    // holds. A one-line mistake with a nine-pixel symptom, hence the pin.
    //
    // Scanned over every .vue in src rather than over the two directories this
    // round may write, so a dialog added anywhere is covered without anyone
    // remembering to add it — and filtered to the files that actually wear the
    // *scaled* arrival, which is the only case the rule is about. Plenty of
    // chrome centres itself with a transform and is right to (ui/TableMenu.vue
    // pins a hover toolbar over a cell); none of it is scaled by anything.
    const centring = /transform:\s*translate(?:X|Y)?\(-50%/
    const scaled = vueFiles('..').filter((file) => wearsArrival(declarations(read(file), file), SCALED_ARRIVAL))
    expect(scaled.length, 'the scaled arrival still has wearers to check').toBeGreaterThanOrEqual(5)
    for (const file of scaled) {
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
