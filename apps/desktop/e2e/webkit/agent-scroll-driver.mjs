/**
 * The gestures: real input to the engine, and what the driver answered.
 *
 * Split out of `probe-agent-scroll.mjs` at the line budget. Nothing here knows about the agent
 * panel; everything here is the difference between measuring the app and measuring the probe.
 * A click is a driver click at a point read in the same command that uses it (the editor
 * re-renders under a selection change, and a tag-then-click between two round trips loses that
 * race as a 404 from the element endpoint); a scroll is a wheel action, because a `WheelEvent`
 * built in the page is untrusted and WebKit does not scroll for it; a key is a key action, so
 * the engine's own default actions run.
 *
 * Nothing here throws on a driver that cannot do the thing. "This driver has no wheel" is a
 * finding about the instrument, and a finding has to be returned to be visible.
 */
/* ---------------------------------------------------------------------------
 * Small client-side helpers
 * ------------------------------------------------------------------------- */

/** The element id out of a WebDriver element reference, whichever key the driver used. */
export function elementId(found) {
  return found['element-6066-11e4-a52e-4f735466cecf'] ?? Object.values(found)[0]
}

/** Click an element addressed by a CSS selector, through the driver. */
export async function clickSelector(wd, selector) {
  const found = await wd.findElement(selector)
  await wd.clickElement(elementId(found))
}

/**
 * A real click at a point in the viewport, through the driver's pointer.
 *
 * Used where the element is inside a surface that re-renders: `findElement` runs as its own
 * command, and a tag-and-click between two round trips loses the race with anything that
 * rewrites the DOM in between — the editor does exactly that after a selection change, and the
 * failure reads as a 404 from the element endpoint rather than as the race it is. A point read
 * in the same command that clicks it cannot go stale.
 */
export async function clickAt(wd, x, y) {
  try {
    await wd.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ])
    await wd.releaseActions()
    return { ok: true, x: Math.round(x), y: Math.round(y) }
  } catch (error) {
    return { ok: false, why: String(error.message || error) }
  }
}

/**
 * Type into a field, addressed by selector: the driver's own key path, not a value write.
 *
 * The element id is read in this command and used in the next, which is the one place that race
 * is acceptable — a text field is not re-created under the pointer the way an editor's rows are
 * — and the caller gets to name the field rather than carry a WebDriver element reference.
 */
export async function typeInto(wd, selector, text) {
  try {
    const id = elementId(await wd.findElement(selector))
    await wd.typeInto(id, text)
    return { ok: true, selector, characters: text.length }
  } catch (error) {
    return { ok: false, selector, why: String(error.message || error) }
  }
}

/**
 * Click the status-bar button whose `title` is one of `titles`.
 *
 * Tagged in the page and clicked through the driver, like every other click this harness makes.
 * The rail's toggle is a Vue listener and would accept an untrusted event, but the question
 * below is what the app does in response to a reader, and the reader is the driver.
 */
export async function clickStatusButton(wd, titles) {
  const tagged = await wd.execute(
    `const titles = arguments[0];
     const buttons = Array.from(document.querySelectorAll('.status-btn'));
     document.querySelectorAll('[data-nkw-probe]').forEach(function (n) { n.removeAttribute('data-nkw-probe'); });
     const hit = buttons.filter(function (el) { return titles.indexOf(el.getAttribute('title') || '') !== -1; })[0];
     if (!hit) return { ok: false, found: buttons.map(function (el) { return el.getAttribute('title'); }) };
     hit.setAttribute('data-nkw-probe', '1');
     return { ok: true, title: hit.getAttribute('title') };`,
    [titles],
  )
  if (!tagged?.ok) return tagged
  await clickSelector(wd, '[data-nkw-probe="1"]')
  return tagged
}

/** Click a `.switch-option` by its text, tolerating its absence. */
export async function clickSwitchOption(wd, text) {
  try {
    const tagged = await wd.execute(
      `const needle = arguments[0];
       const hit = Array.from(document.querySelectorAll('.switch-option')).filter(function (el) {
         return (el.textContent || '').indexOf(needle) !== -1;
       })[0];
       document.querySelectorAll('[data-nkw-probe]').forEach(function (n) { n.removeAttribute('data-nkw-probe'); });
       if (!hit) return false;
       hit.setAttribute('data-nkw-probe', '1');
       return true;`,
      [text],
    )
    if (!tagged) return { ok: false, why: `no .switch-option containing ${text}` }
    await clickSelector(wd, '[data-nkw-probe="1"]')
    return { ok: true }
  } catch (error) {
    return { ok: false, why: String(error.message || error) }
  }
}

/**
 * Scroll the container with a real wheel gesture, or say why not.
 *
 * The W3C actions endpoint is the only route to a wheel event the engine will act on: a
 * `WheelEvent` built in the page is untrusted and WebKit does not scroll for it, so a park made
 * that way would be measuring the probe's own dispatch. When the endpoint is missing the caller
 * falls back to writing `scrollTop` — which still produces the container's own scroll event,
 * which is what the panel listens to — and the result says which route it took.
 */
export async function wheel(wd, selector, deltaY) {
  const id = elementId(await wd.findElement(selector))
  const action = {
    type: 'scroll',
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY,
    origin: { 'element-6066-11e4-a52e-4f735466cecf': id },
  }
  // Both spellings of the source type are tried, because the specification renamed it and
  // engines disagree about which one they answer. Which one worked is reported: a driver that
  // scrolls for neither is a route that was never taken, and the caller falls back to writing
  // `scrollTop` — a real scroll event, but not the reader's hand.
  const failures = []
  for (const source of ['scroll', 'wheel']) {
    try {
      await wd.performActions([
        { type: source, id: 'wheel', parameters: { pointerType: 'mouse' }, actions: [action] },
      ])
      await wd.releaseActions()
      return { ok: true, deltaY, source }
    } catch (error) {
      failures.push(`${source}: ${String(error.message || error).slice(0, 120)}`)
    }
  }
  return { ok: false, deltaY, why: failures.join(' | ') }
}

/** Send keys through the driver's own input. */
export async function pressKeys(wd, values) {
  const actions = []
  for (const value of values) {
    actions.push({ type: 'keyDown', value })
    actions.push({ type: 'keyUp', value })
  }
  try {
    await wd.performActions([{ type: 'key', id: 'keyboard', actions }])
    await wd.releaseActions()
    return { ok: true, keys: values.length }
  } catch (error) {
    return { ok: false, why: String(error.message || error) }
  }
}
