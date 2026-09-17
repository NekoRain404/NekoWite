/**
 * The transcript's find bar, in the engine that ships.
 *
 * This is the half of the search a unit test cannot hold. The DOM assertions (which rows, which
 * words, how many, the sentence for a query that matched nothing) live in
 * `AgentTimeline.test.ts` and the rule lives in `agent-conversation-search.test.ts`; what is
 * measured here is everything that only a real layout engine can answer:
 *
 *  1. **the box is reachable by the reader's own gesture** — the control is on screen inside the
 *     panel, a real pointer click opens the bar, and the bar's box is above the log rather than
 *     over it;
 *  2. **opening it does not move the reader** (§5.2 「高度变化保持可见内容锚点」) — the log gives up
 *     the bar's height, and the row the reader's eye is on has to stay where it was;
 *  3. **the count is the number of marks on the page** — the one reading that catches a counter
 *     that lies, taken from the DOM rather than from any state the probe can reach;
 *  4. **landing on a hit puts it inside the log's own box** — the container moves, and the marked
 *     element ends up on screen; a hit the reader is "taken to" and cannot see is not reached;
 *  5. **the reader's own wheel is not undone afterwards** — the landing is one instant write, so
 *     there is nothing to fight: the position the wheel leaves holds;
 *  6. **content arriving while the reader is on a hit does not move them** — the same rule the
 *     parked-reader half of `probe-agent-scroll.mjs` measures, with the search live: a rescan
 *     that scrolled to its active hit on every frame would show up here as moved frames;
 *  7. **closing takes the marks with it**, and the control goes back to unpressed;
 *  8. **the bar fits at the rail's narrowest width** — the same defect the composer's bar had
 *     (a control pushed past the panel's edge, where a pointer cannot reach it), measured on a
 *     row that has four controls in 204px of panel.
 *
 * Every reading is taken with the driver's own input — a pointer click at the control's box, real
 * keys typed into the field through the driver's element endpoint — and every verdict is read off
 * the product's own DOM afterwards. A click that lands nowhere leaves every number as it was.
 *
 * The numbers are not asserted here. `verify.mjs` decides, and the readings stand on their own —
 * the same division every other phase in this harness keeps.
 *
 * `--violate search` swallows the press on the control in the page and returns after this phase,
 * so the checks below can be shown red on the thing they claim to measure rather than only green:
 * a control that is drawn and reaches nothing is exactly the failure this audit was written for.
 */
import { JUMP, KEY, TIMELINE, load } from './agent-scroll-instrument.mjs'
import { clickSelector, pressKeys, typeInto, wheel } from './agent-scroll-driver.mjs'
import { liveTrace, summariseHeld } from './agent-scroll-readings.mjs'

/** The width the rail is left at: `RAIL_WIDTH_DEFAULT`, and the width every other phase runs at. */
const WIDTH_DEFAULT = 300

/** Three frames' worth of settle, so anything the click started has landed. */
async function settle(wd, frames = 3) {
  return wd.executeAsync(
    `window.__nkwSettle({ sel: arguments[0], frames: arguments[1] }, arguments[arguments.length - 1])`,
    [TIMELINE, frames],
  )
}

/** The find bar and everything about it, as the page has it. */
async function read(wd) {
  return wd.execute('return window.__nkwSearch()')
}

/**
 * A press that tolerates the control not being there.
 *
 * The driver's own click throws a 404 when the selector matches nothing, and every control below
 * the first one only exists while the bar is open — so a phase that threw on a missing arrow would
 * take the whole run's JSON with it, which is the shape of failure this harness exists to refuse.
 * `--violate search` is exactly that case: the control is drawn and refuses the press, the bar
 * never opens, and every reading after it has to be *reported* as a bar that is not there.
 */
async function press(wd, selector) {
  try {
    return await clickSelector(wd, selector)
  } catch (error) {
    return { ok: false, selector, why: String(error.message || error).slice(0, 120) }
  }
}

/**
 * A query that hits the transcript this probe seeded: the tool rows carry
 * `Reading note seed-<n>` and `notes/2026-09/seed-<n>.md`, so a single index names two hits on
 * one row — the header's title and the path beside it. Chosen to be narrow enough that the
 * active hit is a specific row (the check that the container moved has to know where it moved
 * from) and wide enough to be more than one hit.
 */
const QUERY = 'seed-7'

/** A query nothing in the seeded transcript carries. */
const NO_QUERY = 'zz-nothing-says-this'

