/**
 * One entry from `e2e/motion-surfaces.spec.ts`, on the surface whose arrival is
 * the reason the engine version was chosen at all.
 *
 * `tokens.css` documents the installed WebKitGTK (2.52.6) because the
 * surface-arrival curve is a `linear()` sample set and `linear()` landed in
 * 2.44. That file names the engine the design depends on and, until this
 * harness, the engine had never run it. So the entry picked here is the heading
 * dropdown — the one surface whose own stylesheet says out loud which property
 * takes the spring and why:
 *
 *   `.toolbar-menu-enter-active`
 *     transition: opacity var(--app-motion) var(--app-ease),
 *                 transform var(--app-motion) var(--app-ease-surface);
 *
 * The reading that matters is not "the CSS parsed" but the one the spec's own
 * instrument takes: a frame-by-frame trace of the surface while it arrives and
 * while it leaves, with the scale read off the transform MATRIX — because the
 * whole question is whether it goes above 1.
 *
 * ---- Why this file measures the curve twice, and why it has to
 *
 * The trace above is the behavioural half and for a long time it was the only
 * half. It is also a *sample* of a 300ms animation taken by `requestAnimationFrame`,
 * and that makes its verdict a function of the machine as much as of the design:
 * the overshoot is 0.02 of scale over 8.35% of the curve, so the stretch that
 * rounds above 1 is about 120ms of a 300ms timeline — and on a loaded box the
 * main thread can miss that stretch entirely. One run of this file did exactly
 * that: its own trace reads `t22 s0.98`, `t51 s0.9857`, then a 209ms gap to
 * `t260 s1`, with the whole excursion inside the gap. The run reported "scale
 * min 0.98 max 1" and was read as the curve having been replaced by a monotone
 * ease, which is the one thing it was not: the same run's `timingFunctions`
 * reads `cubic-bezier(0.22, 1, 0.36, 1), linear(0 0%, …)` — two transitions,
 * the fade on the bezier and the movement on the spring, which is what the
 * stylesheet asks for. A trace that could not see the excursion is not evidence
 * that there was none, and a check that cannot tell the two apart is not a gate.
 *
 * So the curve is read a second time, three ways, and only the first is
 * sampled:
 *
 *   1. `applied` — what the cascade actually resolves for the `transform`
 *      property on an element wearing the real arrival classes. Read through a
 *      throwaway node that wears the same classes and the component's own scope
 *      attribute, so it is the menu's own rule and the menu's own cascade that
 *      answer. No transition has to run and no frame has to land: this is a
 *      question about CSS, and it is answered the same way on a loaded box as
 *      on an idle one. It is what catches "a monotone ease won at the point of
 *      use" — the regression the whole harness exists for.
 *   2. `scrubbed` — the engine's own computed scale at the curve's *peak*,
 *      by pausing the live transition and holding it there. Self-validating:
 *      it reads the scale at 0 as well, and refuses the reading if the two are
 *      equal (an engine that does not reflect `currentTime` would otherwise
 *      answer with whatever frame it was on and look like a result).
 *   3. the frame trace, exactly as before.
 *
 * The trace half is not weakened by this; it is *read* against the window it
 * could have observed. `summarise` computes, from the applied curve's own
 * stops, the stretch of the timeline that would have rounded above 1, and says
 * whether any sampled frame fell inside it. A trace that missed the window
 * without a stall is a curve that does not overshoot and still fails; a trace
 * that missed it *because* of a stall defers to (1) and (2) and says so.
 */
import { clickByText } from './probe-support.mjs'
import { until } from './webdriver.mjs'

const SURFACE = '.toolbar-menu'
/** The arrival classes the menu's own stylesheet hands its movement to. */
const ARRIVAL_CLASSES = 'toolbar-menu toolbar-menu-enter-active'
/** The property whose value is the whole question. */
const MOVEMENT = 'transform'

