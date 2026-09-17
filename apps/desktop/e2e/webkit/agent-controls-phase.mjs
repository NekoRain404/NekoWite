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
