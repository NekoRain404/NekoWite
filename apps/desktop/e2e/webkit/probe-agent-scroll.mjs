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
import { FOCUS_INSTRUMENTS } from './focus-instrument.mjs'
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
import { elapsedPhase, followSwitchPhase, transcriptControlsPhase } from './agent-controls-phase.mjs'
import { searchPhase } from './agent-search-phase.mjs'

/**
 * `--violate pin` / `--violate width` / `--violate search`: a deliberate violation, so the
 * instrument can be shown failing on the thing it claims to measure.
 *
 * The brief this probe answers asks for a red rather than for a promise of one, and the only
 * honest way to produce it without touching application source is to break the property in the
 * page — a container that pins itself, a body whose width sweeps across frames, or a find control
 * whose press reaches nothing. `pin` and `width` run ONE phase and return, so their red is focused;
 * `search` deliberately does not, because the bar it breaks is the only thing the later phases do
 * not use — a run under it decides the search checks against a window with no box in it and leaves
 * every other check measuring what it always measured. The output names what was injected, so a
 * run under this flag can never be mistaken for a measurement of the product.
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
    // The focus instruments are a second script because they are a second subject; the
    // scripts are one-way — this one reads __nkwTabStops, the enumeration INSTRUMENTS owns.
    await wd.execute(FOCUS_INSTRUMENTS)
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
    //
    // `at` is stamped here because one reading downstream needs it: the turn the panel times for
    // row 37's elapsed half begins at the `agent_prompt` the composer's send made, and the page's
    // own clock is the only one both sides of that measurement share.
    await wd.execute(
      `const internals = window.__TAURI_INTERNALS__;
       if (internals && !internals.__nkwWrapped) {
         const original = internals.invoke;
         window.__nkwInvokes = [];
         internals.invoke = function (cmd, args) {
           const entry = { cmd: cmd, args: JSON.stringify(args || {}).slice(0, 120), at: Date.now() };
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
    // The find bar's own control, read here because this is the only moment in the run when the
    // transcript is EMPTY. The bar is drawn only when there is something to search — a field over
    // a log with no rows is a control that cannot act — and the same decision is what the history
    // popup keeps for its own box (`AgentSessionHead`'s `searchable`). Read from the DOM rather
    // than from the component, because "not drawn when there is nothing to narrow" is a claim
    // about the window.
    out.boot.emptyTranscript = await wd.execute(
      `const control = document.querySelector('[data-timeline-control="search"]');
       const bar = document.querySelector('[data-agent-search]');
       const rows = document.querySelector('${TIMELINE}');
       return { rows: rows ? rows.children.length : null,
                control: Boolean(control), bar: Boolean(bar) }`,
    )
    out.boot.listeners = await wire(wd)

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

    // ---- The transcript's own control row -------------------------------------
    //
    // Rows 36 and 38 of the gap audit, measured at the point in the run where a transcript that
    // is following at its end already exists: the copy / navigation controls the panel did not
    // have, and the switch over following that it had behaviour for and no control over. Both
    // phases are their own file at the line budget, and both drive the controls through the
    // driver's own pointer rather than through the page's `click()`.
    out.switch = await followSwitchPhase(wd, RUN)
    out.controls = await transcriptControlsPhase(wd)

    // ---- The find bar, from the control beside them ---------------------------
    //
    // The transcript's third way around a long log, and the only one that had no gesture at all
    // (the audit's row 12, second half). Its own file at the line budget, and it runs here because
    // a log with something in it already exists and the reader is parked somewhere in the middle
    // — which is the state every claim in that phase is about.
    out.search = await searchPhase(wd, RUN, violated)

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

    // ---- The composer's own row at the rail's narrow end ----------------------
    //
    // Last of all, because it is the only phase that CHANGES the rail's width, and every phase
    // above measures a transcript whose scrollHeight depends on how wide the panel is. At
    // `RAIL_WIDTH_MIN` the composer's bar — the `+`, the hint, the session's own config
    // controls, and the send button — is asked to fit in 204px, and the controls are the widest
    // thing in it. The numbers this phase returns are the ones the checks in `verify.mjs` read.
    out.fit = await fitPhase(wd)

    // ---- The turn's own stats: what it cost and what it took ------------------
    //
    // Last of all because it *ends* the run the probe has been driving: the elapsed half (row 37)
    // can only be read off a turn that finished, and every phase above wants a live run.
    out.elapsed = await elapsedPhase(wd, RUN)

    // ---- The rail toggled inside its own leave ---------------------------------
    //
    // Last of all, because it is the one phase that can leave the panel on screen with no
    // subscription — and a panel in that state receives nothing, which every phase above would
    // then be measuring. See the phase for what it is a candidate for.
    out.retoggle = await retogglePhase(wd, clickStatusButton)
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
  const trace = { direction, load: load(), listenersBefore: await wire(wd) }
  const running = wd.executeAsync(
    `window.__nkwPanel({ body: '${BODY}', rail: '.info-rail', panel: '${PANEL}', ms: 1400 },
                        arguments[arguments.length - 1])`,
  )
  await new Promise((resolve) => setTimeout(resolve, 120))
  trace.click = await click(wd, RAIL_TITLES)
  const collected = await running
  trace.stateAfter = await wd.execute('return window.__nkwPanelState()')
  trace.listenersAfter = await wire(wd)
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

/* ---------------------------------------------------------------------------
 * The composer's bar, at every width the rail can be dragged to
 *
 * ---- The defect this measures
 *
 * `RAIL_WIDTH_MIN` is 220 (`src/stores/appearance-schema.ts`), the default is 300, and the bar
 * below the composer's field holds four things: the `+`, the hint, the session's own config
 * controls, and the send button. The controls are the widest of them, and they were given
 * `flex: 0 0 auto` — a row that may take whatever it needs and NEVER give any of it back. Below
 * the width at which the four of them fit (268px of panel, measured), the bar overflows its own
 * box, and the thing that goes over the edge is the one control the reader cannot do without:
 * the send button. It is not clipped, it is not scrolled to — it is drawn past the window's
 * right edge, where a pointer cannot reach it at all.
 *
 * ---- What is read, and why these numbers
 *
 *  - **the bar's own two widths.** `scrollWidth > clientWidth` is the overflow, in the engine's
 *    own arithmetic, and it is the coarse question.
 *  - **the action button's box against the viewport**, and the element the ENGINE's hit test
 *    answers at its centre (`elementFromPoint`). This is the same question Playwright's
 *    actionability check asks before it clicks: an element whose centre belongs to something
 *    else is not clickable, however visible its left edge is.
 *  - **the row's own box and each chip's**, so a bar that fits because the controls vanished is
 *    told apart from one that fits because they wrapped.
 *  - **the composer's height and the field's**, because "it fits" is not a pass if the way it
 *    fits is a stack of one chip per line.
 *
 * ---- How the width is applied
 *
 * Through the product's own setter when the page can reach it — `useAppearanceStore()
 * .setRailWidth`, which is exactly what the rail's drag handle calls — and through the Custom
 * property `AppShell` renders that value into when it cannot. Which path was taken is reported
 * rather than assumed: a page where the store is unreachable and the property was written by
 * hand is a weaker reading, and the difference has to be visible.
 * ------------------------------------------------------------------------- */