export const motionProbe = {
  name: 'motion-surface',
  async run(wd) {
    const support = await wd.execute(
      `const value = getComputedStyle(document.documentElement)
         .getPropertyValue('--app-ease-surface').trim()
       return {
         supportsLinear: CSS.supports('transition-timing-function', 'linear(0, 1)'),
         supportsAnimationLinear: CSS.supports('animation-timing-function', 'linear(0, 1)'),
         resolvedSurfaceEase: value.slice(0, 160),
         isSpring: value.startsWith('linear('),
         reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
       }`,
    )

    // Before anything is clicked: what the menu's arrival rule resolves to.
    const applied = await readApplied(wd)
    const movement = applied.transitions?.find((t) => t.property === MOVEMENT) ?? null
    const movementStops = springStops(movement?.easing ?? '')
    const peak = movementStops ? movementStops.reduce((a, b) => (b.value > a.value ? b : a)) : null
    const resolved = {
      transitionProperty: applied.transitionProperty ?? null,
      movementEasing: movement?.easing ?? null,
      movementDuration: movement?.duration ?? null,
      fadeEasing: applied.transitions?.find((t) => t.property === 'opacity')?.easing ?? null,
      // The movement is on the spring **and on the same curve the token names**,
      // read off the element rather than off `documentElement`. A fallback
      // bezier or the state-change curve here is the regression this whole
      // harness exists for, and this is the reading that cannot miss it.
      //
      // Compared stop by stop and not as text: the engine re-serialises what it
      // computes (`0.0000` comes back as `0`), so a string equality would report
      // the correct curve as the wrong one — which is the same defect one layer
      // down, a check that answers about the spelling rather than the value.
      movementIsSpring:
        movementStops !== null &&
        sameCurve(movement.easing, applied.easeSurface) &&
        !/bezier/.test(movement.easing),
      movementPeak: peak?.value ?? null,
      peakAtFraction: peak ? peak.at / 100 : null,
      error: applied.error ?? null,
    }

    // A sampler installed BEFORE the click, because frame 1 is the one that says
    // the arrival started rather than that it finished. It is installed and
    // started, never awaited: WebDriver classic runs one command at a time, so
    // an `executeAsync` that waits for the trace would block the click that
    // causes it.
    await wd.execute(
      `window.__frames = [];
       window.__done = false;
       window.__sample = function (sel, ms) {
         const t0 = performance.now();
         let last = t0;
         const tick = (now) => {
           const el = document.querySelector(sel);
           const frame = { t: Math.round(now - t0), dt: Math.round((now - last) * 10) / 10 };
           last = now;
           if (el) {
             const cs = getComputedStyle(el);
             const r = el.getBoundingClientRect();
             frame.display = cs.display;
             frame.opacity = Math.round(Number(cs.opacity) * 1000) / 1000;
             frame.pointerEvents = cs.pointerEvents;
             frame.timing = cs.transitionTimingFunction;
             // Kept alongside the timings so the two lists can be read
             // index-aligned — the fade takes the bezier and the movement takes
             // the spring, and which is which is the first item of the question.
             frame.properties = cs.transitionProperty;
             // Read off the matrix rather than off the transform string: the
             // whole question is whether it goes ABOVE 1, and a matrix says that
             // in one number (m.a is the x scale).
             const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
             frame.scaleX = Math.round(m.a * 10000) / 10000;
             frame.rendered = cs.display !== 'none' && r.width > 0 && r.height > 0;
           } else {
             frame.rendered = false;
           }
           window.__frames.push(frame);
           if (now - t0 < ms) requestAnimationFrame(tick);
           else window.__done = true;
         };
         requestAnimationFrame(tick);
       };
       return true`,
    )

    await clickByText(wd, '.toolbar-menu-wrap .toolbar-btn', '', 0)
    await wd.execute(`window.__sample('${SURFACE}', 1200); return true`)
    const arrival = await collect(wd, 'the arrival trace')

    // The exit, which is the half the spec asserts a surface must have.
    await wd.execute(
      `window.__frames = []; window.__done = false; window.__sample('${SURFACE}', 1200); return true`,
    )
    await clickByText(wd, '.toolbar-menu-wrap .toolbar-btn', '', 0)
    const exit = await collect(wd, 'the exit trace')

    // Held at the peak, on a fresh arrival, with the menu left closed.
    const scrubbed = await samplePeak(wd, applied)

    return {
      support,
      applied: resolved,
      scrubbed,
      arrival: summarise(arrival, resolved, scrubbed),
      exit: summarise(exit, null, null).exitOnly,
    }
  },
}

