/**
 * The shared mechanics every probe needs.
 *
 * Split out of `probes.mjs` so the registry can import the probes and the probes
 * can import this — one direction only. A cycle here would work by accident of
 * ESM hoisting and break the first time a helper was read at module scope,
 * which is exactly the kind of thing this programme's `madge --circular` rule
 * exists to prevent.
 */
import { sleep, until } from './webdriver.mjs'

/** A rect as six numbers, in viewport coordinates. */
export const RECT_SRC = `(function (sel) {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
})`

/**
 * Click an element addressed by its text.
 *
 * WebDriver classic has no text selector and this client does not carry one, so
 * the element is tagged in-page and then clicked THROUGH THE DRIVER — which
 * matters, because a DOM `el.click()` is an untrusted event and handlers that
 * check `isTrusted` (ProseMirror's, and the ones the editor installs on its own
 * DOM) ignore it. The tag is an attribute, not a class: no stylesheet sees it.
 */
export async function clickByText(wd, selector, text, index = 0) {
  await until(
    () =>
      wd.execute(
        `const want = arguments[0], needle = arguments[1], nth = arguments[2];
         const hits = Array.from(document.querySelectorAll(want))
           .filter((el) => (el.textContent || '').includes(needle));
         const el = hits[nth];
         document.querySelectorAll('[data-nkw-probe]')
           .forEach((n) => n.removeAttribute('data-nkw-probe'));
         if (!el) return false;
         el.setAttribute('data-nkw-probe', '1');
         return true;`,
        [selector, text, index],
      ),
    { what: `${selector} containing ${JSON.stringify(text)}` },
  )
  const element = await wd.findElement('[data-nkw-probe="1"]')
  const id = element['element-6066-11e4-a52e-4f735466cecf'] ?? Object.values(element)[0]
  await wd.clickElement(id)
}

/** Scroll a pane and let the placement's rAF coalescer settle before reading. */
export function scrollTo(wd, selector, top) {
  return wd.executeAsync(
    `const sel = arguments[0], want = arguments[1], done = arguments[arguments.length - 1];
     const el = document.querySelector(sel);
     if (!el) { done({ ok: false, why: 'no ' + sel }); return; }
     el.scrollTop = want;
     let n = 0;
     const tick = () => { if (++n >= 3) done({ ok: true, scrollTop: el.scrollTop }); else requestAnimationFrame(tick); };
     requestAnimationFrame(tick);`,
    [selector, top],
  )
}

/**
 * Scroll so the element's top lands on a given viewport y.
 *
 * Corrected in a loop rather than in one step: a scroll offset is quantised by
 * the engine to whatever its scrollable-area units are, so `scrollTop += delta`
 * lands NEAR the target and not on it. The residual is reported so a reader can
 * see how exactly the frame was reproduced — WebKitGTK snaps `scrollTop` to
 * whole pixels, so the Chromium frame of 268.234 cannot be reproduced closer
 * than the 0.95px its own content offset leaves. That is a setup difference and
 * not a placement one, and the two are only distinguishable because the delta
 * between the two rects is reported separately from the rects.
 */
export function scrollSoTopIs(wd, paneSelector, elementSelector, targetTop) {
  return wd.executeAsync(
    `const pane = document.querySelector(arguments[0]), el = document.querySelector(arguments[1]);
     const target = arguments[2], done = arguments[arguments.length - 1];
     if (!pane || !el) { done({ ok: false }); return; }
     let pass = 0;
     const tick = () => {
       const r = el.getBoundingClientRect();
       const residual = r.top - target;
       if (Math.abs(residual) < 0.01 || ++pass > 4) {
         done({ ok: true, scrollTop: pane.scrollTop, figureTop: r.top, residual: residual });
         return;
       }
       pane.scrollTop += residual;
       requestAnimationFrame(tick);
     };
     requestAnimationFrame(tick);`,
    [paneSelector, elementSelector, targetTop],
  )
}

/** Boot waits: the app mounts, the note opens, the rendered editor parses. */
export async function openNote(wd) {
  await until(() => wd.execute(`return typeof window.__TAURI_INTERNALS__ === 'object'`), {
    what: 'the Tauri mock',
  })
  await until(() => wd.execute(`return Boolean(document.querySelector('.nav-item'))`), {
    what: 'the sidebar',
  })
  await clickByText(wd, '.nav-item', 'Folders')
  await until(() => wd.execute(`return Boolean(document.querySelector('.tree-name'))`), {
    what: 'the folder tree',
  })
  await clickByText(wd, '.tree-name', '.md')
  await until(
    () => wd.execute(`return Boolean(document.querySelector('.pane.rendered .ProseMirror h1'))`),
    { timeout: 30_000, what: 'the rendered note' },
  )
  // The editor's first parse lands after the h1 is visible, and a measurement
  // taken inside that window is a measurement of the app starting up.
  await sleep(600)
}

