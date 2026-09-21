/**
 * The focus indicator of every tab stop this task owns, painted by the engine and read back.
 *
 * ---- Why this file exists
 *
 * Four tab stops in this product carry a comment saying why they are focusable and no rule that
 * draws a focus ring, and a hand survey found four of them where there are five. Two halves of one
 * defect — a scroll container the keyboard cannot reach, and a tab stop a reader cannot see — and
 * only the first half had a probe. The second half cannot be measured the way the first was: a
 * ring is not a number in a stylesheet, it is what the engine paints when the heuristic agrees,
 * and `probe-agent-scroll.mjs` established the only honest reading of that (a real Tab, then
 * `getComputedStyle` on the frame focus lands).
 *
 * **Three components were mounted here because nothing hosted them.** `ui/EditorPane.vue` hosts two
 * of the three now (`AgentChangedFiles` carries `AgentChangesView`, `AgentNoteProposals` carries
 * `AgentEditConflictView`), and the fixtures stayed: this is where their target elements can be
 * built with the texts and the refusals the readings need, without a run behind them. The third —
 * `AgentNativeTerminal` — was deleted rather than hosted: §4.3 asks for a mature terminal rendering
 * component and this tree has none, so the entry could not draw the engine's own TUI. So this file
 * mounts what it measures, from the running dev server, the way `e2e/agent-changes.spec.ts` and
 * `e2e/desktop-pet-tasks.spec.ts` mount theirs in Chromium: the component is the application's own,
 * compiled by the application's own Vite, against the application's own Vue instance, resolved out
 * of `main.ts`'s transform. What is rebuilt here is the mounting site and nothing else, and every
 * reading below says which element it was taken on.
 *
 * ---- How a reading here is made worth having
 *
 *  - **The ring is painted, not asserted.** Nothing in this file reads a stylesheet. The element
 *    is focused and `getComputedStyle` answers, which is the same answer a keyboard reader gets.
 *  - **The method is proved in the run, against a witness.** `:focus-visible` is a heuristic on
 *    the LAST INPUT's kind, so a programmatic focus after a pointer gesture legitimately paints
 *    nothing and every reading below would be a false accusation. A real Tab is pressed first and
 *    a control known to paint (`.switch-option`, which has had its ring since the UI kit) is
 *    measured through the same code path. When the witness comes back dark the run reports itself
 *    blind and claims nothing.
 *  - **Contrast is arithmetic on what the engine returned**, not a claim: the indicator's colour
 *    against the surface behind it, by WCAG's ratio, with the number printed beside every verdict.
 *    An indicator that paints and cannot be seen is the defect wearing a fix's clothes.
 *  - **The sweep.** The five stops are the ones that were reported; the question is whether the
 *    list is complete. Every tab stop the page has is focused and read the same way, and the ones
 *    that show nothing are named — including the ones whose ring layout clips away, which is the
 *    answer the first version of the sweep could not give at any price (see `focus-instrument.mjs`).
 *  - **The census, and the controls that make it checkable.** The sweep says whether a stop paints
 *    an indicator; the census says WHOSE. It is a gate now rather than a printed count, because the
 *    sixteen stops that used to wear the engine's ring are all repairable from this change's file
 *    scope — an ungated census would report the regression and let the run pass. Five fixture stops
 *    (`focus-controls.mjs`) are mounted through every sweep so the two branches that were repaired
 *    can be watched deciding, in both directions, in the run that reports them green.
 */
import { until } from './webdriver.mjs'
import { INSTRUMENTS, KEY, RAIL_TITLES, load } from './agent-scroll-instrument.mjs'
import { FOCUS_INSTRUMENTS } from './focus-instrument.mjs'
import { FOCUS_CONTROLS, CONTROL_SELECTORS } from './focus-controls.mjs'
import { PAGE_SURFACES, MOUNTS, MOUNT_SCRIPT, UNMOUNT_SCRIPT, RING_PIXEL_STOPS } from './focus-surfaces.mjs'
import { clickStatusButton, pressKeys } from './agent-scroll-driver.mjs'
import { clickByText } from './probe-support.mjs'
import { ensureFocusPermission } from './focus-permission-fixture.mjs'