/**
 * What the menu's own arrival rule resolves to, for the property that moves.
 *
 * The element is a throwaway that wears the real classes and the real scope
 * attribute, is `display: none` so it is never painted, and never transitions —
 * it is inserted with its classes already on, so there is no state change for
 * one to run from. That is the point: this reading does not need a transition
 * to be in flight, so it cannot be missed by a stalled main thread.
 *
 * The two computed lists are split on commas OUTSIDE parentheses, because the
 * values being split are `cubic-bezier(0.22, 1, 0.36, 1)` and `linear(0 0%, …)`
 * and a plain `split(',')` turns one curve into five. They are then read
 * index-aligned against `transition-property`, which is how "the movement takes
 * the spring and the fade does not" becomes a fact about this element rather
 * than a claim about the stylesheet.
 */
function readApplied(wd) {
  return wd.execute(
    `const wrap = document.querySelector('.toolbar-menu-wrap')
     if (!wrap) return { error: 'no .toolbar-menu-wrap to take a scope attribute from' }
     const scope = Array.from(wrap.attributes).map((a) => a.name).filter((n) => n.indexOf('data-v-') === 0)
     const el = document.createElement('div')
     el.className = '${ARRIVAL_CLASSES}'
     for (const name of scope) el.setAttribute(name, '')
     el.style.display = 'none'
     document.body.appendChild(el)
     const cs = getComputedStyle(el)
     const root = getComputedStyle(document.documentElement)
     const split = (value) => {
       const out = []
       let depth = 0
       let cur = ''
       for (const ch of value) {
         if (ch === '(') depth += 1
         else if (ch === ')') depth -= 1
         if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else { cur += ch }
       }
       if (cur.trim()) out.push(cur.trim())
       return out
     }
     const properties = split(cs.transitionProperty)
     const eases = split(cs.transitionTimingFunction)
     const durations = split(cs.transitionDuration)
     const result = {
       scopeAttribute: scope[0] || null,
       transitionProperty: cs.transitionProperty,
       transitionTimingFunction: cs.transitionTimingFunction,
       transitions: properties.map((property, i) => ({
         property: property,
         easing: eases[i] === undefined ? null : eases[i],
         duration: durations[i] === undefined ? null : durations[i]
       })),
       easeSurface: root.getPropertyValue('--app-ease-surface').trim(),
       motionRung: root.getPropertyValue('--app-motion').trim()
     }
     document.body.removeChild(el)
     return result`,
  )
}

/**
 * The engine's own scale at the curve's peak, held there on purpose.
 *
 * This is the reading the frame trace wants and cannot guarantee: one sample at
 * a chosen point on the timeline, taken through the same cascade and the same
 * matrix the trace reads, with the machine's load taken out of it. The
 * transition is paused, `currentTime` is moved to the peak, the matrix is read,
 * and it is put back where it was — a flight recorder, not a destination.
 *
 * It refuses its own reading when the engine does not reflect `currentTime`
 * (two different times answering with the same scale), because a scrub that
 * silently does nothing would otherwise report whatever frame it was on and
 * look exactly like an answer. Every refusal is a reason string, and a refusal
 * is not a failure — `applied` is the half that decides.
 */
