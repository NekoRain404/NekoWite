/**
 * The two keyboard checks this task added: the chat panel's transcript, and every focus indicator
 * the engine paints.
 *
 * Split out of `verify.mjs` at §13.1's line budget and along the seam the file already had. What
 * the split is by is the SUBJECT, not the size: everything left in `verify.mjs` reads a surface one
 * of the pre-existing probes measured, and everything here reads one of the two surfaces this task
 * opened — a second transcript in a different feature, and the focus indicator of a tab stop. The
 * collector and the load-average spelling arrive as arguments, so `Checks` stays the one place a
 * verdict is formed and `verify.mjs` stays the one place a run is reported.
 *
 * Every check names the mutation that turns it red, and each was shown red under one: the chat
 * four under `--violate chatnofocus`, and the focus checks under `--violate ringless` — which
 * suppresses the indicators the per-surface checks are about, and (with `--revert`) puts the
 * engine's ring back on them, which is the same red arriving from the other side.
 *
 * The focus checks split in two, and the split is by what each one can do to a regression:
 * seven of them read a SURFACE (a stop this task fixed, or one nothing hosts yet), and four read
 * the INSTRUMENTS — the witness, the sweep over every stop, the two repaired branches held against
 * five fixture controls, and the census, which is the one that names a stop whose ring is not this
 * app's. A surface check goes red when its surface regresses; an instrument check goes red when the
 * method that would find the NEXT surface stops being able to.
 */

