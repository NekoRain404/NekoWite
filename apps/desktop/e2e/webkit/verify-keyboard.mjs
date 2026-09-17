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
 * four under `--violate chatnofocus`, the focus five under `--violate ringless`.
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
  // The sweep, printed rather than decided: it covers surfaces this task may not edit, and a
  // gate that can only go green by opening files outside its brief is not a gate. What it is
  // for is the report's answer to "is the list of ringless stops complete" — and it is the only
  // reading in this repository that can say whether the class regrew. The check itself claims
  // only what it can: that the sweep RAN, over a whole page, through a method that was proved
  // able to see a ring. The offender list is in the detail for a reader to act on.
  if (focus.sweep) {
    c.run(
      'focus indicator: the sweep reaches every tab stop on the page',
      `the sweep focused ${focus.sweep.total ?? '?'} tab stops through the witness's own method and found ` +
        `${focus.sweep.offenders?.length ?? '?'} that painted nothing: ` +
        `${JSON.stringify((focus.sweep.offenders ?? []).map((o) => `${o.cls || o.tag} (${o.outline})`))}; ` +
        `${focus.sweep.clean ?? '?'} painted an indicator, ${focus.sweep.unaddressable?.length ?? 0} could not be addressed` +
        (focus.sweep.blind ? ' — AND THE SWEEP WAS BLIND' : ''),
      focus.sweep.blind !== true && (focus.sweep.total ?? 0) > 0,
    )
  }
  // The census, printed for the same reason the sweep is: it covers stops this task does not own,
  // and the number it produces is a fact about the product rather than about this change. What it
  // claims is only that it ran over the page and could classify what it saw — the counts are in
  // the detail, and the two classes it separates are the two answers the sweep cannot tell apart.
  if (focus.census) {
    c.run(
      'focus indicator: the census counts whose ring each tab stop paints',
      `of ${focus.census.total ?? '?'} stops, ${focus.census.accent ?? '?'} paint the app's own accent ` +
        `(${JSON.stringify(focus.census.accentList ?? [])}) and ${focus.census.engine ?? '?'} paint the ` +
        `engine's ring from the user agent's stylesheet (${JSON.stringify(focus.census.engineList ?? [])}); ` +
        `${focus.census.other ?? '?'} paint something else (${JSON.stringify(focus.census.otherList ?? [])})`,
      (focus.census.total ?? 0) > 0,
    )
  }
}
}