async function samplePeak(wd, applied) {
  const stops = springStops(applied?.easeSurface ?? '')
  if (!stops) return { caught: false, why: 'the resolved token is not a linear() sample set' }
  const peak = stops.reduce((a, b) => (b.value > a.value ? b : a))
  if (peak.value <= 1) return { caught: false, why: 'the resolved curve never exceeds 1' }
  const at = peak.at / 100

  // Installed BEFORE the click and run from inside the page, for the reason the
  // sampler above is: a WebDriver round trip takes longer than the 300ms the
  // transition lives for, so a client that clicks and then asks is asking about
  // a transition that has already finished. (That is not a guess — the first
  // version of this did exactly that and came back `no transform transition was
  // in flight` on every attempt, with `saw: []`.) In the page, the first frame
  // after the insert is 20ms away and the transition is 300ms long.
  await wd.execute(
    `window.__scrub = null;
     window.__scrubDone = false;
     const deadline = performance.now() + 2000;
     const tick = () => {
       const el = document.querySelector('${SURFACE}');
       if (el && el.getAnimations) {
         const running = el.getAnimations().filter((a) => a.transitionProperty === '${MOVEMENT}');
         if (running.length) {
           const t = running[0];
           const timing = t.effect.getComputedTiming();
           const was = t.currentTime;
           const read = () => {
             const cs = getComputedStyle(el);
             const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
             return Math.round(m.a * 1000000) / 1000000;
           };
           t.pause();
           t.currentTime = 0;
           const atStart = read();
           t.currentTime = timing.duration * ${at};
           const atPeak = read();
           // Put it back where it was: this is a reading, not a destination.
           t.currentTime = was && was < timing.duration ? was : 0;
           t.play();
           window.__scrub = {
             caught: atStart !== atPeak,
             why: atStart === atPeak ? 'currentTime is not reflected in the computed style' : null,
             atStart: atStart, atPeak: atPeak,
             duration: timing.duration, at: timing.duration * ${at}
           };
           window.__scrubDone = true;
           return;
         }
       }
       if (performance.now() > deadline) {
         window.__scrub = { caught: false, why: 'no ${MOVEMENT} transition was ever in flight' };
         window.__scrubDone = true;
         return;
       }
       requestAnimationFrame(tick);
     };
     requestAnimationFrame(tick);
     return true`,
  )
  await clickByText(wd, '.toolbar-menu-wrap .toolbar-btn', '', 0)
  const reading = await until(
    () => wd.execute('return window.__scrubDone === true ? window.__scrub : null'),
    { timeout: 10_000, what: 'the peak scrub' },
  )
  // Closed again, and left that way: the probes after this one expect a page
  // with no menu on it, which is where the two traces above already left it.
  await clickByText(wd, '.toolbar-menu-wrap .toolbar-btn', '', 0)
  return reading ?? { caught: false, why: 'the scrub never reported' }
}

/**
 * A computed `transition-duration` in milliseconds.
 *
 * The engine serialises `300ms` as `0.3s`, and the window arithmetic below is
 * in milliseconds like every `performance.now()` in this file. `parseFloat`
 * alone reads that as 0.3 and puts the excursion a hundredth of the way along
 * a timeline it is a third of the way along — a hundred-fold error that only
 * shows up when the trace is blind, which is to say only on the runs this
 * whole path exists for. It was found by replaying a recorded one.
 */
function durationMs(value) {
  const text = String(value ?? '').trim()
  const n = Number.parseFloat(text)
  if (!Number.isFinite(n)) return null
  return text.endsWith('ms') ? n : n * 1000
}

/** The stops of a `linear()` easing, in order, with their positions. */
export function springStops(easing) {
  const body = /linear\(([\s\S]*)\)\s*$/.exec(easing.trim())
  if (!body) return null
  const stops = [...body[1].matchAll(/(-?[\d.]+)\s+([\d.]+)%/g)].map(([, value, at]) => ({
    value: Number(value),
    at: Number(at),
  }))
  return stops.length >= 2 ? stops : null
}

/**
 * Two `linear()` easings, compared as curves rather than as strings.
 *
 * The token is authored `0.0000 0%` and the engine computes `0 0%`; the same
 * curve, two spellings. Anything that compares the text would call the applied
 * curve wrong, so the stops are parsed out of both and matched on value and
 * position. A bezier on either side has no stops and is not equal to anything.
 *
 * Exported because the dialog probe asks the same question of a different
 * surface, and answering it a second way is how two readings of one token start
 * disagreeing.
 */
