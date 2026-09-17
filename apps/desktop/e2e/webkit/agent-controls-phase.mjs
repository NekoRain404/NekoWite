/**
 * The transcript's own control row, driven in the engine that ships.
 *
 * Split out of `probe-agent-scroll.mjs` at the line budget and along the seam the file already
 * had: that probe's phases are about where the container *is* — a reader parked, a stream
 * arriving, a route back to the end. These two are about the controls that decide it, which are
 * rows 36 and 38 of the gap audit:
 *
 *   「Copy response / scroll-to-user / scroll-to-top」 — three controls the panel did not have;
 *   「Follow-agent toggle」 — the switch the panel had behaviour for and no control over.
 *
 * Every gesture here is the driver's own — a real click at the control's centre, read in the
 * page — and every verdict is read off the product's own state afterwards: the container's
 * offset, the row the reader's eye is on, the control's `aria-pressed`, and what the clipboard
 * taps recorded. A click that lands nowhere leaves those numbers exactly as they were.
 */
import { JUMP, TIMELINE } from './agent-scroll-instrument.mjs'
import { clickSelector } from './agent-scroll-driver.mjs'
import { liveTrace, summariseFollow, summariseHeld } from './agent-scroll-readings.mjs'

/** The controls row, and the state of every control in it. */
export async function readControls(wd) {
  return wd.execute('return window.__nkwControls()')
}

/** Three frames' worth of settle, so anything the click started has landed. */
async function settle(wd, frames = 3) {
  return wd.executeAsync(
    `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: arguments[2] },
                        arguments[arguments.length - 1])`,
    [TIMELINE, JUMP, frames],
  )
}

/** The reader's eye, at one instant, with the identity of the row it is on. */
async function read(wd) {
  return wd.execute(`return window.__nkwRead('${TIMELINE}')`)
}

/**
 * The follow switch: a reader turns it off, content arrives, and nothing moves — then they turn
 * it back on and the newest arrival is followed.
 *
 * The failure each half is written against is a switch that only *looks* like one: a control
 * whose state is drawn but not wired flips its `aria-pressed` and leaves the container
 * following anyway, which is exactly the panel that fights the reader. So the trace is the
 * verdict and the switch's own state is only the witness that the press arrived.
 */
export async function followSwitchPhase(wd, run) {
  const out = { before: null, pressed: {}, held: {}, resumed: {} }

  out.before = await readControls(wd)
  // The phase needs a transcript that is following at its end: the streams below are measured
  // against a container that would otherwise pin.
  if (out.before?.present !== true || out.before.follow?.present !== true) {
    out.failure = 'the transcript has no control row, or it has no follow switch in it'
    return out
  }
  out.readBefore = await read(wd)

  // Off. A real click at the control's own centre, through the driver's pointer.
  out.off = await clickSelector(wd, '[data-timeline-control="follow"]')
  out.afterOff = await settle(wd)
  out.pressed.off = await readControls(wd)
  out.readOff = await read(wd)
  // FAILS IF: turning the switch off moved the transcript. It is a statement about what should
  // happen next, not a navigation — the reader is exactly where they were.
  out.offMovedBy = out.readBefore?.scrollTop === null || out.readOff?.scrollTop === null
    ? null
    : Math.round((out.readOff.scrollTop - out.readBefore.scrollTop) * 100) / 100

  // Content arrives while the switch is off. The trace is the same instrument the parked
  // reader's half of this probe uses, so "not moved" means the same thing in both places: the
  // reader's row keeps its offset, frame after frame.
  await wd.execute(`return window.__nkwWatchScroll('${TIMELINE}')`)
  const heldTrace = await wd.executeAsync(
    `window.__nkwStream({ sel: arguments[0], jump: arguments[1], ms: 1400, every: 2, count: 18,
                          prefix: 'switch-off', runId: arguments[2] }, arguments[arguments.length - 1])`,
    [TIMELINE, JUMP, run],
  )
  out.held.trace = summariseHeld(heldTrace)
  out.held.live = liveTrace(out.held.trace)
  out.held.controls = await readControls(wd)
  out.held.read = await read(wd)

  // On again: the reader asks for the newest row, and the switch is back where it started.
  out.on = await clickSelector(wd, '[data-timeline-control="follow"]')
  out.afterOn = await settle(wd)
  out.pressed.on = await readControls(wd)
  out.readOn = await read(wd)
  out.reachedEnd = out.afterOn !== null && out.afterOn.max - out.afterOn.scrollTop <= 2

  if (out.reachedEnd) {
    const followTrace = await wd.executeAsync(
      `window.__nkwStream({ sel: arguments[0], jump: arguments[1], ms: 1200, every: 2, count: 14,
                            prefix: 'switch-on', runId: arguments[2] }, arguments[arguments.length - 1])`,
      [TIMELINE, JUMP, run],
    )
    out.resumed.follow = summariseFollow(followTrace)
    out.resumed.follow.live = liveTrace(out.resumed.follow)
  } else {
    out.resumed.follow = null
  }
  out.after = await readControls(wd)
  return out
}