export async function searchPhase(wd, run, violated) {
  const out = { key: {}, opened: {}, answer: {}, landing: {}, held: {}, after: {}, narrow: {} }

  out.before = await read(wd)
  if (out.before.toggle === null) {
    out.failure = 'the transcript is not drawing a find control'
    return out
  }
  if (out.before.bar !== null || out.before.field !== null) {
    out.failure = 'the find bar was already open before the probe opened it'
    return out
  }

  // A deliberate violation, installed after the control has been read and before it is pressed:
  // the press reaches nothing and every check below is decided against a transcript with no bar
  // in it. See `probe-agent-scroll.mjs` for the rule that a run under `--violate` stops after the
  // phase it breaks.
  if (violated === 'search') out.injected = await wd.execute('return window.__nkwViolateSearch()')

  // --- 1 and 2: the press, and what it does to the reader --------------------
  //
  // Read before the press and after it with the same instrument, because the question is a
  // delta: the log loses the bar's height, and the row the reader's eye is on must not move.
  out.click = await press(wd, '[data-timeline-control="search"]')
  out.opened.settled = await settle(wd)
  out.opened.state = await read(wd)
  out.opened.moved = movedBy(out.before.scroller, out.opened.state.scroller)
  // The bar is a row of the transcript's own column, so its bottom edge meets the log's top edge.
  // An overlaid bar would cover the line a hit is scrolled to, which is the reason it is not one.
  out.opened.aboveLog = out.opened.state.bar !== null && out.opened.state.log !== null
    ? out.opened.state.bar.bottom <= out.opened.state.log.top + 1
    : null

  // --- 3: what the count claims, against what the page paints -----------------
  out.key.typed = await typeInto(wd, '[data-conversation-search]', QUERY)
  out.answer.settled = await settle(wd, 4)
  out.answer.state = await read(wd)
  out.answer.reading = await wd.execute('return window.__nkwSearchAnswer()')

  // The reader's own key path for the arrows as well as the buttons: Enter walks forward and
  // Shift+Enter back (`thread_search_bar.rs`'s bar context, and this panel's own binding).
  out.key.enter = await pressKeys(wd, [KEY.enter])
  out.key.settled = await settle(wd, 3)
  out.key.afterEnter = await wd.execute('return window.__nkwSearchAnswer()')

  // --- 4: landing on a hit, from a reader who is nowhere near it ---------------
  //
  // The reader is taken to the END of the log first, with a real wheel, so the hit the arrow goes
  // to is off screen. Without that precondition the check passes for a control that moved
  // nothing at all: the first hit of the seeded transcript sits near the top, and a probe that
  // happened to be parked there would read "the hit is inside the log's box" before the press as
  // well as after it. The precondition is read and carries its own check.
  out.landing.park = await wheel(wd, TIMELINE, 6000)
  out.landing.parked = await settle(wd, 3)
  out.landing.before = await read(wd)
  out.landing.click = await press(wd, '[data-search-step="next"]')
  out.landing.settled = await settle(wd, 4)
  out.landing.after = await read(wd)
  out.landing.movedBy = movedBy(out.landing.before.scroller, out.landing.after.scroller)
  out.landing.activeIndexMoved = out.landing.before.activeIndex !== out.landing.after.activeIndex

  // --- 5: the reader's own scroll after it, and whether it holds ---------------
  //
  // Two claims in one gesture. The wheel is the reader's hand, so it is the reading that the
  // landing did not leave anything running that pulls the log back; and the quiet that follows is
  // the reading that nothing else writes to it either (a re-scan that moved to its active hit
  // would land here as a position that did not hold). Downwards, because the landing put the hit
  // at the log's top edge and there is always transcript below it.
  out.after.wheel = await wheel(wd, TIMELINE, 420)
  out.after.quiet = await wd.executeAsync(
    `window.__nkwQuiet({ sel: arguments[0] }, arguments[arguments.length - 1])`,
    [TIMELINE],
  )
  out.after.state = await read(wd)
  out.after.landed = movedBy(out.landing.after.scroller, out.after.state.scroller)

  // --- 6: content arriving while the reader is on a hit ------------------------
  //
  // The same instrument the parked-reader half of the probe uses, so "not moved" means the same
  // thing in both places: the row the reader's eye is on keeps its offset, frame after frame. The
  // rescan runs on every one of those frames, which is exactly what is under measurement.
  //
  // The frames go to the run this probe started at boot, which is the run every phase above has
  // been streaming into. **This reading can come back blind**, and `liveTrace` says so rather than
  // passing: the store refuses a frame whose run it has already closed (`agent-event-reducer.ts`,
  // `judgeRun` → `closed-run`), so a run in which an earlier phase ended that run leaves a trace
  // that measured an inert transcript. Starting a turn of this phase's own would remove that
  // dependency and was tried — it is the wrong trade, because closing the boot run is what makes
  // the *keyboard* phase's permission frame (turn-scoped, pushed for that same run) refuse to
  // mount its prompt. A later phase that depends on this one's run being the live one is a reason
  // not to touch it, not a reason to hide a blind reading.
  await wd.execute(`return window.__nkwWatchScroll('${TIMELINE}')`)
  const trace = await wd.executeAsync(
    `window.__nkwStream({ sel: arguments[0], jump: arguments[1], ms: 1400, every: 2, count: 18,
                          prefix: 'search-under', runId: arguments[2] }, arguments[arguments.length - 1])`,
    [TIMELINE, JUMP, run],
  )
  out.held.trace = summariseHeld(trace)
  out.held.live = liveTrace(out.held.trace)
  out.held.state = await read(wd)
  out.held.answer = await wd.execute('return window.__nkwSearchAnswer()')

  // --- 7: a query with no answer, and the way out ------------------------------
  //
  // The no-match state first, because it is one of the two answers the bar can give and the one
  // that is a sentence rather than a number. Then the close control: the marks have to go with
  // the bar, or the transcript is highlighting something the reader has no control left over.
  out.none = {}
  out.none.cleared = await press(wd, '[data-search-clear]')
  out.none.afterClear = await settle(wd, 3)
  out.none.typed = await typeInto(wd, '[data-conversation-search]', NO_QUERY)
  out.none.settled = await settle(wd, 4)
  out.none.state = await read(wd)
  out.none.close = await press(wd, '[data-search-close]')
  out.none.closed = await settle(wd, 3)
  out.none.afterClose = await read(wd)

  // --- 8: the same bar at the rail's narrowest width ---------------------------
  //
  // The composer's bar was measured here for the same reason (`fitPhase`): the row holds four
  // controls, and below the width at which they fit, the last of them is drawn past the panel's
  // own edge where a pointer cannot reach it. The width is applied through the product's own
  // setter — the one the rail's drag handle calls — and put back afterwards, so every phase after
  // this one measures the width it always did.
  await wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     import('/src/stores/appearance.ts').then(function (m) {
       const store = m.useAppearanceStore();
       window.__nkwSetRailWidth = function (w) { store.setRailWidth(w); };
       window.__nkwRailWidth = function () { return store.railWidth; };
       store.setRailWidth(220);
       requestAnimationFrame(function () { requestAnimationFrame(function () {
         done({ ok: true, railWidth: store.railWidth });
       }); });
     }, function (e) { done({ ok: false, why: String(e && e.message ? e.message : e) }); })`,
  )
  out.narrow.open = await press(wd, '[data-timeline-control="search"]')
  out.narrow.settled = await settle(wd, 3)
  out.narrow.typed = await typeInto(wd, '[data-conversation-search]', QUERY)
  out.narrow.state = await read(wd)
  // The whole panel, so "the bar fits" is not read off a bar that left the panel behind.
  out.narrow.panel = await wd.execute(
    `const panel = document.querySelector('${TIMELINE}');
     const bar = document.querySelector('[data-agent-search]');
     const close = document.querySelector('[data-search-close]');
     if (!panel || !bar || !close) return { failure: 'the find bar is not mounted' };
     const p = panel.getBoundingClientRect();
     const c = close.getBoundingClientRect();
     const hit = document.elementFromPoint(Math.round(c.left + c.width / 2), Math.round(c.top + c.height / 2));
     return {
       log: { left: Math.round(p.left), right: Math.round(p.right), width: Math.round(p.width) },
       close: { left: Math.round(c.left), right: Math.round(c.right), width: Math.round(c.width) },
       insidePanel: c.left >= p.left - 1 && c.right <= p.right + 1,
       reachable: close === hit || close.contains(hit),
       viewport: { width: innerWidth },
     }`,
  )
  await press(wd, '[data-search-close]')
  await settle(wd, 2)
  await wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     if (window.__nkwSetRailWidth) window.__nkwSetRailWidth(arguments[0]);
     requestAnimationFrame(function () { requestAnimationFrame(function () { done(true); }); });`,
    [WIDTH_DEFAULT],
  )
  out.narrow.restored = await wd.execute(
    `return window.__nkwRailWidth ? window.__nkwRailWidth() : null`,
  )

  out.loadAfter = load()
  return out
}

/**
 * Where a row on screen ended up, in the two terms the ruling is written in.
 *
 * The anchor id is the row the reader's eye is on and the offset is where that row sits relative
 * to the log's top edge; both are needed, because a row that kept its offset while a different
 * row became the topmost one is a move a reader can see, and an id that changed while the offset
 * did not is a row that grew above the fold.
 */
function movedBy(before, after) {
  if (!before || !after) return null
  return {
    anchorBefore: before.anchorId,
    anchorAfter: after.anchorId,
    anchorChanged: before.anchorId !== after.anchorId,
    offsetDelta: before.anchorOffset === null || after.anchorOffset === null
      ? null
      : Math.round((after.anchorOffset - before.anchorOffset) * 100) / 100,
    scrollTopBefore: before.scrollTop,
    scrollTopAfter: after.scrollTop,
    scrollTopDelta: Math.round((after.scrollTop - before.scrollTop) * 100) / 100,
  }
}

export { QUERY as SEARCH_QUERY, NO_QUERY as SEARCH_NO_MATCH_QUERY }