/** `--violate ringless`: the indicator suppressed in the page, so the checks can be shown red. */
const VIOLATION = 'ringless'

/**
 * The graph view's entry in the sidebar's navigation, as `nav.graph` spells it in the language the
 * harness boots in (`harness.html` writes `nekowite.locale = 'en'` before the app reads it). It is
 * a label rather than a selector because the navigation carries no id in the DOM — the entry's own
 * `id` is a key in a Vue list, not an attribute — and a reader reaches this view by reading that
 * label, so the probe does too.
 */
const GRAPH_NAV = 'Graph'

function violation() {
  const i = process.argv.indexOf('--violate')
  if (i === -1) return null
  const value = process.argv[i + 1]
  return value === undefined || value.startsWith('--') ? null : value
}


export const focusRingProbe = {
  name: 'focus-ring',

  async run(wd) {
    const harness = await wd.execute('return window.__NEKO_HARNESS__ ?? null')
    if (!harness) return { skipped: 'the page is not the WebKit harness' }

    const out = { harness, load: load(), surfaces: [], sweep: null }
    await wd.execute(INSTRUMENTS)
    // The focus instruments are a second script because they are a second subject; the scripts
    // are one-way — this one reads __nkwTabStops, the enumeration INSTRUMENTS owns.
    await wd.execute(FOCUS_INSTRUMENTS)
    await wd.execute(FOCUS_CONTROLS)

    // --- the surfaces already on the product's own screens ------------------
    //
    // The rail is mounted with v-if, so either panel is absent from the document until the reader
    // opens it — and whether that has already happened is read from the DOM rather than assumed,
    // because a second click on the toggle would CLOSE the rail the reading needs open. This runs
    // BEFORE the witness, because the click is a pointer gesture and a pointer gesture is exactly
    // what turns `:focus-visible` off for everything measured after it.
    const panelSel = harness.agent ? '.agent-panel' : '.chat-panel'
    const alreadyOpen = await wd.execute(`return Boolean(document.querySelector('${panelSel}'))`)
    out.rail = alreadyOpen ? { ok: true, alreadyOpen: true } : await clickStatusButton(wd, RAIL_TITLES)
    try {
      await until(() => wd.execute(`return Boolean(document.querySelector('${panelSel}'))`), {
        timeout: 20_000,
        what: 'the rail panel to mount',
      })
    } catch (error) {
      out.railFailure = String(error.message || error)
    }

    // The graph's canvas, reached the way a reader reaches it: the sidebar's own entry, which
    // switches the note list column's body. A pointer gesture, so it belongs here with the rail's
    // click and not in the reading loop — and it is a page reading, on the product's own panel over
    // the product's own vault, rather than a mount of a component nothing hosts.
    if (PAGE_SURFACES.some((s) => s.prep === 'graph')) {
      const onGraph = await wd.execute(`return Boolean(document.querySelector('.graph-canvas'))`)
      if (onGraph) {
        out.graph = { ok: true, alreadyOpen: true }
      } else {
        try {
          await clickByText(wd, '.nav-item', GRAPH_NAV)
          await until(
            () => wd.execute(`return Boolean(document.querySelector('.graph-canvas'))`),
            { timeout: 20_000, what: 'the graph panel to mount' },
          )
          out.graph = { ok: true }
        } catch (error) {
          // Reported, not thrown: a reading that could not be set up is a surface the run says it
          // did not measure, and the failure below names the reason rather than going quiet.
          out.graph = { ok: false, why: String(error.message || error) }
        }
      }
      // What the panel drew, so the ring is not the only thing on this page that was read: the
      // canvas is drawn into rather than filled with child nodes, so the count is the graph's own.
      out.graphReading = await wd.execute(
        `const canvas = document.querySelector('.graph-canvas');
         if (!canvas) return null;
         const r = canvas.getBoundingClientRect();
         const count = document.querySelector('.graph-count');
         return { width: Math.round(r.width), height: Math.round(r.height),
                  tabIndex: canvas.tabIndex, role: canvas.getAttribute('role'),
                  label: canvas.getAttribute('aria-label'),
                  toolbarCount: count ? count.textContent.trim() : null };`,
      )
    }

    if (harness.agent) out.permissionFixture = await ensureFocusPermission(wd)

    // Keyboard modality, re-established after every pointer gesture and read as a measurement
    // rather than assumed. `:focus-visible` is the heuristic on the LAST INPUT's kind, so a
    // programmatic focus after a click legitimately paints nothing — and a run that read the
    // surfaces under that modality would report every one of them as ringless and every reading
    // below would be a false accusation. This line is re-run before each group of readings that a
    // click precedes, and the witness is measured under the SAME modality as the subjects.
    await pressKeys(wd, [KEY.tab])
    out.witness = await wd.execute(
      `const el = document.querySelector('.switch-option') || document.querySelector('.status-btn');
       if (!el) return null;
       el.setAttribute('data-nkw-witness', '1');
       const reading = window.__nkwFocusPaint('[data-nkw-witness="1"]');
       el.removeAttribute('data-nkw-witness');
       return reading;`,
    )
    out.blind = !out.witness || out.witness.painted !== true
    if (out.blind) return out
    // The witness's own pixels: the method's ground truth. It is a control whose ring is not in
    // question, so a number here proves the pixel reader can see a ring at all — without it, a
    // zero on a surface below would be as likely to be a broken screenshot as a missing ring.
    await wd.execute(`const el = document.querySelector('.switch-option'); if (el) el.focus(); return true`)
    out.witnessPixels = await pixelsAround(wd, '.switch-option', false)

    // **The deliberate violation, installed here.** After the witness and before every subject, so
    // the whole run measures the defect rather than the fix and the witness is still measured
    // clean — it is not in the injected selector, and it must keep painting for the run to be
    // read at all. The red this produces is the "the engine's own ring is not this app's ring"
    // state, which is what the surfaces below were in before the rule was added.
    if (violation() === VIOLATION) {
      out.injected = await wd.execute(`return window.__nkwViolateNoRing(arguments[0], arguments[1])`, [
        MOUNTS.map((m) => m.sel).concat(PAGE_SURFACES.map((s) => s.sel)).join(', '),
        process.argv.includes('--revert') ? 'revert' : 'none',
      ])
    }

    for (const surface of PAGE_SURFACES) {
      // `app` is the shell every run boots: the tab bar and the graph are on the page whatever the
      // run asked for, so there is no page for them to be not-on and a missing element is a real
      // absence rather than a run that did not prepare the right panel.
      const wanted =
        surface.page === 'app'
          ? true
          : surface.page === 'agent'
            ? harness.agent === true
            : harness.agent !== true && harness.chat === true
      if (!wanted) {
        out.surfaces.push({ name: surface.name, sel: surface.sel, on: 'the product page', present: false,
                            why: surface.page === 'agent' ? 'this run is not the agent run' : 'this run did not seed a conversation' })
        continue
      }
      const present = await wd.execute(`return Boolean(document.querySelector('${surface.sel}'))`)
      if (!present) {
        out.surfaces.push({ name: surface.name, sel: surface.sel, on: 'the product page', present: false,
                            why: 'the element is not in the document on this page' })
        continue
      }
      await pressKeys(wd, [KEY.tab])
      const reading = await wd.execute(`return window.__nkwFocusPaint('${surface.sel}')`)
      out.surfaces.push({
        name: surface.name,
        sel: surface.sel,
        on: 'the product page',
        present: true,
        entered: 'a programmatic focus under keyboard modality',
        reading,
        pixels: await pixelsAround(wd, surface.sel, false),
      })
    }

    // --- the surfaces nothing hosts yet --------------------------------------
    //
    // Mounted ONE AT A TIME and taken off the page between readings. Not tidiness: the overlay a
    // component has to be drawn in is big enough to cover the next one, and the first version
    // measured every surface but the last through the one stacked on top of it.
    out.mounts = []
    for (const spec of MOUNTS) {
      const mounted = await wd.executeAsync(MOUNT_SCRIPT, [spec])
      out.mounts.push(mounted)
      // A few frames for the mount's own stylesheet to land: a SFC's style is injected by the dev
      // server's module, and a ring read in the same task as the import would be read before the
      // rule existed.
      await frames(wd, 3)
      if (mounted?.ok !== true) {
        out.surfaces.push({ name: spec.name, sel: spec.sel, on: 'mounted by this probe', present: false,
                            why: mounted?.why ?? 'the mount was not attempted' })
        await wd.execute(UNMOUNT_SCRIPT)
        continue
      }
      const found = await wd.execute(
        `const nodes = Array.from(document.querySelectorAll(arguments[0]));
         return { count: nodes.length, first: nodes[0] ? (nodes[0].className || nodes[0].tagName) : null }`,
        [spec.sel],
      )
      if (found.count === 0) {
        out.surfaces.push({ name: spec.name, sel: spec.sel, on: 'mounted by this probe', present: false,
                            why: 'the mount rendered no ' + spec.sel })
        await wd.execute(UNMOUNT_SCRIPT)
        continue
      }
      // Every one of these is a tab stop with `tabindex="0"`, so there is a way to reach it that
      // leaves no question about the heuristic: tag the stop before it, focus that, and let the
      // driver's own Tab do the entering — the same walk `probe-agent-scroll.mjs` uses. Where the
      // target IS the first stop in its host there is nothing to walk in from, and the reading
      // says so and falls back to the method the witness proved.
      const walk = await wd.execute(
        `return window.__nkwTagTabStop({ root: arguments[0], sel: arguments[1], step: -1 })`,
        [`[data-nkw-focus-host="${spec.name}"]`, spec.sel],
      )
      let reading = null
      if (walk?.target) {
        // The tagged stop is focused and the driver's own Tab does the entering; the reading is
        // taken with focus already on the target, so nothing in it moved focus there.
        await wd.execute(`const el = document.querySelector('[data-nkw-tabstop]'); if (el) el.focus(); return true`)
        await pressKeys(wd, [KEY.tab])
        reading = await wd.execute(`return window.__nkwFocusPaint(arguments[0])`, [spec.sel])
      } else {
        await pressKeys(wd, [KEY.tab])
        reading = await wd.execute(`return window.__nkwFocusPaint(arguments[0])`, [spec.sel])
      }
      // The pixels, while focus is still on it. Every surface mounted here ends with focus on it
      // or nothing, so the screenshot is taken before anything else runs.
      const pixels = await pixelsAround(wd, spec.sel, false)
      out.surfaces.push({
        name: spec.name,
        sel: spec.sel,
        on: 'mounted by this probe',
        present: true,
        count: found.count,
        entered: walk?.target ? 'a real Tab from the stop before it' : 'a programmatic focus under keyboard modality',
        reading,
        pixels,
      })
      await wd.execute(UNMOUNT_SCRIPT)
    }

    // --- the controls: the sweep's two repaired branches, on stops whose verdicts are known ---
    //
    // Mounted BEFORE the sweep and taken off the page AFTER it, so the five stops are in the list
    // the sweep walks — the instrument has to decide them, not a helper the probe calls beside it.
    // They are also the reason the sweep's own `total` is five larger than the page's stop count
    // while they are up, and the reason they are removed before the census counts anything: a
    // census that counted a fixture would be counting this file's own markup as the product's.
    out.controls = { mounted: await wd.execute(`return window.__nkwFocusControls('inject')`) }
    await frames(wd, 3)
    out.controls.present = await wd.execute(
      `return document.querySelectorAll('[data-nkw-focus-controls] button').length`,
    )

    // --- the sweep: every tab stop the page has ------------------------------
    out.sweep = await wd.executeAsync(
      `window.__nkwFocusSweep({ root: null, witness: '.switch-option' }, arguments[arguments.length - 1])`,
    )

    // What the sweep decided about each control, read off its own two lists rather than from a
    // second call — the verdict under test is the one the sweep produced for the whole page.
    const verdictOf = (sel) => {
      const cls = sel.slice(1)
      const clipped = (out.sweep?.clipped ?? []).find((e) => e.cls === cls)
      if (clipped) return { verdict: 'clipped', entry: clipped }
      const offender = (out.sweep?.offenders ?? []).find((e) => e.cls === cls)
      if (offender) return { verdict: 'offender', entry: offender }
      return { verdict: 'clean', entry: null }
    }
    out.controls.verdicts = Object.fromEntries(
      Object.entries(CONTROL_SELECTORS).map(([key, sel]) => [key, verdictOf(sel)]),
    )
    // The pixels, per control, through the same reader every surface above was read with. This is
    // the half that makes the sweep's verdict checkable: a stop the sweep calls clipped must
    // repaint nothing, and a stop it calls clean must repaint something.
    out.controls.pixels = {}
    for (const [key, sel] of Object.entries(CONTROL_SELECTORS)) {
      out.controls.pixels[key] = await pixelsAround(wd, sel, false)
    }
    out.controls.removed = await wd.execute(`return window.__nkwFocusControls('remove')`)

    // --- the rings this task added, read as pixels rather than as declarations --------------
    //
    // The census below says whose ring each stop declares; this says whether the screen changed
    // when focus landed, which is the only reading that can tell a rule from a ring. It runs after
    // the fixture is off the page and before the census, so neither reading is taken through a
    // foreign overlay. The numbers are PRINTED and not gated: they come from whole-page
    // screenshots, and a loaded machine makes this reader blind for every surface at once — the
    // witness check above is the detector for that, and a second gate on the same blindness would
    // red for a reason that has nothing to do with a ring. The isolated run is where they mean
    // something, which is where they were taken.
    out.ringPixels = []
    for (const stop of RING_PIXEL_STOPS) {
      const present = await wd.execute(
        `return Boolean(document.querySelector(arguments[0]))`,
        [stop.sel],
      )
      if (!present) {
        out.ringPixels.push({ name: stop.name, sel: stop.sel, rule: stop.rule, present: false })
        continue
      }
      // The computed reading beside the pixels, on the same element, so "what does this stop
      // paint now" is answerable per class rather than only in aggregate: the census counts the
      // whole page, and a count is not a place to look.
      await pressKeys(wd, [KEY.tab])
      const reading = await wd.execute(`return window.__nkwFocusPaint(arguments[0])`, [stop.sel])
      out.ringPixels.push({
        name: stop.name, sel: stop.sel, rule: stop.rule, present: true,
        reading,
        pixels: await pixelsAround(wd, stop.sel, false),
      })
    }

    // --- the enumeration's own blind spot: focusable elements no attribute names --------
    //
    // The census below answers "whose ring does each stop paint" for every stop in the
    // enumeration, and the previous list of offenders was read off that answer. It cannot answer
    // for a stop the enumeration does not contain: `contenteditable` is a tab stop with no
    // attribute in the selector list, and this application's editor body is one. So the
    // candidates are focused and read here, and whether each one is a stop at all is measured
    // rather than assumed — a candidate the engine refuses to focus is reported as such.
    out.beyond = await wd.execute(
      `const candidates = window.__nkwStopsBeyondEnumeration(null);
       return candidates.map(function (el) {
         const before = document.activeElement;
         el.focus({ preventScroll: true });
         const s = getComputedStyle(el);
         const ring = window.__nkwRingVisibility(el, s);
         const shadow = window.__nkwShadowPaints(s.boxShadow);
         const pseudo = window.__nkwPseudoIndicator(el);
         const reading = {
           tag: el.tagName.toLowerCase(), cls: el.className || null,
           focusable: document.activeElement === el,
           focusVisible: el.matches(':focus-visible'),
           outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor,
           boxShadow: s.boxShadow, shadowPaints: shadow.paints, pseudo: pseudo ? pseudo.part : null,
           onScreen: ring === null ? null : ring.onScreen,
           // The same three branches the sweep's own verdict is made of, so "paints nothing"
           // means the same thing here as it does there.
           paints: (s.outlineStyle !== 'none' && window.__nkwPx(s.outlineWidth) > 0) ||
                   shadow.paints || pseudo !== null,
           where: window.__nkwStopWhere(el)
         };
         if (before && before !== el && before.focus) before.focus({ preventScroll: true });
         else if (!before) el.blur();
         return reading;
       })`,
    )

    // --- the census: whose ring each of those stops paints --------------------
    //
    // The sweep answers "does this stop paint an indicator". It cannot answer "does it paint THIS
    // APP's indicator", and the difference is the whole of the two surfaces fixed above: WebKit
    // draws a ring of its own on every focusable element, so a stop with no author rule is never
    // an offender by the sweep's test and is still a place where this product's focus language
    // stops. The class is therefore invisible to the one reading that was supposed to be the
    // complete list, and this is the reading that makes its size visible.
    //
    // Classification is by `outlineStyle`, not by colour: every author rule in this repository
    // says `solid` and the user agent's ring is `auto`, so the two cannot be confused by a theme
    // change or by a `color-mix`. **A ring layout clips away is its own bucket**, because a stop
    // whose author rule is right and whose ring is not on screen is neither: `.graph-canvas` was
    // in exactly that state, classified `accent` by this reading's first version, which would have
    // credited a fix that a keyboard reader could not see.
    //
    // **A stop with no outline is re-read four frames later**, and the reason is the failure this
    // whole file keeps running into: this app fades its other indicators in (`LayoutResizeHandle`'s
    // `::after` bar, `.chat-textarea`'s box-shadow), and a style read in the task the focus landed
    // in samples the transition at t=0 — where a control that has a ring reads as a control that
    // has none. Only the outline-less stops pay for it: an outline is not transitioned by any rule
    // here, so the other 158 are classified from the reading that was already taken. Four frames
    // is a reading *of* the transition rather than of its end; that is said rather than hidden,
    // and nothing in the classification depends on the alpha at that moment.
    out.census = await wd.executeAsync(
      `const accent = arguments[0];
       const done = arguments[arguments.length - 1];
       const stops = window.__nkwTabStops(null);
       const accented = [], engine = [], foreign = [], other = [], invisible = [], removed = [], skipped = [];
       // The style, read where the element is — the caller is the one that decides whether that
       // is the task the focus landed in or four frames after it, and the difference is the whole
       // reason a transitioned indicator needs the second one. The ring's visibility is read with
       // it, while the element still holds focus, because that is when the rule is applied at all.
       const style = function (el) {
         const s = getComputedStyle(el);
         const pseudo = window.__nkwPseudoIndicator(el);
         const ring = window.__nkwRingVisibility(el, s);
         return { tag: el.tagName.toLowerCase(), cls: el.className || null,
                  focusVisible: el.matches(':focus-visible'),
                  outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor,
                  boxShadow: s.boxShadow, pseudo: pseudo ? pseudo.part : null,
                  onScreen: ring === null ? null : ring.onScreen,
                  clipped: ring !== null && ring.clipped === true,
                  clips: ring === null ? null : ring.clips };
       };
       const read = function (el) { el.focus({ preventScroll: true }); return style(el); };
       const blur = function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); };
       const classify = function (index, r) {
         const entry = { i: index, tag: r.tag, cls: r.cls,
                         outline: r.outlineStyle + ' ' + r.outlineWidth + ' ' + r.outlineColor };
         if (r.focusVisible !== true) { invisible.push(entry); return; }
         if (r.clipped === true) {
           removed.push({ i: index, tag: r.tag, cls: r.cls, outline: entry.outline,
                          onScreen: r.onScreen, clips: r.clips });
           return;
         }
         if (r.outlineStyle === 'auto') engine.push(entry);
         else if (r.outlineStyle === 'solid' && r.outlineColor === accent) accented.push(entry);
         // A solid outline in a colour that is not this app's. Nothing is in this bucket today,
         // and it exists because the engine's bucket is keyed on outline-style: auto — a fact
         // about how WebKit spells its own ring, not about whose ring it is. If the engine ever
         // reported its ring as solid, every stop still wearing it would move here instead of
         // vanishing into 'other', and the count would say so in the same words.
         else if (r.outlineStyle === 'solid') foreign.push(entry);
         else other.push({ i: index, tag: r.tag, cls: r.cls, outline: entry.outline,
                           boxShadow: r.boxShadow, pseudo: r.pseudo });
       };
       let i = 0;
       const step = function () {
         if (i >= stops.length) {
           const name = function (e) { return (e.cls || e.tag) + ' [' + e.outline + ']'; };
           done({
             total: stops.length,
             accent: accented.length, engine: engine.length, foreign: foreign.length,
             other: other.length, notFocusVisible: invisible.length, skipped: skipped.length,
             // Every stop lands in exactly one bucket, and this sum is what says so: a branch that
             // returns without pushing is a stop the census silently stopped counting, which reads
             // exactly like a page whose stops are all fine.
             classified: accented.length + engine.length + foreign.length + other.length +
                         invisible.length + removed.length + skipped.length,
             engineList: engine.slice(0, 40).map(name),
             foreignList: foreign.slice(0, 40).map(name),
             // Where each of those stops lives, in the same order: the class alone took the last
             // reader from a name to a file by grepping, and one of these was attributed to the
             // wrong component that way. The parent chain is the measurable half of that walk.
             engineWhere: engine.slice(0, 40).map(function (e) { return window.__nkwStopWhere(stops[e.i]); }),
             otherList: other.slice(0, 40).map(function (e) {
               return name(e) + ' boxShadow ' + e.boxShadow + ' pseudo ' + e.pseudo;
             }),
             accentList: accented.slice(0, 60).map(name),
             clippedList: removed.map(function (e) {
               return (e.cls || e.tag) + ' [' + e.outline + '], ' + e.onScreen + '% on screen, clipped by ' +
                 JSON.stringify(e.clips);
             }),
           });
           return;
         }
         const el = stops[i];
         const box = el.getBoundingClientRect();
         const index = i;
         i += 1;
         if (box.width < 2 || box.height < 2) { skipped.push(index); requestAnimationFrame(step); return; }
         const quick = read(el);
         if (quick.outlineStyle !== 'none' || quick.focusVisible !== true) {
           blur();
           classify(index, quick);
           requestAnimationFrame(step);
           return;
         }
         // Focus is HELD across the wait, and that is not a detail: blurring first would let the
         // transition run back to its unfocused value, and the settled read would be of the state
         // the element is in when nothing is focused — the same t=0 reading with four frames of
         // delay in front of it. Found by taking exactly that reading and believing it.
         let left = 4;
         const settle = function () {
           if (--left > 0) { requestAnimationFrame(settle); return; }
           const settled = style(el);
           blur();
           classify(index, settled);
           requestAnimationFrame(step);
         };
         requestAnimationFrame(settle);
       };
       requestAnimationFrame(step);`,
      [out.witness?.outlineColor ?? null],
    )
    out.loadAfter = load()
    return out
  },
}