/**
 * Row 37's elapsed half: a turn the probe starts, ends and times for itself.
 *
 * The turn is opened the way a reader opens one — text in the composer and a real click on send,
 * through the driver's pointer — and closed by a `run-finished` frame the page pushes 1.25
 * seconds later. Both moments are therefore known twice, by two independent clocks: the panel's
 * own stopwatch (which is what the bar draws) and the page's `Date.now()` around the window it
 * held open. The verdict is the comparison.
 *
 * It ends whatever run the phases above left open first, and that is not tidiness: a live run
 * leaves the composer offering a *stop*, so the send this phase needs would not be there. The
 * ending frame can be refused (`closed-run`, if the run is already over) and that is expected —
 * which is why the phase judges nothing by it.
 */
export async function elapsedPhase(wd, run) {
  const out = { before: null, after: null }

  const readBar = (extra) => wd.execute(
    `const clock = document.querySelector('[data-agent-clock]');
     const usage = document.querySelector('[data-agent-usage]');
     const dropped = document.querySelector('[data-agent-dropped]');
     const action = document.querySelector('.agent-composer [data-action="send"]') ? 'send'
       : document.querySelector('.agent-composer [data-action="stop"]') ? 'stop' : null;
     return {
       clock: clock ? clock.textContent.trim() : null,
       usage: usage ? usage.textContent.trim() : null,
       state: (document.querySelector('.agent-bar-state') || {}).dataset?.state ?? null,
       action: action,
       hostRunId: window.__NEKO_AGENT__ ? window.__NEKO_AGENT__.runId() : null,
       dropped: dropped ? dropped.textContent.trim() : null,
       now: Date.now()${extra ?? ''},
     }`,
  )

  out.before = await readBar()

  // Whatever run the phases above left open is ended first, with a frame of its own id: a live
  // run would leave the composer offering a stop, and the turn this phase is here to measure is
  // one it starts itself. A refusal here is harmless and expected when the run is already over —
  // the reducer remembers closed runs and answers `closed-run` — so its outcome is not judged.
  out.ended = await wd.execute(
    `const id = window.__NEKO_AGENT__.runId();
     return id === null ? null : window.__NEKO_AGENT__.push('run-finished',
       { stopReason: 'cancelled', usage: null }, id)`,
  )
  await settle(wd, 3)
  out.afterEnding = await readBar()

  // The turn under measurement: a prompt typed into the composer and sent with the driver's own
  // click, which is the path a reader takes and the moment the panel's stopwatch starts.
  const before = await wd.execute(
    `const seen = window.__nkwInvokes || [];
     return seen.filter(function (e) { return e.cmd === 'agent_prompt'; }).length`,
  )
  out.typed = await wd.execute(
    `const field = document.querySelector('.agent-composer-field');
     if (!field) return { ok: false, why: 'no composer field' };
     field.focus();
     return { ok: true, value: field.value };`,
  )
  await wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     import('/src/features/agent/stores/agent-session.ts').then(function (m) {
       const store = m.useAgentSessionStore();
       const key = store.activeKey;
       const before = store.recordFor(key) ? store.recordFor(key).draft : null;
       if (store.recordFor(key)) store.recordFor(key).draft = 'elapsed probe';
       done({ ok: true, draftBefore: before });
     }, function (e) { done({ ok: false, why: String(e && e.message ? e.message : e) }); })`,
  )
  await settle(wd, 2)
  out.sendClick = await clickSelector(wd, '.agent-composer [data-action="send"]')
  await settle(wd, 3)
  out.prompts = {
    before: before,
    after: await wd.execute(
      `const seen = window.__nkwInvokes || [];
       return seen.filter(function (e) { return e.cmd === 'agent_prompt'; }).length`,
    ),
  }
  out.started = await readBar()
  out.runId = out.started?.hostRunId ?? null

  if (out.runId !== null) {
    // One and a quarter seconds of turn, measured by the page's own clock and ended by a frame
    // the page pushes — so the panel's stopwatch and this phase's clock are two independent
    // readings of the same interval.
    out.window = await wd.executeAsync(
      `const done = arguments[arguments.length - 1];
       const id = arguments[0];
       const openedAt = Date.now();
       setTimeout(function () {
         window.__NEKO_AGENT__.push('text-delta', { text: 'elapsed probe output. ' }, id);
         window.__NEKO_AGENT__.push('run-finished',
           { stopReason: 'end-turn', usage: { totalTokens: 9189, inputTokens: 1721, outputTokens: 6 } },
           id);
         done({ openedAt: openedAt, closedAt: Date.now() });
       }, arguments[1]);`,
      [out.runId, 1250],
    )
  }
  await settle(wd, 5)
  out.after = await readBar()
  out.store = await readStore(wd)
  out.invokes = await wd.execute(
    `return (window.__nkwInvokes || []).slice(-40)
       .filter(function (e) { return e.failed || e.cmd.indexOf('agent_') === 0; })
       .map(function (e) { return { cmd: e.cmd, ok: e.ok === true, failed: e.failed || null }; })`,
  )
  return out
}

/** What the store believes, read through the app's own module — the same route the fit phase
 *  takes to the appearance store. A frame that changed nothing has one of two shapes and the DOM
 *  cannot tell them apart: the reducer refused it (and the reason is in the record) or it never
 *  became an event at all (and the record is untouched). */
function readStore(wd) {
  return wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     import('/src/features/agent/stores/agent-session.ts').then(function (m) {
       const store = m.useAgentSessionStore();
       const record = store.recordFor(store.activeKey);
       done(record ? {
         state: record.view.state,
         sequence: record.view.sequence,
         runId: record.view.runId,
         closedRuns: record.view.closedRuns,
         lastResult: record.view.lastResult,
         failure: record.view.failure,
         draft: record.draft,
         timeline: record.view.timeline.length,
         dropped: record.dropped,
         lastDrop: record.lastDrop,
       } : { why: 'the store holds no record for the active key' });
     }, function (e) { done({ why: String(e && e.message ? e.message : e) }); })`,
  )
}

