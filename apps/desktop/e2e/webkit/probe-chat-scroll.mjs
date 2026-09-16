/**
 * The chat transcript as a keyboard surface, and every tab stop's ring, in the engine that ships.
 *
 * ---- Why this file exists
 *
 * `probe-agent-scroll.mjs` measured the agent panel's transcript, found it was not a tab stop,
 * and fixed it under fifteen checks in WebKitGTK. The same container exists in the chat panel —
 * `ChatTranscript.vue`'s `.chat-scroll`, `role="log"`, `overflow-y: auto`, `aria-live="off"` and
 * no `tabindex` — and the agent probe deliberately did NOT fix it, for the reason this file
 * exists: no probe in this repository touched the chat panel at all, so a fix there would have
 * been verified by inspection, which is the failure mode the whole harness is built against.
 * Different surface, different container, different composer, different send path; the agent
 * panel's fifteen greens are not evidence about this one, and `use-chat-scroll.ts`'s own comment
 * already names "a keyboard scroll" as a route to the end that the container could not take.
 *
 * ---- What is measured
 *
 * The same five claims, in the reader's own order, on this surface:
 *
 *  1. the container is a tab stop a real Tab lands on, and the engine PAINTS a ring on it;
 *  2. it is not a trap — a real Tab leaves it;
 *  3. landing on it does not move the reader;
 *  4. PageDown and End scroll it, read after the box has stopped;
 *  5. the chat composer keeps its own keys, and a character typed there still arrives.
 *
 * ---- And the sweep
 *
 * A container that is a tab stop with no ring is the same defect from the other side, and it is
 * the one a reviewer walks past: four such surfaces were reported out of a hand survey and there
 * were five. So this probe also asks the question of EVERY tab stop the app has on screen, by
 * focusing each and reading back what the engine paints — `__nkwFocusSweep` in the instrument.
 * The method is proved in the same call against a witness known to paint; when the witness comes
 * back dark the sweep reports itself blind rather than accusing a hundred and fifty controls.
 *
 * The sweep is a READING and is printed, not a verdict: it covers surfaces outside this task's
 * reach, and a gate that can only go green by fixing files it may not open is not a gate. What
 * it is for is the report's answer to "how did you enumerate them", and it is the only reading
 * in this repository that can say whether the class regrew.
 */
import { until } from './webdriver.mjs'
import {
  CHAT,
  CHAT_FIELD,
  CHAT_PANEL,
  CHAT_SEND,
  INSTRUMENTS,
  KEY,
  RAIL,
  RAIL_TITLES,
  load,
} from './agent-scroll-instrument.mjs'
import { clickAt, clickStatusButton, pressKeys, wheel } from './agent-scroll-driver.mjs'
import { frameStats } from './agent-scroll-readings.mjs'

/** `--violate chatnofocus`: the defect, injected in the page, so the checks can be shown red. */
export const CHAT_NOFOCUS = 'chatnofocus'

function violation() {
  const i = process.argv.indexOf('--violate')
  if (i === -1) return null
  const value = process.argv[i + 1]
  return value === undefined || value.startsWith('--') ? null : value
}

export const chatScrollProbe = {
  name: 'chat-scroll',

  async run(wd) {
    // Asked of the page. A plain `node measure.mjs` has no seeded conversation and no rail, so
    // the probe reports itself skipped rather than measuring an empty transcript — and the run's
    // own `chat` flag is what `verify.mjs` reads to tell the skip apart from a requested run
    // that produced nothing.
    const harness = await wd.execute(
      'return window.__NEKO_HARNESS__ ? { agent: window.__NEKO_HARNESS__.agent, chat: window.__NEKO_HARNESS__.chat, scenario: window.__NEKO_HARNESS__.scenario } : null',
    )
    if (!harness) return { skipped: 'the page is not the WebKit harness' }
    if (harness.agent) {
      return { skipped: 'the rail hosts the agent panel under --agent; run this probe without it' }
    }
    if (!harness.chat) return { skipped: 'the harness was not asked to seed a conversation (run with --chat)' }

    const violated = violation() === CHAT_NOFOCUS ? CHAT_NOFOCUS : null
    const out = { harness, load: load(), violation: violated, boot: {}, keys: {}, composer: {}, sweep: {} }

    await wd.execute(INSTRUMENTS)

    // The rail is mounted with `v-if="railOpen"`, so the panel is not in the document — let
    // alone scrolled — until the reader opens it. Clicked through the driver for the same reason
    // every other gesture here is: the question is what the app does for a reader.
    out.boot.rail = await clickStatusButton(wd, RAIL_TITLES)
    if (!out.boot.rail?.ok) {
      out.boot.failure = 'the rail toggle could not be found in the status bar'
      return out
    }
    try {
      await until(() => wd.execute(`return Boolean(document.querySelector('${CHAT}'))`), {
        timeout: 20_000,
        what: 'the chat panel to mount in the rail',
      })
    } catch (error) {
      out.boot.failure = String(error.message || error)
      out.boot.railText = await wd.execute(
        `const body = document.querySelector('.rail-body') || document.querySelector('.info-rail');
         return body ? body.textContent.trim().slice(0, 400) : null`,
      )
      return out
    }
    // The fixture's own evidence that there is something to scroll: a transcript that fits in
    // its viewport answers every question below with "nothing moved".
    out.boot.metrics = await wd.execute(`return window.__nkwMetrics('${CHAT}')`)
    out.boot.rows = await wd.execute(
      `const el = document.querySelector('${CHAT}'); return el ? el.children.length : null`,
    )
    if (!out.boot.metrics || out.boot.metrics.max <= 8) {
      out.boot.failure = `the seeded transcript does not overflow (max ${out.boot.metrics?.max ?? '?'})`
      return out
    }

    // The deliberate violation, installed before the DOM is read so the whole phase runs against
    // the defect: the tab-order reading, the Tab walk, the ring and the key scroll all go red
    // together while the composer half below stays green — which is what says the red is about
    // the container and not about the panel.
    if (violated) {
      out.injected = await wd.execute(`return window.__nkwViolateNoFocus('${CHAT}')`)
      out.injectedRing = await wd.execute(`return window.__nkwViolateNoRing('${CHAT}')`)
    }

    await keyboardPhase(wd, out)
    out.sweep = await focusSweep(wd)
    out.loadAfter = load()
    return out
  },
}