export function verifyKeyboard(c, results, avg) {
// ---- The chat transcript as a keyboard surface --------------------------
//
// The same five claims the agent panel's transcript is held to, on the OTHER transcript: a
// different container, in a different feature, inside a different composer's tab order. The
// agent panel's greens are not evidence about this one and are not read as any — the probe that
// measures it is `probe-chat-scroll.mjs`, it runs on a page `--chat` prepared, and a run that
// did not ask for that page claims nothing here.
const chat = results.probes['chat-scroll']
if (chat && chat.skipped && results.chat) {
  // The run asked for the conversation and the probe produced no numbers for it. A skip is only
  // free when the run never asked; this is the failure `results.chat` exists to make visible.
  c.run(
    'chat scroll: the run asked for the conversation and nothing measured it',
    String(chat.skipped),
    false,
  )
} else if (chat && !chat.skipped) {
  const k = chat.keys ?? {}
  const t = k.tab ?? {}
  const self = k.tabOrder?.self ?? null
  const ring = t.ring ?? null
  const chatPainted = ring !== null && ring.outlineStyle !== 'none' && parseFloat(ring.outlineWidth) > 0
  // FAILS IF: the container is out of the tab order — which is what it WAS, and what WebKitGTK
  // has for a plain `div` with `overflow-y: auto`. Shown red under `--violate chatnofocus`.
  c.run(
    'chat keyboard: the transcript is a visible, walkable tab stop',
    `in the DOM the container is ${self ? `tabIndex ${self.tabIndex}` : 'absent'} ` +
      `(tab stop ${self?.i ?? '?'} of ${k.tabOrder?.total ?? '?'} in the rail, after ${k.tabOrder?.previous?.cls ?? 'nothing'}); ` +
      `a real Tab from ${t.before?.target?.cls ?? 'nowhere'} landed on ` +
      `${JSON.stringify(t.entered?.active ?? null)} — ${JSON.stringify(t.entered?.active?.role ?? null)} ` +
      `labelled ${JSON.stringify(t.entered?.active?.label ?? null)}; the engine paints ` +
      `${ring?.outlineStyle ?? '?'} ${ring?.outlineWidth ?? '?'} ${ring?.outlineColor ?? '?'} at offset ` +
      `${ring?.outlineOffset ?? '?'} (:focus-visible matches ${ring?.matchesFocusVisible ?? '?'}); ` +
      `${avg(chat.load)}`,
    self !== null && self.tabIndex >= 0 && t.entered?.onChat === true && chatPainted,
  )
  // FAILS IF: a real Tab comes back to the container — a focus trap, and the composer behind it
  // would then be unreachable by keyboard.
  c.run(
    'chat keyboard: the transcript’s tab stop is not a trap',
    `a real Tab from the focused transcript went to ${JSON.stringify(t.left?.active ?? null)} ` +
      `(still on the transcript: ${t.left?.stillOnChat ?? '?'}); ${avg(chat.load)}`,
    t.left != null && t.left.stillOnChat === false,
  )
  // FAILS IF: receiving focus scrolls the container. Read as three numbers: the offset, the row
  // the reader was on, and the container's own scroll-event count. The third is what tells a
  // held reader from a container nothing was asked of.
  const parked = k.focus?.parked ?? null
  const fBefore = k.focus?.before ?? null
  const fAfter = k.focus?.after ?? null
  c.run(
    'chat keyboard: landing on the transcript does not move the reader',
    `parked by two real wheel gestures at ${parked?.scrollTop ?? '?'} of ${parked?.max ?? '?'} ` +
      `(${parked && parked.max !== undefined ? Math.round((parked.max - parked.scrollTop) * 100) / 100 : '?'}px from the end), ` +
      `focus on ${fBefore?.focus ?? '?'} → ${fAfter?.focus ?? '?'}; scrollTop ${fBefore?.scrollTop ?? '?'} → ` +
      `${fAfter?.scrollTop ?? '?'}, the reader's row offset ${fBefore?.anchorOffset ?? '?'} → ` +
      `${fAfter?.anchorOffset ?? '?'} (row ${fAfter?.anchorId ?? '?'}), the container's own scroll events ` +
      `${fBefore?.scrollEvents ?? '?'} → ${fAfter?.scrollEvents ?? '?'}; ` +
      `wheels ${JSON.stringify(k.focus?.wheelToEnd ?? null)} / ${JSON.stringify(k.focus?.wheelBack ?? null)}; ${avg(chat.load)}`,
    parked !== null &&
      parked.scrollTop > 8 &&
      parked.max - parked.scrollTop > 8 &&
      fAfter?.onTimeline === true &&
      fAfter.scrollTop === fBefore?.scrollTop &&
      fAfter.anchorOffset === fBefore?.anchorOffset &&
      fAfter.scrollEvents === fBefore?.scrollEvents,
  )
  // FAILS IF: a focused transcript does not scroll. Both keys are read after the box has stopped
  // — WebKitGTK animates a keyboard scroll, so a fixed-frame read is a read of the easing.
  // Focus is part of the claim: on an unfocusable container a keypress on whatever else holds
  // focus can still move it, and a check that passed for that reason would be crediting the
  // engine's guess. (The keys here had never been sent to this container at all: before the
  // attribute, `use-chat-scroll`'s own comment named "a keyboard scroll" as a route the
  // container could not take.)
  const pd = k.pageDown ?? {}
  const end = k.end ?? {}
  const stepped = (pd.after?.scrollTop ?? 0) - (pd.before?.scrollTop ?? 0)
  const endGap = end.after ? end.after.max - end.after.scrollTop : null
  c.run(
    'chat keyboard: PageDown and End scroll the focused transcript',
    `PageDown: ${pd.before?.scrollTop ?? '?'} → ${pd.after?.scrollTop ?? '?'} of ${pd.after?.max ?? '?'} ` +
      `(moved ${Math.round(stepped * 100) / 100}px, settled ${pd.quiet?.settled ?? '?'} after ${pd.quiet?.frames ?? '?'} frames / ` +
      `${pd.quiet?.ms ?? '?'}ms, deltas p50 ${pd.quiet?.frameDeltaP50 ?? '?'}ms p95 ${pd.quiet?.frameDeltaP95 ?? '?'}ms max ` +
      `${pd.quiet?.frameDeltaMax ?? '?'}ms); End: ${end.before?.scrollTop ?? '?'} → ${end.after?.scrollTop ?? '?'} of ` +
      `${end.after?.max ?? '?'} (${endGap ?? '?'}px from the end, settled ${end.quiet?.settled ?? '?'} after ` +
      `${end.quiet?.frames ?? '?'} frames / ${end.quiet?.ms ?? '?'}ms); ${avg(pd.quiet?.loadBefore)} → ${avg(end.quiet?.loadAfter)}`,
    pd.quiet?.settled === true &&
      stepped > 1 &&
      pd.after?.onTimeline === true &&
      end.quiet?.settled === true &&
      end.after?.onTimeline === true &&
      endGap !== null &&
      Math.abs(endGap) <= 2,
  )
  // FAILS IF: focus in the log leaks the composer's keys into the log — the failure a new tab
  // stop is most likely to cause. Both halves are asserted, because either alone passes for the
  // wrong reason: a dead field and a dead transcript are indistinguishable if only one is read.
  const comp = chat.composer ?? {}
  c.run(
    'chat keyboard: the composer keeps its own keys',
    `focus on ${comp.focus?.cls ?? '?'} (${comp.focus?.tag ?? '?'}), PageDown+End sent there left the transcript at ` +
      `${comp.before?.scrollTop ?? '?'} → ${comp.after?.scrollTop ?? '?'} of ${comp.after?.max ?? '?'} with ` +
      `${comp.before?.scrollEvents ?? '?'} → ${comp.after?.scrollEvents ?? '?'} of its own scroll events; a character typed ` +
      `next reached the field: ${comp.field?.value ?? '?'} → ${comp.fieldAfter?.value ?? '?'} characters, focus still ` +
      `${comp.fieldAfter?.focus?.cls ?? '?'}; settled ${comp.quietBefore?.settled ?? '?'} / ${comp.quietAfter?.settled ?? '?'} ` +
      `(${comp.quietAfter?.frames ?? '?'} frames, deltas p50 ${comp.quietAfter?.frameDeltaP50 ?? '?'}ms p95 ` +
      `${comp.quietAfter?.frameDeltaP95 ?? '?'}ms); ${avg(comp.quietAfter?.loadAfter ?? chat.loadAfter)}`,
    comp.before !== null &&
      comp.after?.scrollTop === comp.before?.scrollTop &&
      comp.after?.scrollEvents === comp.before?.scrollEvents &&
      comp.focus?.cls === 'chat-textarea' &&
      comp.fieldAfter?.focus?.cls === 'chat-textarea' &&
      (comp.fieldAfter?.value ?? 0) > (comp.field?.value ?? 0),
  )
}

// ---- The focus indicator, as the engine paints it ------------------------
//
// The other half of the same defect, and the half a hand survey walks past: a tab stop a
// keyboard reader cannot SEE they are on. Every reading below is a painted one — the element is
// focused and `getComputedStyle` answers, and beside it are the pixels a screenshot diff shows
// repainting around the element's box when focus arrives. Nothing here is a stylesheet read.
//
// The run is blind if the witness did not paint: `:focus-visible` is a heuristic on the last
// input's kind, and a method that cannot see a ring reports every surface as ringless, which is
// the wrong conclusion and looks exactly like the right one.
const focus = results.probes['focus-ring']
if (focus && !focus.skipped) {
  if (focus.blind) {
    c.run(
      'focus indicator: the method can see a ring at all',
      `the witness painted no ring (${JSON.stringify(focus.witness ?? null)}), so no surface below was judged`,
      false,
    )
  } else {
    const painted = focus.witnessPixels?.painted === true
    c.run(
      'focus indicator: the witness, whose ring is not in question, is visible in pixels',
      `focus on ${focus.witness?.cls ?? '?'} painted ${focus.witness?.outlineStyle} ${focus.witness?.outlineWidth} ` +
        `${focus.witness?.outlineColor} at offset ${focus.witness?.outlineOffset}, contrast ${focus.witness?.backdropContrast ?? '?'}:1 ` +
        `against ${focus.witness?.backdrop?.from ?? '?'}; the screenshot diff shows ${focus.witnessPixels?.diff?.outside ?? '?'} pixels ` +
        `repainted outside the box and ${focus.witnessPixels?.diff?.inside ?? '?'} inside it ` +
        `(edges L ${focus.witnessPixels?.diff?.strip?.left ?? '?'} R ${focus.witnessPixels?.diff?.strip?.right ?? '?'} ` +
        `T ${focus.witnessPixels?.diff?.strip?.top ?? '?'} B ${focus.witnessPixels?.diff?.strip?.bottom ?? '?'}, ` +
        `max channel delta ${focus.witnessPixels?.diff?.outsideDelta ?? '?'}); ${avg(focus.load)}`,
      painted,
    )
  }
  // One check per surface, so a regression names the surface it is on rather than a count.
  //
  // FAILS IF: a tab stop this task owns loses its indicator — either half of it. The outline
  // must be one the engine is drawing, of at least the 2px the app's own ring is, at 3:1 or
  // better against what is behind it (the floor the standards name for a focus indicator); and
  // the pixels must show something actually repainting, because an outline the engine reports
  // and does not draw is a rule, not an indicator. Shown red under `--violate ringless`.
  // **The ring has to be this app's, and that clause is the one that can fail.** Every focusable
  // element in a WebKit page paints a ring: the user agent draws one from its own stylesheet, at
  // 5px, in its own blue — so "an indicator is painted, of at least 2px, at 3:1" is satisfied by
  // an element with no author rule at all, and a check made of those clauses alone stays green
  // after the rule it was written for is deleted. What the app's own focus language is instead is
  // one colour, the accent the witness paints, and comparing against it is what makes these
  // checks able to answer both ways. A surface that ever needs a ring of a different colour is a
  // surface whose expectation has to be declared here rather than assumed.
  const appRing = focus.witness?.outlineColor ?? null
  for (const surface of focus.surfaces ?? []) {
    const r = surface.reading ?? null
    const px = surface.pixels ?? null
    const width = parseFloat(r?.outlineWidth ?? '0')
    const contrast = r?.backdropContrast ?? r?.ownContrast ?? null
    // Three states, not two. A surface that is not on this page because the run did not ask for
    // its panel is NOT APPLICABLE and no check is run for it — the agent panel is not on a
    // `--chat` page and the chat panel is not on an `--agent` one, and a red for either would be
    // a check that can never go green in the run that can only see one of them. A surface that
    // IS supposed to be there and is not — a mount that threw, an element behind a condition
    // that no longer holds — is a red, and says which.
    const notThisPage =
      surface.present !== true &&
      (String(surface.why ?? '').includes('this run is not the agent run') ||
        String(surface.why ?? '').includes('this run did not seed a conversation'))
    if (notThisPage) {
      c.run(
        `focus indicator: ${surface.name} shows a keyboard reader where they are`,
        `not on this page — ${surface.why}; measured by the run that prepares its panel`,
        true,
      )
      continue
    }
    c.run(
      `focus indicator: ${surface.name} shows a keyboard reader where they are`,
      !surface.present
        ? `not measured — ${surface.why ?? 'absent'}`
        : `${surface.sel} (${surface.on}), reached by ${surface.entered}: ` +
          `${r?.outlineStyle} ${r?.outlineWidth} ${r?.outlineColor} at offset ${r?.outlineOffset}, ` +
          `contrast ${contrast ?? '?'}:1 against ${r?.backdrop?.from ?? '?'}; the screenshot diff repainted ` +
          `${px?.diff?.inside ?? '?'} pixels inside the box and ${px?.diff?.outside ?? '?'} outside it ` +
          `(max channel delta ${px?.diff?.insideDelta ?? 0}/${px?.diff?.outsideDelta ?? 0}), stable over ` +
          `${px?.shots ?? '?'} screenshot(s)${px?.settled === false ? ' and NEVER SETTLED' : ''}` +
          `; the ring ${r?.outlineColor === appRing ? 'is' : `is NOT the app's (${appRing ?? '?'})`}` +
          (focus.injected ? `; INJECTED (${focus.injected.mode}) ${focus.injected.what}` : ''),
      surface.present === true &&
        surface.on !== undefined &&
        r !== null &&
        r.matchesFocusVisible === true &&
        width >= 2 &&
        contrast !== null &&
        contrast >= 3 &&
        r.outlineColor === appRing &&
        px?.painted === true,
    )
  }
  // The sweep, printed rather than decided — unlike the census below, and the difference is what
  // each one covers. The sweep walks every stop on whatever page the run booted and names the ones
  // that paint nothing; its reds are not a defect count this task owns but a reading of the page,
  // and a run whose page is another feature's would be gated on that feature's markup. What this
  // check claims is what it can: that the sweep RAN, over a whole page, through a method proved
  // able to see a ring — and the two lists are in the detail for a reader to act on. Its two
  // repaired branches are gated separately, on five fixture stops (below) rather than on the
  // product, so the instrument is held even where the page is not.
  if (focus.sweep) {
    c.run(
      'focus indicator: the sweep reaches every tab stop on the page',
      `the sweep focused ${focus.sweep.total ?? '?'} tab stops through the witness's own method and found ` +
        `${focus.sweep.offenders?.length ?? '?'} that painted nothing: ` +
        `${JSON.stringify((focus.sweep.offenders ?? []).map((o) => `${o.cls || o.tag} (${o.outline})`))}; ` +
        `${focus.sweep.clipped?.length ?? '?'} whose ring layout clips away: ` +
        `${JSON.stringify((focus.sweep.clipped ?? []).map((o) => `${o.cls || o.tag} (${o.outline} at ${o.offset}, ${o.ring?.onScreen ?? '?'}% on screen)`))}; ` +
        `${focus.sweep.clean ?? '?'} painted an indicator a reader can see, ${focus.sweep.unaddressable?.length ?? 0} could not be addressed` +
        (focus.sweep.blind ? ' — AND THE SWEEP WAS BLIND' : ''),
      focus.sweep.blind !== true && (focus.sweep.total ?? 0) > 0,
    )
  }
  // ---- The sweep's two repaired branches, on stops whose verdicts are not in question -------
  //
  // A sweep nobody has watched decide anything is a sweep nobody can trust, and this file's whole
  // subject is the reading that was trusted and was wrong. Five fixture stops are mounted by the
  // probe for the length of one sweep — one of each kind the two repairs are about — and each
  // check below asserts BOTH polarities in one line: the branch fires on the stop it was written
  // for, and stays quiet on the stop that looks like it but paints. The pixel half is what makes
  // the sweep's word checkable, through the same reader every surface above was measured with.
  //
  // FAILS IF: the clip test stops firing (the `.graph-canvas` defect stops being findable), stops
  // firing on the twin that paints (the branch has gone loose and will be switched off), the
  // box-shadow test goes back to reading the declaration, or the four-frame settle is dropped and
  // a transitioned ring is read at t=0 as a control that paints nothing.
  const controls = focus.controls ?? null
  const verdict = (key) => controls?.verdicts?.[key]?.verdict ?? 'not mounted'
  const px = (key) => controls?.pixels?.[key] ?? null
  const paint = (key) => (px(key)?.painted === true ? 'repainted' : 'repainted nothing')
  if (controls) {
    c.run(
      'focus indicator: the sweep sees a ring layout clips away, and does not accuse one that paints',
      `controls mounted: ${controls.present ?? '?'} of 5; the clipped ring reads "${verdict('clipped')}" ` +
        `and ${paint('clipped')} (${px('clipped')?.diff?.inside ?? '?'} inside the box, ${px('clipped')?.diff?.outside ?? '?'} outside); ` +
        `the same ring with room around it reads "${verdict('plain')}" and ${paint('plain')} ` +
        `(${px('plain')?.diff?.inside ?? '?'} inside, ${px('plain')?.diff?.outside ?? '?'} outside)` +
        (controls.removed?.mounted === false ? '' : ' — AND THE FIXTURE IS STILL ON THE PAGE'),
      controls.present === 5 &&
        verdict('clipped') === 'clipped' &&
        px('clipped')?.painted === false &&
        verdict('plain') === 'clean' &&
        px('plain')?.painted === true,
    )
    // FAILS IF: the box-shadow branch is tightened without the settle (the fading control would
    // read as ringless), or left loose (the empty one would read as painted). The two are the same
    // repair read from either side, which is why they are asserted together.
    c.run(
      'focus indicator: the sweep judges a box-shadow by what it paints, at the end of the fade',
      `an all-zero transparent shadow reads "${verdict('shadowless')}" and ${paint('shadowless')} ` +
        `(${JSON.stringify(controls.verdicts?.shadowless?.entry?.boxShadow ?? null)}); ` +
        `a three-pixel accent shadow reads "${verdict('shadow')}" and ${paint('shadow')} ` +
        `(${JSON.stringify(controls.verdicts?.shadow?.entry?.boxShadow ?? 'clean')}); the same shadow arriving on a ` +
        `150ms transition reads "${verdict('fade')}" and ${paint('fade')}`,
      controls.present === 5 &&
        verdict('shadowless') === 'offender' &&
        px('shadowless')?.painted === false &&
        verdict('shadow') === 'clean' &&
        px('shadow')?.painted === true &&
        verdict('fade') === 'clean' &&
        px('fade')?.painted === true,
    )
  } else {
    c.run(
      'focus indicator: the sweep sees a ring layout clips away, and does not accuse one that paints',
      'the control fixture was not mounted, so neither repaired branch of the sweep was shown to fire',
      false,
    )
  }
  // ---- The enumeration's own blind spot -----------------------------------------------------
  //
  // The census is exhaustive over the stops `__nkwTabStops` returns, and the previous list of
  // offenders was called complete on that basis. It is not the whole tab order: a
  // `contenteditable` region is focusable with no attribute the selector list names, and this
  // application's editor body is one — so a ring the product does not draw on the editor would
  // never have appeared in any list this file prints. Each candidate is focused and read above;
  // the ones the engine refuses to focus are reported and not judged, and the ones it focuses are
  // held to the clause the sixteen stops were fixed for: none of the engine's ring.
  //
  // FAILS IF: a focusable element outside the enumeration paints the user agent's ring — the
  // same defect as the sixteen, on a surface no list in this repository could name. An element
  // that paints NOTHING is printed and not gated: whether a focusable region may hide its own
  // outline is a design decision (the editor body's caret is the affordance it was traded for),
  // and a gate that decides it here would be this file making that choice by accident.
  if (Array.isArray(focus.beyond)) {
    const candidates = focus.beyond
    const focusable = candidates.filter((b) => b.focusable === true)
    const onEngineRing = focusable.filter((b) => String(b.outline ?? '').startsWith('auto'))
    const ringless = focusable.filter((b) => b.paints !== true)
    c.run(
      'focus indicator: no stop the enumeration cannot see paints the engine’s ring',
      `${candidates.length} candidate(s) beside the enumeration, ${focusable.length} of them focusable: ` +
        focusable
          .map(
            (b) =>
              `${b.cls || b.tag} (${b.outline}${b.paints === true ? '' : ' — PAINTS NOTHING'}, ` +
              `${b.onScreen ?? '?'}% on screen, ${b.where?.parent ?? '?'})`,
          )
          .join('; ') +
        (candidates.length === focusable.length
          ? ''
          : `; the engine refused ${candidates.length - focusable.length} (${candidates
              .filter((b) => b.focusable !== true)
              .map((b) => b.cls || b.tag)
              .join(', ')})`) +
        (ringless.length > 0
          ? ` — ${ringless.length} of them remove the indicator outright rather than painting the wrong one`
          : ''),
      onEngineRing.length === 0,
    )
  }
  // The census, GATED — and the gate is the point of this task's second half.
  //
  // The previous run of this check asserted only that the census had run, because the stops still
  // wearing the engine's ring were in files that change could not open: a gate that can only go
  // green by editing somebody else's component is not a gate, and it said so rather than pretending
  // otherwise. All sixteen of those stops have now been given the app's ring — six beside their
  // markup, ten from the shared layer — so the claim can be made in full: **no tab stop on this
  // page paints a ring that is not this app's**. Deleting any one of those rules turns this red and
  // names the stop, its class and the chain of parents it lives under.
  //
  // FAILS IF: a rule is removed or renamed (a stop comes back on the engine's ring), a new control
  // is added without one, an author ring is written in a colour that is not the accent, or the
  // census stops accounting for a stop it walked (the sum clause — a bucket that silently drops
  // one reads exactly like a page where nothing is wrong).
  if (focus.census) {
    c.run(
      'focus indicator: every tab stop paints this app’s ring, not another one',
      `of ${focus.census.total ?? '?'} stops, ${focus.census.accent ?? '?'} paint the app's own accent; ` +
        `${focus.census.engine ?? '?'} still paint the engine's ring from the user agent's stylesheet ` +
        `(${JSON.stringify(focus.census.engineList ?? [])} — at ${JSON.stringify(focus.census.engineWhere ?? [])}); ` +
        `${focus.census.foreign ?? '?'} paint a ring of some other colour (${JSON.stringify(focus.census.foreignList ?? [])}); ` +
        `${focus.census.clippedList?.length ?? 0} paint a ring layout does not leave on screen ` +
        `(${JSON.stringify(focus.census.clippedList ?? [])}); ` +
        `${focus.census.other ?? '?'} paint no outline but something else ` +
        `(${JSON.stringify(focus.census.otherList ?? [])}); ${focus.census.notFocusVisible ?? '?'} did not answer ` +
        `:focus-visible and ${focus.census.skipped ?? '?'} had no box to read. The accent list is ` +
        `${JSON.stringify(focus.census.accentList ?? [])}`,
      (focus.census.total ?? 0) > 0 &&
        (focus.census.engine ?? -1) === 0 &&
        (focus.census.foreign ?? -1) === 0 &&
        (focus.census.classified ?? -1) === (focus.census.total ?? -2),
    )
  }
}
}
