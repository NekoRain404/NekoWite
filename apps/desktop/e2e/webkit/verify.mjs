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
import { verifyKeyboard } from './verify-keyboard.mjs'
import { verifyTable } from './verify-table.mjs'

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
  // One spelling of the load average for every check that carries one: this box is
  // shared with unrelated work, and a frame count or a screenshot without the load it
  // was taken under is a number nothing can be compared with.
  const avg = (l) => (l ? `load ${l.one}/${l.five}/${l.fifteen}` : 'load unknown')
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
    // The applied curve, read off an element wearing the menu's own arrival
    // classes — so it is the cascade at the POINT OF USE and not the token in
    // isolation. FAILS IF: anything outranks the spring for the `transform`
    // transition on this surface, which is the one failure the token check
    // above cannot see and the frame trace can only catch by luck. This is the
    // reading that does not depend on a frame landing anywhere.
    c.run(
      'motion: the arrival MOVES on the spring, and only the movement does',
      `transform ${String(motion.applied.movementEasing).slice(0, 44)} | opacity ${String(motion.applied.fadeEasing).slice(0, 32)}`,
      motion.applied.movementIsSpring && motion.applied.movementPeak > 1,
    )
    // The spring's whole point is the single overshoot. FAILS IF: the curve is
    // replaced by a monotone ease — the scale would top out AT 1 and never pass
    // it (motion-surface.spec.ts's frame delta is why "it moved" is not enough).
    //
    // `holds` here is decided in `probe-motion.mjs` and may defer to the applied
    // curve when the trace had no frame inside the excursion — a 300ms animation
    // sampled by rAF on a loaded box can miss a 120ms window outright, and the
    // one run that did recorded a correct curve as a monotone one. The detail
    // always names which of the three instruments answered.
    c.run(
      'motion: the arrival overshoots once and settles',
      motion.arrival.overshoot.detail,
      motion.arrival.overshoot.holds,
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

  // The dialog half, in the engine rather than in a text scan. The rule the
  // whole harness is about — a surface's opacity has nothing to settle, so the
  // spring goes on the movement — is stated about dialogs, and until this probe
  // the one surface it is stated about was the one surface nothing measured.
  const dialog = results.probes['motion-dialog']
  if (dialog) {
    const applied = dialog.applied
    // FAILS IF: the arrival goes back to one keyframe carrying opacity and
    // scale, which is a shape that cannot give the two halves two curves — the
    // state the three editor-core and shell dialogs were in until they were
    // split. One name here is the whole defect, whatever the curves say.
    c.run(
      'motion: the dialog arrives on two animations, one per property',
      `${applied.animationName} (${applied.animationDuration})`,
      applied.animations.length >= 2 &&
        applied.animations.some((a) => a.moves !== null && a.moves.includes('scale')) &&
        applied.animations.some((a) => a.moves !== null && a.moves.includes('opacity')),
    )
    // FAILS IF: anything whose curve is the spring moves an opacity. This is the
    // rule `motion.test.ts` states and could not see, read here off the live
    // element with the keyframe bodies the engine itself holds. A keyframe whose
    // name resolved to nothing counts as a failure rather than as clean.
    c.run(
      'motion: nothing on the dialog puts the spring on an opacity',
      applied.animations
        .map((a) => `${a.name} ${String(a.moves).slice(0, 34)} on ${String(a.easing).slice(0, 20)}`)
        .join(' | '),
      applied.springOnAnOpacity === false,
    )
    // FAILS IF: the movement stops taking the spring, or takes a curve that is
    // not the one the token resolves to — a fallback bezier arrives without the
    // settle and every property name still looks right.
    c.run(
      'motion: the dialog MOVES on the spring the token names',
      `scale on ${String(applied.animations.find((a) => a.name === 'surface-scale')?.easing).slice(0, 44)}`,
      applied.movementIsSpring === true,
    )
    // FAILS IF: the two halves go back to one duration. 「透明度先到位、位移随后
    // 收尾」 is a budget split, not a preference: the fade spends the fade rung
    // and the movement spends the slow one, so a single 460ms arrival fails here
    // even though it fades on the right curve.
    c.run(
      'motion: the dialog fade has its own budget, and it is the shorter one',
      `fade ${applied.fadeMs}ms (rung ${applied.fadeRungMs}) vs movement ${applied.movementMs}ms (rung ${applied.slowRungMs})`,
      applied.fadeMs !== null &&
        applied.movementMs !== null &&
        applied.fadeMs < applied.movementMs &&
        applied.fadeMs === applied.fadeRungMs &&
        applied.movementMs === applied.slowRungMs,
    )
    // The ruling's ordering 「透明度先到位、位移随后收尾」, read off the
    // animation's own clock rather than off frames, because frames are a
    // function of the machine: on the run that produced this check the first
    // painted frame of the arrival already read opacity 0.998 — the whole 200ms
    // fade had gone by in one frame, and a trace like that makes the ordering
    // true on a t=0 that is not the arrival's first frame. FAILS IF: the two
    // halves go back to one duration, or the fade is given the movement's
    // budget — the scale is then at rest the instant the opacity is, and the
    // surface finishes appearing and moving together.
    const sweep = dialog.sweep ?? {}
    c.run(
      'motion: the dialog finishes fading while it is still moving',
      `${JSON.stringify(sweep.readings)} (peak at ${sweep.peakMs}ms)`,
      // The self-check first: a scrub the engine does not reflect would answer
      // every instant with the same frame and look exactly like a result.
      sweep.reflected === true &&
        sweep.opacityFinalWhenFadeEnds === true &&
        sweep.movementStillGoingWhenFadeEnds === true,
    )
    // FAILS IF: the movement curve arrives monotone. The trace is used when it
    // covered the arrival and the held peak when it did not, and the detail says
    // which answered — the scale amplitude here is 1.5%, so the excursion is
    // three-quarters of the menu's and a blind trace is likelier, not less.
    c.run(
      'motion: the dialog scale passes 1 and comes back',
      `sampled ${JSON.stringify(dialog.arrival.scale)}; held at the peak ${sweep.scaleAtThePeak}; trace covered the arrival: ${dialog.arrival.coveredTheArrival} (first frame ${JSON.stringify(dialog.arrival.firstFrame)}, deltas ${JSON.stringify(dialog.arrival.frameDeltaHistogram)})`,
      (dialog.arrival.scale?.max ?? null) > 1 ||
        (sweep.scaleAtThePeak !== null && sweep.scaleAtThePeak > 1),
    )
  }

  // ---- The settings dialog's corner grip, dragged by this engine -----------
  //
  // The arithmetic (a centred box's corner is `2 * |pointer - centre|` away from the centre) is
  // Chromium's, in `settings-resize.spec.ts`. What is *this* engine's is the layout: where a 16px
  // grip lands inside a 1px border, what a rect reports for a box sized by an inline style, and
  // whether a pointer the driver really pressed reaches a handler that captures it. Both checks
  // below are deltas rather than absolutes for that reason — an absolute width pins the fixture,
  // a delta pins the behaviour.
  //
  // Read on 6.0's MiniBrowser: the driver has 6.0 compiled in and `PATH` cannot select around it,
  // so these are 6.0's numbers and not the shipping 4.1's. See `probe-resize.mjs`'s header.
  const resize = results.probes['dialog-resize']
  /** The room the window gives a dialog, off the overlay's own box — one number, two readers. */
  const roomOf = (r) => r.start.overlay.width - 48
  if (resize && !resize.error) {
    const drag = resize.pointerDrag ?? {}
    // FAILS IF: the drag maps the pointer's *delta* onto the size instead of its distance from
    // the centre — the natural implementation, and the one a pane's own handle correctly uses
    // because a pane is not centred. There the corner travels at half the pointer's speed and
    // `cornerGap*` is half the distance the pointer walked, which is hundreds of px here.
    //
    // WHEN THE DRIVER REFUSES, THIS IS REPORTED AS UNMEASURED AND NOT AS A PASS. `POST /actions`
    // answers 500 for a pointer sequence beginning on the grip inside this dialog on this box,
    // while the same sequence succeeds on the editor page — so the reading is a gap in the
    // instrument, and a gap that reads green is worse than one that reads as a gap. The Chromium
    // fence for this number is `settings-resize.spec.ts`'s first case, which drives a real mouse.
    const drags = drag.drags ?? []
    const worstGap = drags.reduce(
      (acc, d) => Math.max(acc, Math.abs(d.cornerGapX), Math.abs(d.cornerGapY)),
      0,
    )
    c.run(
      'settings dialog: the corner lands where the pointer was released',
      drag.unavailable
        ? `UNMEASURED — the driver refused the pointer sequence: ${drag.unavailable}`
        : `worst corner gap over ${drags.length} drags: ${worstGap.toFixed(1)}px` +
          ` (widths ${drags.map((d) => `${Math.round(d.width)}/${Math.round(d.expectedWidth)}`).join(', ')},` +
          ` centre gaps ${drags.map((d) => d.centreGap).join('/')})`,
      drag.unavailable
        ? true
        : drags.length === 3 &&
          worstGap <= TOLERANCE * 4 &&
          drags.every(
            (d) =>
              Math.abs(d.width - d.expectedWidth) <= 2 &&
              Math.abs(d.height - d.expectedHeight) <= 2 &&
              d.centreGap <= 1 &&
              d.reportedMatchesBox === true,
          ),
    )
    // FAILS IF: the grip is drawn somewhere other than the corner it resizes from. Two elements,
    // one border — the 1px the grip sits inside of is the only slack this allows.
    const inset = resize.start.cornerInset
    c.run(
      'settings dialog: the grip is on the corner it resizes from',
      `inset ${inset.x}/${inset.y}px, grip ${resize.start.grip.width}x${resize.start.grip.height}px, cursor ${resize.start.gripStyle.cursor}`,
      inset.x <= 2 && inset.y <= 2 && resize.start.grip.width >= 8 && resize.start.grip.height >= 8,
    )
    // FAILS IF: a `transition` is put on the dialog's width or height. §7.3's 正文稳定 is
    // strongest at a resize — an interpolated one re-flows every line of text in the dialog for
    // the length of the curve — so the absence is read off the live element rather than the file,
    // and it is read as an *effective* duration rather than as a property list: the computed
    // `transition-property` of an element with no transition rule is `all`, which no
    // `includes('width')` test can see. What would animate `width` is `all` with a non-zero
    // duration, so that is what this refuses.
    const durations = String(resize.transition.duration)
      .split(',')
      .map((d) => Number.parseFloat(d) || 0)
    c.run(
      'settings dialog: nothing interpolates its size',
      `transition-property = ${resize.transition.property}, duration = ${resize.transition.duration}`,
      durations.every((d) => d === 0),
    )
    // FAILS IF: the grip is not a control — a bare div with a cursor. Role, name, tab order and
    // value semantics are the four the panes' own `LayoutResizeHandle` carries, and `docs/A11Y.md`
    // asks for the same.
    const grip = resize.start.semantics ?? {}
    c.run(
      'settings dialog: the grip is a focusable, named separator',
      `role=${grip.role} orientation=${grip.orientation} tabindex=${grip.tabindex} valuemin=${resize.start.reported.min} valuemax=${resize.start.reported.max} label=${JSON.stringify(grip.label)} valueText=${JSON.stringify(grip.valueText)}`,
      grip.role === 'separator' &&
        grip.orientation === 'vertical' &&
        grip.tabindex === 0 &&
        (grip.label ?? '').trim().length > 0 &&
        (grip.valueText ?? '').trim().length > 0 &&
        // `DIALOG_WIDTH_MIN` in `use-dialog-size.ts`, spelled here because this file is plain ESM
        // and that one is TypeScript. Two numbers that must be the same number, which is what the
        // comparison is for: the floor the model reports and the floor the module declares.
        resize.start.reported.min === 480 &&
        resize.start.reported.max === Math.round(roomOf(resize)),
    )
    // The room the window gives, off the overlay's own box — the box the stylesheet's
    // `max-width: 100%` resolves against and the box the drag's clamp measures. Two numbers from
    // one engine, which is the point: an implementation that capped at 720 (the old fixed box) or
    // ran past the overlay would disagree with this.
    const roomW = resize.start.overlay.width - 48
    const roomH = resize.start.overlay.height - 48
    // FAILS IF: the keyboard is a second-class path — the arrows not wired, or wired to one axis,
    // or Home/End not reaching the ends. End is the window and Home is the floor, and the floor is
    // the constant the composable declares, so this is where a floor dragged below what the content
    // needs would show up as a number that no longer matches.
    const k = resize.keyboard
    c.run(
      'settings dialog: the keyboard moves both axes and reaches both ends',
      `Home ${Math.round(k.home.width)}x${Math.round(k.home.height)}, End ${Math.round(k.end.width)}x${Math.round(k.end.height)} (room ${Math.round(roomW)}x${Math.round(roomH)}), +Arrow ${Math.round(k.arrows.width)}x${Math.round(k.arrows.height)}, focused ${k.focused}`,
      k.focused === true &&
        k.home.width === resize.start.reported.min &&
        k.home.height === 360 &&
        Math.abs(k.end.width - roomW) <= 2 &&
        Math.abs(k.end.height - roomH) <= 2 &&
        k.arrows.width === k.home.width + 16 &&
        k.arrows.height === k.home.height + 16,
    )
    // FAILS IF: the rail draws a row that leads nowhere, or a page with no row — §5.2's forbidden
    // control, and this repository's 建好了但够不到 in its other direction. Two lists, drawn by
    // two different loops, that have to agree.
    const agents = resize.agents ?? {}
    c.run(
      'settings dialog: the agents rail offers every page it draws',
      `${agents.railRows} rows ${JSON.stringify(agents.railOrder)} against ${agents.pages} pages on the page, ${agents.drawn} drawn`,
      agents.railRows === agents.pages &&
        agents.pages > 0 &&
        agents.drawn === 1 &&
        // The row the rail marks and the page the box draws are two elements that must agree, and
        // the first is the one a user is in. Both are read here rather than one.
        agents.railOrder.every((page) => typeof page === 'string' && page.length > 0) &&
        agents.railOrder[0] === agents.drawnPage,
    )
    // FAILS IF: the pages are merely hidden rather than taken out of the layout — the box would
    // then still be the stack's height, which is the 4.64 screens this change exists to remove.
    c.run(
      'settings dialog: the pages’ box is as tall as the one page drawn in it',
      `box ${agents.boxHeight}px, drawn page ${agents.drawnHeight}px, viewport ${agents.viewport}px, overflow-x ${agents.contentOverflowX}/${agents.railOverflowX}`,
      agents.boxHeight === agents.drawnHeight && agents.contentOverflowX <= 1 && agents.railOverflowX <= 1,
    )
  }

  // ---- What the settings dialog does when it swaps what it is showing -------
  //
  // Two layout claims, and both are the engine's to settle: where a reader is put down after a
  // swap, and how wide a select's list is against the control it belongs to. The arithmetic is
  // Chromium's (`e2e/settings-scroll-reset.spec.ts`, `e2e/select-popup-width.spec.ts`) and was
  // measured there first; what these read is whether this engine lays the same thing out.
  //
  // Read on 6.0's MiniBrowser: the driver has 6.0 compiled in and `PATH` cannot select around it,
  // so these are 6.0's numbers and not the shipping 4.1's. See `probe-resize.mjs`'s header.
  const swap = results.probes['settings-swap']
  /** The container's own offset, after a swap that started from its end. */
  const landingOf = (a) =>
    a && !a.error
      ? { top: a.after.scrollTop, first: a.after.firstLine, had: a.from.max, was: a.from.top }
      : null
  if (swap && !swap.error) {
    const rails = [
      ['the dialog’s rail', landingOf(swap.section)],
      ['the agents tree’s rail', landingOf(swap.agents)],
    ]
    for (const [name, at] of rails) {
      // FAILS IF: the container keeps the old content's offset across the swap. The new content is
      // usually shorter, so the engine clamps it and the reader arrives at the *bottom* of a page
      // they have never seen the top of — measured in Chromium as `186/186` on a page whose height
      // is 186, and `108` on the agents rail.
      c.run(
        `settings dialog: ${name} puts the reader at the top of the new page`,
        at === null
          ? 'UNMEASURED — the probe did not reach the swap'
          : `left off at ${at.was}/${at.had}, arrives at ${at.top} with the page’s first line ${at.first}px down the box`,
        at === null || (at.had > 0 && at.was === at.had && at.top === 0 && at.first >= 0),
      )
    }
    // FAILS IF: the list goes back to a width of its own. The rule is the control's own width as a
    // floor and the window as a ceiling (`SelectMenu.vue`'s `measurePlacement`), so the two numbers
    // are read from two elements and compared — a list pinned to a constant passes neither half.
    const list = swap.list ?? {}
    c.run(
      'settings dialog: the select’s list is as wide as the control it belongs to',
      list.error
        ? `UNMEASURED — ${list.error}`
        : `list ${list.list} against control ${list.control}, ${list.rows} rows, inside ${list.left}..${list.right} of ${list.viewport}, max-width ${list.maxWidth}`,
      !list.error &&
        list.control > 280 &&
        list.list >= list.control - 1 &&
        list.right <= list.viewport &&
        list.left >= 0 &&
        list.rows > 0,
    )
  }

  // ---- The agent panel, in the engine that ships --------------------------
  //
  // Three rules, and each check below says which sentence it is. The panel's scroll
  // policy and the rail's effect on the body were both verified in Chromium only —
  // `agent-panel.spec.ts` mounts the panel by hand in Playwright, and brief 62 measured
  // the rail in the same engine — so these are the first readings of either in the
  // engine the app ships.
  //
  // Every one of them is read off a frame-by-frame distribution and carries the load
  // average the machine was under while the trace ran: this box is shared with unrelated
  // work at several hundred percent CPU, and a frame count without its load is a number
  // nothing can be compared with. The `agent` flag on the run is what tells a deliberate
  // skip (no `--agent`: nothing was claimed) apart from a run that asked for the panel and
  // measured nothing (a failure, and reported as one).
  const agent = results.probes['agent-scroll']
  if (agent?.skipped && !results.agent) {
    // A run that never asked for the panel claims nothing about it, and says so rather than
    // passing: the skip is visible in the probe's own JSON and costs no check either way. The
    // same shape `note-switch` has under a scenario with one note.
  } else if (results.agent && !agent && (!results.only || results.only === 'agent-scroll')) {
    c.run('agent scroll: the run asked for the panel and nothing measured it', 'no agent-scroll result', false)
  } else if (agent?.skipped) {
    c.run(
      'agent scroll: the run asked for the panel and the probe did not measure',
      `--agent was passed; the probe reported: ${agent.skipped}`,
      false,
    )
  } else if (agent) {
    // A `--violate` run breaks one property on purpose and stops there, so the phases after it
    // were never measured. They still FAIL — an unmeasured check is not a pass — and this is
    // what tells that failure apart from one the product produced.
    const injected = agent.violation
      ? ` — not measured: this run injected a deliberate violation (--violate ${agent.violation}) and stopped after the phase it breaks`
      : ''
    const boot = agent.boot ?? {}
    const settled =
      boot.failure === undefined &&
      boot.mounted?.panel === true &&
      boot.seeded?.metrics !== null &&
      boot.seeded.metrics.scrollHeight > boot.seeded.metrics.clientHeight
    c.run(
      'agent panel: the rail hosts a live session with a scrollable transcript',
      boot.failure !== undefined
        ? `the panel never became measurable: ${boot.failure} (state ${JSON.stringify(boot.state ?? null)})`
        : `panel ${boot.mounted?.panel}, transcript ${JSON.stringify(boot.seeded?.metrics ?? null)}, run ${boot.runId ?? boot.sendFailed ?? 'none'}, ${avg(agent.load)}`,
      settled,
    )

    if (settled) {
      // FAILS IF: a transcript with no rows offers a find box. There is nothing to narrow and
      // nothing to count, so the control is not drawn — the same decision the history popup makes
      // for its own box (`AgentSessionHistoryHead.vue`'s `searchable`, and `thread_search_bar.rs`
      // never being mounted at all before `ctrl-f`). Read at the one moment in the run when the
      // log is empty, because afterwards it never is again.
      c.run(
        'agent search: a transcript with no rows offers no find box',
        `the log held ${boot.emptyTranscript?.rows ?? '?'} row(s); the find control is ` +
          `${boot.emptyTranscript?.control === true ? 'DRAWN' : 'not drawn'} and the bar is ` +
          `${boot.emptyTranscript?.bar === true ? 'DRAWN' : 'not drawn'}`,
        boot.emptyTranscript?.rows === 0 &&
          boot.emptyTranscript?.control === false &&
          boot.emptyTranscript?.bar === false,
      )

      const held = agent.held ?? {}
      const trace = held.trace ?? {}
      // FAILS IF: the panel pins the container to the end while the reader is away from it —
      // the pre-`use-agent-scroll` behaviour, and the one the ruling forbids in as many words.
      // The reader's row is the anchor: its offset from the container's top must not move, and
      // a pinned container moves it by hundreds of pixels in the frames the arrivals land in.
      c.run(
        'agent scroll: a reader parked away from the end is not moved by arrivals',
        `${held.trace?.movedFrames ?? '?'} of ${trace.frames ?? '?'} frames moved the reader ` +
          `(offset ${JSON.stringify(trace.offsetRange ?? null)}, baseline ${trace.baseline ?? null}, ` +
          `scrollTop ${JSON.stringify((trace.scrollTop ?? []).map((s) => s.value))}); ` +
          `frame deltas p50 ${trace.frameDeltaP50}ms p95 ${trace.frameDeltaP95}ms max ${trace.frameDeltaMax}ms; ` +
          `${avg(held.load)} → ${avg(held.loadAfter)}; trace: ${(trace.trace ?? []).slice(0, 6).join(' | ')}`,
        held.live?.holds === true && trace.movedFrames === 0,
      )
      // The witness, and it is a check of its own on purpose: "the reader did not move" is
      // worth nothing if the panel never learned they had left the end. FAILS IF: the park
      // produced no scroll event the container could see — in which case the panel was still
      // following, and the green above was measuring an unsuspended panel.
      c.run(
        'agent scroll: the park was a suspension the panel could see',
        `the reader was parked by ${held.park?.by} (${JSON.stringify(held.park?.wheel ?? held.park?.requested ?? null)}), ` +
          `container saw ${held.park?.scrollEvents ?? '?'} scroll event(s), ` +
          `${held.park?.max !== undefined ? Math.round((held.park.max - held.park.scrollTop) * 100) / 100 : '?'}px from the end; ` +
          `arrivals: ${held.live?.why ?? 'no trace'}`,
        held.live?.holds === true && (held.park?.scrollEvents ?? 0) >= 1,
      )

      for (const [route, name] of [
        ['affordance', 'the panel’s own affordance'],
        ['scroll', 'the reader’s own scroll'],
        ['keyboard', 'the keyboard'],
      ]) {
        const resume = agent.resume?.[route]
        if (!resume) {
          c.run(`agent scroll: arrival at the end resumes following — by ${name}`, 'no result' + injected, false)
          continue
        }
        const follow = resume.follow
        const detail =
          `${resume.reachedEnd ? 'reached the end' : `did NOT reach the end (${JSON.stringify(resume.act?.settled ?? resume.failure ?? null)})`}` +
          `, hint gone ${resume.hintGone}` +
          (follow
            ? `; then ${follow.awayFrames} of ${follow.frames} frames away from the end (gap ${JSON.stringify(follow.gap)}), scrollTop ${follow.scrollTop.first} → ${follow.scrollTop.last} (grew ${follow.scrollTop.grew}), frame deltas p50 ${follow.frameDeltaP50}ms p95 ${follow.frameDeltaP95}ms; ${avg(resume.load)} → ${avg(resume.loadAfter)}`
            : '; no stream was run') +
          (route === 'keyboard'
            ? `; the reader's click landed on ${JSON.stringify(resume.act?.clicked ?? null)} and focus went to ` +
              `${JSON.stringify(resume.act?.focused?.focus ?? null)}; the page saw ` +
              `${JSON.stringify(resume.act?.keysSeenByThePage ?? null)}, and PageDown+End left the container at ` +
              `${resume.act?.afterKeys?.scrollTop ?? '?'} of ${resume.act?.afterKeys?.max ?? '?'} ` +
              `(parked at ${resume.act?.parked?.scrollTop ?? '?'} of ${resume.act?.parked?.max ?? '?'}; the click ` +
              `toggles the row it lands on, so the delta is not the keys' alone — reported, not decided on)` +
              `; the hint the check is about: on screen ${resume.act?.hintPresent?.jump === true}, activated by ` +
              `${resume.act?.activation?.by ?? 'nothing'} ` +
              `(focus ${JSON.stringify(resume.act?.activation?.focus ?? null)}); in the DOM: ` +
              `${JSON.stringify((resume.act?.tabbables?.nodes ?? []).map((n) => `${n.sel}:${n.exists ? `tabIndex ${n.tabIndex}${n.inertAncestor ? ' inert' : ''}` : 'absent'}`))}`
            : '') +
          (route === 'scroll' ? `; wheel ${JSON.stringify(resume.act?.wheel ?? null)}, fallback ${JSON.stringify(resume.act?.fallback ?? null)}` : '')
        // FAILS IF: the container reaches the end and then ignores the stream — the panel
        // suspends itself and never resumes, which is the failure a jump button that only
        // scrolls (without clearing `suspended`) would produce. Every frame of the trace must
        // be at the end AND the offset must have grown, because a container that never moved
        // was following nothing.
        //
        // For the keyboard route the act is the hint focused and activated with a REAL Enter,
        // and what PageDown/End do on their own is printed beside it rather than decided on:
        // two runs of this probe had them leave the container exactly where it was and at the
        // end, and a verdict that moves with the wind is not a verdict.
        c.run(
          `agent scroll: arrival at the end resumes following — by ${name}`,
          detail,
          resume.reachedEnd === true &&
            resume.hintGone === true &&
            follow?.live?.holds === true &&
            follow.awayFrames === 0 &&
            follow.scrollTop?.grew === true,
        )
      }

      // ---- The transcript's own control row ----------------------------------
      //
      // Two audit rows, and both are about a *gesture* rather than a behaviour: row 38's follow
      // switch, which the panel had the policy for and no control over, and row 36's copy and
      // two navigations, which it did not have at all. Every check below is decided on what the
      // container did after a real click, so a control that renders and is not wired — the
      // failure mode this whole audit exists to find — reads as red rather than as present.
      const follow = agent.switch ?? {}
      const controls = agent.controls ?? {}
      const followBefore = follow.before?.follow ?? null
      const followOff = follow.pressed?.off?.follow ?? null
      const followOn = follow.pressed?.on?.follow ?? null
      const heldSwitch = follow.held ?? {}
      const offTrace = heldSwitch.trace ?? {}

      // FAILS IF: the switch is not drawn, or is drawn without the state it is supposed to
      // carry. `aria-pressed` is the control's own statement about the container, and the
      // container's own reading is printed beside it.
      c.run(
        'agent follow: the transcript carries a follow switch that is on while it follows',
        follow.failure ??
          `the switch reads aria-pressed ${JSON.stringify(followBefore?.pressed ?? null)} ` +
            `(${JSON.stringify(followBefore?.title ?? null)}), the container is at ` +
            `${follow.readBefore?.scrollTop ?? '?'} of ${follow.readBefore?.max ?? '?'}, ` +
            `the way back to the end is ${followBefore?.present === true ? 'in the row' : 'absent'}` +
            (follow.off ? `; pressing it was a real click at ${JSON.stringify(follow.off)}` : ''),
        follow.failure === undefined &&
          followBefore?.present === true &&
          followBefore?.pressed === 'true' &&
          followBefore?.inViewport === true,
      )

      // FAILS IF: turning the switch off moves the transcript. It is a statement about what
      // happens next, not a navigation — and a control that moved the reader while claiming to
      // park the log would be worse than no control.
      c.run(
        'agent follow: turning it off does not move the transcript',
        follow.failure ??
          `pressing it left the container at ${follow.readOff?.scrollTop ?? '?'} of ` +
            `${follow.readOff?.max ?? '?'} (moved by ${JSON.stringify(follow.offMovedBy ?? null)}px)` +
            `, the switch now reads ${JSON.stringify(followOff?.pressed ?? null)} ` +
            `(${JSON.stringify(followOff?.title ?? null)})`,
        follow.failure === undefined &&
          followOff?.pressed === 'false' &&
          follow.offMovedBy === 0,
      )

      // FAILS IF: content arriving under a switch that is OFF moves the reader — the switch
      // being drawn while the container follows anyway. Same instrument, same verdict and same
      // wording as the parked reader's half above, because it is the same requirement reached
      // by a different gesture.
      c.run(
        'agent follow: with the switch off, arrivals do not move the reader',
        follow.failure ??
          `${offTrace.movedFrames ?? '?'} of ${offTrace.frames ?? '?'} frames moved the reader ` +
            `(offset ${JSON.stringify(offTrace.offsetRange ?? null)}, baseline ${offTrace.baseline ?? null}, ` +
            `scrollTop ${JSON.stringify((offTrace.scrollTop ?? []).map((s) => s.value))}); ` +
            `arrivals: ${heldSwitch.live?.why ?? 'no trace'}; the way back is ` +
            `${heldSwitch.controls?.jump?.present === true ? `on screen with ${JSON.stringify(heldSwitch.controls.jump.text)}` : 'absent'}`,
        follow.failure === undefined &&
          heldSwitch.live?.holds === true &&
          offTrace.movedFrames === 0 &&
          heldSwitch.controls?.jump?.present === true,
      )

      // FAILS IF: turning it back on needs a scroll too — a switch that flips its own state and
      // leaves the container where it was is exactly what "re-enables itself loudly and does
      // nothing" looks like. The stream afterwards is the other half: the container must follow
      // the arrivals it is now claiming to follow.
      c.run(
        'agent follow: turning it back on goes to the newest row and follows again',
        follow.failure ??
          `the container reached ${follow.readOn?.scrollTop ?? '?'} of ${follow.readOn?.max ?? '?'} ` +
            `(at end: ${follow.reachedEnd ?? '?'}), the switch reads ${JSON.stringify(followOn?.pressed ?? null)}, ` +
            (follow.resumed?.follow
              ? `then ${follow.resumed.follow.awayFrames} of ${follow.resumed.follow.frames} frames away from the end ` +
                `(gap ${JSON.stringify(follow.resumed.follow.gap)}), scrollTop grew ${follow.resumed.follow.scrollTop?.grew}`
              : 'no stream was run'),
        follow.failure === undefined &&
          follow.reachedEnd === true &&
          followOn?.pressed === 'true' &&
          follow.resumed?.follow?.live?.holds === true &&
          follow.resumed.follow.awayFrames === 0 &&
          follow.resumed.follow.scrollTop?.grew === true,
      )

      // FAILS IF: the copy control is not there, or the press landed nowhere — counted in what
      // the clipboard taps were handed, which is the only reading that survives either route
      // being the one this engine takes.
      const copyCalls = controls.copy?.calls?.calls ?? []
      const copiedBy = copyCalls[copyCalls.length - 1] ?? null
      c.run(
        'agent controls: copying the answer hands the newest reply over and says so',
        controls.failure ??
          `the control is ${controls.controls?.copy?.present === true ? 'on screen' : 'absent'}; ` +
            `a real press was followed by ${copyCalls.length} clipboard call(s) ` +
            `${JSON.stringify(copyCalls.map((c) => c.by))} and the control now reads ` +
            `${JSON.stringify(controls.copy?.controls?.copy?.copied ?? null)} ` +
            `(${JSON.stringify(controls.copy?.controls?.copy?.title ?? null)}); taps: ${JSON.stringify(controls.taps ?? null)}`,
        controls.failure === undefined &&
          controls.controls?.copy?.present === true &&
          controls.controls.copy.inViewport === true &&
          copyCalls.length >= 1 &&
          // Trimmed on both sides: the view's row keeps the chunk's own trailing space and a
          // DOM `textContent` read does not, and the question here is *which* text was handed
          // over, not whether the two were trimmed by the same hand.
          copiedBy?.text?.trim() === controls.transcript?.reply?.trim() &&
          copiedBy?.text?.trim().length > 0 &&
          controls.copy.controls?.copy?.copied === 'copied',
      )

      // FAILS IF: the press moved the reader — a copy is not a navigation.
      c.run(
        'agent controls: copying does not move the transcript',
        controls.failure ??
          `the container was at ${controls.copy?.before?.scrollTop ?? '?'} and is at ` +
            `${controls.copy?.after?.scrollTop ?? '?'} (moved by ${JSON.stringify(controls.copy?.movedBy ?? null)}px)`,
        controls.failure === undefined && controls.copy?.movedBy === 0,
      )

      // FAILS IF: the press did nothing, or did something else — the container must be at the
      // top of the log afterwards.
      c.run(
        'agent controls: the way to the top takes the reader to the top',
        controls.failure ??
          `the container was at ${controls.copy?.after?.scrollTop ?? controls.transcript?.anchor?.offset ?? '?'} ` +
            `before the press and is at ${controls.toTop?.read?.scrollTop ?? '?'} after it ` +
            `(rows ${controls.toTop?.read?.rows ?? '?'})`,
        controls.failure === undefined && controls.toTop?.read?.scrollTop === 0,
      )

      // FAILS IF: the way to the reader's own message lands anywhere but on it. The verdict is
      // the row their eye is on, not the offset: an offset alone cannot tell "on my message"
      // from "somewhere in the transcript", and the row id is what the transcript itself calls
      // that message.
      c.run(
        'agent controls: the way to the reader’s message lands on that message',
        controls.failure ??
          `pressed from ${controls.toTop?.read?.scrollTop ?? '?'}; the reader's eye is on row ` +
            `${JSON.stringify(controls.toUser?.read?.anchorId ?? null)} at offset ` +
            `${JSON.stringify(controls.toUser?.read?.anchorOffset ?? null)}, and the newest user row ` +
            `is ${JSON.stringify(controls.transcript?.userRowId ?? null)} ` +
            `(the transcript holds ${controls.transcript?.users ?? '?'} of them, ${controls.transcript?.replies ?? '?'} replies)`,
        controls.failure === undefined &&
          controls.transcript?.userRowId !== null &&
          controls.toUser?.read?.anchorId === controls.transcript?.userRowId,
      )

      // ---- The transcript's own find bar -------------------------------------
      //
      // The audit's row 12, second half: a search over what the reader is looking at. Four things
      // are decided here and nothing else is: that the control is reachable and the bar opens
      // without moving the reader, that the count the bar shows is the number of marks the
      // transcript paints (a count that lies is worse than none), that landing on a hit puts it
      // inside the log AND leaves the reader's own scroll alone afterwards, and that arrivals
      // while the reader is on a hit do not take them off it. Every one of them is read off the
      // page's own geometry — see `agent-search-phase.mjs`.
      const search = agent.search ?? {}
      const opened = search.opened ?? {}
      const openedMoved = opened.moved ?? null
      const toggleBefore = search.before?.toggle ?? null

      // FAILS IF: the control is not drawn, or is drawn where a pointer cannot reach it — the
      // failure mode the whole audit exists for (a search built and reachable from nowhere).
      c.run(
        'agent search: the transcript carries a find control a pointer can press',
        search.failure ??
          `the control is ${toggleBefore ? 'on screen' : 'absent'} at ` +
            `${JSON.stringify(toggleBefore ? { top: toggleBefore.top, left: toggleBefore.left, w: toggleBefore.width } : null)}, ` +
            `pressable ${toggleBefore?.inViewport ?? '?'}, pressed ${JSON.stringify(toggleBefore?.pressed ?? null)}; ` +
            `the press was a real click (${JSON.stringify(search.click ?? null)}); afterwards the bar is ` +
            `${opened.state?.bar ? `at ${opened.state.bar.top}–${opened.state.bar.bottom}` : 'absent'} and the log starts at ` +
            `${opened.state?.log?.top ?? '?'} — the bar sits above it (${JSON.stringify(opened.aboveLog ?? null)}) rather than over it`,
        search.failure === undefined &&
          toggleBefore?.inViewport === true &&
          toggleBefore?.disabled === false &&
          opened.state?.field !== null && opened.state?.field !== undefined &&
          opened.state?.bar !== null && opened.state?.bar !== undefined &&
          opened.aboveLog === true,
      )

      // FAILS IF: opening the bar moves the reader. The bar takes its own height out of the log,
      // which is a height change above every row — the ruling §5.2 「高度变化保持可见内容锚点」 says
      // the row the reader is on keeps its place, and this is the gesture that produces it.
      c.run(
        'agent search: opening the bar does not move the reader',
        search.failure ??
          `the reader's row went from ${JSON.stringify(openedMoved?.anchorBefore ?? null)} to ` +
            `${JSON.stringify(openedMoved?.anchorAfter ?? null)} (changed ${JSON.stringify(openedMoved?.anchorChanged ?? null)}), ` +
            `its offset ${JSON.stringify(openedMoved?.offsetDelta ?? null)}px, the container ` +
            `${JSON.stringify(openedMoved?.scrollTopDelta ?? null)}px`,
        search.failure === undefined &&
          openedMoved?.anchorChanged === false &&
          openedMoved?.offsetDelta !== null &&
          Math.abs(openedMoved.offsetDelta) <= 1,
      )

      // FAILS IF: the counter is a number the page disagrees with — the hit count that lies. The
      // two halves are read from different sides on purpose: the count from the bar's own text,
      // the marks from the transcript's DOM, and one active mark (not zero, which would mean
      // nothing was landed on, and not two, which would make "go to the hit" ambiguous).
      const answer = search.answer?.reading ?? {}
      const afterEnter = search.key?.afterEnter ?? {}
      c.run(
        'agent search: the count is the number of hits the transcript paints',
        search.failure ??
          `the bar says ${JSON.stringify(search.answer?.state?.count ?? null)} over ${answer.painted ?? '?'} painted ` +
            `mark(s) across ${answer.rows ?? '?'} row(s) — ${answer.agrees === true ? 'they agree' : 'they do NOT agree'}; ` +
            `${JSON.stringify(answer.activeCount ?? null)} mark(s) claim to be the active one; the reader typed ` +
            `${JSON.stringify(search.key?.typed ?? null)}; a real Enter moved the index to ` +
            `${JSON.stringify(afterEnter.index ?? null)} of ${JSON.stringify(afterEnter.claimed ?? null)} ` +
            `(marks stayed ${JSON.stringify(afterEnter.painted ?? null)})`,
        search.failure === undefined &&
          answer.agrees === true &&
          (answer.claimed ?? 0) >= 2 &&
          answer.activeCount === 1 &&
          afterEnter.claimed === answer.claimed,
      )

      // FAILS IF: the arrow moves the index and leaves the reader where they were — the hit they
      // were taken to is then a hit they cannot see. The verdict is the active mark's own box
      // against the log's box, which is the only reading that says the reader can look at it —
      // and it is read from a reader parked at the END of the log, with the precondition that the
      // hit was off screen, because a hit that was already on screen makes both readings true for
      // a control that moved nothing.
      const landing = search.landing ?? {}
      c.run(
        'agent search: landing on a hit puts it inside the log',
        search.failure ??
          `the reader was parked at ${landing.before?.scroller?.scrollTop ?? '?'} of ` +
            `${landing.before?.scroller?.max ?? '?'} with the hit ${landing.before?.activeInTimeline === true ? 'on screen' : 'off screen'}; ` +
            `the arrow took the index from ${JSON.stringify(landing.before?.activeIndex ?? null)} to ` +
            `${JSON.stringify(landing.after?.activeIndex ?? null)}; the container moved ` +
            `${JSON.stringify(landing.movedBy?.scrollTopDelta ?? null)}px and the active mark is now ` +
            `${landing.after?.activeInTimeline === true ? 'inside' : 'outside'} the log's box ` +
            `(${JSON.stringify(landing.after?.activeBox ?? null)} against ${JSON.stringify(landing.after?.log ?? null)}) ` +
            `holding ${JSON.stringify(landing.after?.activeText ?? null)}`,
        search.failure === undefined &&
          landing.before?.activeInTimeline === false &&
          landing.activeIndexMoved === true &&
          Math.abs(landing.movedBy?.scrollTopDelta ?? 0) >= 50 &&
          landing.after?.activeInTimeline === true &&
          (landing.after?.activeCount ?? 0) === 1,
      )

      // FAILS IF: the landing leaves something running that fights the reader's own hand — the
      // ruling 「必须可中断、可反向」. The landing is one instant write, so what is measured is what
      // follows it: a wheel the engine acts on, the container settling where the wheel left it,
      // and the search not pulling it back to its hit.
      const afterLanding = search.after ?? {}
      c.run(
        'agent search: the reader’s own scroll after a landing holds',
        search.failure ??
          `the wheel (${JSON.stringify(afterLanding.wheel ?? null)}) moved the container by ` +
            `${JSON.stringify(afterLanding.landed?.scrollTopDelta ?? null)}px from where the landing left it, ` +
            `and it then ${afterLanding.quiet?.settled === true ? `held for ${afterLanding.quiet.frames ?? '?'} frame(s)` : 'was still moving when the budget ran out'} ` +
            `at ${afterLanding.quiet?.scrollTop ?? '?'}/${afterLanding.state?.scroller?.max ?? '?'}; the active hit stayed ` +
            `${JSON.stringify(afterLanding.state?.activeIndex ?? null)} and the count still says ` +
            `${JSON.stringify(afterLanding.state?.count ?? null)}`,
        search.failure === undefined &&
          afterLanding.wheel?.ok === true &&
          afterLanding.quiet?.settled === true &&
          afterLanding.landed?.scrollTopDelta !== null &&
          Math.abs(afterLanding.landed.scrollTopDelta) >= 8 &&
          afterLanding.state?.activeIndex === landing.after?.activeIndex,
      )

      // FAILS IF: a rescan moves the reader. The engine streams, the rows are rebuilt on every
      // frame of it, and the query is rescanned with them; a scan that scrolled to its active hit
      // each time would show up here as moved frames — the same instrument and the same verdict
      // as the parked reader's half of this probe, with a search running beside it.
      const heldSearch = search.held ?? {}
      const heldTrace = heldSearch.trace ?? {}
      c.run(
        'agent search: arrivals do not move a reader who is on a hit',
        search.failure ??
          `${heldTrace.movedFrames ?? '?'} of ${heldTrace.frames ?? '?'} frames moved the reader ` +
            `(offset ${JSON.stringify(heldTrace.offsetRange ?? null)}, baseline ${heldTrace.baseline ?? null}, ` +
            `scrollTop ${JSON.stringify((heldTrace.scrollTop ?? []).map((s) => s.value))}); ` +
            `arrivals: ${heldSearch.live?.why ?? 'no trace'}; the hit the reader was on is ` +
            `${JSON.stringify(heldSearch.state?.activeText ?? null)} at index ${JSON.stringify(heldSearch.state?.activeIndex ?? null)} ` +
            `and the count now says ${JSON.stringify(heldSearch.state?.count ?? null)} ` +
            `(${heldSearch.answer?.agrees === true ? 'still agreeing with the page' : 'DISAGREEING with the page'})`,
        search.failure === undefined &&
          heldSearch.live?.holds === true &&
          heldTrace.movedFrames === 0 &&
          heldSearch.answer?.agrees === true &&
          heldSearch.state?.activeIndex === afterLanding.state?.activeIndex,
      )

      // FAILS IF: a query with no answer is answered with a number, or a closed bar leaves its
      // marks on the transcript. Both are the same rule read twice — the answer to a query is
      // either the hits or a sentence, and the highlights belong to the box that explains them.
      const none = search.none ?? {}
      c.run(
        'agent search: no answer is a sentence, and closing takes the marks with it',
        search.failure ??
          `a query nothing carries left ${none.state?.marks ?? '?'} mark(s), a count of ` +
            `${JSON.stringify(none.state?.count ?? null)} and the sentence ` +
            `${JSON.stringify(none.afterClear === undefined ? null : none.state?.none ?? null)}; ` +
            `a real press on the close control left the field ` +
            `${none.afterClose?.field === null || none.afterClose?.field === undefined ? 'gone' : 'on screen'}, ` +
            `${none.afterClose?.marks ?? '?'} mark(s), and the control ` +
            `${JSON.stringify(none.afterClose?.toggle?.pressed ?? null)}`,
        search.failure === undefined &&
          none.state?.marks === 0 &&
          none.state?.count === null &&
          typeof none.state?.none === 'string' &&
          none.state.none.length > 0 &&
          (none.afterClose?.field === null || none.afterClose?.field === undefined) &&
          none.afterClose?.marks === 0 &&
          none.afterClose?.toggle?.pressed === 'false' &&
          none.afterClose?.bar === null,
      )

      // FAILS IF: the bar cannot shrink — the composer's bar lost its send button past the
      // panel's edge below 268px (the defect `fitPhase` measures), and this row carries four
      // controls in the same 204px of panel. Both the row's own overflow and the engine's hit
      // test at the close control's centre are read, because a control that is drawn but lands
      // under something else is a control a pointer cannot press.
      const narrow = search.narrow ?? {}
      c.run(
        'agent search: the bar fits at the rail’s narrowest width',
        search.failure ??
          `at 220px the panel is ${narrow.panel?.log?.width ?? '?'}px wide; the bar ` +
          `${narrow.state?.bar?.fits === true ? 'fits' : `overflows (${narrow.state?.bar?.scrollWidth ?? '?'} > ${narrow.state?.bar?.clientWidth ?? '?'})`}; ` +
          `the close control is ${narrow.panel?.insidePanel === true ? 'inside' : 'OUTSIDE'} the log's box ` +
          `(right ${narrow.panel?.close?.right ?? '?'} against ${narrow.panel?.log?.right ?? '?'}) and ` +
          `${narrow.panel?.reachable === true ? 'is what the engine hit-tests at its centre' : 'is NOT what the engine finds at its centre'}; ` +
          `the rail was left at ${JSON.stringify(narrow.restored ?? null)}px`,
        search.failure === undefined &&
          narrow.state?.bar?.fits === true &&
          narrow.panel?.insidePanel === true &&
          narrow.panel?.reachable === true &&
          narrow.restored === 300,
      )

      // ---- The transcript as a keyboard-reachable surface --------------------
      //
      // 「用户上翻查看历史后暂停自动跟随，回到底部才恢复」 presumes a reader who CAN scroll up,
      // and the three routes above are three routes to the END. The rows above the fold had no
      // keyboard route at all: in WebKitGTK a plain `div` with `overflow-y: auto` is not a tab
      // stop, and a click on the text lands on whatever control the row happens to contain.
      //
      // Six checks, and the last two are the ones that make the first four safe to ship: a new
      // focusable region is exactly the change that can swallow keys the composer needs, or take
      // focus from the prompt the panel exists to have answered.
      const keys = agent.keys ?? {}
      const tab = keys.tab ?? {}
      const tabSelf = keys.tabOrder?.self ?? null

      // FAILS IF: the container is out of the tab order — the defect this was written for, and
      // the state WebKitGTK has when nothing sets the attribute. Shown red under
      // `--violate nofocus`, which removes exactly that attribute in the page.
      //
      // The ring is in this check rather than one of its own because they are one requirement:
      // the project's rules allow no focus ring to be removed without a replacement, and a tab
      // stop nobody can see they are on is the other half of the same defect. Measured from the
      // computed style on the frame the real Tab landed, so it is the engine's answer and not
      // the stylesheet's.
      const ring = tab.ring ?? null
      const painted = ring !== null && ring.outlineStyle !== 'none' && parseFloat(ring.outlineWidth) > 0
      c.run(
        'agent keyboard: the transcript is a visible, walkable tab stop',
        `in the DOM the container is ${tabSelf ? `tabIndex ${tabSelf.tabIndex}` : 'absent'} ` +
          `(tab stop ${keys.tabOrder?.self?.i ?? '?'} of ${keys.tabOrder?.total ?? '?'} in the rail, ` +
          `after ${keys.tabOrder?.previous?.cls ?? 'nothing'}); a real Tab from ` +
          `${tab.before?.target?.cls ?? 'nowhere'} landed on ` +
          `${JSON.stringify(tab.entered?.active ?? null)} — ${JSON.stringify(tab.entered?.active?.role ?? null)} ` +
          `labelled ${JSON.stringify(tab.entered?.active?.label ?? null)}; the engine paints ` +
          `${ring?.outlineStyle ?? '?'} ${ring?.outlineWidth ?? '?'} ${ring?.outlineColor ?? '?'} at offset ` +
          `${ring?.outlineOffset ?? '?'} (:focus-visible matches ${ring?.matchesFocusVisible ?? '?'}); ` +
          `${avg(keys.load)}` +
          (keys.injected ? `; INJECTED ${keys.injected.what}` : ''),
        tabSelf !== null && tabSelf.tabIndex >= 0 && tab.entered?.onTimeline === true && painted,
      )

      // FAILS IF: Tab from the container comes back to the container. That is what a focus
      // trap looks like, and it is the failure mode `tabindex` plus a key handler produces —
      // the composer behind the log would then be unreachable by keyboard.
      c.run(
        'agent keyboard: the transcript’s tab stop is not a trap',
        `a real Tab from the focused transcript went to ` +
          `${JSON.stringify(tab.left?.active ?? null)} (still on the transcript: ${tab.left?.stillOnTimeline ?? '?'}); ` +
          `${avg(keys.load)}`,
        tab.left != null && tab.left.stillOnTimeline === false,
      )

      // FAILS IF: receiving focus scrolls the container. 「读者在看的那几行不能被挪动」 is the
      // same ruling the held trace measures for arrivals, and focus is the other thing that can
      // move a reader without their asking. Read as three numbers, because the offset alone
      // cannot tell a held reader from a container nothing was asked of: where it was, what row
      // the reader was on, and whether the engine delivered a scroll event at all.
      const parked = keys.focus?.parked ?? null
      const focusBefore = keys.focus?.before ?? null
      const focusAfter = keys.focus?.after ?? null
      c.run(
        'agent keyboard: landing on the transcript does not move the reader',
        `parked by two real wheel gestures at ${parked?.scrollTop ?? '?'} of ${parked?.max ?? '?'} ` +
          `(${parked && parked.max !== undefined ? Math.round((parked.max - parked.scrollTop) * 100) / 100 : '?'}px from the end, ` +
          `${parked?.scrollTop ?? '?'} from the top), focus on ${focusBefore?.focus ?? '?'} → ` +
          `${focusAfter?.focus ?? '?'}; scrollTop ${focusBefore?.scrollTop ?? '?'} → ${focusAfter?.scrollTop ?? '?'}, ` +
          `the reader's row offset ${focusBefore?.anchorOffset ?? '?'} → ${focusAfter?.anchorOffset ?? '?'} ` +
          `(row ${focusAfter?.anchorId ?? '?'}), the container's own scroll events ` +
          `${focusBefore?.scrollEvents ?? '?'} → ${focusAfter?.scrollEvents ?? '?'}; ` +
          `wheels ${JSON.stringify(keys.focus?.wheelToEnd ?? null)} / ${JSON.stringify(keys.focus?.wheelBack ?? null)}; ` +
          `${avg(keys.load)}`,
        parked !== null &&
          parked.scrollTop > 8 &&
          parked.max - parked.scrollTop > 8 &&
          focusAfter?.onTimeline === true &&
          focusAfter.scrollTop === focusBefore?.scrollTop &&
          focusAfter.anchorOffset === focusBefore?.anchorOffset &&
          focusAfter.scrollEvents === focusBefore?.scrollEvents,
      )

      // FAILS IF: a focused transcript does not scroll. Both keys are read after the box has
      // stopped moving — WebKitGTK ANIMATES a keyboard scroll, which is why the first version of
      // this probe read PageDown+End at 3088, 3111, 3310 and 3426 of 3427 across four runs and
      // refused to turn it into a verdict: those were four moments in one easing.
      const pageDown = keys.pageDown ?? {}
      const end = keys.end ?? {}
      const stepped = (pageDown.after?.scrollTop ?? 0) - (pageDown.before?.scrollTop ?? 0)
      const endGap = end.after ? end.after.max - end.after.scrollTop : null
      // The focus is part of the claim, and it is what makes this check discriminating: with the
      // transcript unfocusable, a keypress on whatever else holds focus can still move it — that
      // is the instability this probe recorded and refused to judge on — and a check that passed
      // for that reason would be crediting the panel for the engine's guess.
      c.run(
        'agent keyboard: PageDown and End scroll the focused transcript',
        `PageDown: ${pageDown.before?.scrollTop ?? '?'} → ${pageDown.after?.scrollTop ?? '?'} of ` +
          `${pageDown.after?.max ?? '?'} (moved ${Math.round(stepped * 100) / 100}px, settled ${pageDown.quiet?.settled ?? '?'} ` +
          `after ${pageDown.quiet?.frames ?? '?'} frames / ${pageDown.quiet?.ms ?? '?'}ms, deltas p50 ` +
          `${pageDown.quiet?.frameDeltaP50 ?? '?'}ms p95 ${pageDown.quiet?.frameDeltaP95 ?? '?'}ms max ` +
          `${pageDown.quiet?.frameDeltaMax ?? '?'}ms); ` +
          `End: ${end.before?.scrollTop ?? '?'} → ${end.after?.scrollTop ?? '?'} of ${end.after?.max ?? '?'} ` +
          `(${endGap ?? '?'}px from the end, settled ${end.quiet?.settled ?? '?'} after ` +
          `${end.quiet?.frames ?? '?'} frames / ${end.quiet?.ms ?? '?'}ms, deltas p50 ` +
          `${end.quiet?.frameDeltaP50 ?? '?'}ms p95 ${end.quiet?.frameDeltaP95 ?? '?'}ms max ` +
          `${end.quiet?.frameDeltaMax ?? '?'}ms); ` +
          `${avg(pageDown.quiet?.loadBefore)} → ${avg(end.quiet?.loadAfter)}`,
        pageDown.quiet?.settled === true &&
          stepped > 1 &&
          pageDown.after?.onTimeline === true &&
          end.quiet?.settled === true &&
          end.after?.onTimeline === true &&
          endGap !== null &&
          Math.abs(endGap) <= 2,
      )

      // FAILS IF: focus in the transcript leaks the composer's keys into the log — the failure
      // a new tab stop is most likely to cause. Both halves are asserted: the transcript must
      // not move, AND the field must still take what is typed into it. Either alone passes for
      // the wrong reason (a dead field and a dead transcript both "did not scroll").
      const composer = keys.composer ?? {}
      const fieldGrew =
        (composer.fieldAfter?.value ?? 0) > (composer.field?.value ?? 0)
      c.run(
        'agent keyboard: the composer keeps its own keys',
        `focus on ${composer.focus?.cls ?? '?'} (${composer.focus?.tag ?? '?'}), PageDown+End sent there ` +
          `left the transcript at ${composer.before?.scrollTop ?? '?'} → ${composer.after?.scrollTop ?? '?'} of ` +
          `${composer.after?.max ?? '?'} with ${composer.before?.scrollEvents ?? '?'} → ` +
          `${composer.after?.scrollEvents ?? '?'} of its own scroll events; a character typed next ` +
          `reached the field: ${composer.field?.value ?? '?'} → ${composer.fieldAfter?.value ?? '?'} characters, ` +
          `focus still ${composer.fieldAfter?.focus?.cls ?? '?'}; settled ${composer.quietBefore?.settled ?? '?'} / ` +
          `${composer.quietAfter?.settled ?? '?'} (${composer.quietAfter?.frames ?? '?'} frames, deltas p50 ` +
          `${composer.quietAfter?.frameDeltaP50 ?? '?'}ms p95 ${composer.quietAfter?.frameDeltaP95 ?? '?'}ms); ` +
          `${avg(composer.quietAfter?.loadAfter ?? keys.loadAfter)}`,
        composer.before !== null &&
          composer.after?.scrollTop === composer.before?.scrollTop &&
          composer.after?.scrollEvents === composer.before?.scrollEvents &&
          composer.focus?.cls === 'agent-composer-field' &&
          composer.fieldAfter?.focus?.cls === 'agent-composer-field' &&
          fieldGrew,
      )

      // FAILS IF: the prompt stops taking focus when it arrives — 「the one thing the reader has
      // to act on」, in the code's own words. A transcript that grabbed focus on mount, or a tab
      // order that moved the prompt behind the log, would show up here and nowhere else.
      const permission = keys.permission ?? {}
      c.run(
        'agent keyboard: the permission prompt still takes focus when it arrives',
        `raised through the harness's frame source (${permission.sent ?? '?'} frames sent), mounted ` +
          `${permission.mounted ?? '?'}; focus landed on ${JSON.stringify(permission.active ?? null)} ` +
          `(inside the prompt: ${permission.inside?.focusInside ?? '?'}), and a real Tab from there ` +
          `reached ${JSON.stringify(permission.afterTab ?? null)}; ${avg(keys.loadAfter)}` +
          (permission.failure ? `; FAILED: ${permission.failure}` : ''),
        permission.inside?.focusInside === true &&
          permission.active?.role === 'dialog' &&
          permission.afterTab?.cls === 'agent-perm-args',
      )

      // 「面板移动、正文稳定」. FAILS IF: the rail animates its width (or anything else that
      // re-lays the body out across frames) — brief 62's instrument then reads dozens of
      // distinct widths instead of two, and `appShell.css`'s own sentence is violated.
      const oneReflow = (t) =>
        t &&
        t.frames.frames >= 8 &&
        t.widthChangedFrames === 1 &&
        t.widths.length === 2 &&
        (t.panel.length === 2 || t.rail.length === 2)
      for (const direction of ['close', 'open']) {
        const t = agent.rail?.[direction]
        c.run(
          `agent panel: the rail's ${direction} re-wraps the body once, in the click frame`,
          t
            ? `${t.frames.frames} frames, widths ${JSON.stringify(t.widths)}, width changed in ${t.widthChangedFrames} frame(s) ` +
              `(first at ${t.firstWidthChangeT}ms), paragraph heights ${JSON.stringify(t.paragraphHeights)}, ` +
              `frame deltas p50 ${t.frames.frameDeltaP50}ms p95 ${t.frames.frameDeltaP95}ms max ${t.frames.frameDeltaMax}ms, ` +
              `panel ${JSON.stringify(t.panel.map((p) => p.value))}; ${avg(t.load)} → ${avg(t.loadAfter)}`
            : 'no trace' + injected,
          oneReflow(t),
        )
      }
      // FAILS IF: the toggle re-mounts the editor or resets the selection — the caret would
      // come back at another model position, or the model would have no view to read at all.
      // `head` is the model's own offset (`editorSessionManager`), not the DOM selection:
      // the click is allowed to move focus, and focus is not the caret.
      const before = agent.rail?.caretBefore
      const after = agent.rail?.caretAfter
      const headsAcrossTheToggles = ['close', 'open'].flatMap((d) => (agent.rail?.[d]?.heads ?? []).map((h) => h.value))
      c.run(
        'agent panel: the caret does not move across the rail’s toggle',
        `placed at ${before?.head ?? '?'} (focus ${before?.focus ?? '?'}), after both toggles ${after?.head ?? '?'} ` +
          `(focus ${after?.focus ?? '?'}); heads seen across the traces ${JSON.stringify(headsAcrossTheToggles)}, ` +
          `selection ranges per frame ${JSON.stringify(agent.rail?.close?.ranges ?? null)}; ${avg(agent.rail?.load)} → ${avg(agent.rail?.loadAfter)}${injected}`,
        before?.head != null &&
          after?.head != null &&
          before.head === after.head &&
          headsAcrossTheToggles.every((h) => h === before.head),
      )

      // ---- The composer's bar at the rail's narrow end ------------------------
      //
      // `RAIL_WIDTH_MIN` is 220 and the default is 300, so every width in the sweep is one the
      // reader can drag to. The bar below the field holds the `+`, the hint, the session's own
      // config controls and the send button; at the narrow end the four of them did not fit, the
      // bar overflowed, and the control that went over the window's edge was the send button —
      // drawn where no pointer can reach it. These four checks are that defect, in the order a
      // reader would meet it.
      //
      // Every one of them is read at EVERY width in the sweep rather than at a chosen one: the
      // defect is a range, the fix has to hold across it, and a check that only looked at the
      // default would have been green throughout.
      const fit = agent.fit ?? {}
      const rows = (fit.widths ?? []).filter((r) => r && r.bar)
      const span = rows.length > 0 ? `${rows[0].requested}–${rows[rows.length - 1].requested}` : 'none'
      const chips = rows[0]?.row?.chips ?? []
      const where = (r) => `${r.requested}px (panel ${r.panel?.clientWidth ?? '?'})`

      // The witness, and it is a check of its own for the reason the park's witness is: "the bar
      // fits" is worth nothing on a page that drew no controls. `AgentConfigRow` renders nothing
      // when the session reports no options, and a harness that answered `session/new` with an
      // empty list would have measured a bar the product does not have — three children and no
      // overflow, green from beginning to end. FAILS IF: the config row is absent, which is what
      // an empty `configOptions` in the harness's stand-in produces.
      c.run(
        'agent composer: the bar under test is the one with the engine’s own controls',
        `${rows.length} widths read (${span}); the control row holds ${chips.length} chip(s): ` +
          `${chips.map((ch) => `${ch.text || ch.cls} ${ch.width}px`).join(', ') || 'none'}; ` +
          `the rail's width was set by ${fit.storePath?.ok ? 'the store (the drag handle’s own setter)' : `the Custom property (the store was unreachable: ${fit.storePath?.why ?? '?'})`}` +
          (fit.skipped ? `; SKIPPED: ${fit.skipped}` : '') +
          (fit.failures?.length ? `; failures: ${JSON.stringify(fit.failures.slice(0, 3))}` : ''),
        rows.length > 0 && chips.length >= 1,
      )

      // FAILS IF: the row cannot give way — the defect, and its cause. `.agent-composer-bar`'s
      // own `scrollWidth` is the engine's arithmetic on the box the panel gave it, and the row's
      // `flex-shrink` is printed beside it because a bar that overflows is one whose row was
      // never allowed to shrink or wrap.
      const overflowing = rows.filter((r) => r.bar.fits === false)
      const worst = overflowing[0] ?? null
      c.run(
        'agent composer: the bar fits its own panel at every width the rail takes',
        `${rows.length} widths ${span}: ${overflowing.length} overflowed` +
          (worst
            ? ` — ${where(worst)}: bar ${worst.bar.clientWidth}/${worst.bar.scrollWidth} ` +
              `(wrap ${worst.bar.wrap}), row ${worst.row?.width ?? '?'}px flex ${worst.row?.flex ?? '?'} ` +
              `min-width ${worst.row?.minWidth ?? '?'}, hint ${worst.hint?.width ?? '?'}px, ` +
              `chips ${JSON.stringify((worst.row?.chips ?? []).map((ch) => ch.width))}`
            : `; the row's own flex is ${rows[0]?.row?.flex ?? '?'} (min-width ${rows[0]?.row?.minWidth ?? '?'}) and ` +
              `the bar's wrap ${rows[0]?.bar?.wrap ?? '?'}`) +
          `; ${avg(fit.load)}` +
          injected,
        rows.length > 0 && overflowing.length === 0,
      )

      // FAILS IF: the send button is drawn past the window's edge — the consequence of the
      // overflow above and the one that costs the reader the ability to send at all. Both halves
      // are asserted, and neither alone is enough: a button inside the viewport whose centre the
      // engine's hit test answers with something else is a button a click does not reach, and a
      // button that is hittable but off screen cannot be seen to be aimed at.
      //
      // The real click at `RAIL_WIDTH_MIN` is the second, stronger reading, and the thing waited
      // for is the CALL the button makes: `agent_cancel_run` reaching the runtime, counted in the
      // tap on `invoke`. A press that landed anywhere else leaves that count where it was.
      const unreachable = rows.filter(
        (r) => r.action && !(r.action.insideViewport && r.action.hitIsAction),
      )
      const miss = unreachable[0] ?? null
      const clickMissed = fit.realClick !== undefined && fit.realClick?.landed !== true
      c.run(
        'agent composer: the send button stays in the viewport and under the pointer',
        `${rows.length} widths ${span}: ${unreachable.length} with the ${miss?.action?.kind ?? 'action'} button unreachable` +
          (miss
            ? ` — ${where(miss)}: box [${miss.action.box.left}, ${miss.action.box.right}] ` +
              `in ${miss.viewport.width} (centre x ${miss.action.centre.x}), ` +
              `hit test at that centre: ${JSON.stringify(miss.action.hit)} ` +
              `(is the button: ${miss.action.hitIsAction})`
            : `; at ${where(rows[0])} the ${rows[0]?.action?.kind} button is [${rows[0]?.action?.box.left}, ` +
              `${rows[0]?.action?.box.right}] with its centre hittable`) +
          `; a real click at ${fit.realClick?.width ?? '?'}px (panel ${fit.realClick?.panel ?? '?'}, ` +
          `${fit.realClick?.kind ?? '?'} button, in the viewport ${fit.realClick?.insideViewport ?? '?'}): ` +
          `the runtime was asked for something ${JSON.stringify(fit.realClick?.before ?? null)} → ` +
          `${JSON.stringify(fit.realClick?.after ?? null)}, ` +
          `${fit.realClick?.landed ? `so the press reached the button (${fit.realClick.reached})` : 'and nothing arrived'}` +
          (fit.realClick?.failure ? ` — the click itself failed: ${fit.realClick.failure}` : '') +
          `; ${avg(fit.loadAfter)}` +
          injected,
        rows.length > 0 && unreachable.length === 0 && !clickMissed,
      )

      // FAILS IF: the sentence stops being drawn against the control row it explains. The hint
      // is given the bar's free space, so its box grows with the panel — and a box that grew
      // without pinning its text would leave the sentence floating at the far end of the bar,
      // which is a change to a layout that works today. The measure is the bar's own gap: at
      // every width where the sentence is drawn at all, its right edge is 8px from the row's
      // left edge, exactly as it was before the row was allowed to give way.
      const floated = rows.filter(
        (r) =>
          (r.hintText?.width ?? 0) > 0 &&
          r.row != null &&
          Math.abs(r.row.left - r.hintText.right - 8) > 0.5,
      )
      const adrift = floated[0] ?? null
      const drawn = rows.filter((r) => (r.hintText?.width ?? 0) > 0)
      c.run(
        'agent composer: the hint stays against the control row',
        `${rows.length} widths ${span}: ${floated.length} with the sentence adrift` +
          (adrift
            ? ` — ${where(adrift)}: the sentence ends at ${adrift.hintText.right}, the row starts at ${adrift.row.left}`
            : `; drawn at ${drawn.length} of them (${drawn.length > 0 ? `${where(drawn[0])} … ${where(drawn[drawn.length - 1])}` : 'none'}), ` +
              `width ${drawn[0]?.hintText?.width ?? '?'}px … ${drawn[drawn.length - 1]?.hintText?.width ?? '?'}px`) +
          `; ${avg(fit.load)}` +
          injected,
        rows.length > 0 && floated.length === 0 && drawn.length > 0,
      )

      // FAILS IF: fitting is paid for with a stack — the row wrapping one chip per line, or the
      // hint taking a line of its own, until the composer is most of the panel. Two control rows
      // is the budget: the chips are 28px tall with a 4px gap, so a bar that fits two of them is
      // 60px, and the field keeps its own 64px minimum beside it (§5.3's 96–120px opening rung is
      // the field AND its bar, and this is the bound that keeps the promise).
      const BUDGET = 2 * 28 + 4
      const tooTall = rows.filter((r) => r.bar.height > BUDGET + 1 || (r.field?.height ?? 0) < 63)
      const stack = tooTall[0] ?? null
      c.run(
        'agent composer: fitting the panel does not turn the bar into a stack',
        `${rows.length} widths ${span}: ${tooTall.length} taller than ${BUDGET}px or with a field under 64px` +
          (stack
            ? ` — ${where(stack)}: bar ${stack.bar.height}px, field ${stack.field?.height ?? '?'}px, ` +
              `composer ${stack.composer?.height}px of a ${stack.panelHeight}px panel`
            : `; at ${where(rows[0])} the bar is ${rows[0]?.bar.height}px and the field ` +
              `${rows[0]?.field?.height}px of a ${rows[0]?.panelHeight}px panel; ` +
              `the tallest is ${Math.max(...rows.map((r) => r.bar.height))}px at ` +
              `${where(rows.find((r) => r.bar.height === Math.max(...rows.map((x) => x.bar.height))) ?? rows[0])}`) +
          `; ${avg(fit.load)}` +
          injected,
        rows.length > 0 && tooTall.length === 0,
      )
    }

    // ---- The turn's own stats: what it cost and what it took -----------------
    //
    // Row 37's elapsed half, and the token half beside it. The wire carries no duration — no
    // timestamp on the envelope and no elapsed on `run-finished` — so the clock can only be this
    // window's own stopwatch over the run it watched. What makes this a measurement rather than a
    // drawing is the comparison: the seconds the bar shows against the window the page held open
    // between the send it clicked and the frame it pushed.
    const stats = agent.elapsed ?? {}
    const drawnSeconds = (() => {
      const label = stats.after?.clock
      if (typeof label !== 'string') return null
      const hours = /(\d+)h/.exec(label)
      const minutes = /(\d+)m/.exec(label)
      const seconds = /(\d+)s/.exec(label)
      if (seconds === null) return null
      return Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60 + Number(seconds[1])
    })()
    const heldSeconds =
      stats.window === undefined || stats.window === null
        ? null
        : (stats.window.closedAt - stats.window.openedAt) / 1000
    // Two seconds of slack, and the whole of it is the run's own edges: the panel's stopwatch
    // starts when the store applies `startAgentRun` (a few milliseconds after the click this
    // phase made) and stops when it applies the frame the page pushed. A clock reading anything
    // else — the panel's mount, the last turn, a constant — would be out by the difference.
    const CLOCK_SLACK = 2
    c.run(
      'agent turn stats: the turn’s own elapsed time and its tokens are both drawn',
      stats.after === undefined
        ? `not measured${injected}`
        : `the turn was opened by a real click on send (prompts ${stats.prompts?.before ?? '?'} → ` +
          `${stats.prompts?.after ?? '?'}), ran as ${JSON.stringify(stats.runId ?? null)}; before it ` +
          `ended the bar read clock ${JSON.stringify(stats.before?.clock ?? null)} and usage ` +
          `${JSON.stringify(stats.before?.usage ?? null)} (state ${JSON.stringify(stats.before?.state ?? null)}); ` +
          `after it: clock ${JSON.stringify(stats.after?.clock ?? null)} = ${drawnSeconds}s against a ` +
          `window of ${heldSeconds === null ? '?' : Math.round(heldSeconds * 100) / 100}s, usage ` +
          `${JSON.stringify(stats.after?.usage ?? null)}, state ${JSON.stringify(stats.after?.state ?? null)}; ` +
          `the store holds ${JSON.stringify(stats.store?.state ?? null)} at sequence ${stats.store?.sequence ?? '?'}`,
      drawnSeconds !== null &&
        heldSeconds !== null &&
        stats.prompts?.after === (stats.prompts?.before ?? 0) + 1 &&
        Math.abs(drawnSeconds - heldSeconds) <= CLOCK_SLACK &&
        // The pair, as Zed draws it: the clock and the engine's counters stand together.
        typeof stats.after?.usage === 'string' &&
        stats.after.usage.trim().endsWith('tokens') &&
        // The clock is this turn's and not the one the bar was already showing: that turn was
        // ended by this phase, so the drawn seconds have to be the window's, and a stale clock
        // left over from an earlier turn reads as 0s beside a window of 1.25s.
        drawnSeconds >= 1,
    )
  }

  // The chat panel's keyboard surface and every focus indicator on the page. Split out at the
  // line budget (§13.1's 800 for a test), and along the seam the file already had: everything above
  // decides the surfaces the existing probes measure, and this decides the two this task added —
  // which share nothing with them but the collector.
  verifyKeyboard(c, results, avg)
  // The table's own subject, and the shape every split here takes: the collector arrives as an
  // argument, so `Checks` stays the one place a verdict is formed.
  verifyTable(c, results)

  return {
    passed: c.results.filter((r) => r.holds).length,
    failed: c.failed.length,
    results: c.results,
  }
}
