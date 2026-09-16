/**
 * The dialog case, in the engine that ships.
 *
 * The menu probe is the app's one measured arrival, and it is a menu. The rule
 * the two share is stated about dialogs — a surface's opacity has nothing to
 * settle, so the spring belongs on the movement and not on the fade — and until
 * this file no probe could open a dialog, which means the surface the rule is
 * about was the one surface no engine-level reading covered. A unit test can see
 * the declaration; only the engine can say what it resolved to on an element.
 *
 * ---- The curve is read twice, and neither reading samples frames
 *
 * 1. `applied` — the live dialog's own computed `animation-name`,
 *    `animation-timing-function` and `animation-duration`, split on commas
 *    outside parentheses and read INDEX-ALIGNED, because a surface arrival is
 *    two animations and "is the spring on the fade" is a question about which
 *    list position holds which curve. Read off the element and not off
 *    `documentElement`, so what answers is the cascade at the point of use.
 *    Unlike a transition, an `animation`'s computed value outlives the animation,
 *    so this reading does not have to catch the 460ms it is about.
 *
 * 2. `keyframes` — what each of those named keyframes MOVES, read from the
 *    engine's own `CSSKeyframesRule`s. This is the half that makes the verdict
 *    about the product rather than about a name: `surface-fade` is known to move
 *    an opacity because the engine says so, and the assertion is then "nothing
 *    whose curve is the spring moves an opacity" — the guard's rule, stated
 *    where the engine can answer it.
 *
 * ---- Why the ordering is scrubbed and not traced
 *
 * The ruling is 「透明度先到位、位移随后收尾」, and it is not "the fade crosses 1
 * before the scale does": the spring passes its target about a third of the way
 * along, on purpose, and returns to it at the end. It is that the fade *finishes*
 * while the movement is still going.
 *
 * A frame trace delivers that only when the machine lets it. Measured here on a
 * box at load ~35, the first painted frame of the arrival already reads
 * `opacity 0.9983, scale 1.00081` — the whole 200ms fade had gone by in one
 * frame, and a trace like that makes the ordering true by arithmetic on a t=0
 * that is not the arrival's first frame. That is the same blindness the menu's
 * trace hit once from the other end, and it is why the verdict here comes from
 * the animation's own clock instead: the animations are paused, `currentTime` is
 * set to chosen instants, the computed style is read at each, and the clock is
 * put back. The machine's load cannot move a reading that does not depend on a
 * frame landing anywhere.
 *
 * The trace still runs, and is reported in full — frames, deltas, a distribution
 * and not a mean — because "the fade arrived in a single frame" is a fact about
 * this app under this load and is worth seeing. It is evidence, not the verdict.
 */
import { clickByText } from './probe-support.mjs'
import { until } from './webdriver.mjs'
import { sameCurve, springStops } from './probe-motion.mjs'

const SURFACE = '.settings-dialog'
/** The shell's settings button, and the only way this harness can open a dialog. */
const TRIGGER = '.status-btn[title="Settings"]'
/** The two keyframes the split arrival is made of, by name. */
const FADE = 'surface-fade'
const MOVEMENT = 'surface-scale'
/** How long the trace runs. Twice the slow rung, so the settle is inside it. */
const TRACE_MS = 900

