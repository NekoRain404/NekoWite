/**
 * The page-side instrument the agent-scroll probe drives, and the names it addresses it by.
 *
 * Split out of `probe-agent-scroll.mjs` at the line budget, and along the seam the file already
 * had: everything here is machinery that would be the same for any measurement of a scroll
 * container, and nothing here knows what the agent panel's rules are. The probe keeps the
 * rules — which phases run, in what order, and what each one is evidence for.
 *
 * `INSTRUMENTS` is installed once with `wd.execute` and then called from the probe. It has to
 * live in the page because WebDriver classic runs ONE command at a time: a trace interleaved
 * with the clicks and the frames it measures would be measuring the round trips between them,
 * so pushing, scrolling and sampling all happen on the page's own clock. The gestures the
 * ENGINE acts on — a real click, a wheel, a key — are one file over in
 * `agent-scroll-driver.mjs`, and the frame arithmetic is in `agent-scroll-readings.mjs`.
 */
import { readFileSync } from 'node:fs'

/** §5.3's panel, as the running app renders it (the rail hosts it, `AgentPanel` is its root). */
export const PANEL = '.agent-panel'
/** The scroll container: `AgentTimeline`'s own element, and the composable's `container`. */
export const TIMELINE = '.agent-timeline'
/** The affordance the panel offers a reader who has left the end. */
export const JUMP = '.agent-jump'
/** The body under the rule's second half: the rendered pane's ProseMirror root. */
export const BODY = '.pane.rendered .ProseMirror'

/**
 * The status-bar buttons that toggle the rail, by their `title`.
 *
 * `shell.ts`'s `rail.expand` / `rail.collapse`, and the harness pins the locale to English, so
 * these are the words on screen. Read from the DOM rather than assumed: when none matches, the
 * probe reports every title it found, which is how a renamed label shows up as a probe failure
 * instead of as a toggle that silently did nothing.
 */
export const RAIL_TITLES = ['AI assistant', 'Collapse the panel']

/** The run the probe drives. The harness's `agent_prompt` answers with this same id. */
export const RUN = 'probe-run-1'
/**
 * The keys, by the WebDriver table's own code points.
 *
 * Spelled as escapes and not as the characters they stand for: a literal PageDown in a source
 * file is invisible, and one that a formatter or a copy-paste turns into a plain character is a
 * probe that presses nothing and reports the absence of movement as a result.
 */
export const KEY = {
  pageDown: '\uE00F',
  end: '\uE010',
  enter: '\uE007',
  tab: '\uE004',
}
/** The harness's frame source — the IPC stand-in `harness.html` installs under `?agent=1`. */
export const AGENT = 'window.__NEKO_AGENT__'

/**
 * The load average this machine is under, read where it is used.
 *
 * `/proc/loadavg` rather than a library: it is three numbers and this is a probe, not a
 * monitoring stack. A failed read is null rather than 0.00, because a zero would read as an
 * idle machine.
 */
