import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { markArrived, markLeaving } from '../composables/surface-leave'

/**
 * The exit half of the motion vocabulary.
 *
 * `motion.test.ts` owns the ladder, the curves and the arrival, and its own
 * header says what it is for. What it could not hold is this: **every surface
 * that arrives has to leave.** The arrival is one rule that everything wearing
 * `.dialog` gets for free, so the arrival cannot regress silently; the exit is
 * per-host, because a `<Transition>` has to sit where the `v-if` is, and a host
 * that forgets it produces a dialog that fades in over 460ms and is gone in the
 * frame the user answers it. That is the failure these guards exist for, and it
 * is invisible in any single file — it is a *pair* of facts about two files.
 *
 * It lives in its own file rather than in `motion.test.ts` because that one is
 * at 765 lines against §13.1's 800-line test budget, and these are a different
 * behaviour domain: a surface's lifetime, not a curve's shape.
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')
/** CSS with its prose removed, so an assertion reads declarations only. */
const css = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '')

/** Every attribute block of a `<Transition …>` element in a template. */
function transitions(source: string): string[] {
  return [...source.matchAll(/<Transition\b([\s\S]*?)>/g)].map(([, attrs]) => attrs)
}

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
 * Every file that mounts a dialog surface, and how many it mounts.
 *
 * The count is the assertion, not documentation: a new dialog added to a host
 * makes the number wrong and the guard fails, which is the moment its author
 * has to decide whether it gets an exit like the rest of them. A surface that
 * is *not* in this table is a surface with a one-frame disappearance, and that
 * is exactly the defect this file was written after measuring.
 */
const DIALOG_HOSTS: Record<string, number> = {
  '../app/AppDialogs.vue': 5,
  '../ui/EditorPane.vue': 1,
  '../features/sidebar/components/AppSidebar.vue': 1,
}

describe('a dialog that arrives can leave', () => {
  it('declares the departure on the shared surface, out of the ladder', () => {
    // The layer, joined: the departure lives in `surface-motion.css` beside the
    // arrival it mirrors, and a reader that named one file would be checking
    // whichever half happened to hold the rule on the day it was written.
    const motion = ['surface-motion.css', 'motion.css']
      .map((sheet) => css(`./${sheet}`))
      .join('\n')
    // The leaver is a transition and not a second keyframe: a keyframe restarts
    // from its first frame, so a dialog dismissed mid-arrival would snap to full
    // and replay the fade before it left.
    expect(motion, 'the overlay transitions rather than animating on the way out').toMatch(
      /\.dialog-leave-active\s*\{[^}]*transition:\s*opacity var\(--app-motion-exit-slow\)/,
    )
    // And it must take no pointer: this overlay is `position: fixed; inset: 0`
    // at the top of the z-scale, so without it the whole window is dead to the
    // mouse for the length of the exit.
    expect(motion, 'the leaving scrim does not swallow the click').toMatch(
      /\.dialog-leave-active\s*\{[^}]*pointer-events:\s*none/,
    )
    expect(motion, 'the surface itself fades out').toMatch(
      /\.dialog-leave-to\s+\.dialog\s*\{[^}]*opacity:\s*0/,
    )
    // The reversal, which is the half a keyframe could never have given: no
    // `-enter-from`, so an interrupted close glides back from where it is
    // instead of snapping to full.
    const enter = motion.match(/\.dialog-enter-active\s*\{[^}]*\}/)?.[0] ?? ''
    expect(enter, 'a reopened dialog continues from where it is').toMatch(/transition:/)
    expect(motion, 'and the entrance stays the keyframe, not a second arrival').not.toMatch(
      /\.dialog-enter-from/,
    )
  })

  it('puts every one of them inside a Transition, in the host that owns the v-if', () => {
    for (const [file, expected] of Object.entries(DIALOG_HOSTS)) {
      const found = transitions(read(file)).filter((attrs) => /name="dialog"/.test(attrs))
      expect(
        found.length,
        `${file} mounts ${expected} dialog(s) and wraps ${found.length} of them in a <Transition name="dialog">`,
      ).toBe(expected)
      for (const attrs of found) {
        // Not decoration. These surfaces arrive on a keyframe and leave on a
        // transition, and with no type declared Vue waits out the longer of the
        // two — measured at 460ms against a fade that was over at 280ms, so an
        // invisible full-screen overlay held the modal stack and the focus trap
        // for another 180ms after the user could no longer see anything.
        expect(attrs, `${file}: the exit must name its type`).toMatch(/type="transition"/)
      }
    }
  })

  it('has a host for every surface that wears the overlay classes', () => {
    // The closed loop the table above is worth: the surfaces are found by what
    // they wear, not by a second hand-written list, so a dialog added to
    // `components/` or `ui/` without a host transition is caught by the count
    // in the test above rather than by a person remembering.
    const surfaces = vueFiles('..').filter((file) =>
      /class="(?:dialog|settings)-overlay"/.test(read(file)),
    )
    const hosts = Object.values(DIALOG_HOSTS).reduce((a, b) => a + b, 0)
    expect(
      surfaces.length,
      `the app has ${surfaces.length} surfaces wearing the dialog overlay and ${hosts} host transitions`,
    ).toBe(hosts)
    expect(surfaces.length, 'the sweep still finds the dialogs').toBeGreaterThanOrEqual(6)
  })
})