export const dialogProbe = {
  name: 'motion-dialog',
  async run(wd) {
    await wd.execute(IN_PAGE)

    // The trace is installed BEFORE the click and started from inside the page.
    // A WebDriver round trip is longer than the first frames of a 200ms fade, so
    // a sampler *called* after the click begins too late to see the fade start.
    await wd.execute(
      `window.__dlg.frames = []; window.__dlg.done = false; window.__dlgSample(${TRACE_MS}); return true`,
    )
    await clickByText(wd, TRIGGER, '', 0)
    const applied = await readApplied(wd)
    const keyframes = await wd.execute(`return window.__dlgKeyframes`)

    const animations = (applied.animations ?? []).map((animation) => ({
      ...animation,
      // What the engine says this keyframe moves. `null` means the name resolved
      // to nothing, which is the failure the unit guard was blind to for three
      // dialogs and must not be blind to here.
      moves: keyframes[animation.name] ?? null,
      isSpring: springStops(animation.easing ?? '') !== null,
      ms: milliseconds(animation.duration),
    }))
    const fade = animations.find((a) => a.name === FADE) ?? null
    const movement = animations.find((a) => a.name === MOVEMENT) ?? null

    const plan = sweepPlan(fade, movement)
    // The sweep pauses the animations and puts them back, so the trace running
    // beside it will hold a frame or two that the scrub produced rather than the
    // arrival. That is one more reason the trace is corroboration here and not
    // the verdict: its extremes are still the arrival's (the scrub restores the
    // clock before the next frame), but its shape around them is not.
    const sweep = await wd.execute(`return window.__dlgSweep(${JSON.stringify(plan.times)})`)
    const arrival = await until(
      () => wd.execute(`return window.__dlg.done === true ? window.__dlg.frames : null`),
      { timeout: 10_000, what: 'the dialog arrival trace' },
    )
    await close(wd)

    return {
      support: {
        reducedMotion: applied.reducedMotion,
        easeSurface: applied.easeSurface.slice(0, 60),
      },
      applied: {
        animationName: applied.animationName,
        animationTimingFunction: applied.animationTimingFunction,
        animationDuration: applied.animationDuration,
        animations,
        // The rule, read off the live element: no animation whose curve is the
        // spring moves an opacity. A name that resolved to nothing counts as a
        // failure rather than as clean.
        springOnAnOpacity: animations.some(
          (a) => a.isSpring && (a.moves === null || a.moves.includes('opacity')),
        ),
        movementIsSpring: movement
          ? movement.isSpring && sameCurve(movement.easing, applied.easeSurface)
          : false,
        fadeMs: fade?.ms ?? null,
        movementMs: movement?.ms ?? null,
        fadeRungMs: milliseconds(applied.fadeRung),
        slowRungMs: milliseconds(applied.slowRung),
      },
      sweep: sweepReading(sweep, plan, fade),
      arrival: summarise(arrival),
    }
  },
}

/** The instants the arrival is read at, all of them off the engine's own rungs. */
function sweepPlan(fade, movement) {
  const stops = springStops(movement?.easing ?? '')
  const peak = stops ? stops.reduce((a, b) => (b.value > a.value ? b : a)) : null
  const peakMs = peak && movement?.ms ? Math.round((peak.at / 100) * movement.ms) : null
  const times = [0, fade?.ms ?? null, peakMs, movement?.ms ?? null]
  return { times: [...new Set(times.filter((t) => t !== null))], peakMs }
}

/**
 * The arrival at chosen instants of the animation's own clock.
 *
 * Three readings and what each one is for:
 *
 *   - at 0, the surface is at the token's amplitude and at opacity 0 — which is
 *     also the self-check. If the engine did not reflect `currentTime` every
 *     reading would come back identical, and a scrub that silently does nothing
 *     looks exactly like a result. `reflected` is that check.
 *   - at the fade's own duration, the opacity is final. The question the ruling
 *     asks is what the SCALE is doing then, and it is the one a single-duration
 *     arrival cannot answer: it would be at rest too, and the surface would have
 *     finished appearing and finished moving in the same instant.
 *   - at the spring's peak fraction, the scale is above 1 — the settle the whole
 *     curve exists for, held still long enough to read.
 */
function sweepReading(sweep, plan, fade) {
  if (!sweep || sweep.error) return { error: sweep?.error ?? 'the sweep did not report' }
  const readings = sweep.readings ?? []
  const at = (t) => readings.find((r) => r.t === t) ?? null
  const start = at(0)
  const fadeEnd = fade ? at(fade.ms) : null
  const peak = plan.peakMs === null ? null : at(plan.peakMs)
  return {
    readings,
    peakMs: plan.peakMs,
    reflected:
      start !== null && start.opacity !== undefined && start.opacity < 0.5 && start.scale < 1,
    // The ordering, and it is the whole point: at the instant the fade is over,
    // the movement is not.
    opacityFinalWhenFadeEnds: fadeEnd ? fadeEnd.opacity === 1 : null,
    movementStillGoingWhenFadeEnds: fadeEnd ? fadeEnd.scale !== 1 : null,
    scaleAtThePeak: peak?.scale ?? null,
  }
}

/**
 * The arrival, frame by frame — reported, and deliberately not the verdict.
 *
 * `firstFrame` is the reading that matters here and it is a reading about the
 * machine, not about the curve: it says how much of the arrival was over before
 * the trace's first frame was painted. A trace whose first frame is already at
 * opacity 1 cannot decide anything about the ordering, and saying so is the
 * difference between a blind instrument and a wrong answer.
 *
 * `frameDeltaP50` is a percentile with the distribution beside it, never a mean:
 * a mean hides the 200ms gap that made one run's trace blind, which is the exact
 * reading this harness exists to make impossible.
 */
