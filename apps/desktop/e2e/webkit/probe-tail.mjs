/**
 * The split-mode tail space (`63077f7`) — a scroll-range claim, read in the
 * engine that ships.
 *
 * The defect was arithmetic, not layout: each pane reported
 * `scrollHeight - clientHeight - pad` as "how far I can scroll" while its
 * scrollbar actually travels `scrollHeight - clientHeight`, and the sync CLAMPS
 * every write to the range it is given. So the pane the sync DROVE could never
 * be pushed into the trailing space the pane the user HELD could be wheeled
 * into — it landed exactly the pad short of its own maximum, in both directions,
 * and which pane that was flipped with whichever the user touched.
 *
 * The fixed claim is therefore two things, and both are read here: one pad for
 * both panes, and a driven pane that reaches its OWN maximum.
 */
import { clickByText, scrollTo } from './probe-support.mjs'
import { sleep, until } from './webdriver.mjs'

/** `TAIL_SPACE_RATIO` — the pad is this much of the PANEL's height. */
const TAIL_SPACE_RATIO = 0.8

const readTail = (wd) =>
  wd.execute(
    `const pad = (sel) => {
       const el = document.querySelector(sel)
       if (!el) return null
       const raw = el.style.getPropertyValue('--nkw-tail-space')
       return raw === '' ? null : parseFloat(raw)
     }
     const range = (sel) => {
       const el = document.querySelector(sel)
       if (!el) return null
       return { range: el.scrollHeight - el.clientHeight, scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
     }
     const panes = document.querySelector('.panes')
     const source = range('.cm-scroller')
     const rendered = range('.pane.rendered')
     return {
       mode: panes ? panes.className : null,
       panelHeight: panes ? panes.clientHeight : null,
       expectedPad: panes ? Math.round(panes.clientHeight * ${TAIL_SPACE_RATIO}) : null,
       // The source pane writes the pad on its own root; the rendered pane
       // writes it on the box INSIDE its scroller, because that is the box its
       // stylesheet reads it on (.editor-container's padding-bottom). Two homes,
       // one number — which is the whole claim.
       sourcePad: pad('.pane.source'),
       renderedPad: pad('.editor-container'),
       source: source,
       rendered: rendered,
       // What each pane can actually be scrolled to, as the scrollbar reads it.
       sourceAtMax: source ? Math.abs(source.scrollTop - source.range) < 1 : null,
       renderedAtMax: rendered ? Math.abs(rendered.scrollTop - rendered.range) < 1 : null
     }`,
  )

export const tailProbe = {
  name: 'split-tail-space',
  async run(wd) {
    await clickByText(wd, '.switch-option', 'Split')
    await until(
      () =>
        wd.execute(
          `const s = document.querySelector('.cm-scroller');
           return Boolean(s && s.scrollHeight > s.clientHeight)`,
        ),
      { timeout: 20_000, what: 'the source pane scroller, ready to travel' },
    )
    await sleep(400)

    const out = { base: await readTail(wd) }

    const sourceMax = await wd.execute(
      `const el = document.querySelector('.cm-scroller'); return el.scrollHeight - el.clientHeight`,
    )
    await scrollTo(wd, '.cm-scroller', sourceMax)
    await sleep(300)
    out.afterDrivingSourceToBottom = await readTail(wd)

    const renderedMax = await wd.execute(
      `const el = document.querySelector('.pane.rendered'); return el.scrollHeight - el.clientHeight`,
    )
    await scrollTo(wd, '.pane.rendered', renderedMax)
    await sleep(300)
    out.afterDrivingRenderedToBottom = await readTail(wd)

    // What the user sees: how much blank space sits under the last line of each
    // pane when it is at its own bottom. The two panes wrap differently and their
    // stylesheets give the last line different breathing room on purpose (48px
    // in the source pane, 96px in the rendered one), so this is not an equality
    // to the pixel — but each should read its own constant PLUS the same 510,
    // which is what says the pad is reachable at all.
    out.bottomSpace = await wd.execute(
      `const bottomSpace = (scrollerSel, lastSel) => {
         const s = document.querySelector(scrollerSel)
         const l = lastSel ? document.querySelector(lastSel) : null
         if (!s || !l) return null
         return Math.round((s.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom) * 1000) / 1000
       }
       return {
         source: bottomSpace('.cm-scroller', '.source-pane .cm-line:last-of-type'),
         rendered: bottomSpace('.pane.rendered', '.editor-container .ProseMirror > *:last-child')
       }`,
    )
    return out
  },
}