/**
 * The pixels, for one surface: the same band around the same box, before and after focus.
 *
 * A computed style says what the engine would draw. This says what changed on screen when focus
 * arrived. The two screenshots are taken by the driver and diffed by the page's own canvas, which
 * is the only thing in this repository that can read a rendered pixel — and what comes back is
 * counts and deltas, so no image leaves this function.
 *
 * **Both halves are taken, and the difference is the reading.** Whatever repainted inside a 12px
 * band around the element's box when it took focus IS its focus indicator, whatever produced it —
 * an author outline, the engine's own default ring, a box-shadow, a background swap. Neither
 * screenshot alone can tell an indicator from the element's own border, a neighbouring panel's
 * edge, or a decode that failed. The band is split into "outside the box" and "inside the box"
 * because this codebase draws both: an inset ring on a full-bleed scroll container is inside it,
 * and every other rule puts the ring outside.
 */
export async function pixelsAround(wd, sel, pressTabFirst) {
  if (pressTabFirst) await pressKeys(wd, [KEY.tab])
  // Focus is put on `<body>` before the first screenshot, and it is not tidiness: a caller that
  // reached the element with a real Tab has focus ON it already, and a "before" screenshot taken
  // then is a screenshot of the focused state — the diff comes back empty and the element reads
  // as ringless for the one reason that has nothing to do with the ring. Found by taking exactly
  // that reading on a control whose ring is not in question.
  await wd.execute(`if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
                    return document.activeElement ? document.activeElement.tagName : null`)
  await frames(wd, 2)
  const before = await wd.screenshot()
  if (!before) return { sel, why: 'this driver produces no screenshot' }
  await wd.execute(`const el = document.querySelector(arguments[0]); if (el) el.focus(); return true`, [sel])
  // **The paint is quiesced before it is read, and it has to be.** The first version took one
  // screenshot two frames after the focus and diffed: a control whose ring is a complete 5px
  // perimeter came back with a ten-pixel arc on one edge in one run and nothing at all in the
  // next. That is not a ring that comes and goes — it is MiniBrowser repainting the focus ring
  // in tiles, and a screenshot taken while it is still going is a screenshot of part of it. The
  // fix is the same one `__nkwQuiet` applies to a keyboard scroll: read it when it has stopped.
  const settle = await settleScreenshot(wd, 5)
  const after = settle.png
  if (!after) return { sel, why: 'this driver produces no screenshot' }
  const diff = await decode(wd, sel, before, after)
  return {
    sel,
    diff,
    settled: settle.settled,
    shots: settle.tries,
    painted: (diff?.outside ?? 0) + (diff?.inside ?? 0) > 0,
    where: (diff?.outside ?? 0) > 0 ? 'around the box' : (diff?.inside ?? 0) > 0 ? 'inside the box' : 'nowhere',
  }
}