/** The widths swept: the whole of `[RAIL_WIDTH_MIN, RAIL_WIDTH_DEFAULT]` at 2px, then the
 *  rungs above it that a reader actually drags to. `220` and `300` are `appearance-schema.ts`'s
 *  own numbers; `268` is the width the Chromium reading found the bar first fitting at. */
function fitWidths() {
  const widths = []
  for (let w = 220; w <= 300; w += 2) widths.push(w)
  for (const w of [320, 360, 480, 640]) widths.push(w)
  return widths
}

/**
 * One width: apply it, then read the composer.
 *
 * Synchronous on purpose. The width arrives as a Custom property (or through the reactive store,
 * which writes it in the same turn), and reading a rect is what makes WebKit lay the page out —
 * so the numbers below are the layout of the width just applied, with no frame to wait for and
 * no chance of reading the previous one. Nothing in the rail animates its width: `appShell.css`
 * says so in as many words ("The layout collapses in the frame the user acts"), and the only
 * transitions on it are `opacity` on enter and leave.
 *
 * The width is applied in its own step, and it WAITS, because the two paths are not the same
 * shape: a Custom property written by hand lands before the next line, while the store's value
 * reaches the DOM through a Vue render, which is a microtask away. The first version of this
 * probe read straight after the setter and every reading was one width stale — a sweep that
 * looked like it had measured 220 twice and 640 as 480. The wait is on the rendered property,
 * not on a guess: it polls until `AppShell`'s own `--app-rail-width` says what was asked for.
 */