export function load() {
  try {
    const [one, five, fifteen] = readFileSync('/proc/loadavg', 'utf8').split(' ')
    return { one: Number(one), five: Number(five), fifteen: Number(fifteen) }
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------------------
 * The page-side instruments
 *
 * They are installed once and called from here, and the reason is WebDriver classic: it runs
 * ONE command at a time, so a trace that had to be interleaved with the clicks and the frames
 * it measures would be measuring the round trips between them. Pushing, scrolling and sampling
 * therefore happen inside the page, on the page's own clock.
 * ------------------------------------------------------------------------- */
export const INSTRUMENTS = `
/** A row's own id, whichever kind it is: transcript rows carry data-row, tool rows data-call. */
window.__nkwRowId = function (row, index) {
  return row.dataset.row || row.dataset.call || ('#' + index);
};

/** The row the reader's eye is on: the first whose bottom edge is below the container's top. */
window.__nkwAnchor = function (sh) {
  const top = sh.getBoundingClientRect().top;
  const rows = Array.from(sh.children);
  for (let i = 0; i < rows.length; i++) {
    const box = rows[i].getBoundingClientRect();
    if (box.bottom - top > 0) {
      return { id: window.__nkwRowId(rows[i], i), offset: box.top - top };
    }
  }
  return { id: null, offset: null };
};

window.__nkwMetrics = function (sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  return {
    scrollTop: Math.round(el.scrollTop * 100) / 100,
    max: Math.round((el.scrollHeight - el.clientHeight) * 100) / 100,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    rows: el.children.length,
    text: el.textContent.length
  };
};

/**
 * Count the container's own scroll events, so "the reader scrolled" is a reading rather than
 * an assumption. A park that produced no event would leave the panel believing the reader is
 * still at the end, and the trace after it would be measuring a suspension that never
 * happened. This witness is what makes that impossible to report as a pass.
 */
window.__nkwWatchScroll = function (sel) {
  const el = document.querySelector(sel);
  if (!el) return { why: 'no ' + sel };
  if (!el.__nkwWatched) {
    el.__nkwWatched = true;
    el.__nkwScrollEvents = 0;
    el.addEventListener('scroll', function () { el.__nkwScrollEvents += 1; }, { passive: true });
  }
  el.__nkwScrollEvents = 0;
  return { watching: true, events: el.__nkwScrollEvents };
};

/** Where the container is, after enough frames for anything async to have landed. */
window.__nkwSettle = function (opts, done) {
  const el = document.querySelector(opts.sel);
  const report = function () {
    const m = window.__nkwMetrics(opts.sel);
    done(m ? {
      scrollTop: m.scrollTop, max: m.max, rows: m.rows, text: m.text,
      scrollEvents: el && el.__nkwScrollEvents !== undefined ? el.__nkwScrollEvents : null,
      jump: Boolean(document.querySelector(opts.jump))
    } : { why: 'no ' + opts.sel });
  };
  let n = 0;
  const tick = function () { if (++n >= opts.frames) report(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};

/** Park the reader away from the end with a written offset, and settle for the scroll event. */
window.__nkwPark = function (opts, done) {
  const el = document.querySelector(opts.sel);
  if (!el) { done({ why: 'no ' + opts.sel }); return; }
  const max = el.scrollHeight - el.clientHeight;
  const target = Math.max(0, Math.min(opts.top === undefined ? max - opts.up : opts.top, max));
  el.scrollTop = target;
  let n = 0;
  const tick = function () {
    if (++n >= 3) {
      const m = window.__nkwMetrics(opts.sel);
      done({
        requested: Math.round(target * 100) / 100,
        scrollTop: m.scrollTop, max: m.max, rows: m.rows,
        awayFromEnd: Math.round((m.max - m.scrollTop) * 100) / 100,
        scrollEvents: el.__nkwScrollEvents === undefined ? null : el.__nkwScrollEvents,
        jump: Boolean(document.querySelector(opts.jump))
      });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/**
 * The stream: from here every frame is recorded while content arrives.
 *
 * The pushes are made from inside the sampling loop on purpose — they ARE the arrivals under
 * measurement, and a frame pushed by a client round trip between two samples would leave the
 * arrival time unknown. Two out of three are new tool rows (bulk, each a new row at the end),
 * one is a text delta: the stream the ruling names, the last row growing.
 */
window.__nkwStream = function (opts, done) {
  const host = ${AGENT};
  const sh = document.querySelector(opts.sel);
  if (!sh) { done({ why: 'no ' + opts.sel }); return; }
  const frames = [];
  const t0 = performance.now();
  let last = t0;
  let ticks = 0;
  let pushed = 0;
  const sent0 = host ? host.sent : -1;
  const rows0 = sh.children.length;
  const text0 = sh.textContent.length;

  const push = function () {
    pushed += 1;
    if (pushed % 3 === 0) {
      host.push('text-delta', { text: host.chunk }, opts.runId);
      return;
    }
    host.push('tool-update', {
      update: {
        toolCallId: opts.prefix + '-' + pushed,
        title: 'Reading note ' + opts.prefix + '-' + pushed,
        kind: 'read',
        status: 'completed',
        locations: [{ path: 'notes/2026-09/' + opts.prefix + '-' + pushed + '.md' }],
        rawInput: { state: 'absent' }
      }
    }, opts.runId);
  };

  const tick = function (now) {
    const frame = {
      t: Math.round(now - t0),
      dt: Math.round((now - last) * 10) / 10,
      scrollTop: Math.round(sh.scrollTop * 100) / 100,
      max: Math.round((sh.scrollHeight - sh.clientHeight) * 100) / 100,
      rows: sh.children.length,
      text: sh.textContent.length
    };
    last = now;
    const anchor = window.__nkwAnchor(sh);
    frame.anchorId = anchor.id;
    frame.anchorOffset = anchor.offset === null ? null : Math.round(anchor.offset * 100) / 100;
    frames.push(frame);
    ticks += 1;
    if (ticks % opts.every === 0 && pushed < opts.count) push();
    if (now - t0 < opts.ms) { requestAnimationFrame(tick); return; }
    done({
      frames: frames, pushed: pushed,
      sent0: sent0, sent1: host ? host.sent : -1,
      rows0: rows0, rows1: sh.children.length,
      text0: text0, text1: sh.textContent.length,
      scrollEvents: sh.__nkwScrollEvents === undefined ? null : sh.__nkwScrollEvents,
      jump: Boolean(document.querySelector(opts.jump))
    });
  };
  requestAnimationFrame(tick);
};

/**
 * The rail toggle, sampled frame by frame: the body's box, the caret, and who has focus.
 *
 * The body readings are brief 62's instrument brought over — the width the text is laid out at
 * and the height that width produces. A layout that re-wraps frame by frame shows up as many
 * distinct widths across the trace; one reflow in the click frame shows up as exactly two, the
 * second arriving once and never moving again.
 *
 * The caret is read from the model — editorSessionManager's view state selection head, the
 * same handle e2e/support/editorHarness.ts reads — rather than from the DOM selection: the
 * click that toggles the rail moves focus, and focus is not the caret.
 */
window.__nkwPanel = function (opts, done) {
  const editor = window.__nkwEditor || null;
  const frames = [];
  const t0 = performance.now();
  let last = t0;
  const read = function (now) {
    const frame = { t: Math.round(now - t0), dt: Math.round((now - last) * 10) / 10 };
    last = now;
    const root = document.querySelector(opts.body);
    if (root) {
      const box = root.getBoundingClientRect();
      frame.bodyWidth = Math.round(box.width * 100) / 100;
      frame.bodyHeight = Math.round(box.height * 100) / 100;
      const blocks = root.children;
      frame.p0 = blocks.length > 0 ? Math.round(blocks[0].getBoundingClientRect().height * 100) / 100 : null;
      frame.p20 = blocks.length > 20 ? Math.round(blocks[20].getBoundingClientRect().height * 100) / 100 : null;
    }
    const view = editor ? editor.getView() : null;
    frame.head = view ? view.state.selection.head : null;
    const sel = window.getSelection();
    frame.ranges = sel ? sel.rangeCount : null;
    frame.focus = document.activeElement
      ? (document.activeElement.className || document.activeElement.tagName || null)
      : null;
    frame.rail = Boolean(document.querySelector(opts.rail));
    frame.panel = Boolean(document.querySelector(opts.panel));
    frames.push(frame);
    if (now - t0 < opts.ms) { requestAnimationFrame(read); return; }
    done({ frames: frames });
  };
  requestAnimationFrame(read);
};

/** The end of the container, written: the fallback for a driver with no wheel gesture. */
window.__nkwToEnd = function (opts, done) {
  const el = document.querySelector(opts.sel);
  if (!el) { done({ why: 'no ' + opts.sel }); return; }
  el.scrollTop = el.scrollHeight - el.clientHeight;
  let n = 0;
  const tick = function () {
    if (++n >= 3) {
      const m = window.__nkwMetrics(opts.sel);
      done({ scrollTop: m.scrollTop, max: m.max,
             scrollEvents: el.__nkwScrollEvents === undefined ? null : el.__nkwScrollEvents,
             jump: Boolean(document.querySelector(opts.jump)) });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** Seed the transcript in one tick: the bulk a live run produces before a reader looks away. */
window.__nkwSeed = function (opts) {
  const host = ${AGENT};
  for (let i = 0; i < opts.count; i++) {
    host.push('tool-update', {
      update: {
        toolCallId: opts.prefix + '-' + i,
        title: 'Reading note ' + opts.prefix + '-' + i,
        kind: 'read',
        status: 'completed',
        locations: [{ path: 'notes/2026-09/' + opts.prefix + '-' + i + '.md' }],
        rawInput: { state: 'absent' }
      }
    }, opts.runId);
  }
  return host.sent;
};

/** What the panel is showing, for the guards that say a trace had something to measure. */
window.__nkwPanelState = function () {
  const sh = document.querySelector('${TIMELINE}');
  const count = document.querySelector('${JUMP} .agent-jump-count');
  return {
    panel: Boolean(document.querySelector('${PANEL}')),
    timeline: Boolean(sh),
    metrics: sh ? window.__nkwMetrics('${TIMELINE}') : null,
    jump: Boolean(document.querySelector('${JUMP}')),
    jumpCount: count ? count.textContent.trim() : null,
    running: Boolean(document.querySelector('.agent-composer [data-action="stop"]')),
    rail: Boolean(document.querySelector('.info-rail')),
    sent: ${AGENT} ? ${AGENT}.sent : null,
    runId: ${AGENT} ? ${AGENT}.runId() : null
  };
};

/**
 * A deliberate violation, installed in the page: the container pins itself to the end on
 * every frame, which is the unconditional following the ruling forbids. Used only under
 * --violate pin, to show that the trace above turns red for the thing it claims to measure.
 */
window.__nkwViolatePin = function (sel) {
  const el = document.querySelector(sel);
  if (!el) return { why: 'no ' + sel };
  if (window.__nkwPinning) return { already: true };
  window.__nkwPinning = true;
  const loop = function () {
    el.scrollTop = el.scrollHeight - el.clientHeight;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return { installed: true, what: 'scrollTop := scrollHeight - clientHeight, every frame' };
};

/**
 * The other deliberate violation: the body's own width sweeps across frames, which re-wraps
 * the text on every one of them — the mechanism the rail's rule forbids. Injected as a
 * stylesheet in the page, so no application source is involved.
 */
window.__nkwViolateWidth = function () {
  const style = document.createElement('style');
  style.textContent =
    '@keyframes nkw-body-sweep { from { width: 520px } to { width: 760px } }' +
    ' .pane.rendered .ProseMirror { animation: nkw-body-sweep 700ms linear infinite alternate; }';
  document.head.appendChild(style);
  return { installed: true, what: 'a width animation on the rendered body, one re-wrap per frame' };
};

/** The caret, as the model has it, plus who holds focus — read at one instant. */
window.__nkwCaret = function () {
  const view = window.__nkwEditor ? window.__nkwEditor.getView() : null;
  const sel = window.getSelection();
  return {
    head: view ? view.state.selection.head : null,
    ranges: sel ? sel.rangeCount : null,
    focus: document.activeElement
      ? (document.activeElement.className || document.activeElement.tagName || null)
      : null
  };
};
`
