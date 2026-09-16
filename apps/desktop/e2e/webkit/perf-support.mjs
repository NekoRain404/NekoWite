/**
 * The instruments the performance probes share, and the arithmetic they are read with.
 *
 * Three things live here, and they are the three things a frame measurement needs:
 *
 *  1. **A per-frame trace** (`installSampler`, `startTrace`, `stopTrace`). One
 *     `requestAnimationFrame` loop recording the timestamp of every frame it is given, so the
 *     result is a *distribution* of frame intervals and never an average — the maintainer's
 *     rule, and the reason this file exists rather than a `fps` counter. A 60fps average with
 *     a 200 ms stall in it is what the user feels, and only the distribution shows it.
 *
 *  2. **A deterministic counter** (`mutationWindow`). Frame time on a contended machine is
 *     partly a measurement of the machine. `MutationObserver` records are not: two frames that
 *     touch the same DOM produce the same count on an idle machine and on a loaded one. So the
 *     question this file can answer *without* a quiet machine is the structural one — does the
 *     work per streamed chunk grow with the length of the conversation (the O(n²) streaming
 *     defect) or stay flat — and `mutationWindow` is how that is asked.
 *
 *  3. **The latency arithmetic** (`keystrokeLatencies`). A keystroke's cost is not the handler's
 *     duration; it is the distance from the key going down to the frame that shows the glyph.
 *     `keyboardCapture` records the three timestamps that bound it — key, DOM write, frame —
 *     and this file turns them into a distribution.
 *
 * Every timestamp is absolute `performance.now()`, taken in the page. Nothing here compares a
 * page clock against a Node clock; the two are different origins and a latency computed across
 * them would be a number about the transport.
 */

/** The sampler, installed once per page. Idempotent. */
export const INSTALL_SAMPLER = `
if (!window.__NP) {
  const NP = {}
  window.__NP = NP
  NP.frames = []
  NP.marks = []
  NP.anims = []
  NP.keys = []
  NP.writes = []
  NP.running = false
  NP.scrollSelector = null
  NP.t0 = performance.now()
  NP.mut = { records: 0, childList: 0, characterData: 0, attributes: 0, added: 0, removed: 0 }
  NP.mutWindow = null

  /** A count of DOM writes, by kind, summed over whatever happened since the last reset. */
  NP.mutReset = function () {
    NP.mutWindow = { records: 0, childList: 0, characterData: 0, attributes: 0, added: 0, removed: 0 }
  }
  NP.mutRead = function () {
    const w = NP.mutWindow
    NP.mutWindow = null
    return w
  }

  const tally = function (records, target) {
    for (const r of records) {
      target.records++
      if (r.type === 'childList') {
        target.childList++
        target.added += r.addedNodes.length
        target.removed += r.removedNodes.length
      } else if (r.type === 'characterData') target.characterData++
      else target.attributes++
    }
  }

  /**
   * Watch a subtree. Records are counted, never kept: an observer that accumulates records
   * for the length of a stream is an instrument that grows the very thing it measures.
   */
  NP.observe = function (selector) {
    if (NP.observer) NP.observer.disconnect()
    const root = selector ? document.querySelector(selector) : document.body
    if (!root) return false
    NP.observer = new MutationObserver(function (records) {
      tally(records, NP.mut)
      if (NP.mutWindow) tally(records, NP.mutWindow)
    })
    NP.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    return true
  }

  /**
   * One CSS animation starting, anywhere.
   *
   * This is the instrument for "does an entrance animation replay per chunk": a row that
   * animates in on every token produces one of these per token, and no timing is involved in
   * saying so.
   */
  document.addEventListener(
    'animationstart',
    function (e) {
      NP.anims.push({ t: performance.now(), name: e.animationName, cls: String(e.target.className || '').slice(0, 48) })
    },
    true,
  )

  /**
   * The frame trace.
   *
   * `scrollSelector` is optional and adds the container's offset to every frame, which is what
   * makes "is the scroll attached to the input" answerable: a scroll that follows the finger
   * has moved by the same amount on the frame after the input, and one that eases has not.
   */
  NP.start = function (scrollSelector) {
    NP.frames = []
    NP.marks = []
    NP.scrollSelector = scrollSelector || null
    NP.t0 = performance.now()
    NP.running = true
    let last = NP.t0
    const tick = function (now) {
      if (!NP.running) return
      const frame = { t: now, dt: Math.round((now - last) * 100) / 100 }
      if (NP.scrollSelector) {
        const el = document.querySelector(NP.scrollSelector)
        if (el) {
          frame.top = el.scrollTop
          frame.max = Math.max(0, el.scrollHeight - el.clientHeight)
        }
      }
      NP.frames.push(frame)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  NP.stop = function () {
    NP.running = false
  }
  NP.mark = function (name) {
    NP.marks.push({ t: performance.now(), name: name })
  }

  /**
   * Timestamps for the three moments a keystroke is felt at.
   *
   * `keydown` is the reader's input, the MutationObserver's callback is the editor's write
   * landing in the DOM, and the next `requestAnimationFrame` after it is the frame that can
   * show the glyph. `isTrusted` is recorded because an untrusted key event never reaches
   * ProseMirror's own handlers, and a run that silently measured synthetic events would be
   * measuring nothing.
   */
  NP.captureKeys = function (selector) {
    NP.keys = []
    NP.writes = []
    if (NP.keyHandler) document.removeEventListener('keydown', NP.keyHandler, true)
    if (NP.writeObserver) NP.writeObserver.disconnect()
    NP.keyHandler = function (e) {
      NP.keys.push({ t: performance.now(), key: e.key, trusted: e.isTrusted })
    }
    document.addEventListener('keydown', NP.keyHandler, true)
    const el = document.querySelector(selector)
    if (el) {
      NP.writeObserver = new MutationObserver(function () {
        NP.writes.push(performance.now())
      })
      NP.writeObserver.observe(el, { subtree: true, childList: true, characterData: true })
    }
    return Boolean(el)
  }
}
return true`