function applyRailWidth(wd, width) {
  return wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     const width = arguments[0];
     const store = window.__nkwSetRailWidth;
     const by = store ? 'store.setRailWidth' : 'the --app-rail-width Custom property';
     if (store) store(width);
     else {
       const shell = document.querySelector('.shell');
       if (!shell) { done({ ok: false, why: 'the shell is not on the page' }); return; }
       shell.style.setProperty('--app-rail-width', width + 'px');
     }
     const deadline = performance.now() + 2000;
     const step = function () {
       const shell = document.querySelector('.shell');
       const rail = document.querySelector('${RAIL}');
       const rendered = shell ? shell.style.getPropertyValue('--app-rail-width').trim() : null;
       if ((rendered !== width + 'px' || !rail) && performance.now() < deadline) {
         requestAnimationFrame(step);
         return;
       }
       done({ ok: true, by: by, rendered: rendered,
              railWidth: rail ? Math.round(rail.getBoundingClientRect().width * 100) / 100 : null,
              storeValue: store ? window.__nkwRailWidth() : null });
     };
     requestAnimationFrame(step);`,
    [width],
  )
}

/**
 * What the composer looks like at the width just applied. Read in its own command, after the
 * frames the step above waited for, so this is the layout of that width and not of the last one.
 */
function fitReading(wd) {
  return wd.execute(
    `const panel = document.querySelector('${PANEL}');
     const bar = document.querySelector('.agent-composer-bar');
     const composer = document.querySelector('.agent-composer');
     const row = document.querySelector('.agent-config-row');
     const hint = document.querySelector('.agent-composer-hint');
     const field = document.querySelector('.agent-composer-field');
     const timeline = document.querySelector('${TIMELINE}');
     const rail = document.querySelector('${RAIL}');
     const action = document.querySelector('.agent-composer [data-action="send"], .agent-composer [data-action="stop"]');
     if (!panel || !bar || !action) return { failure: 'the composer is not mounted' };
     const box = (el) => {
       if (!el) return null;
       const r = el.getBoundingClientRect();
       const round = (n) => Math.round(n * 100) / 100;
       return { left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom),
                width: round(r.width), height: round(r.height) };
     };
     const barBox = box(bar);
     const actionBox = box(action);
     const cx = Math.round((actionBox.left + actionBox.right) / 2);
     const cy = Math.round((actionBox.top + actionBox.bottom) / 2);
     const hit = document.elementFromPoint(cx, cy);
     const rowStyle = row ? getComputedStyle(row) : null;
     const barStyle = getComputedStyle(bar);
     return {
       rail: box(rail),
       panel: Object.assign(box(panel), { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth }),
       panelHeight: panel.clientHeight,
       bar: Object.assign(barBox, {
         clientWidth: bar.clientWidth, scrollWidth: bar.scrollWidth,
         wrap: barStyle.flexWrap,
         fits: bar.scrollWidth <= bar.clientWidth,
       }),
       composer: box(composer),
       field: box(field),
       timeline: box(timeline),
       hint: hint ? Object.assign(box(hint), { text: hint.textContent.trim() }) : null,
       // The sentence's own box, which is the thing whose position must not move: the hint's box
       // is allowed to grow into the bar's free space (it is what the free space is given to),
       // and the text inside it is pinned to its end. Read as the inner span when there is one,
       // and as the hint itself otherwise — so a run before the span existed and a run after it
       // are the same measurement.
       hintText: hint ? box(hint.querySelector('span') || hint) : null,
       row: row ? Object.assign(box(row), {
         clientWidth: row.clientWidth, scrollWidth: row.scrollWidth,
         flex: rowStyle.flexGrow + ' ' + rowStyle.flexShrink + ' ' + rowStyle.flexBasis,
         minWidth: rowStyle.minWidth, maxWidth: rowStyle.maxWidth,
         chips: Array.from(row.children)
           .filter((el) => el.matches('.agent-config-trigger, .agent-config-toggle'))
           .map((el) => ({ cls: el.className.split(' ')[0], text: el.textContent.trim(),
                           width: Math.round(el.getBoundingClientRect().width * 100) / 100 })),
       }) : null,
       action: {
         kind: action.dataset.action, disabled: action.disabled,
         box: actionBox,
         centre: { x: cx, y: cy },
         insideViewport: actionBox.left >= 0 && actionBox.top >= 0 &&
                         actionBox.right <= innerWidth && actionBox.bottom <= innerHeight,
         hit: hit ? (hit.className && hit.className.split ? hit.className.split(' ')[0] : hit.tagName) : null,
         hitIsAction: hit !== null && (hit === action || action.contains(hit)),
       },
       viewport: { width: innerWidth, height: innerHeight },
     }`,
  )
}

/** The calls the composer's two buttons make, counted in the tap the probe put on `invoke`:
 *  the stop asks the runtime to cancel, and the send hands it a prompt. Either growing after the
 *  click is the proof that the press reached the button — and which one it was says which button
 *  the panel was showing. */
function buttonCalls(wd) {
  return wd.execute(
    `const seen = window.__nkwInvokes || [];
     const count = (cmd) => seen.filter((e) => e.cmd === cmd).length;
     return { cancel: count('agent_cancel_run'), prompt: count('agent_prompt'), total: seen.length }`,
  )
}

/** How many `agent-event` handlers the page has registered — the harness's own count of the
 *  wire the store's subscription holds. Zero means every frame pushed from here on reaches
 *  nobody, whatever the panel draws. */
function wire(wd) {
  return wd.execute('return window.__NEKO_AGENT__.listeners()')
}

/**
 * The agent store's own state at the instant of the press, read through the app's own module.
 *
 * A press that reaches the composer's `submit` and produces no call has two shapes and the DOM
 * cannot tell them apart: the component refused it before it emitted (a draft it considers blank,
 * or a `canSend` of its own), or it emitted and the store's `send` answered with a typed refusal
 * (`stores/agent-session.ts`: `no-session` when the *active* key has no subscription or record,
 * `run-in-flight` when the record it names is live) — and the panel discards that outcome.
 *
 * The store keys its records by the pair (session, subscription) that `send` also reads, and the
 * *panel* reads its record through the key it was mounted with. The two used to be compared —
 * the store carried an `activeKey`, and a press could be explained by whether that pointer and
 * the panel's own key agreed — and the pointer is gone (`stores/agent-session.ts`: it was a
 * second answer to "which session is this window on", and the pet's task link could move it).
 * What is left is the one fact the arms are told apart by:
 *
 *  - **which record holds the text this probe just typed**, which names the panel's own key —
 *    captured while the field holds it (`window.__nkwPanelKey`, resolved at each typing site) and
 *    read back here, since a press may have cleared the field by the time this runs;
 *  - the state of *that* record: a live one is the `run-in-flight` arm, a missing one is
 *    `no-session` by record, and a present, non-live one can only be `no-session` by
 *    subscription.
 *
 * Read, never asserted on: the probe reports, `verify.mjs` decides.
 */
/**
 * Remember which record the composer's field belongs to, by the text just typed into it.
 *
 * The store no longer names the session a panel is on (`stores/agent-session.ts`), and the
 * composer's field is the seam where the panel's own key is observable from outside: the draft it
 * writes goes to the record the panel was mounted with, so the record holding `typed` is the one
 * on screen. Kept on `window` because the reads that need it happen after a press has cleared the
 * field.
 */
function rememberPanelKey(wd, typed) {
  return wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     import('/src/features/agent/stores/agent-session.ts').then(function (m) {
       const store = m.useAgentSessionStore();
       const records = store.records || {};
       const keys = Object.keys(records);
       window.__nkwPanelKey = keys.filter(function (k) { return records[k].draft === arguments[0]; })[0] ?? null;
       done({ keys: keys, panel: window.__nkwPanelKey });
     }, function (e) { done({ why: String(e && e.message ? e.message : e) }); });`,
    [typed],
  )
}

