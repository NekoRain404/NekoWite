/**
 * What a frame trace means: the arithmetic that turns 80 samples into a reading.
 *
 * Pure functions over plain objects, and they are a file of their own because that is the whole
 * of what they do — no driver, no page, no probe. Two rules about them:
 *
 *  - **The verdict is a distribution, never an average.** `frameStats` reports how many frames a
 *    trace managed to take and how far apart they were; `distinct` reports which values held for
 *    how many frames. An average frame time hides a trace that took three samples, and an
 *    average offset hides a reader who was moved once and put back.
 *  - **A trace that could see nothing says so.** `liveTrace` is the guard `agent-panel.spec.ts`
 *    learned the hard way: `scrollTop === endOffset` passes at `0 === 0` on a transcript that is
 *    inert, so every verdict here is conditional on the evidence that content arrived, that the
 *    reader was really suspended, and that frames were sampled where it mattered.
 */
/* ---------------------------------------------------------------------------
 * Frames, read as distributions
 * ------------------------------------------------------------------------- */

/** How fast the trace ran: the numbers that say whether it could see anything at all. */
export function frameStats(frames) {
  const deltas = frames.slice(1).map((f) => f.dt)
  const sorted = [...deltas].sort((a, b) => a - b)
  const at = (q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
  return {
    frames: frames.length,
    firstT: frames[0]?.t ?? null,
    lastT: frames.at(-1)?.t ?? null,
    frameDeltaP50: at(0.5),
    frameDeltaP95: at(0.95),
    frameDeltaMax: sorted.at(-1) ?? null,
  }
}

/** Distinct values, each with the number of frames that held it. */
export function distinct(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].map(([value, frames]) => ({ value, frames }))
}

/**
 * One "held" trace: the reader parked away from the end while content arrives underneath them.
 *
 * The reading that decides the rule is the anchor's offset relative to the container: the row
 * the reader was looking at must stay where it was on screen. `movedFrames` counts the frames
 * where it did not, with a one-pixel tolerance — WebKitGTK lays out at whole pixels here, and
 * a sub-pixel difference is not a move a reader can see.
 *
 * The baseline is the FIRST sampled frame, not the offset that was requested: the container
 * clamps, and a baseline it never reached would report every frame as a move. The first two
 * frames are arrival-free by construction (`every` is 2), so the baseline predates the stream.
 */
export function summariseHeld(trace) {
  const frames = trace.frames ?? []
  const baseline = frames[0]?.anchorOffset ?? null
  const offsets = frames.map((f) => f.anchorOffset).filter((v) => v !== null)
  const moved = frames.filter((f) => baseline === null || f.anchorOffset === null || Math.abs(f.anchorOffset - baseline) > 1)
  return {
    ...frameStats(frames),
    baseline,
    offsetRange: { min: offsets.length ? Math.min(...offsets) : null, max: offsets.length ? Math.max(...offsets) : null },
    movedFrames: moved.length,
    movedDetail: moved.slice(0, 12).map((f) => `t${f.t} row ${f.anchorId} offset ${f.anchorOffset} scrollTop ${f.scrollTop}`),
    scrollTop: distinct(frames.map((f) => f.scrollTop)),
    anchorIds: distinct(frames.map((f) => f.anchorId)),
    arrivals: {
      pushed: trace.pushed,
      sent: [trace.sent0, trace.sent1],
      rows: [trace.rows0, trace.rows1],
      text: [trace.text0, trace.text1],
    },
    scrollEvents: trace.scrollEvents,
    // `same`/`rail`/`hidden` are in the trace line because they answer the one question the
    // offsets cannot: whether this container is still the one on screen. A replaced element
    // reads as 0/0 from the replacement onwards, and a line that says so names the cause.
    same: distinct(frames.map((f) => f.same)),
    trace: frames.map((f) =>
      `t${f.t} off${f.anchorOffset} top${f.scrollTop}/${f.max} rows${f.rows}` +
      (f.same === false || f.rail === false ? ` SAME${f.same} rail${f.rail}` : '')),
  }
}

/**
 * One "follow" trace: the reader is at the end and the container must stay there.
 *
 * `gap` is how far the container is from its own end on each frame — the rule's question asked
 * per frame rather than once at the end of the stream. A trace whose container never moved is
 * reported as such: following means the offset grew with the content, and a container that
 * stayed put while rows arrived was not following anything.
 */
export function summariseFollow(trace) {
  const frames = trace.frames ?? []
  const gaps = frames.map((f) => Math.round((f.max - f.scrollTop) * 100) / 100)
  const first = frames[0] ?? null
  const last = frames.at(-1) ?? null
  return {
    ...frameStats(frames),
    gap: { min: gaps.length ? Math.min(...gaps) : null, max: gaps.length ? Math.max(...gaps) : null },
    atEndFrames: gaps.filter((g) => Math.abs(g) <= 2).length,
    awayFrames: gaps.filter((g) => Math.abs(g) > 2).length,
    scrollTop: { first: first?.scrollTop ?? null, last: last?.scrollTop ?? null, grew: (last?.scrollTop ?? 0) > (first?.scrollTop ?? 0) },
    arrivals: {
      pushed: trace.pushed,
      sent: [trace.sent0, trace.sent1],
      rows: [trace.rows0, trace.rows1],
      text: [trace.text0, trace.text1],
    },
    trace: frames.map((f) => `t${f.t} top${f.scrollTop}/${f.max} rows${f.rows}`),
  }
}

/**
 * Whether a trace had anything to measure.
 *
 * This is the guard the harness's `agent-panel.spec.ts` learned the hard way: an assertion
 * about a container that never scrolled and never grew passes for free, and `0 === 0` is how a
 * completely inert transcript looked like a satisfied precondition. Frames sent, rows added,
 * text added, and frames sampled — all four, or the trace concludes nothing.
 */
export function liveTrace(summary) {
  const { pushed, sent, rows, text } = summary.arrivals ?? {}
  const sentGrew = Array.isArray(sent) && sent[1] > sent[0]
  const contentGrew = (rows?.[1] ?? 0) > (rows?.[0] ?? 0) || (text?.[1] ?? 0) > (text?.[0] ?? 0)
  return {
    holds: sentGrew && contentGrew && (summary.frames ?? 0) >= 8,
    sentGrew,
    contentGrew,
    frames: summary.frames ?? 0,
    why:
      `${pushed} frame(s) pushed (host ${JSON.stringify(sent)}), ` +
      `rows ${JSON.stringify(rows)}, text ${JSON.stringify(text)}, ${summary.frames ?? 0} frames sampled`,
  }
}

