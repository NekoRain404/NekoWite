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
 */
import { clickByText } from './probe-support.mjs'
import { until } from './webdriver.mjs'

const SURFACE = '.toolbar-menu'

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

    return { support, arrival: summarise(arrival), exit: summarise(exit) }
  },
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
 */
function summarise(frames) {
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
  return {
    renderedFrames: visible.length,
    firstT: visible[0]?.t ?? null,
    lastT: visible.at(-1)?.t ?? null,
    frameDeltaP50: median(win.slice(1).map((f) => f.dt)),
    fadedOut,
    untouchedFrames: win.filter((f) => f.rendered && f.pointerEvents === 'none').length,
    timingFunctions: [...new Set(seen.map((f) => f.timing))],
    scale: { min: Math.min(...scales), max: Math.max(...scales) },
    trace: seen.map((f) => `t${f.t} op${f.opacity} s${f.scaleX}`),
  }
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
