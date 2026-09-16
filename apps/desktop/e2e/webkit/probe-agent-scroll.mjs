/**
 * The agent panel's scroll policy and the rail's effect on the body, in the engine that ships.
 *
 * Two rulings are measured here, both of them product sentences rather than test names:
 *
 *   「用户上翻查看历史后暂停自动跟随，回到底部才恢复。」 — the transcript follows the stream
 *   while the reader is at its end, stops the moment they leave it, and takes their reading
 *   position back only when they return to the end themselves.
 *
 *   「面板移动、正文稳定：侧栏开合时正文不得逐帧重新换行、光标不得移动。」 — opening or
 *   closing the rail re-lays the body out ONCE, in the click frame, and the caret stays where
 *   the reader left it. `appShell.css` states the failure this forbids: a column animated by
 *   width re-wraps the body for the whole of the animation — 「打开侧栏不要让正文连续数十帧
 *   重新换行」, the user's own sentence.
 *
 * ---- Why this file exists
 *
 * Both were verified in Chromium and nowhere else. `e2e/agent-panel.spec.ts` mounts the panel
 * by hand in Playwright's Chromium and asserts on `scrollTop`; the rail's effect on the body
 * was measured once, by hand, in brief 62 — also in Chromium. The app ships WebKitGTK, and
 * neither subject is engine-free: `scrollTop` clamping, when a scroll event is delivered,
 * `ResizeObserver` timing and whether a scroll container can be reached by the keyboard at all
 * are all the engine's.
 *
 * ---- What makes a reading here worth having
 *
 *  - **Frames, not an average.** Every trace is a per-frame record and every verdict is read
 *    off the distribution: how many frames moved, by how much, and how many frames the trace
 *    managed to take at all.
 *  - **The load average stands beside every trace**, read from `/proc/loadavg` on this machine
 *    at the moment the trace ran. This box is shared with unrelated work at several hundred
 *    percent CPU, and a frame count without its load is a number nothing can be compared with.
 *  - **A blind trace is reported as blind.** Each trace carries the evidence that content
 *    actually arrived (frames sent, rows and text length before and after), that the reader was
 *    actually suspended (the container's own scroll events), and how fast the frames came. An
 *    absence of movement with none of those is not a pass — it is the failure this harness
 *    spent a day on, and it is reported as `measured: false` rather than as a green.
 *
 * ---- What is deliberately not copied from Chromium
 *
 * The spec's assertions are not restated here. There is one panel but two questions: the spec
 * asks whether the composable works when a test drives the container, and this asks what the
 * product does when a driver drives a real WebKit scroll container inside the real rail. Where
 * the two disagree, the difference is the finding.
 */
import { until } from './webdriver.mjs'
import {
  AGENT,
  BODY,
  INSTRUMENTS,
  JUMP,
  KEY,
  PANEL,
  RAIL,
  RAIL_TITLES,
  RUN,
  TIMELINE,
  load,
} from './agent-scroll-instrument.mjs'
import {
  clickAt,
  clickSelector,
  clickStatusButton,
  clickSwitchOption,
  pressKeys,
  typeInto,
  wheel,
} from './agent-scroll-driver.mjs'
import { distinct, frameStats, liveTrace, summariseFollow, summariseHeld } from './agent-scroll-readings.mjs'

/**
 * `--violate pin` / `--violate width`: a deliberate violation, so the instrument can be shown
 * failing on the thing it claims to measure.
 *
 * The brief this probe answers asks for a red rather than for a promise of one, and the only
 * honest way to produce it without touching application source is to break the property in the
 * page — a container that pins itself, or a body whose width sweeps across frames. Each
 * violation runs ONE phase and returns, so the run is a focused red: the same check, in the
 * same words, decided the other way. The output names what was injected, so a run under this
 * flag can never be mistaken for a measurement of the product.
 */
function violation() {
  const i = process.argv.indexOf('--violate')
  if (i === -1) return null
  const value = process.argv[i + 1]
  return value === undefined || value.startsWith('--') ? 'pin' : value
}

/* ---------------------------------------------------------------------------
 * The probe
 * ------------------------------------------------------------------------- */

