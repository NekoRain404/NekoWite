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
  } else if (results.agent && !agent) {
    c.run('agent scroll: the run asked for the panel and nothing measured it', 'no agent-scroll result', false)
  } else if (agent?.skipped) {
    c.run(
      'agent scroll: the run asked for the panel and the probe did not measure',
      `--agent was passed; the probe reported: ${agent.skipped}`,
      false,
    )
  } else if (agent) {
    const avg = (l) => (l ? `load ${l.one}/${l.five}/${l.fifteen}` : 'load unknown')
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
    }
  }

  return {
    passed: c.results.filter((r) => r.holds).length,
    failed: c.failed.length,
    results: c.results,
  }
}