function summarise(frames) {
  const seen = frames.filter((f) => f.opacity !== undefined)
  const deltas = seen.slice(1).map((f) => f.dt)
  const opacity = seen.map((f) => f.opacity)
  const scales = seen.map((f) => f.scale)
  return {
    frames: seen.length,
    firstT: seen[0]?.t ?? null,
    lastT: seen.at(-1)?.t ?? null,
    firstFrame: seen[0] ? { opacity: seen[0].opacity, scale: seen[0].scale } : null,
    coveredTheArrival: seen.length > 0 && seen[0].opacity < 0.95,
    frameDeltaP50: percentile(deltas, 50),
    frameDeltaP90: percentile(deltas, 90),
    frameDeltaMax: deltas.length ? Math.max(...deltas) : null,
    frameDeltaHistogram: histogram(deltas),
    // `null` and not `Infinity` when nothing was sampled: a trace that saw no
    // frame at all is a missing reading, and `Math.min()` of nothing is a number
    // that reads like one.
    opacity: seen.length ? { min: Math.min(...opacity), max: Math.max(...opacity) } : null,
    scale: seen.length ? { min: Math.min(...scales), max: Math.max(...scales) } : null,
    trace: seen.map((f) => `t${f.t} op${f.opacity} s${f.scale}`),
  }
}

/**
 * Close the dialog, through the dialog.
 *
 * Not by clicking the status button that opened it, which is the obvious way and
 * the one that does not work: the overlay is `position: fixed; inset: 0` at the
 * top of the app's z-scale, so the button is underneath it and WebDriver refuses
 * the click as intercepted (`POST /element/…/click -> 400`). The close control is
 * inside the dialog, where the pointer can reach it.
 */
async function close(wd) {
  // The arrival is allowed to settle first. A half-open dialog is still being
  // scaled, and the hit test that decides whether a click lands runs against the
  // box the element has at that instant — so a close pressed mid-arrival is the
  // one that can be refused as intercepted.
  await until(
    () =>
      wd.execute(
        `const el = document.querySelector('${SURFACE}')
         return !el || el.getAnimations().every((a) => a.playState === 'finished')`,
      ),
    { timeout: 10_000, what: 'the dialog arrival to settle' },
  )
  await clickByText(wd, '.settings-close', '', 0)
  await until(() => wd.execute(`return !document.querySelector('${SURFACE}')`), {
    what: 'the dialog to close',
  })
}

/**
 * The live dialog's own computed animation lists, index-aligned.
 *
 * The split is on commas outside parentheses for the reason the menu probe
 * gives: the values being split are `cubic-bezier(0.22, 1, 0.36, 1)` and
 * `linear(0 0%, …)`, and a plain `split(',')` turns one curve into five.
 */
function readApplied(wd) {
  return wd.execute(
    `const el = document.querySelector('${SURFACE}')
     if (!el) return { error: 'the dialog is not on the page' }
     const cs = getComputedStyle(el)
     const root = getComputedStyle(document.documentElement)
     const split = (value) => {
       const out = []
       let depth = 0
       let cur = ''
       for (const ch of String(value)) {
         if (ch === '(') depth += 1
         else if (ch === ')') depth -= 1
         if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else { cur += ch }
       }
       if (cur.trim()) out.push(cur.trim())
       return out
     }
     const names = split(cs.animationName)
     const eases = split(cs.animationTimingFunction)
     const durations = split(cs.animationDuration)
     return {
       animationName: cs.animationName,
       animationTimingFunction: cs.animationTimingFunction,
       animationDuration: cs.animationDuration,
       animations: names.map((name, i) => ({
         name: name,
         easing: eases[i] === undefined ? null : eases[i],
         duration: durations[i] === undefined ? null : durations[i]
       })),
       easeSurface: root.getPropertyValue('--app-ease-surface').trim(),
       fadeRung: root.getPropertyValue('--app-motion-fade').trim(),
       slowRung: root.getPropertyValue('--app-motion-slow').trim(),
       reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
     }`,
  )
}