export function sameCurve(a, b) {
  const left = springStops(a ?? '')
  const right = springStops(b ?? '')
  if (!left || !right || left.length !== right.length) return false
  return left.every(
    (stop, i) =>
      Math.abs(stop.value - right[i].value) < 1e-6 && Math.abs(stop.at - right[i].at) < 1e-6,
  )
}

/**
 * Where the curve crosses a value, by linear interpolation between the stops
 * that bracket it — exact for `linear()`, which is piecewise linear by
 * definition. The first crossing on the way up, and the last on the way down,
 * so a curve that crossed more than once would report the whole of it.
 */
function crossings(stops, threshold) {
  const hits = []
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    const here = a.value - threshold
    const there = b.value - threshold
    if (here === 0 || (here < 0) !== (there < 0)) {
      const span = b.value - a.value
      const fraction = span === 0 ? 0 : (threshold - a.value) / span
      hits.push(a.at + fraction * (b.at - a.at))
    }
  }
  return hits.length ? { from: Math.min(...hits), to: Math.max(...hits) } : null
}

function collect(wd, what) {
  return until(() => wd.execute('return window.__done === true'), { timeout: 10_000, what }).then(
    () => wd.execute('return window.__frames'),
  )
}

/**
 * The two assertions `motion-surfaces.spec.ts` makes, computed here with the
 * same arithmetic the spec uses rather than restated — `fadedOut` is "a frame
 * part-way out that a LATER frame is lower than", which is what tells a
 * departure from a cut.
 *
 * `overshoot` is the arrival's own arithmetic and the reason this file grew a
 * second way to read the curve. It is decided in the order the evidence is
 * worth: the engine held at the peak, then the frames, and only when neither
 * could answer does it say the trace was blind rather than call a stall a
 * regression. `holds: null` is that third state and `verify.mjs` reads it.
 */
function summarise(frames, applied, scrubbed) {
  const seen = frames.filter((f) => f.rendered && f.opacity !== undefined)
  const lastRendered = frames.reduce((acc, f, i) => (f.rendered ? i : acc), -1)
  const win = frames.slice(0, Math.min(frames.length, lastRendered + 3))
  const visible = win.filter((f) => f.rendered)
  const fadedOut = seen.some(
    (f, i) =>
      f.opacity > 0.05 &&
      f.opacity < 0.95 &&
      seen.slice(i + 1).some((later) => later.opacity < f.opacity),
  )
  const scales = seen.map((f) => f.scaleX)
  const exitOnly = {
    renderedFrames: visible.length,
    firstT: visible[0]?.t ?? null,
    lastT: visible.at(-1)?.t ?? null,
    frameDeltaP50: median(win.slice(1).map((f) => f.dt)),
    fadedOut,
    untouchedFrames: win.filter((f) => f.rendered && f.pointerEvents === 'none').length,
    timingFunctions: [...new Set(seen.map((f) => f.timing))],
    trace: seen.map((f) => `t${f.t} op${f.opacity} s${f.scaleX}`),
  }
  if (!applied) return { exitOnly }

  return {
    ...exitOnly,
    scale: { min: Math.min(...scales), max: Math.max(...scales) },
    overshoot: overshootReading(seen, scales, applied, scrubbed),
  }
}

/**
 * Exported because a verdict that cannot be replayed against a recorded run is
 * a verdict nobody can argue with: the run that produced this function's
 * `the applied curve` branch is on disk, and feeding its trace back through
 * here is how that branch was checked.
 *
 *
 * The threshold is not a taste: the trace stores the scale rounded to four
 * decimals, so a surface scaled to 1.00002 is written down as 1 and is
 * invisible to any amount of sampling. `rounding` is that half-step, and the
 * excursion the trace can see is where the scaled value clears it — computed
 * from the curve the engine will actually run and the amplitude the trace
 * actually measured, so a retuned spring or a retuned amplitude moves the
 * window with it instead of silently invalidating this arithmetic.
 */