/**
 * The three controls row 36 is about, each pressed for real.
 *
 * The copy is measured through two taps installed in the page (the async clipboard and the
 * engine's own copy command) because the engine this ships on is *unmeasured* for either; what
 * the probe can say without assuming is which one ran and what text it was handed. The two
 * navigations are measured as where the reader ends up and which row their eye is on — a scroll
 * offset alone cannot tell "went to my message" from "went somewhere".
 */
export async function transcriptControlsPhase(wd) {
  const out = { controls: null, copy: {}, toTop: {}, toUser: {} }
  out.controls = await readControls(wd)
  if (out.controls?.present !== true) {
    out.failure = 'the transcript has no control row'
    return out
  }
  out.taps = await wd.execute('return window.__nkwWatchClipboard()')

  // What the answer is, read from the DOM rather than assumed: the copy is right when the
  // text it handed over is the text of the newest reply row on screen.
  const newest = await wd.execute(
    `const replies = document.querySelectorAll('${TIMELINE} .agent-row-reply');
     const rows = document.querySelectorAll('${TIMELINE} [data-row]');
     const users = document.querySelectorAll('${TIMELINE} .agent-row-user');
     return {
       reply: replies.length ? replies[replies.length - 1].textContent.trim() : null,
       replies: replies.length,
       lastRowId: rows.length ? rows[rows.length - 1].dataset.row : null,
       userRowId: users.length ? users[users.length - 1].dataset.row : null,
       users: users.length,
       anchor: window.__nkwAnchor(document.querySelector('${TIMELINE}'))
     }`,
  )
  out.transcript = newest

  // ---- copy -----------------------------------------------------------------
  if (out.controls.copy?.present) {
    out.copy.before = await read(wd)
    out.copy.click = await clickSelector(wd, '[data-timeline-control="copy"]')
    // The notice lives for a moment and the DOM is where it is read, so this reads the control
    // in the frames the notice covers rather than after it has expired.
    out.copy.settled = await settle(wd, 2)
    out.copy.controls = await readControls(wd)
    out.copy.calls = await wd.execute('return window.__nkwCopied()')
    out.copy.after = await read(wd)
    // FAILS IF: the press moved the reader. Copying is not a navigation, and a control that
    // moved the transcript while claiming to copy would be the worse of the two failures.
    out.copy.movedBy = out.copy.before?.scrollTop === null || out.copy.after?.scrollTop === null
      ? null
      : Math.round((out.copy.after.scrollTop - out.copy.before.scrollTop) * 100) / 100
  } else {
    out.copy.absent = 'no copy control is drawn'
  }

  // ---- to the top -----------------------------------------------------------
  out.toTop.click = await clickSelector(wd, '[data-timeline-control="to-top"]')
  out.toTop.settled = await settle(wd)
  out.toTop.read = await read(wd)
  out.toTop.controls = await readControls(wd)

  // ---- to the reader's own last message -------------------------------------
  out.toUser.click = await clickSelector(wd, '[data-timeline-control="to-user"]')
  out.toUser.settled = await settle(wd)
  out.toUser.read = await read(wd)
  out.toUser.controls = await readControls(wd)
  return out
}