function readAgentStore(wd) {
  return wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     import('/src/features/agent/stores/agent-session.ts').then(function (m) {
       const store = m.useAgentSessionStore();
       const records = store.records || {};
       const keys = Object.keys(records);
       const seen = function (k) {
         const r = records[k];
         if (!r) return null;
         return { state: r.view.state, runId: r.view.runId, sequence: r.view.sequence,
                  draft: r.draft, timeline: r.view.timeline.length,
                  failure: r.view.failure ? r.view.failure.code : null,
                  failureMessage: r.view.failure ? r.view.failure.message : null,
                  lastResult: r.view.lastResult ? r.view.lastResult.stopReason : null };
       };
       const field = document.querySelector('.agent-composer-field');
       const panel = window.__nkwPanelKey ?? null;
       done({
         panel: panel,
         keys: keys,
         panelHeld: panel !== null && keys.indexOf(panel) >= 0,
         panelView: seen(panel),
         views: keys.map(function (k) { return { key: k, view: seen(k) }; }),
         fieldValue: field ? field.value : null,
       });
     }, function (e) { done({ why: String(e && e.message ? e.message : e) }); });`,
  )
}

/**
 * The rail closed and reopened *inside* the leave it is animating, and the composer pressed
 * afterwards.
 *
 * ---- The state this is a candidate for
 *
 * `AppShell.vue` paints the rail through a `<Transition>` with no `mode`, so the closing rail is
 * kept in the tree for its own exit and destroyed when that exit ends. Reopened before then, the
 * entering panel mounts while the leaving one is still alive — and both are mounted for the SAME
 * session, because the rail's session did not change. The store's subscription is keyed by the
 * session, so there is one entry: the entering panel's `attach` replaces the leaving one's, and
 * the leaving panel's teardown (`useAgentSession`'s `onBeforeUnmount` → `store.detach(key)`) then
 * releases the entry that is now the *entering* panel's. The panel on screen would be mounted,
 * subscribed to nothing, and would receive no frame at all.
 *
 * ---- What is read
 *
 *  - **the wire, before and after**, which is the harness's own count of registered
 *    `agent-event` handlers: zero after the toggle means the panel on screen is listening to
 *    nothing, whatever it draws;
 *  - **the press**, through the same typed-field-then-click path the fit phase uses, and the
 *    calls it produced. A press that produces no call, with the button enabled and the field
 *    full, is a press the reader cannot tell from one that did nothing.
 *
 * Read, never asserted on: `verify.mjs` decides, and the readings stand on their own.
 */
async function retogglePhase(wd, click) {
  const out = { load: load(), listenersBefore: await wire(wd) }
  if (!(await wd.execute(`return Boolean(document.querySelector('${PANEL}'))`))) {
    return { skipped: 'the panel is not mounted at this point in the run', ...out }
  }
  try {
    out.close = await click(wd, RAIL_TITLES)
    // Well inside the exit (`--app-motion-exit`), which is what makes the overlap: the leaving
    // panel is still in the tree when the entering one mounts.
    await new Promise((resolve) => setTimeout(resolve, 60))
    out.open = await click(wd, RAIL_TITLES)
    // …and long past it, so a teardown that runs at the end of the leave has run.
    await new Promise((resolve) => setTimeout(resolve, 900))
    out.listenersAfter = await wire(wd)
    out.panel = await wd.execute(`return Boolean(document.querySelector('${PANEL}'))`)
    out.state = await wd.execute('return window.__nkwPanelState()')

    // Whatever turn the phases above left open is ended, so the press below is a send: a live run
    // draws stop instead, and the question here is about the send button.
    out.ending = await wd.execute(
      `const id = window.__NEKO_AGENT__.runId();
       return id === null ? null : window.__NEKO_AGENT__.push('run-finished',
         { stopReason: 'cancelled', usage: null }, id)`,
    )
    await wd.executeAsync(
      `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 },
                          arguments[arguments.length - 1])`,
      [TIMELINE, JUMP],
    )
    out.typed = await wd.execute(
      `const field = document.querySelector('.agent-composer-field');
       if (!field) return { ok: false, why: 'no composer field' };
       field.value = 'probe';
       field.dispatchEvent(new Event('input', { bubbles: true }));
       return { ok: true, value: field.value }`,
    )
    out.panel = await rememberPanelKey(wd, 'probe')
    const at = await fitReading(wd)
    out.kind = at.action?.kind ?? null
    out.disabled = at.action?.disabled ?? null
    out.before = await buttonCalls(wd)
    out.store = await readAgentStore(wd)
    if (at.action) {
      out.click = await clickAt(wd, at.action.centre.x, at.action.centre.y)
      try {
        await until(
          async () => {
            const seen = await buttonCalls(wd)
            return seen.prompt > out.before.prompt || seen.cancel > out.before.cancel
          },
          { timeout: 3000, what: 'the press to reach the runtime' },
        )
      } catch {
        // The counts below are what the reading is; a press that never arrived is the case this
        // wait gives up on.
      }
      out.after = await buttonCalls(wd)
      out.landed = out.after.prompt > out.before.prompt || out.after.cancel > out.before.cancel
      out.reached = out.after.prompt > out.before.prompt
        ? 'agent_prompt'
        : out.after.cancel > out.before.cancel
          ? 'agent_cancel_run'
          : null
      out.storeAfter = await readAgentStore(wd)
      out.barAfter = await wd.execute(
        `const state = document.querySelector('.agent-bar-state');
         return { state: state ? state.dataset.state ?? null : null,
                  stateText: state ? state.textContent.trim() : null }`,
      )
    }
  } catch (error) {
    out.failure = String(error.message || error)
  }
  out.loadAfter = load()
  return out
}

async function fitPhase(wd) {
  const out = { load: load(), widths: [], failures: [] }
  // The store's own setter, when this page has one. `useAppearanceStore` needs an active Pinia;
  // the app installs one on this page, so the import normally succeeds and the sweep drives the
  // path the drag handle drives — the clamp in `appearance-schema.ts` included. The fallback is
  // recorded per reading rather than hidden.
  out.storePath = await wd.executeAsync(
    `const done = arguments[arguments.length - 1];
     import('/src/stores/appearance.ts').then(function (m) {
       const store = m.useAppearanceStore();
       window.__nkwSetRailWidth = function (w) { store.setRailWidth(w); };
       window.__nkwRailWidth = function () { return store.railWidth; };
       done({ ok: true, reached: store.railWidth });
     }, function (e) { done({ ok: false, why: String(e && e.message ? e.message : e) }); });`,
  )
  const mounted = await wd.execute(`return Boolean(document.querySelector('${PANEL}'))`)
  if (!mounted) return { skipped: 'the panel is not mounted at this point in the run', storePath: out.storePath }
  // The wire as this phase finds it, before a single width is applied: a subscription already
  // gone here belongs to something above, and one that goes missing across the sweep belongs to
  // the sweep.
  out.wireBefore = await wire(wd)

  for (const width of fitWidths()) {
    try {
      const applied = await applyRailWidth(wd, width)
      if (!applied?.ok) {
        out.failures.push({ width, why: applied?.why ?? 'the width could not be applied' })
        continue
      }
      const reading = await fitReading(wd)
      if (reading?.failure) out.failures.push({ width, why: reading.failure })
      out.widths.push({ requested: width, ...applied, ...reading })
    } catch (error) {
      out.failures.push({ width, why: String(error.message || error) })
    }
  }
  out.loadAfter = load()

  // The narrowest width, clicked for real.
  //
  // The hit test in every reading above is the engine's own answer to "what is under this point",
  // and it is the same question Playwright asks before it clicks. This is the stronger reading:
  // the driver presses where the button is, and the thing observed afterwards is the call the
  // button makes — `agent_cancel_run` for the stop or `agent_prompt` for the send, counted in the
  // tap the probe put on `invoke`. A press that landed anywhere else leaves both counts where
  // they were.
  //
  // Which button is on screen is the panel's state rather than this probe's choice, so both are
  // counted and the reading records which one the press produced.
  //
  // It runs last, and it is allowed to end the run: the panel is not moved to `cancelled` by the
  // stop call (the store's own comment says cancelling is a request, not an outcome) and a send
  // starts a turn the harness answers with the same id — so nothing above is measured across a
  // state the reader would notice.
  try {
    const narrowest = out.widths.find((r) => r.requested === 220) ?? out.widths[0] ?? null
    if (narrowest?.action) {
      await applyRailWidth(wd, narrowest.requested)
      // Whatever turn the phases above left open is ended first, with a frame carrying the host's
      // own run id — the gesture `elapsedPhase` makes and for the same reason: a live run leaves
      // the composer offering stop, and the press below is meant to be a real action either way.
      //
      // It is also what makes this press mean what the check reads. The stand-in answers
      // `agent_prompt` and never ends the turn it started, so its own bookkeeping still holds one
      // in flight while the snapshot it hands a re-subscription says the session is `ready`; the
      // adapter then refuses the next prompt with `buffer-conflict` BEFORE any call goes out
      // (`platform/gateways/tauri-agent.ts`, the per-session `running` latch). The panel draws a
      // send button, the press produces no call, and the reading is about the stand-in's latch
      // rather than about the button. That state is reported to the reader — the bar reads
      // "Failed" over the adapter's own sentence, which `realClick.barAfter` carries — but it is
      // not the question this phase asks.
      out.ending = await wd.execute(
        `const id = window.__NEKO_AGENT__.runId();
         return id === null ? null : window.__NEKO_AGENT__.push('run-finished',
           { stopReason: 'cancelled', usage: null }, id)`,
      )
      await wd.executeAsync(
        `window.__nkwSettle({ sel: arguments[0], jump: arguments[1], frames: 3 },
                            arguments[arguments.length - 1])`,
        [TIMELINE, JUMP],
      )
      // Text in the field first, because the press has to have something to do: the button is a
      // send whenever no run is live, and a send with an empty draft is a press the composer
      // refuses — which read as "the click reached nothing" and made this check depend on the
      // state the phases above happened to leave behind rather than on whether the button is
      // reachable. With text in it, either button is a real action: stop cancels a live run, send
      // starts one.
      //
      // Written here rather than with the driver's `/element/value`, and the difference is the
      // whole of why this line exists: that call sets the element's value without the `input`
      // event Vue's model listens for, so the field showed text while the component's draft was
      // still empty and the press submitted nothing. The event is what a reader's keystroke
      // produces, and it is what the panel's own tests dispatch for the same reason.
      out.realClick = {
        typing: await wd.execute(
          `const field = document.querySelector('.agent-composer-field');
           if (!field) return { ok: false, why: 'no composer field' };
           field.value = 'probe';
           field.dispatchEvent(new Event('input', { bubbles: true }));
           // A tap on the two events the press has to produce, so a press that reaches nothing
           // is diagnosed as "the pointer never arrived" or "it arrived and nothing submitted"
           // rather than as one indistinguishable red.
           window.__nkwPresses = [];
           if (!window.__nkwPressTap) {
             window.__nkwPressTap = true;
             document.addEventListener('click', function (e) {
               const hit = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
               window.__nkwPresses.push({ kind: 'click', action: hit ? hit.dataset.action : null,
                 tag: e.target ? e.target.tagName : null, trusted: e.isTrusted,
                 defaultPrevented: e.defaultPrevented, at: Date.now() });
             }, true);
             document.addEventListener('submit', function (e) {
               window.__nkwPresses.push({ kind: 'submit', cls: (e.target.className || '').toString().slice(0, 40), at: Date.now() });
             }, true);
           }
           return { ok: true, value: field.value };`,
        ),
        panel: await rememberPanelKey(wd, 'probe'),
      }
      const at = await fitReading(wd)
      const before = await buttonCalls(wd)
      // Read BEFORE the press, so this is the state the refusals below would be answered from —
      // and the text the field holds is the one typed a few lines up, which is what names the
      // record the composer is bound to.
      const held = await readAgentStore(wd)
      const wired = await wire(wd)
      out.realClick = {
        ...out.realClick,
        endedRun: out.ending,
        width: narrowest.requested,
        panel: at.panel.clientWidth,
        kind: at.action.kind,
        disabled: at.action.disabled,
        centre: at.action.centre,
        insideViewport: at.action.insideViewport,
        hitIsAction: at.action.hitIsAction,
        before: before,
        store: held,
        listeners: wired,
      }
      try {
        out.realClick.click = await clickAt(wd, at.action.centre.x, at.action.centre.y)
      } catch (error) {
        out.realClick.failure = String(error.message || error)
      }
      // The reading waits for the call rather than pausing for a fixed number of milliseconds:
      // the send path is asynchronous (the store settles the turn's baselines before it asks the
      // runtime for anything), and a press that reached nothing is still red — three seconds
      // later, with both counts where they were.
      try {
        await until(
          async () => {
            const seen = await buttonCalls(wd)
            return seen.prompt > before.prompt || seen.cancel > before.cancel
          },
          { timeout: 3000, what: 'the press to reach the runtime' },
        )
      } catch {
        // Nothing to do with the failure: the counts below are what the check reads, and a press
        // that never arrived is exactly the case this wait gives up on.
      }
      const after = await buttonCalls(wd)
      out.realClick.after = after
      out.realClick.listenersAfter = await wire(wd)
      // What the press did to the store, and what the bar says about it. A press that reached
      // `send` and was refused there leaves one of three marks and they are told apart here:
      // the store's own typed refusal (nothing changes in the record), a throw the store folds
      // into the view's `failure` (the record carries a code), or a call that went out.
      out.realClick.storeAfter = await readAgentStore(wd)
      out.realClick.barAfter = await wd.execute(
        `const state = document.querySelector('.agent-bar-state');
         const bar = document.querySelector('.agent-session-bar') || document.querySelector('.agent-bar');
         return { state: state ? state.dataset.state ?? null : null,
                  stateText: state ? state.textContent.trim() : null,
                  barText: bar ? bar.textContent.trim().slice(0, 300) : null };`,
      )
      out.realClick.presses = await wd.execute('return window.__nkwPresses || null')
      // The press arrived at the button: the button emitted, the store called the gateway, and
      // the gateway asked the runtime for something.
      out.realClick.landed = after.cancel > before.cancel || after.prompt > before.prompt
      out.realClick.reached = after.prompt > before.prompt ? 'agent_prompt' : after.cancel > before.cancel ? 'agent_cancel_run' : null
    }
  } catch (error) {
    out.realClick = { failure: String(error.message || error) }
  }

  // …and back to the width the rest of the app is measured at, so the page is left as it was
  // found for anything after this run.
  await applyRailWidth(wd, 300)
  return out
}