export function overshootReading(seen, scales, applied, scrubbed) {
  const sampled = { min: Math.min(...scales), max: Math.max(...scales) }
  const duration = durationMs(applied.movementDuration)
  const stops = springStops(applied.movementEasing ?? '')
  const amplitude = 1 - Math.min(...scales)

  // The other half of the original assertion, kept first and unconditional: a
  // trace with no frame below 1 never saw the surface arrive at all, and that
  // is a failure whatever the curve says.
  if (!(sampled.min < 1)) {
    return {
      holds: false,
      by: 'the trace',
      detail: `scale min ${sampled.min} max ${sampled.max} — no frame caught the surface at its start value, so nothing was observed`,
    }
  }

  if (sampled.max > 1) {
    return {
      holds: true,
      by: 'the trace',
      detail: `scale min ${sampled.min} max ${sampled.max} — the sampled scale passes 1 and returns`,
    }
  }

  if (scrubbed?.caught && scrubbed.atPeak > 1) {
    return {
      holds: true,
      by: 'the scrub',
      detail: `scale min ${sampled.min}; held at the peak (${Math.round(scrubbed.at)}ms of ${Math.round(scrubbed.duration)}) the engine computes ${scrubbed.atPeak}`,
    }
  }

  // The curve itself cannot do it. This is the regression the whole check
  // exists for, and it is named as such rather than reported as an absence of
  // evidence — a monotone ease arriving on this surface is a red whatever the
  // trace happened to sample.
  if (applied.movementEasing !== null && !curveOvershoots(applied)) {
    return {
      holds: false,
      by: 'the applied curve',
      detail: `scale min ${sampled.min} max ${sampled.max}: the movement is on ${applied.movementEasing}, which cannot pass 1 — the arrival is monotone`,
    }
  }

  // Nothing above 1 yet, on a curve that could have produced one. Whether that
  // is a monotone *rendering* or a blind trace is decided by where the
  // excursion was and whether any frame fell inside it.
  const window = stops && amplitude > 0 ? crossings(stops, 1 + 0.00005 / amplitude) : null
  const origin = seen[0]?.t ?? 0

  if (window && Number.isFinite(duration)) {
    const from = origin + (window.from / 100) * duration
    const to = origin + (window.to / 100) * duration
    const inside = seen.filter((f) => f.t >= from && f.t <= to)
    if (inside.length > 0) {
      return {
        holds: false,
        by: 'the trace',
        detail: `${inside.length} frame(s) landed inside ${from.toFixed(0)}–${to.toFixed(0)}ms, where this curve is above the rounding step, and every one of them reads 1 — the movement rendered monotone`,
      }
    }
    // The trace missed the excursion outright, which is not evidence either
    // way. The verdict goes to the curve that is applied — and it only goes
    // there because that curve is known to overshoot, which is the check.
    return {
      holds: true,
      by: 'the applied curve',
      detail: `scale min ${sampled.min} max ${sampled.max}: no frame landed between ${from.toFixed(0)}–${to.toFixed(0)}ms, where this curve is above the rounding step — the trace was blind here, and the movement is on the spring (peak ${applied.movementPeak})`,
    }
  }

  // A curve that overshoots and a trace that cannot be located on it. The
  // regression is covered by the branch above; this defers to it rather than
  // inventing a failure out of arithmetic that did not run.
  return {
    holds: true,
    by: 'the applied curve',
    detail: `scale min ${sampled.min} max ${sampled.max}; the excursion could not be located on this trace (${stops ? `duration ${applied.movementDuration}` : 'no parseable stops'}), and the movement is on the spring (peak ${applied.movementPeak})`,
  }
}

/** Whether the applied movement curve can pass 1 at all. */
function curveOvershoots(applied) {
  return (
    applied.movementIsSpring === true &&
    applied.movementPeak !== null &&
    applied.movementPeak > 1
  )
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
