/**
 * Does a note switch leave the rendered pane at the previous note's offset —
 * in the engine that ships?
 *
 * `RenderedPane` is kept alive under `v-show`, so nothing the app remounts its
 * scroll container when the document behind it changes. Reading the tree found
 * no writer of `.rendered-pane`'s `scrollTop` that runs on an `activeId` change,
 * but reading cannot rule out the ENGINE resetting the scroller as it replaces
 * the content subtree — and that is the whole question, because it decides
 * whether a stale offset is a defect or a thing the layout engine already
 * handles. Playwright cannot answer it: it drives Blink, and this app ships
 * WebKitGTK.
 *
 * So the probe drives the real thing and returns the two offsets, plus the
 * extents they were measured against — an offset that is only carried because
 * the arriving note clamps it to its own bottom is a different finding from one
 * that survives intact, and the two are indistinguishable without the ranges.
 *
 * `--only note-switch --scenario two-notes`.
 */
import { clickByText, scrollTo } from './probe-support.mjs'
import { sleep, until } from './webdriver.mjs'

/** The rendered pane IS `.rendered-pane` (`EditorPane` adds `pane rendered`). */
const readPanes = (wd) =>
  wd.execute(
    `const rendered = document.querySelector('.rendered-pane')
     const root = rendered ? rendered.querySelector('.ProseMirror') : null
     const cm = document.querySelector('.cm-scroller')
     const box = (el) => el ? {
       scrollTop: Math.round(el.scrollTop * 100) / 100,
       range: el.scrollHeight - el.clientHeight,
       scrollHeight: el.scrollHeight,
       clientHeight: el.clientHeight
     } : null
     return {
       rendered: box(rendered),
       source: box(cm),
       firstParagraph: root && root.querySelector('p') ? root.querySelector('p').textContent : null,
       contentHeight: root ? Math.round(root.getBoundingClientRect().height) : null,
       panesClass: document.querySelector('.panes') ? document.querySelector('.panes').className : null
     }`,
  )

/** Wait until the rendered pane is showing the note whose body starts with `text`. */
const showing = (wd, text) =>
  until(
    () =>
      wd.execute(
        `const root = document.querySelector('.pane.rendered .ProseMirror')
         if (!root) return false
         const p = root.querySelector('p')
         return Boolean(p && (p.textContent || '').indexOf(arguments[0]) !== -1)`,
        [text],
      ),
    { timeout: 30_000, what: `the rendered pane to be showing ${text}` },
  )

export const noteSwitchProbe = {
  name: 'note-switch',
  async run(wd) {
    // Asked of the page rather than of a parameter: what the probe needs is a
    // second note in the tree, and a scenario that has none cannot answer the
    // question. Skipping keeps `node measure.mjs` (every probe, the default
    // `long` scenario) working exactly as it did.
    const hasSecond = await wd.execute(
      `return Array.from(document.querySelectorAll('.tree-name'))
         .some((el) => (el.textContent || '').indexOf('second.md') !== -1)`,
    )
    if (!hasSecond) {
      return { skipped: 'this scenario has no second note; run with --scenario two-notes' }
    }

    // Rendered mode: the pane the reader is looking at, and the one `v-show`
    // keeps alive across the switch. Set here rather than assumed, because this
    // probe changes the document and a run that reaches it after another probe
    // must not inherit that probe's mode.
    await clickByText(wd, '.switch-option', 'Rendered')
    await showing(wd, 'first paragraph 1')
    // The editor's own first parse lands after the text is visible; a
    // measurement taken inside that window is a measurement of the app
    // starting up.
    await sleep(600)

    // A tap on the setter, so "who moved the pane" is read rather than inferred.
    // `.pane.rendered` keeps its own scroll offset, so an offset after the switch
    // is either a program write (the stack says which) or the engine's own. The
    // prototype's accessor is called through, so the engine still scrolls and
    // only the writes are recorded. It has to go on after the pane has mounted,
    // and it survives the switch because `v-show` never remounts the element.
    await wd.execute(
      `const el = document.querySelector('.rendered-pane')
       if (el.__nkwTapped) return true
       const proto = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
       window.__nkwWrites = []
       Object.defineProperty(el, 'scrollTop', {
         configurable: true,
         get: function () { return proto.get.call(el) },
         set: function (v) {
           const stack = String(new Error().stack || '').split('\\n').slice(1, 4).join(' | ')
           // The pane's own state AT the write: a position written through a
           // range that is not yet the new document's lands somewhere else
           // entirely, and the two are indistinguishable from the value alone.
           window.__nkwWrites.push({
             value: v,
             scrollHeight: el.scrollHeight,
             clientHeight: el.clientHeight,
             wasAt: proto.get.call(el),
             stack: stack
           })
           proto.set.call(el, v)
         }
       })
       el.__nkwTapped = true
       return true`,
    )

    const out = {}
    out.beforeSwitch = await readPanes(wd)

    // A third of the way down, so the offset is neither the top (which the
    // engine would produce anyway) nor the bottom (which a clamp would).
    const offset = Math.round(out.beforeSwitch.rendered.range * 0.35)
    out.driven = { requested: offset, ...(await scrollTo(wd, '.rendered-pane', offset)) }
    await sleep(400)
    out.afterDriving = await readPanes(wd)

    // Click the other note in the tree, the way the user does.
    await wd.execute('window.__nkwWrites.length = 0')
    await clickByText(wd, '.tree-name', 'second.md')
    await showing(wd, 'second paragraph 1')
    await sleep(400)
    out.afterSwitch = await readPanes(wd)
    // Every program write the switch produced. Empty means the engine kept the
    // offset by itself and no app code touched it — which is exactly the
    // question the audit could not settle by reading.
    out.writesDuringSwitch = await wd.execute('return window.__nkwWrites')

    // Then move the second note somewhere else and go back, so the value the
    // first note REMEMBERS and the value it would CARRY are different numbers.
    // Without this the two are equal and the reading cannot tell a restore from
    // a carry.
    const secondOffset = Math.round(out.afterSwitch.rendered.range * 0.6)
    out.secondDriven = { requested: secondOffset, ...(await scrollTo(wd, '.rendered-pane', secondOffset)) }
    await sleep(400)
    out.afterDrivingSecond = await readPanes(wd)

    await wd.execute('window.__nkwWrites.length = 0')
    await clickByText(wd, '.tree-name', 'two-notes.md')
    await showing(wd, 'first paragraph 1')
    await sleep(400)
    out.backOnFirst = await readPanes(wd)
    out.writesDuringRestore = await wd.execute('return window.__nkwWrites')
    // What the app's memory actually holds, read through the app's own module
    // rather than inferred from the offset it produced.
    out.memory = await wd.executeAsync(
      `const done = arguments[arguments.length - 1]
       Promise.all([import('/src/stores/tabs.ts'), import('/src/features/editor/model/reading-position.ts')])
         .then(([tabsMod, posMod]) => {
           const tabs = tabsMod.useTabsStore()
           return {
             tabs: tabs.tabs.map((t) => t.path),
             active: tabs.activeTab ? tabs.activeTab.path : null,
             lines: tabs.tabs.map((t) => posMod.readingLineOf(t.id))
           }
         })
         .then(done, (e) => done({ error: String(e) }))`,
    )

    out.verdict = {
      carriedFrom: out.beforeSwitch.rendered.scrollTop,
      carriedTo: out.afterSwitch.rendered.scrollTop,
      arrivedRange: out.afterSwitch.rendered.range,
      secondLeftAt: secondOffset,
      restoredTo: out.backOnFirst.rendered.scrollTop,
    }
    return out
  },
}