/** A computed time in milliseconds. The engine serialises `200ms` as `0.2s`. */
function milliseconds(value) {
  const text = String(value ?? '').trim()
  const n = Number.parseFloat(text)
  if (!Number.isFinite(n)) return null
  return text.endsWith('ms') ? n : n * 1000
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/**
 * Frame deltas in buckets, so a stall is a count and not a decimal.
 *
 * The edges are the refresh rates this machine can be in plus the first one
 * after each: an idle 60Hz frame, a 120Hz one, and the tail where a dropped
 * frame lives. A run whose tail is empty did not stall; a run with counts in the
 * tail had that many chances to miss something, and the number says how many.
 */
function histogram(deltas) {
  const buckets = { '<=8ms': 0, '8-20ms': 0, '20-40ms': 0, '40-100ms': 0, '>100ms': 0 }
  for (const dt of deltas) {
    if (dt <= 8) buckets['<=8ms'] += 1
    else if (dt <= 20) buckets['8-20ms'] += 1
    else if (dt <= 40) buckets['20-40ms'] += 1
    else if (dt <= 100) buckets['40-100ms'] += 1
    else buckets['>100ms'] += 1
  }
  return buckets
}

/**
 * Everything the probe installs in the page, in one string.
 *
 * Three instruments: the arrival trace, the animation-clock sweep, and the
 * engine's own keyframe bodies.
 */
const IN_PAGE = `window.__dlg = { frames: [], done: false };
window.__dlgKeyframes = {};
// The engine's own keyframe bodies, by name, from every sheet it has — the
// component's scoped stylesheet included.
for (const sheet of document.styleSheets) {
  let rules;
  try { rules = sheet.cssRules } catch (error) { continue }
  for (const rule of rules) {
    // A keyframes rule by its shape, not by its constructor's name: a renamed
    // interface would make this read as zero keyframes and the probe would then
    // report a clean surface it never looked at. It is the rule with a name and
    // steps that carry a key.
    if (!rule.name || !rule.cssRules || !rule.cssRules.length) continue;
    if (rule.cssRules[0].keyText === undefined) continue;
    const properties = new Set();
    // Indexed, not an iterator: CSSStyleDeclaration's indexed getter is required
    // and its iterator is not, and an engine with the first and not the second
    // would report every keyframe as moving nothing.
    for (const step of rule.cssRules) {
      for (let i = 0; i < step.style.length; i++) properties.add(step.style[i]);
    }
    window.__dlgKeyframes[rule.name] = Array.from(properties);
  }
}
const scaleOf = (el) => {
  const cs = getComputedStyle(el);
  const raw = cs.scale === undefined ? 'none' : cs.scale;
  // The scale property serialises with the y and z terms when they are not all
  // the same; the x term is the one the arrival animates.
  return raw === 'none' || raw === '' ? 1 : Number(String(raw).split(/\\s+/)[0]);
};
window.__dlgSample = (ms) => {
  const t0 = performance.now();
  let started = 0;
  let last = 0;
  const tick = (now) => {
    const el = document.querySelector('${SURFACE}');
    if (!started) {
      // The dialog is inserted by the click, so the first frame with the element
      // on it is the first frame of the arrival the browser got to paint.
      if (!el) {
        if (now - t0 > 4000) { window.__dlg.error = 'the dialog never mounted'; window.__dlg.done = true; return }
        requestAnimationFrame(tick);
        return;
      }
      started = now;
      last = now;
    }
    const cs = getComputedStyle(el);
    window.__dlg.frames.push({
      t: Math.round(now - started),
      dt: Math.round((now - last) * 10) / 10,
      opacity: Math.round(Number(cs.opacity) * 10000) / 10000,
      scale: Math.round(scaleOf(el) * 100000) / 100000
    });
    last = now;
    if (now - started < ms) requestAnimationFrame(tick);
    else window.__dlg.done = true;
  };
  requestAnimationFrame(tick);
};
// The animation's own clock, held at chosen instants. Each animation is set to
// min(t, its own duration), so a reading at a time past the shorter one is that
// animation at rest — which is exactly what "the fade is over" means.
window.__dlgSweep = (times) => {
  const el = document.querySelector('${SURFACE}');
  if (!el || !el.getAnimations) return { error: 'the dialog has no animations to read' };
  const anims = el.getAnimations().filter((a) => a.animationName);
  if (!anims.length) return { error: 'no CSS animations are running on the dialog' };
  const saved = anims.map((a) => ({ a: a, at: a.currentTime, state: a.playState }));
  const durations = anims.map((a) => {
    const timing = a.effect.getComputedTiming();
    return timing.duration;
  });
  const readings = [];
  for (const t of times) {
    anims.forEach((a, i) => { a.pause(); a.currentTime = Math.min(t, durations[i]); });
    readings.push({
      t: t,
      opacity: Math.round(Number(getComputedStyle(el).opacity) * 100000) / 100000,
      scale: Math.round(scaleOf(el) * 100000) / 100000
    });
  }
  saved.forEach((s) => {
    s.a.currentTime = s.at;
    if (s.state !== 'paused') s.a.play();
  });
  return { readings: readings, names: anims.map((a) => a.animationName), durations: durations };
};
return true`