export const agentScrollProbe = {
  name: 'agent-scroll',

  async run(wd) {
    // Asked of the page, not of a parameter: what this probe needs is a page whose agent IPC is
    // stood in for, and a run that never asked for one cannot answer the question. Skipping
    // keeps a plain `node measure.mjs` (every probe, no flags) working exactly as it did — and
    // the run's own `agent` flag is what `verify.mjs` reads to tell this skip apart from a run
    // that asked for the panel and got nothing back.
    const harness = await wd.execute(
      'return window.__NEKO_HARNESS__ ? { agent: window.__NEKO_HARNESS__.agent, scenario: window.__NEKO_HARNESS__.scenario } : null',
    )
    if (!harness) return { skipped: 'the page is not the WebKit harness' }
    if (!harness.agent) return { skipped: 'the harness is not in agent mode (run with --agent)' }

    const violated = violation()
    const out = { harness, load: load(), violation: violated, boot: {}, held: {}, resume: {}, keys: {}, rail: {} }

    await wd.execute(INSTRUMENTS)
    // The editor's live view, so the caret can be read from the model. The module is the app's
    // own and the page is the app's own dev server, so this is the handle
    // `e2e/support/editorHarness.ts` reads in Chromium.
    out.boot.editor = await wd.executeAsync(
      // The callback arrives as the LAST ARGUMENT of an async execute, never as a global: a
      // script that calls a bare `done` throws inside its own promise, the driver's 30s script
      // timeout is what reports it, and nothing in between says why.
      `const done = arguments[arguments.length - 1];
       import('/src/features/editor/session-manager.ts')
         .then(function (m) { window.__nkwEditor = m.editorSessionManager; done({ ok: true }) },
               function (e) { done({ ok: false, why: String(e) }) })`,
    )
    // Rendered mode, set rather than assumed: this probe runs after every other one, and the
    // body under the rule's second half is the rendered pane's.
    out.boot.mode = await clickSwitchOption(wd, 'Rendered')

    // Every IPC call the harness's stand-in answers, recorded. The engine's start is a chain —
    // `agent_start`, the session, the snapshot — and when the panel does not appear, which link
    // failed is the whole diagnosis. Wrapped here, in the page, rather than guessed at from the
    // rail's own words: the sentinel is what the harness already answers for, so this is a tap
    // on an existing seam and not a second stand-in.
    await wd.execute(
      `const internals = window.__TAURI_INTERNALS__;
       if (internals && !internals.__nkwWrapped) {
         const original = internals.invoke;
         window.__nkwInvokes = [];
         internals.invoke = function (cmd, args) {
           const entry = { cmd: cmd, args: JSON.stringify(args || {}).slice(0, 120) };
           window.__nkwInvokes.push(entry);
           let result;
           try { result = original.apply(internals, arguments); }
           catch (e) { entry.threw = String(e && e.message ? e.message : e); return Promise.reject(e); }
           if (result && typeof result.then === 'function') {
             return result.then(
               function (value) { entry.ok = true; return value; },
               function (error) { entry.failed = String(error && error.message ? error.message : error); throw error; });
           }
           entry.ok = true;
           return result;
         };
         internals.__nkwWrapped = true;
       }
       return true`,
    )

    out.boot.rail = await clickStatusButton(wd, RAIL_TITLES)
    if (!out.boot.rail?.ok) {
      out.boot.failure = 'the rail toggle could not be found in the status bar'
      return out
    }
    try {
      await until(() => wd.execute(`return Boolean(document.querySelector('${TIMELINE}'))`), {
        timeout: 20_000,
        what: 'the agent panel to mount in the rail',
      })
    } catch (error) {
      out.boot.failure = String(error.message || error)
      out.boot.state = await wd.execute('return window.__nkwPanelState()')
      out.boot.railText = await wd.execute(
        `const body = document.querySelector('.rail-body') || document.querySelector('.info-rail');
         return body ? body.textContent.trim().slice(0, 400) : null`,
      )
      out.boot.invokes = await wd.execute('return (window.__nkwInvokes || []).slice(-25)')
      return out
    }
    out.boot.loadAfterMount = load()
    out.boot.mounted = await wd.execute('return window.__nkwPanelState()')

    // A live turn, taken through the composer: the panel's own send path is what names a run,
    // and a run nobody started is not the state the ruling is about. Typed with the driver's own
    // input (`/element/…/value`), which is the engine's key path rather than a value write.
    try {
      out.boot.typed = await typeInto(wd, '.agent-composer-field', 'go')
      if (!out.boot.typed.ok) throw new Error(`the composer could not be typed into: ${out.boot.typed.why}`)
      await clickSelector(wd, '.agent-composer [data-action="send"]')
      await until(() => wd.execute(`return Boolean(${AGENT}) && ${AGENT}.runId() !== null`), {
        timeout: 10_000,
        what: 'the host to answer a run id',
      })
      out.boot.runId = await wd.execute(`return ${AGENT}.runId()`)
    } catch (error) {
      // Reported, not fatal: the frames below carry the run id explicitly, so the panel still
      // receives a stream. What is lost is the composer's own path, and that is said out loud.
      out.boot.sendFailed = String(error.message || error)
    }

    // The bulk a run produces before the reader looks away, so the transcript can scroll.
    await wd.execute(`return window.__nkwSeed({ prefix: 'seed', count: 40, runId: arguments[0] })`, [RUN])
    try {
      await until(
        () =>
          wd.execute(
            `const sh = document.querySelector('${TIMELINE}');
             return Boolean(sh) && sh.scrollHeight > sh.clientHeight + 50`,
          ),
        { timeout: 15_000, what: 'a transcript with something to scroll' },
      )
    } catch (error) {
      out.boot.failure = String(error.message || error)
      out.boot.state = await wd.execute('return window.__nkwPanelState()')
      return out
    }
    out.boot.seeded = await wd.execute('return window.__nkwPanelState()')

    // ---- The rule's first half: a reader who scrolled up is not moved ---------
    //
    // The park is attempted as the reader's own gesture first — a wheel, which the engine acts
    // on because the driver sent it — and falls back to a written offset only if this driver
    // has no wheel action. Which one happened is recorded, because only one of them is the
    // reader's hand.
    await wd.execute(`return window.__nkwWatchScroll('${TIMELINE}')`)
    const wheelUp = await wheel(wd, TIMELINE, -320)
    const parked = await wd.executeAsync(
      `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 }, arguments[arguments.length - 1])`,
      [TIMELINE, JUMP],
    )
    const parkWheeled = wheelUp.ok && parked?.max - parked?.scrollTop >= 8
    const park = parkWheeled
      ? { by: 'wheel', ...parked }
      : {
          by: 'write',
          wheel: wheelUp,
          ...(await wd.executeAsync(
            `window.__nkwPark({ sel: arguments[0], up: 320, jump: arguments[1] }, arguments[arguments.length - 1])`,
            [TIMELINE, JUMP],
          )),
        }
    out.held = { park, load: load() }
    if (!park?.scrollTop || park.max - park.scrollTop < 8) {
      out.held.failure = 'the transcript could not be parked away from its end'
      // Nothing below can be measured without a reader who has left the end, and saying so is
      // the point: a resume trace from an unparked container would be measuring the container's
      // own drift and calling it a route.
      return out
    }

    // The deliberate violation, installed after the park and before the trace: the reader is
    // where they were and the container takes them away from it, in the frames.
    if (violated === 'pin') out.held.injected = await wd.execute(`return window.__nkwViolatePin('${TIMELINE}')`)
    const heldTrace = await wd.executeAsync(
      `window.__nkwStream({ sel: arguments[0], jump: arguments[1], ms: 1600, every: 2, count: 24,
                            prefix: 'under', runId: arguments[2] }, arguments[arguments.length - 1])`,
      [TIMELINE, JUMP, RUN],
    )
    out.held.trace = summariseHeld(heldTrace)
    out.held.live = liveTrace(out.held.trace)
    out.held.stateAfter = await wd.execute('return window.__nkwPanelState()')
    out.held.loadAfter = load()
    // One focus of the run, so the red is that check and nothing else.
    if (violated === 'pin') return out

    // ---- Returning to the end, by each route the panel offers -----------------
    //
    // Three, each driven the way a reader drives it: the hint button through the driver, the
    // scroll by a wheel gesture, and the keyboard through the driver's key actions. What each
    // route claims is not "the container reached its end" but "the arrivals after it are
    // followed" — a container that lands at the end and then ignores the stream has resumed
    // nothing.
    out.resume.affordance = await resumeBy(wd, 'jump', async () => {
      const before = await wd.execute('return window.__nkwPanelState()')
      await clickSelector(wd, JUMP)
      const settled = await wd.executeAsync(
        `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      return { before, settled }
    })

    out.resume.scroll = await resumeBy(wd, 'scroll', async () => {
      const parked = await wd.executeAsync(
        `window.__nkwPark({ sel: arguments[0], up: 320, jump: arguments[1] }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      const down = await wheel(wd, TIMELINE, 6000)
      let settled = await wd.executeAsync(
        `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      // A wheel the driver could not send is a route that was never taken, and the written
      // fallback is recorded as the fallback it is rather than passed off as the gesture.
      let fallback = null
      if (!down.ok || settled.max - settled.scrollTop > 2) {
        fallback = await wd.executeAsync(
          `window.__nkwToEnd({ sel: arguments[0], jump: arguments[1] }, arguments[arguments.length - 1])`,
          [TIMELINE, JUMP],
        )
        settled = { ...fallback, rows: null, text: null }
      }
      return { parked, wheel: down, settled, fallback }
    })

    out.resume.keyboard = await resumeBy(wd, 'keyboard', async () => {
      // Two measurements, and only the second one is the verdict.
      //
      // The first is what the container does when a reader whose attention is on the transcript
      // presses PageDown and End. It is REPORTED and not decided on, because it is not stable
      // here: one run of this probe left the container exactly where it was (3088 of 3427) and
      // the next scrolled it to the end (3425 of 3427), and a gate that passes or fails with
      // the wind is not a gate. What varies is the engine's own reading of a focused control
      // inside a scroller, and the honest thing to do with a number like that is to print it.
      //
      // The second is the route the panel actually offers: its hint is a native button, so it
      // is in the tab order and Enter activates it. Focused through the DOM and activated by a
      // real Enter — the activation is the engine's own key path, the focus is scripted, and
      // `activation.by` below says so.
      const parked = await wd.executeAsync(
        `window.__nkwPark({ sel: arguments[0], up: 320, jump: arguments[1] }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      // Two arrivals, so the hint the keyboard has to reach is on screen: it is drawn only
      // while the reader is suspended AND something has arrived since they left.
      await wd.execute(`window.__nkwSeed({ prefix: 'keys', count: 2, runId: arguments[0] }); return true`, [RUN])
      await wd.executeAsync(
        `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      // The reader's own act of moving their attention to the transcript: a click on the text
      // they are reading. Which control takes the focus afterwards is the engine's answer and
      // is reported — it is the difference between "the keys went somewhere else" and "the
      // keys arrived and the container did not move".
      const rowPoint = await wd.execute(
        `const sh = document.querySelector('${TIMELINE}');
         if (!sh) return null;
         const box = sh.getBoundingClientRect();
         const rows = Array.from(sh.children).map(function (row) {
           const r = row.getBoundingClientRect();
           return { el: row, top: r.top, bottom: r.bottom };
         }).filter(function (r) { return r.top > box.top + 8 && r.bottom < box.bottom - 8; });
         const target = rows.length ? rows[Math.floor(rows.length / 2)] : null;
         return { x: Math.round(box.left + box.width / 2),
                  y: Math.round(target ? (target.top + target.bottom) / 2 : box.top + box.height / 2),
                  className: target ? target.el.className : '(the container)',
                  visibleRows: rows.length }`,
      )
      const clicked = rowPoint ? await clickAt(wd, rowPoint.x, rowPoint.y) : { ok: false, why: 'no transcript' }
      const focused = await wd.execute('return window.__nkwCaret()')
      // What the DOM says about the two controls the keys could act on: the container is not in
      // the tab order (`tabIndex -1`, and the panel sets no `tabindex`), the hint is.
      const tabbables = await wd.execute(
        `const nodes = ['.agent-timeline', '.agent-jump', '.agent-composer-field',
                        '.agent-composer [data-action="send"]', '.agent-composer [data-action="stop"]']
           .map(function (sel) {
             const el = document.querySelector(sel);
             if (!el) return { sel: sel, exists: false };
             const rect = el.getBoundingClientRect();
             return { sel: sel, exists: true, tabIndex: el.tabIndex, disabled: Boolean(el.disabled),
                      inertAncestor: Boolean(el.closest('[inert]')), rects: el.getClientRects().length,
                      top: Math.round(rect.top), height: Math.round(rect.height) };
           });
         return { nodes: nodes,
                  inertSubtrees: Array.from(document.querySelectorAll('[inert]')).map(function (el) {
                    return el.className || el.tagName;
                  }) }`,
      )
      await wd.execute(
        `window.__nkwKeys = [];
         if (!window.__nkwKeyWatch) {
           window.__nkwKeyWatch = true;
           window.addEventListener('keydown', function (e) { window.__nkwKeys.push(e.key); }, true);
         }
         window.__nkwKeys.length = 0;
         return true`,
      )
      // PageDown then End: two rungs of the same gesture, so a container that only takes the
      // larger step is still measured on the smaller one.
      const keys = await pressKeys(wd, [KEY.pageDown, KEY.end])
      const keysSeenByThePage = await wd.execute('return window.__nkwKeys')
      const afterKeys = await wd.executeAsync(
        `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )

      // Then the route this check is about, from a fresh park: the reader is away from the end
      // again, content has arrived, and the hint is the thing they press.
      const reparked = await wd.executeAsync(
        `window.__nkwPark({ sel: arguments[0], up: 320, jump: arguments[1] }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      await wd.execute(`window.__nkwSeed({ prefix: 'keys2', count: 2, runId: arguments[0] }); return true`, [RUN])
      const hintPresent = await wd.executeAsync(
        `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      const activation = { by: null, focus: null, enter: null }
      activation.focus = await wd.execute(
        `const el = document.querySelector('${JUMP}');
         if (!el) return { ok: false, why: 'the hint is not on screen' };
         el.focus();
         return { ok: document.activeElement === el, tabIndex: el.tabIndex }`,
      )
      if (activation.focus.ok) {
        activation.by = 'focus+enter'
        activation.enter = await pressKeys(wd, [KEY.enter])
      }
      const settled = await wd.executeAsync(
        `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 }, arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      return {
        parked, row: rowPoint, clicked, focused, tabbables,
        keys, keysSeenByThePage, afterKeys,
        reparked, hintPresent, activation, settled,
      }
    })

    // ---- The transcript as a surface the keyboard can reach -------------------
    //
    // The rule the three routes above do not cover: 「用户上翻查看历史后暂停自动跟随」 presumes a
    // reader who CAN scroll up, and until now nothing in the panel gave the keyboard one. The
    // hint is a route to the END; the rows above the fold had no keyboard route at all.
    out.keys = await keyboardPhase(wd, violated)

    // ---- The rule's second half: the rail, the body and the caret ------------
    //
    // Last, because closing the rail unmounts the panel and one of the two traces below must
    // measure exactly that. Every step is guarded: the phases above have already produced
    // their numbers, and an exception thrown out of here would take the whole run's JSON with
    // it — which is the shape of failure this harness exists to refuse.
    out.rail.load = load()
    try {
      // The caret, put in the body by a real click where a reader would click — the first
      // block that is actually on screen, since the note is longer than the pane.
      const point = await wd.execute(
        `const root = document.querySelector('${BODY}');
         if (!root) return null;
         const blocks = Array.from(root.children);
         for (let i = 0; i < blocks.length; i++) {
           const box = blocks[i].getBoundingClientRect();
           if (box.height > 0 && box.top > 60 && box.bottom < innerHeight - 60) {
             return { x: box.left + 30, y: box.top + Math.min(10, box.height / 2),
                      index: i, tag: blocks[i].tagName };
           }
         }
         return null`,
      )
      out.rail.caretPoint = point
      out.rail.caretClick = point ? await clickAt(wd, point.x, point.y) : { ok: false, why: 'no visible block' }
      out.rail.caretBefore = await wd.execute('return window.__nkwCaret()')
      // The other deliberate violation: a body whose width sweeps across frames. Installed
      // after the caret is placed, so the trace under it is the trace the check reads.
      if (violated === 'width') out.rail.injected = await wd.execute('return window.__nkwViolateWidth()')
      out.rail.close = await railTrace(wd, 'close', clickStatusButton)
      if (violated !== 'width') out.rail.open = await railTrace(wd, 'open', clickStatusButton)
      out.rail.caretAfter = await wd.execute('return window.__nkwCaret()')
    } catch (error) {
      out.rail.failure = String(error.message || error)
    }
    out.rail.stateAfter = await wd.execute('return window.__nkwPanelState()')
    out.rail.loadAfter = load()
    return out
  },
}

/**
 * The transcript as a keyboard-reachable surface, measured in five parts.
 *
 * The gap this answers, stated as the reader's own problem: a scroll container that is not a
 * tab stop has no keyboard route at all. The hint is a route to the END of the log; the rows
 * above the fold — the ones a reader who has already read the recent part is going back to —
 * had none. 「用户上翻查看历史后暂停自动跟随」 presumes the reader CAN scroll up, and by keyboard
 * they could not.
 *
 * Five claims, in the order a reader would make them:
 *
 *  1. **the container is a tab stop**, read from the DOM, and a real Tab chord lands on it from
 *     the stop before it — the driver's key, so the engine's own tab walk is what is measured;
 *  2. **it is not a trap**: a real Tab from the container leaves it. A `tabindex` with a
 *     keydown handler that swallowed Tab would show up here and nowhere else;
 *  3. **receiving focus does not move the reader.** Focusing a scrollable box can scroll it,
 *     and 「读者在看的那几行不能被挪动」 is a ruling this same probe measures elsewhere. Read
 *     as an offset that did not change AND a scroll-event count that did not grow: a held
 *     reader and a container nothing was asked of look identical in `scrollTop` alone;
 *  4. **the keyboard scrolls it**: a real PageDown moves the container, a real End reaches its
 *     end. This is the claim the whole phase exists for, and it is the one the probe previously
 *     refused to make — the number was unstable (3088 … 3426 of 3427 across four runs) because
 *     focus was on a control INSIDE the scroller, which is a different question;
 *  5. **nothing else lost a key.** The composer is given focus and sent the same two keys: the
 *     transcript must not move, and the field must still receive what is typed into it — the
 *     "a new focusable region swallows keys meant for the input" failure. Then the permission
 *     prompt, which the code calls the one thing the reader has to act on, is raised and must
 *     take focus on arrival exactly as it did before.
 */
async function keyboardPhase(wd, violated) {
  const out = { load: load() }
  // The deliberate violation, installed before the DOM is read so the whole phase runs against
  // the defect rather than against the fix: the tab-order reading, the Tab walk and the key
  // scroll all go red together, and the composer and permission halves below stay as they were
  // — which is what says the phase's red is about the tab stop and not about the panel.
  if (violated === 'nofocus') {
    out.injected = await wd.execute(`return window.__nkwViolateNoFocus('${TIMELINE}')`)
  }
  // Every key below is read through this, and it is the difference between the phase working and
  // the phase reporting an easing curve: WebKitGTK animates a keyboard scroll, so a fixed-frame
  // settle reads the container mid-flight. See `__nkwQuiet`.
  //
  // Each call is stamped with the load it ran under, and the frame deltas become the same
  // p50/p95/max distribution every other trace in this harness reports: a settle that took
  // seventeen frames on a machine at load 10 is a different reading from one that took
  // seventeen frames on an idle box, and only the pair says which happened.
  const quiet = async () => {
    const loadBefore = load()
    const settled = await wd.executeAsync(
      `window.__nkwQuiet({ sel: arguments[0] }, arguments[arguments.length - 1])`,
      [TIMELINE],
    )
    if (!settled?.deltas) return { ...settled, loadBefore, load: load() }
    const stats = frameStats(settled.deltas.map((dt) => ({ dt })))
    const { deltas, ...rest } = settled
    return { ...rest, loadBefore, loadAfter: load(), ...stats }
  }
  // Where the container sits among the panel's tab stops, before any gesture: the DOM's answer
  // to "is this reachable", which is what a browser-authored suite would assert and what this
  // probe does not stop at.
  out.tabOrder = await wd.execute(`return window.__nkwTabOrder('${RAIL}', '${TIMELINE}')`)
  out.panelOrder = await wd.execute(`return window.__nkwTabOrder('${PANEL}', '${TIMELINE}')`)

  // --- 1 and 2: in the tab order, and not a trap --------------------------
  //
  // The start of the walk is scripted and the walk is not: a Tab cannot be aimed at a selector,
  // and tabbing an unknown number of times to reach the container would be measuring the count
  // rather than the target. So the stop immediately BEFORE the container is focused in the
  // page, and the driver's own Tab does the entering — the same honesty split §3.2's keyboard
  // route uses for the hint, and `by` says which half was which.
  const before = await wd.execute(
    `return window.__nkwTagTabStop({ root: '${RAIL}', sel: '${TIMELINE}', step: -1 })`,
  )
  out.tab = { before, start: null, intoKeys: null, entered: null, leavesKeys: null, left: null }
  if (before?.why !== undefined || before?.target === null) {
    out.tab.failure = before?.why ?? 'the container has no tab stop before it to walk in from'
  } else {
    out.tab.start = await wd.execute(
      `const el = document.querySelector('[data-nkw-tabstop]');
       if (!el) return { ok: false, why: 'nothing tagged' };
       el.focus();
       return { ok: document.activeElement === el, active: window.__nkwActive() }`,
    )
    out.tab.intoKeys = await pressKeys(wd, [KEY.tab])
    out.tab.entered = await wd.execute(
      `const el = document.querySelector('${TIMELINE}');
       return { active: window.__nkwActive(), onTimeline: document.activeElement === el }`,
    )
    // Read here, on the frame the real Tab landed on: this is the one moment in the run when the
    // engine's own keyboard-focus heuristic has decided, so the ring below is the ring a keyboard
    // reader sees and not a rule in a stylesheet.
    out.tab.ring = await wd.execute(`return window.__nkwFocusRing('${TIMELINE}')`)
    // The same key again, from the container. It must not land back on the container: that is
    // what a trap looks like, and no key handler here is allowed to produce one.
    out.tab.leavesKeys = await pressKeys(wd, [KEY.tab])
    out.tab.left = await wd.execute(
      `const el = document.querySelector('${TIMELINE}');
       return { active: window.__nkwActive(), stillOnTimeline: document.activeElement === el }`,
    )
  }

  // --- 3 and 4: focus holds the reader, then the keyboard moves them ------
  //
  // Parked with real wheel gestures, because the claim is about a reader who has left the end
  // and the panel has to have learned that: an unparked container's `scrollTop` staying put
  // while focus lands would be measuring nothing. Parked MID-DOCUMENT rather than at the top,
  // because a container already at its own clamp cannot move and "focus did not move it" would
  // be true for a reason that has nothing to do with focus. The Tab that follows is a real one,
  // so what is measured is the engine's own focus behaviour and not a scripted `focus()` call.
  out.focus = { wheelToEnd: null, wheelBack: null, parked: null, mark: null, watched: null, before: null, tab: null, after: null }
  out.focus.wheelToEnd = await wheel(wd, TIMELINE, 6000)
  await quiet()
  out.focus.wheelBack = await wheel(wd, TIMELINE, -900)
  out.focus.parked = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
  // Re-tag: the walk above left its tag behind, and the tag is how a known element is focused
  // before the driver's own Tab does the entering.
  out.focus.mark = await wd.execute(`return window.__nkwTagTabStop({ root: '${RAIL}', sel: '${TIMELINE}', step: -1 })`)
  if (out.focus.mark?.target) {
    await wd.execute(
      `const el = document.querySelector('[data-nkw-tabstop]'); if (el) el.focus(); return true`,
    )
    // Watched AFTER the wheels, so the count below is about the focus and nothing else: the
    // park's own events are moves the reader asked for, and counting them would hide it.
    out.focus.watched = await wd.execute(`return window.__nkwWatchScroll('${TIMELINE}')`)
    out.focus.before = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
    out.focus.tab = await pressKeys(wd, [KEY.tab])
    out.focus.after = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
  } else {
    out.focus.failure = out.focus.mark?.why ?? 'the stop before the container could not be tagged'
  }

  // PageDown, then End: two rungs of the same gesture, so a container that only takes the
  // larger step is measured on the smaller one too. Each is read after the box has stopped.
  out.pageDown = { keys: null, quiet: null, before: null, after: null }
  out.pageDown.before = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
  out.pageDown.keys = await pressKeys(wd, [KEY.pageDown])
  out.pageDown.quiet = await quiet()
  out.pageDown.after = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
  out.end = { keys: null, quiet: null, before: null, after: null, read: null }
  out.end.before = out.pageDown.after
  out.end.keys = await pressKeys(wd, [KEY.end])
  out.end.quiet = await quiet()
  out.end.after = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
  out.end.read = out.end.after

  // --- 5: the keys the composer needs still reach the composer ------------
  //
  // The failure a new tab stop is most likely to cause is not a trap but a leak: focus in the
  // transcript, and a key the reader meant for the field arrives in the log instead. Both
  // halves are measured — the transcript must not move, and the field must still take what is
  // typed into it — because either one alone passes for the wrong reason.
  out.composer = { field: null, click: null, focus: null, quietBefore: null, before: null, keys: null, quietAfter: null, after: null, typed: null, fieldAfter: null }
  const fieldPoint = await wd.execute(
    `const el = document.querySelector('.agent-composer-field');
     if (!el) return null;
     const box = el.getBoundingClientRect();
     return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + Math.min(12, box.height / 2)),
              height: Math.round(box.height), value: (el.value || '').length }`,
  )
  out.composer.field = fieldPoint
  if (fieldPoint) {
    out.composer.click = await clickAt(wd, fieldPoint.x, fieldPoint.y)
    out.composer.focus = await wd.execute('return window.__nkwActive()')
    // Quiet first: `End` above left the container at its end and the box may still have been
    // moving. A baseline taken mid-animation would credit the composer's keys with the tail of
    // the earlier gesture — which is exactly the mistake this measurement exists to avoid.
    out.composer.quietBefore = await quiet()
    out.composer.before = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
    out.composer.keys = await pressKeys(wd, [KEY.pageDown, KEY.end])
    out.composer.quietAfter = await quiet()
    out.composer.after = await wd.execute(`return window.__nkwRead('${TIMELINE}')`)
    // A character, through the driver's own keys: the field is where it has to land.
    out.composer.typed = await pressKeys(wd, ['x'])
    out.composer.fieldAfter = await wd.execute(
      `const el = document.querySelector('.agent-composer-field');
       if (!el) return null;
       const box = el.getBoundingClientRect();
       return { height: Math.round(box.height), value: (el.value || '').length, focus: window.__nkwActive() }`,
    )
  } else {
    out.composer.failure = 'the composer field was not on screen'
  }

  // --- 5b: the prompt that has to be answered still takes focus -----------
  //
  // 「the one thing the reader has to act on」, in the code's own words. It focuses its own root
  // on arrival, deliberately not an option button; a change that made the transcript grab focus
  // would show up here as the focus landing anywhere but the prompt. Raised LAST, because a
  // request puts the run into `waiting-permission` and a survey of the other surfaces is not
  // something to perturb with it.
  out.permission = { sent: null, mounted: null, active: null, inside: null, tab: null, afterTab: null }
  try {
    out.permission.sent = await wd.execute(
      `return window.__nkwAskPermission({ requestId: 'probe-perm-1', prefix: 'perm', runId: arguments[0] })`,
      [RUN],
    )
    out.permission.mounted = await until(
      () => wd.execute(`return Boolean(document.querySelector('.agent-perm'))`),
      { timeout: 5000, what: 'the permission prompt to mount' },
    )
    // One frame more than the mount: the prompt focuses itself in `nextTick`, and reading the
    // active element in the same tick as the element appearing would read the element before.
    await wd.executeAsync(
      `(function (done) { let n = 0; const tick = function () { if (++n >= 3) done(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })(arguments[arguments.length - 1])`,
    )
    out.permission.active = await wd.execute('return window.__nkwActive()')
    out.permission.inside = await wd.execute(
      `const root = document.querySelector('.agent-perm');
       return { exists: Boolean(root), focusInside: Boolean(root) && root.contains(document.activeElement) }`,
    )
    out.permission.tab = await pressKeys(wd, [KEY.tab])
    out.permission.afterTab = await wd.execute('return window.__nkwActive()')
  } catch (error) {
    out.permission.failure = String(error.message || error)
  }

  out.loadAfter = load()
  return out
}

/**
 * One resume route, measured end to end.
 *
 * The route's own act is `act()`. What is measured is whether the container reached its end,
 * whether the hint went away, and — the half that actually states the rule — whether the NEXT
 * arrivals are followed. A route that never reached the end is reported with `follow: null`
 * rather than papered over with a stream that would then be measuring the container's own
 * position.
 */
async function resumeBy(wd, name, act) {
  const out = { route: name, load: load() }
  try {
    out.act = await act()
  } catch (error) {
    out.failure = String(error.message || error)
    return out
  }
  const settled = out.act?.settled ?? null
  out.reachedEnd = Boolean(settled) && settled.max - settled.scrollTop <= 2
  out.hintGone = Boolean(settled) && settled.jump === false
  if (!out.reachedEnd) {
    out.follow = null
    out.loadAfter = load()
    return out
  }
  try {
    const trace = await wd.executeAsync(
      `window.__nkwStream({ sel: arguments[0], jump: arguments[1], ms: 1200, every: 2, count: 16,
                            prefix: arguments[2], runId: arguments[3] }, arguments[arguments.length - 1])`,
      [TIMELINE, JUMP, `after-${name}`, RUN],
    )
    out.follow = summariseFollow(trace)
    out.follow.live = liveTrace(out.follow)
  } catch (error) {
    // One route failing must not take the other two, or the JSON, with it.
    out.follow = null
    out.followFailure = String(error.message || error)
  }
  out.loadAfter = load()
  return out
}

/**
 * One rail trace: the sampler runs, the toggle is clicked into it, and the frames are collected.
 *
 * The order is the one `probe-motion.mjs` uses, for the same reason — WebDriver runs one command
 * at a time, so a trace that waited for its own click would be measuring the round trip. The
 * sampler is installed and started first; the click lands inside its window; the frames are read
 * afterwards.
 */
async function railTrace(wd, direction, click) {
  const trace = { direction, load: load() }
  const running = wd.executeAsync(
    `window.__nkwPanel({ body: '${BODY}', rail: '.info-rail', panel: '${PANEL}', ms: 1400 },
                        arguments[arguments.length - 1])`,
  )
  await new Promise((resolve) => setTimeout(resolve, 120))
  trace.click = await click(wd, RAIL_TITLES)
  const collected = await running
  trace.stateAfter = await wd.execute('return window.__nkwPanelState()')
  trace.loadAfter = load()
  const frames = collected.frames ?? []
  trace.frames = frameStats(frames)
  trace.widths = distinct(frames.map((f) => f.bodyWidth))
  trace.widthChangedFrames = frames.filter((f, i) => i > 0 && f.bodyWidth !== frames[i - 1].bodyWidth).length
  trace.firstWidthChangeT = (frames.find((f, i) => i > 0 && f.bodyWidth !== frames[i - 1].bodyWidth) ?? {}).t ?? null
  trace.paragraphHeights = distinct(frames.map((f) => `${f.p0}/${f.p20}`))
  trace.heads = distinct(frames.map((f) => f.head))
  trace.ranges = distinct(frames.map((f) => f.ranges))
  trace.focus = distinct(frames.map((f) => f.focus))
  trace.rail = distinct(frames.map((f) => f.rail))
  trace.panel = distinct(frames.map((f) => f.panel))
  trace.trace = frames.map((f) => `t${f.t} w${f.bodyWidth} h${f.bodyHeight} p0${f.p0} head${f.head} rail${f.rail}`)
  return trace
}