/**
 * The five claims, in the order a reader would make them.
 *
 * Every key is read through `quiet`, and it is the difference between this working and this
 * reporting an easing curve: WebKitGTK ANIMATES a keyboard scroll, so a fixed-frame settle reads
 * the container mid-flight. That finding is the agent probe's and it holds here unchanged — the
 * engine that was measured is the engine this runs in.
 */
async function keyboardPhase(wd, out) {
  const quiet = async (sel) => {
    const loadBefore = load()
    const settled = await wd.executeAsync(
      `window.__nkwQuiet({ sel: arguments[0] }, arguments[arguments.length - 1])`,
      [sel],
    )
    if (!settled?.deltas) return { ...settled, loadBefore, load: load() }
    const stats = frameStats(settled.deltas.map((dt) => ({ dt })))
    const { deltas, ...rest } = settled
    return { ...rest, loadBefore, loadAfter: load(), ...stats }
  }

  out.keys.tabOrder = await wd.execute(`return window.__nkwTabOrder('${RAIL}', '${CHAT}')`)
  out.keys.panelOrder = await wd.execute(`return window.__nkwTabOrder('${CHAT_PANEL}', '${CHAT}')`)

  // --- 1 and 2: in the tab order, and not a trap --------------------------
  //
  // The start of the walk is scripted and the walk is not: a Tab cannot be aimed at a selector,
  // and tabbing an unknown number of times to reach the container measures the count rather than
  // the target. The stop immediately before the container is focused in the page and the driver's
  // own Tab does the entering.
  const before = await wd.execute(
    `return window.__nkwTagTabStop({ root: '${RAIL}', sel: '${CHAT}', step: -1 })`,
  )
  out.keys.tab = { before, start: null, entered: null, ring: null, left: null }
  if (before?.why !== undefined || before?.target === null) {
    out.keys.tab.failure = before?.why ?? 'the container has no tab stop before it to walk in from'
  } else {
    out.keys.tab.start = await wd.execute(
      `const el = document.querySelector('[data-nkw-tabstop]');
       if (!el) return { ok: false, why: 'nothing tagged' };
       el.focus();
       return { ok: document.activeElement === el, active: window.__nkwActive() }`,
    )
    out.keys.tab.intoKeys = await pressKeys(wd, [KEY.tab])
    out.keys.tab.entered = await wd.execute(
      `const el = document.querySelector('${CHAT}');
       return { active: window.__nkwActive(), onChat: document.activeElement === el }`,
    )
    // Read on the frame the real Tab landed: the one moment the engine's own keyboard-focus
    // heuristic has decided, so the ring below is the ring a keyboard reader sees.
    out.keys.tab.ring = await wd.execute(`return window.__nkwFocusRing('${CHAT}')`)
    out.keys.tab.leaves = await pressKeys(wd, [KEY.tab])
    out.keys.tab.left = await wd.execute(
      `const el = document.querySelector('${CHAT}');
       return { active: window.__nkwActive(), stillOnChat: document.activeElement === el }`,
    )
  }

  // --- 3 and 4: focus holds the reader, then the keyboard moves them ------
  //
  // Parked MID-DOCUMENT by real wheel gestures — a container already at its clamp cannot move,
  // and "focus did not move it" would be true for a reason that has nothing to do with focus.
  // Watched AFTER the wheels, so the scroll-event count below is about the focus and nothing
  // else: the park's own events are moves the reader asked for.
  out.keys.focus = { wheelToEnd: null, wheelBack: null, parked: null, mark: null, watched: null, before: null, tab: null, after: null }
  out.keys.focus.wheelToEnd = await wheel(wd, CHAT, 60000)
  await quiet(CHAT)
  out.keys.focus.wheelBack = await wheel(wd, CHAT, -700)
  out.keys.focus.parked = await wd.execute(`return window.__nkwRead('${CHAT}')`)
  out.keys.focus.mark = await wd.execute(`return window.__nkwTagTabStop({ root: '${RAIL}', sel: '${CHAT}', step: -1 })`)
  if (out.keys.focus.mark?.target) {
    await wd.execute(`const el = document.querySelector('[data-nkw-tabstop]'); if (el) el.focus(); return true`)
    out.keys.focus.watched = await wd.execute(`return window.__nkwWatchScroll('${CHAT}')`)
    out.keys.focus.before = await wd.execute(`return window.__nkwRead('${CHAT}')`)
    out.keys.focus.tab = await pressKeys(wd, [KEY.tab])
    out.keys.focus.after = await wd.execute(`return window.__nkwRead('${CHAT}')`)
  } else {
    out.keys.focus.failure = out.keys.focus.mark?.why ?? 'the stop before the container could not be tagged'
  }

  out.keys.pageDown = { before: null, keys: null, quiet: null, after: null }
  out.keys.pageDown.before = await wd.execute(`return window.__nkwRead('${CHAT}')`)
  out.keys.pageDown.keys = await pressKeys(wd, [KEY.pageDown])
  out.keys.pageDown.quiet = await quiet(CHAT)
  out.keys.pageDown.after = await wd.execute(`return window.__nkwRead('${CHAT}')`)
  out.keys.end = { before: out.keys.pageDown.after, keys: null, quiet: null, after: null }
  out.keys.end.keys = await pressKeys(wd, [KEY.end])
  out.keys.end.quiet = await quiet(CHAT)
  out.keys.end.after = await wd.execute(`return window.__nkwRead('${CHAT}')`)

  // --- 5: the composer keeps its own keys ---------------------------------
  //
  // Both halves are asserted, because either alone passes for the wrong reason: a dead field and
  // a never-scrolled transcript are indistinguishable from a correct pair if only one is read.
  const fieldPoint = await wd.execute(
    `const el = document.querySelector('${CHAT_FIELD}');
     if (!el) return null;
     const box = el.getBoundingClientRect();
     return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + Math.min(12, box.height / 2)),
              height: Math.round(box.height), value: (el.value || '').length }`,
  )
  out.composer.field = fieldPoint
  if (fieldPoint) {
    out.composer.click = await clickAt(wd, fieldPoint.x, fieldPoint.y)
    out.composer.focus = await wd.execute('return window.__nkwActive()')
    out.composer.quietBefore = await quiet(CHAT)
    out.composer.before = await wd.execute(`return window.__nkwRead('${CHAT}')`)
    out.composer.keys = await pressKeys(wd, [KEY.pageDown, KEY.end])
    out.composer.quietAfter = await quiet(CHAT)
    out.composer.after = await wd.execute(`return window.__nkwRead('${CHAT}')`)
    out.composer.typed = await pressKeys(wd, ['x'])
    out.composer.fieldAfter = await wd.execute(
      `const el = document.querySelector('${CHAT_FIELD}');
       if (!el) return null;
       const box = el.getBoundingClientRect();
       return { height: Math.round(box.height), value: (el.value || '').length, focus: window.__nkwActive() }`,
    )
  } else {
    out.composer.failure = 'the composer field was not on screen'
  }
}

/**
 * Every tab stop on screen, asked whether it paints a ring.
 *
 * The witness is a stop that must paint, measured through the same code path in the same call —
 * `.chat-send`, whose ring the chat composer has had since before this task. Modality first: a
 * real Tab, because WebKitGTK decides `:focus-visible` from the last input's kind, and a sweep
 * run after a pointer gesture would report every control in the app as ringless.
 *
 * The other polarity is not faked here. It is `--violate chatnofocus`: one run in which the
 * witness still paints and the container does not, which is the only thing that shows the method
 * answering both ways rather than agreeing with itself.
 */
async function focusSweep(wd) {
  const out = { load: load() }
  await pressKeys(wd, [KEY.tab])
  out.sweep = await wd.execute(
    `return window.__nkwFocusSweep({ root: null, witness: arguments[0] })`,
    [CHAT_SEND],
  )
  // The container itself through the same method the sweep uses, so its ring can be read beside
  // the witness's and the two readings are comparable line for line.
  out.container = await wd.execute(`return window.__nkwFocusPaint(arguments[0])`, [CHAT])
  out.loadAfter = load()
  return out
}
