/**
 * The pointer, for the clicks that have to be real.
 *
 * A user's right-click is what opens the note card's own menu, and the app records which note the menu acts on
 * from that event — so a stage that reached for `.click()` from a script would test a listener rather than the
 * path a mouse takes. Two modules need exactly this (the export menu and the delete menu), and it is the kind
 * of thing that is worth having once: the coordinates have to be the element's **in-view** centre, and the
 * driver needs them with `origin: 'viewport'`.
 *
 * **An element origin hangs.** `{ origin: { 'element-…': id } }` never answers on this driver: the request
 * times out and the probe dies with a stack trace and no readings. That is a measured property of
 * WebKitWebDriver here rather than a preference, which is why the coordinates are computed on the page.
 */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

/** The element's own box, plus the viewport it has to be inside for a viewport-origin pointer move. */
const RECT_SCRIPT = `const r = arguments[0].getBoundingClientRect()
return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
         innerWidth: window.innerWidth, innerHeight: window.innerHeight }`

/**
 * Right-click the element, at a point just inside its top-left corner.
 *
 * Answers a reading rather than throwing: `{ ok, rect, point, error }` — a caller records it, and an element
 * that is scrolled out of view is a sentence ("the card is not inside the viewport ()") rather than a crash.
 */
export async function rightClickElement({ run, elementId }) {
  const rect = await run('POST', '/execute/sync', {
    script: RECT_SCRIPT,
    args: [{ [ELEMENT_KEY]: elementId }],
  }).then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: `unreachable: ${String(e?.message ?? e).slice(0, 120)}` }),
  )
  if (!rect.ok) return { ok: false, rect: null, point: null, error: rect.error }
  const point = {
    x: rect.value.x + Math.min(5, Math.max(0, rect.value.w - 1)),
    y: rect.value.y + Math.min(5, Math.max(0, rect.value.h - 1)),
  }
  const inside = point.x > 0 && point.y > 0 && point.x < (rect.value.innerWidth ?? 0) && point.y < (rect.value.innerHeight ?? 0)
  if (!inside) {
    return { ok: false, rect: rect.value, point, error: `the element is not inside the viewport (${JSON.stringify(rect.value)})` }
  }
  const clicked = await run('POST', '/actions', {
    actions: [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', x: point.x, y: point.y },
          { type: 'pointerDown', button: 2 },
          { type: 'pointerUp', button: 2 },
        ],
      },
    ],
  }).then(
    () => ({ ok: true }),
    (e) => ({ ok: false, error: `unreachable: the right-click: ${String(e?.message ?? e).slice(0, 120)}` }),
  )
  return { ok: clicked.ok, rect: rect.value, point, error: clicked.error }
}