/**
 * The instrument source is a page script, so it is written once and executed by whichever
 * probe needs it. `install` is cheap and idempotent; every probe calls it rather than assuming
 * an order, because the probes share one page and the order they run in is the runner's.
 */
export function install(wd) {
  return wd.execute(INSTALL_SAMPLER)
}

export function startTrace(wd, scrollSelector = null) {
  return wd.execute(
    `window.__NP.start(${scrollSelector === null ? 'null' : JSON.stringify(scrollSelector)}); return true`,
  )
}

export function stopTrace(wd) {
  return wd.execute(`window.__NP.stop(); return true`)
}

export function mark(wd, name) {
  return wd.execute(`window.__NP.mark(${JSON.stringify(name)}); return true`)
}

/** The whole instrument's reading, and the marks that say where in the interaction it was. */
export function read(wd) {
  return wd.execute(`return { frames: window.__NP.frames, marks: window.__NP.marks,
    anims: window.__NP.anims, mut: window.__NP.mut, keys: window.__NP.keys, writes: window.__NP.writes }`)
}

export function mutationWindow(wd, reset) {
  return wd.execute(reset ? `window.__NP.mutReset(); return true` : `return window.__NP.mutRead()`)
}

/**
 * Two frames of settling, so a DOM write that Vue scheduled has landed before a count is read.
 * A `nextTick` promise would resolve before the browser has painted it.
 */
export const TWO_FRAMES = `new Promise(function (done) {
  requestAnimationFrame(function () { requestAnimationFrame(function () { done(true) }) })
})`

/**
 * Frame intervals, as a distribution.
 *
 * `budget` is the machine's own frame budget — 16.7 ms at 60 Hz, 8.3 at 120 — so "over budget"
 * means what it says on this display and not against a number chosen for the report.
 *
 * `slow` is the same count expressed against the run's own median, and it is the one to read
 * when the machine is loaded: if every frame is uniformly slower because the CPU is shared, the
 * median moves with them and the ratio does not. The two are reported together, and a claim
 * about the product is only ever made from the one that survives.
 */