describe('the context menu, whose exit every host used to cut', () => {
  // A menu is mounted with `v-if` on a nullable state in six hosts, so its own
  // leave rule never ran and it went from `opacity 1` to out of the document in
  // one frame — the exact failure this file exists for, on the app's most-used
  // popup. The host wrapper is what makes the rule run; the two selectors carry
  // `.ctx-menu` because the component drives its own state with
  // `.ctx-menu.is-open`, which is *two* classes and beats a bare
  // `-leave-active` on specificity.
  const HOSTS = [
    '../ui/EditorPane.vue',
    '../ui/TabBar.vue',
    '../ui/AttachmentsPanel.vue',
    '../features/notes/components/NoteListPanel.vue',
    '../features/notes/components/NoteListToolbar.vue',
    '../features/vault/components/FileTree.vue',
  ]

  it('is wrapped where the v-if is, in every host that mounts one', () => {
    for (const file of HOSTS) {
      const source = read(file)
      expect(source, `${file} keeps the menu mounted through its exit`).toMatch(
        /<Transition name="ctx">/,
      )
    }
    expect(HOSTS.length, 'the list is the host count from ContextMenu.vue').toBe(6)
  })

  it('declares the exit on selectors that can out-specify its own state class', () => {
    const menu = css('../ui/ContextMenu.vue')
    expect(menu, 'the leaver takes no pointer').toMatch(
      /\.ctx-menu\.ctx-leave-active\s*\{[^}]*pointer-events:\s*none/,
    )
    expect(menu, 'and fades on the exit rung and curve').toMatch(
      /\.ctx-menu\.ctx-leave-active\s*\{[^}]*transition:\s*opacity var\(--app-motion-exit\) var\(--app-ease-exit\)/,
    )
    expect(menu, 'and reaches opacity 0 against `.is-open`').toMatch(
      /\.ctx-menu\.ctx-leave-to\s*\{[^}]*opacity:\s*0/,
    )
    // A bare `-leave-active`/`-leave-to` is the trap, not a style choice: it
    // loses to `.ctx-menu.is-open` and the exit silently does nothing.
    expect(menu, 'and never as a bare class').not.toMatch(/^\s*\.ctx-(?:leave-active|leave-to)\s*\{/m)
  })
})

describe('a surface on its way out is not a target', () => {
  it('takes the pointer away from the two panels that were measured taking it', () => {
    // Measured before this rule existed, per frame through the sidebar's whole
    // 195ms exit: `position: absolute`, `pointer-events: auto`, and
    // `elementFromPoint` at the panel's own centre answering a control inside
    // the departing column. For that window the column's 232px is a dead zone
    // over the content that had already moved into it — and the rail's 225px
    // mirrors it on the other edge.
    const shell = css('../app/appShell.css')
    expect(shell, 'a leaving column does not take the click').toMatch(
      /\.col-leave-active[\s\S]{0,80}\.rail-leave-active\s*\{[^}]*pointer-events:\s*none/,
    )
    expect(css('../features/settings/components/SettingsPanel.vue'), 'nor a leaving settings page').toMatch(
      /\.page-leave-active\s*\{[^}]*pointer-events:\s*none/,
    )
  })

  it('takes the tab order away too, which no stylesheet can do', () => {
    // `pointer-events` answers the mouse and nothing else; the properties that
    // would answer the keyboard are the ones that would also take the fade
    // away. `inert` is both, so the panels that leave carry the hooks — and the
    // *pair* of them is the assertion, because a leave that was never cleared
    // would leave a visible, laid-out, permanently dead column behind.
    const hosts: Array<[string, number]> = [
      ['../app/AppShell.vue', 3],
      ['../ui/InfoRail.vue', 6],
      // The settings dialog's section swap. It is not this brief's file and it
      // was measured after this guard was written: 60ms into the swap the
      // leaving page was still `pointer-events: auto` and still matched fifteen
      // controls that now sit under the incoming one, which is the same defect
      // as the shell's panels one level down.
      ['../features/settings/components/SettingsPanel.vue', 1],
    ]
    for (const [file, expected] of hosts) {
      const source = read(file)
      expect(
        [...source.matchAll(/@leave="markLeaving"/g)].length,
        `${file} marks every one of its ${expected} toggled surfaces as leaving`,
      ).toBe(expected)
      expect(
        [...source.matchAll(/@enter="markArrived"/g)].length,
        `${file} clears the mark when one of them comes back`,
      ).toBe(expected)
      expect(source, `${file} imports the hooks it uses`).toMatch(
        /import \{ markArrived, markLeaving \} from '[^']*composables\/surface-leave'/,
      )
    }
  })

  it('marks and clears, and does nothing to a missing element', () => {
    const el = document.createElement('div')
    markLeaving(el)
    expect(el.inert, 'the leaver leaves the tab order').toBe(true)
    markArrived(el)
    expect(el.inert, 'and comes back when it returns').toBe(false)
    expect(() => {
      markLeaving(null)
      markArrived(undefined)
    }, 'a hook that is handed nothing is not an error').not.toThrow()
  })
})
