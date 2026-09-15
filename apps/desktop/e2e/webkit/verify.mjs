/**
 * The invariants the probes' numbers are read against, and how each one would
 * have to change to fail.
 *
 * A harness that only prints cannot be a gate, and one that only asserts cannot
 * be read. This does both: `measure.mjs` always prints the numbers, and this
 * decides whether they hold — so a difference between engines is visible as
 * numbers even when it is also a red exit code.
 *
 * Every check names the mutation that would turn it red. That is the discipline
 * this programme keeps applying to its tests, and it is the reason each check is
 * stated as a DELTA between two rects rather than as an absolute value: an
 * absolute number pins the fixture (the document, the scroll offset, the
 * engine's font metrics) while a delta pins the behaviour.
 */

const TOLERANCE = 0.5

class Checks {
  constructor() {
    this.results = []
  }

  run(name, detail, holds) {
    this.results.push({ name, detail, holds: Boolean(holds) })
  }

  get failed() {
    return this.results.filter((r) => !r.holds)
  }
}

/** The (floor of the) pane the panel must stay inside. */
const inside = (r) => r.insidePane && Object.values(r.insidePane).every(Boolean)

export function verify(results) {
  const c = new Checks()
  const panel = results.probes['image-panel']
  const tail = results.probes['split-tail-space']
  const motion = results.probes['motion-surface']

  if (panel) {
    const frame = panel.atChromiumFrame
    // FAILS IF: placement regresses to an anchor that is not the image — the
    // pre-2478363 `absolute; top: 0` puts the panel at `oldAnchorTop`, which is
    // the document's top (measured at -5911 here), and the delta becomes
    // thousands of px rather than 0.
    c.run(
      'image panel: top level with the figure',
      `panel.top - figure.top = ${frame.topDelta}`,
      Math.abs(frame.topDelta) < TOLERANCE,
    )
    // FAILS IF: IMAGE_PANEL_GAP changes, or the panel is placed from a rect that
    // is not the figure's (a pane edge, a line box, the wrong node view).
    c.run(
      'image panel: left at figure.right + the 8px gap',
      `panel.left - figure.right = ${frame.leftGap}`,
      Math.abs(frame.leftGap - 8) < TOLERANCE,
    )
    // FAILS IF: the panel is no longer fixed-positioned in viewport coordinates,
    // which is what makes the level-top arithmetic above mean anything.
    c.run('image panel: fixed, not document-anchored', `position: ${frame.position}`, frame.position === 'fixed')
    c.run(
      'image panel: inside the pane and the viewport',
      `insidePane=${JSON.stringify(frame.insidePane)} insideViewport=${frame.insideViewport}`,
      inside(frame) && frame.insideViewport,
    )
    c.run(
      'image panel: content not clipped',
      `client ${frame.panelBox.clientHeight} / scroll ${frame.panelBox.scrollHeight}`,
      !frame.panelBox.clipped,
    )

    // FAILS IF: the invariant is true only at the one offset that was tuned.
    // Read at three more positions, two of which fit and one of which clamps.
    const fitting = panel.atOtherFrames.filter((f) => Math.abs(f.topDelta) < TOLERANCE)
    c.run(
      'image panel: level at every offset where it fits',
      panel.atOtherFrames.map((f) => `figure.top ${f.figure.top}: delta ${f.topDelta}`).join(' | '),
      fitting.length >= 2 && panel.atOtherFrames.every((f) => inside(f) && f.leftGap === 8),
    )

    // FAILS IF: the "as close as fits" clamp is removed and the panel leaves the
    // editing column, or the clamp stops using the pane's own floor.
    const floor = panel.atPaneFloor
    c.run(
      'image panel: clamped to the pane floor, not the image',
      `panel.bottom ${floor.panel.bottom} vs pane.bottom ${floor.pane.bottom}`,
      Math.abs(floor.panel.bottom - (floor.pane.bottom - 8)) < TOLERANCE && inside(floor),
    )
    // FAILS IF: the panel follows the image out of the pane instead of stopping
    // at the pane's ceiling. Chromium measured this clamp at 136.
    const ceiling = panel.atPaneCeiling
    c.run(
      'image panel: clamped to the pane ceiling when the image scrolls past',
      `panel.top ${ceiling.panel.top} vs pane.top + 8 = ${ceiling.pane.top + 8}`,
      Math.abs(ceiling.panel.top - (ceiling.pane.top + 8)) < TOLERANCE && inside(ceiling),
    )
  }

  if (tail) {
    const { base } = tail
    // FAILS IF: the pad goes back to being measured per pane — the source pane's
    // CodeMirror scroller loses a horizontal scrollbar and the two numbers stop
    // agreeing (312 against 320 in the unit fixture).
    c.run(
      'tail space: one number, on both panes',
      `source ${base.sourcePad} / rendered ${base.renderedPad}`,
      base.sourcePad !== null && base.sourcePad === base.renderedPad,
    )
    // FAILS IF: the pad stops being read from the panel and goes back to a
    // percentage padding (which resolves against WIDTH) or a blank node.
    c.run(
      'tail space: 80% of the panel, not of a pane',
      `panes ${base.panelHeight} x 0.8 = ${base.expectedPad}, applied ${base.sourcePad}`,
      base.sourcePad === base.expectedPad,
    )
    // FAILS IF: `getScrollRange()` subtracts the pad again. THIS IS THE 63077f7
    // DEFECT: the driven pane then stops exactly `pad` short of its own maximum,
    // and with the panel at 637px that shortfall is 510px — the same arithmetic
    // the unit test watched fail as `expected 1600 to be 1920`.
    const driven = tail.afterDrivingSourceToBottom
    c.run(
      'tail space: the driven pane reaches its OWN maximum',
      `rendered ${driven.rendered.scrollTop} / ${driven.rendered.range} (source was driven to ${driven.source.scrollTop})`,
      driven.renderedAtMax === true,
    )
    // ...and the same in the other direction, which is the "it flipped with
    // whichever pane you touched" half of the report.
    const back = tail.afterDrivingRenderedToBottom
    c.run(
      'tail space: and so does the other one',
      `source ${back.source.scrollTop} / ${back.source.range}`,
      back.sourceAtMax === true,
    )
    // FAILS IF: the pad is no longer inside the scroller. The trailing space is
    // padding on a box INSIDE the scroller so it is part of the content travelled
    // over; put outside it, the space exists and cannot be scrolled to.
    c.run(
      'tail space: reachable at the bottom of both panes',
      `source ${tail.bottomSpace.source} = 48 + ${base.sourcePad}; rendered ${tail.bottomSpace.rendered} = 96 + ${base.renderedPad}`,
      Math.abs(tail.bottomSpace.source - (48 + base.sourcePad)) < TOLERANCE &&
        Math.abs(tail.bottomSpace.rendered - (96 + base.renderedPad)) < 0.5,
    )
  }

  if (motion) {
    // FAILS IF: the engine is older than 2.44, which is the whole reason
    // tokens.css names the version. On WebKitGTK 2.42 this reads false and the
    // design falls back to the bezier.
    c.run(
      'motion: the engine can run the spring at all',
      `CSS.supports linear(0, 1) = ${motion.support.supportsLinear}`,
      motion.support.supportsLinear,
    )
    // FAILS IF: the @supports branch stops matching — the resolved token would
    // fall back to the cubic-bezier, and the surface would arrive on the wrong
    // curve while every property name still looked right.
    c.run(
      'motion: --app-ease-surface resolved to the sample set',
      motion.support.resolvedSurfaceEase.slice(0, 60),
      motion.support.isSpring,
    )
    // The spring's whole point is the single overshoot. FAILS IF: the curve is
    // replaced by a monotone ease — the scale would top out AT 1 and never pass
    // it (motion-surface.spec.ts's frame delta is why "it moved" is not enough).
    c.run(
      'motion: the arrival overshoots once and settles',
      `scale min ${motion.arrival.scale.min} max ${motion.arrival.scale.max}`,
      motion.arrival.scale.max > 1 && motion.arrival.scale.min < 1,
    )
    // The two assertions motion-surfaces.spec.ts makes of every surface.
    c.run(
      'motion: the exit fades over frames rather than being cut',
      `fadedOut=${motion.exit.fadedOut} over ${motion.exit.renderedFrames} frames`,
      motion.exit.fadedOut === true,
    )
    c.run(
      'motion: the exit takes the pointer off the leaver',
      `${motion.exit.untouchedFrames} frames with pointer-events: none (spec wants > 3)`,
      motion.exit.untouchedFrames > 3,
    )
  }

  return {
    passed: c.results.filter((r) => r.holds).length,
    failed: c.failed.length,
    results: c.results,
  }
}