export function distribution(frames, budget) {
  const withDt = frames.filter((f) => typeof f.dt === 'number' && f.t !== undefined)
  // The first frame's dt is measured from the trace's own start, not from a previous frame.
  const dts = withDt.slice(1).map((f) => f.dt)
  if (!dts.length) return null
  const sorted = [...dts].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  const median = at(0.5)
  const over = dts.filter((dt) => dt > budget).length
  const slow = dts.filter((dt) => dt > Math.max(budget, median * 4)).length
  return {
    frames: dts.length,
    budget,
    median: round(median),
    p75: round(at(0.75)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]),
    overBudget: over,
    overBudgetPct: round((over / dts.length) * 100),
    overMedian4x: slow,
    worst: sorted.slice(-8).map(round).reverse(),
  }
}

/**
 * Where the worst frames were, in the interaction's own words.
 *
 * A distribution says a 200 ms frame happened; the marks say whether it was the panel opening,
 * the first chunk of a stream, or the moment the reader started typing. That distinction is the
 * whole difference between a number and a finding, so it is computed rather than left to be
 * guessed from the raw trace.
 */
export function worstByMark(frames, marks, budget, limit = 6) {
  const ordered = [...marks].sort((a, b) => a.t - b.t)
  const label = (t) => {
    let name = 'before any mark'
    for (const m of ordered) {
      if (m.t <= t) name = m.name
      else break
    }
    return name
  }
  const over = frames
    .slice(1)
    .filter((f) => f.dt > budget)
    .sort((a, b) => b.dt - a.dt)
    .slice(0, limit)
  const byPhase = {}
  for (const f of frames.slice(1)) {
    const phase = label(f.t)
    const entry = (byPhase[phase] ??= { frames: 0, over: 0, worst: 0 })
    entry.frames++
    if (f.dt > budget) entry.over++
    if (f.dt > entry.worst) entry.worst = round(f.dt)
  }
  return {
    worst: over.map((f) => ({ dt: round(f.dt), at: label(f.t), agoMs: Math.round(f.t - ordered[0]?.t) })),
    byPhase,
  }
}

/**
 * Keystroke to glyph, for every keystroke in the window.
 *
 * One key's chain is: `keydown` -> the first DOM write after it -> the first frame at or after
 * that write. The middle link is what makes this a measurement of the editor rather than of the
 * event loop: a key that ProseMirror handles and writes is one latency, and a key that a
 * keymap swallows is a different one — and only the writes are counted, so a swallowed key is
 * visible as a keystroke with no latency rather than as a fast one.
 */
export function keystrokeLatencies(keys, writes, frames) {
  const frameTimes = frames.map((f) => f.t)
  const out = []
  for (const k of keys) {
    const write = writes.find((w) => w >= k.t)
    if (write === undefined) {
      out.push({ key: k.key, trusted: k.trusted, latency: null, why: 'no-dom-write' })
      continue
    }
    const frame = frameTimes.find((t) => t >= write)
    if (frame === undefined) {
      out.push({ key: k.key, trusted: k.trusted, latency: null, why: 'no-frame-after-write' })
      continue
    }
    out.push({
      key: k.key,
      trusted: k.trusted,
      latency: round(frame - k.t),
      handlerToWrite: round(write - k.t),
      writeToFrame: round(frame - write),
    })
  }
  return out
}

/** The latency numbers as a distribution, with the unmeasurable keys reported as themselves. */
export function latencySummary(latencies, budget) {
  const measured = latencies.filter((l) => l.latency !== null)
  const values = measured.map((l) => l.latency)
  if (!values.length) {
    return { measured: 0, unmeasured: latencies.length, why: [...new Set(latencies.map((l) => l.why))] }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    measured: measured.length,
    unmeasured: latencies.length - measured.length,
    untrusted: measured.filter((l) => l.trusted === false).length,
    min: round(sorted[0]),
    median: round(at(0.5)),
    p90: round(at(0.9)),
    max: round(sorted[sorted.length - 1]),
    overOneFrame: values.filter((v) => v > budget).length,
    overTwoFrames: values.filter((v) => v > budget * 2).length,
    worst: sorted.slice(-6).map(round).reverse(),
    samples: measured.slice(0, 12).map((l) => ({ key: l.key, ms: l.latency })),
  }
}

export function round(value) {
  return typeof value === 'number' ? Math.round(value * 100) / 100 : value
}

export function stats(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(at(0.5)),
    p90: round(at(0.9)),
    max: round(sorted[sorted.length - 1]),
  }
}