/**
 * Screenshots until two in a row are identical, and says whether that happened.
 *
 * `settled: false` is reported rather than assumed away: a page that never stops repainting (a
 * caret, a spinner, an animation) is a reading that cannot be taken this way, and the count
 * beside it is a lower bound rather than an answer.
 */
async function settleScreenshot(wd, budget) {
  let previous = null
  let tries = 0
  for (let i = 0; i < budget; i += 1) {
    tries += 1
    const png = await wd.screenshot()
    if (!png) return { png: null, settled: false, tries }
    if (previous !== null) {
      if (png === previous) return { png, settled: true, tries }
    }
    previous = png
    await frames(wd, 2)
  }
  return { png: previous, settled: false, tries }
}

async function frames(wd, n) {
  await wd.executeAsync(
    // The IIFE's own `arguments` is why the count and the callback are both passed in by position:
    // naming one of them inside a function whose arguments the driver fills in is how this hung
    // for thirty seconds the first time it ran — `arguments[0]` was the CALLBACK, `--left` was
    // NaN, and `NaN <= 0` is false for as long as the driver is willing to wait.
    `(function () {
       let left = arguments[0];
       const done = arguments[arguments.length - 1];
       const tick = function () { if (--left <= 0) done(true); else requestAnimationFrame(tick); };
       requestAnimationFrame(tick);
     })(arguments[0], arguments[arguments.length - 1])`,
    [n],
  )
}

async function decode(wd, sel, before, after) {
  try {
    return await wd.executeAsync(
      `window.__nkwPixelDiff({ sel: arguments[0], before: arguments[1], after: arguments[2] }, arguments[arguments.length - 1])`,
      [sel, before, after],
    )
  } catch (error) {
    return { why: String(error.message || error) }
  }
}
