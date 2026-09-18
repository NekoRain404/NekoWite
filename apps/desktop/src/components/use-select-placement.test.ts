/**
 * Where a select's list is put, and what keeps it there.
 *
 * `SelectMenu.test.ts` covers the component the way a user meets it — the keyboard, the aria wiring,
 * what a press commits — and asserts nothing about geometry, because happy-dom lays nothing out. That
 * left the half of the control that has actually been measured in a browser (`a36a06d`: every list
 * in the settings dialog opened 280px wide inside a 526px control; `settings-resize.spec.ts`: the AI
 * provider's list opened 87px to the left of its control) held only by e2e specs. These cases pin the
 * arithmetic and the listener lifetimes that the e2e specs read from the outside, so a move of this
 * code — it was moved out of `SelectMenu.vue` whole — cannot lose a bound quietly.
 *
 * **The rects are the fixture.** Every rect is zero here and every box has no size, so the numbers
 * below are the shape the assertions are written against, and only what `measurePlacement` reads is
 * stubbed: the control's rect, the list's own two measurement properties, and the window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useSelectPlacement, type SelectPlacement } from './use-select-placement'

/** The six box fields the placement reads, and *mutable*: a case moves the control by writing them,
 *  `DOMRect`'s own are read-only and the rect below is built from this on every read. */
interface Box {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

/** The window the placement is clamped into, for every case here. */
const WINDOW = { width: 1280, height: 800 }

/** A control in the settings dialog's own size: the number `a36a06d` was measured against. */
const CONTROL: Box = { top: 100, left: 100, right: 626, bottom: 130, width: 526, height: 30 }

/** The window as the environment had it, put back for the next file: happy-dom's own is not ours. */
const UNSET = { width: window.innerWidth, height: window.innerHeight }

let live: SelectPlacement | null = null

afterEach(() => {
  live?.stop()
  live = null
  windowOf(UNSET.width, UNSET.height)
  document.body.innerHTML = ''
})

/**
 * A control and a list, wired the way `SelectMenu.vue` wires them: `open` is the component's and is
 * only read here, and the dismissal comes back as this `close`.
 *
 * The two mutable objects are what a case changes to move the control or resize the list — the
 * fixture is read at call time, so the next measurement sees the new numbers.
 */
function harness(options: {
  rect?: Partial<Box>
  size?: { width: number, height: number }
} = {}) {
  const rect: Box = { ...CONTROL, ...options.rect }
  const size = { width: 300, height: 200, ...options.size }
  const trigger = document.createElement('button')
  const popup = document.createElement('div')
  document.body.append(trigger, popup)
  trigger.getBoundingClientRect = (): DOMRect => ({ ...rect, x: rect.left, y: rect.top }) as DOMRect
  Object.defineProperty(popup, 'offsetWidth', { value: size.width, configurable: true })
  Object.defineProperty(popup, 'offsetHeight', { value: size.height, configurable: true })

  const open = ref(false)
  const close = vi.fn()
  // The refs the component holds: filled once the elements exist, which is what the composable is
  // written against — `null` until then, and the same two bindings its template carries.
  const triggerEl = ref<HTMLElement | null>(null)
  const popupEl = ref<HTMLElement | null>(null)
  triggerEl.value = trigger
  popupEl.value = popup
  const placement = useSelectPlacement({ trigger: triggerEl, popup: popupEl, open, close })
  live = placement
  return { trigger, popup, open, close, placement, rect, size }
}

/** Pin the window, so no case reads the environment's default. */
function windowOf(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

/** Open it the way the component does, and let the `nextTick` the first measurement waits on pass. */
async function opened(placed: ReturnType<typeof harness>): Promise<void> {
  placed.placement.forget()
  placed.open.value = true
  placed.placement.start()
  await nextTick()
}

/** A pointer press, described the way the listener reads it: where it landed. */
function pressWhere(target: Element): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

/** Long enough for a follow loop with nothing to do to stop itself — it needs two agreeing frames,
 *  and a still rectangle gives it nothing else to read. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120))

/** Carry the control the way a spring does — a new number every frame — and resolve when it lands.
 *  A movement read once is not the shape of the thing: the loop stops as soon as two frames agree,
 *  so a rect that changed in the past is a movement no loop of ours would ever measure again. */
function carry(placed: ReturnType<typeof harness>, to: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (): void => {
      placed.rect.left = Math.min(to, placed.rect.left + 40)
      if (placed.rect.left < to) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
}

describe('useSelectPlacement', () => {
  it('is never narrower than the control it belongs to, nor wider than the window it is in', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    const placed = harness({ size: { width: 300, height: 200 } })
    await opened(placed)

    // The two bounds are measurements, not declarations — the stylesheet holds neither.
    expect(placed.placement.pos.value.minWidth).toBe(526)
    expect(placed.placement.pos.value.maxWidth).toBe(WINDOW.width - 16)
    // Below the control, four pixels off it, and inside the left clamp.
    expect(placed.placement.pos.value.left).toBe(100)
    expect(placed.placement.pos.value.top).toBe(134)
    expect(placed.placement.pos.value.drop).toBe('down')
  })

  it('gives the room to a list whose own content is wider than its control', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    // A control near the right edge, and a list that overflows it: the clamp has to be against the
    // width the list will *have*, which is the number that crosses the right edge — not the floor.
    const placed = harness({ rect: { left: 700, right: 1226 }, size: { width: 900, height: 200 } })
    await opened(placed)

    expect(placed.placement.pos.value.minWidth).toBe(526)
    expect(placed.placement.pos.value.left).toBe(1280 - 900 - 8)
  })

  it('opens upward when the room below runs out, and says so', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    // 300px of list under a control whose bottom is 630: 934 > 800 - 8.
    const placed = harness({ rect: { top: 600, bottom: 630 }, size: { width: 300, height: 300 } })
    await opened(placed)

    expect(placed.placement.pos.value.drop).toBe('up')
    // Above the control by the same four pixels, so the arrival travels the way it was placed.
    expect(placed.placement.pos.value.top).toBe(600 - 300 - 4)
  })

  it('forgets the last placement, so a second open measures from a box of its own', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    const placed = harness()
    await opened(placed)
    expect(placed.placement.pos.value.minWidth).toBe(526)

    // What `a36a06d` was missing: `pos` outlives the popup, so the next open would render its first
    // frame at the last control's width and the loop read a box the component had sized itself.
    placed.placement.forget()
    expect(placed.placement.pos.value).toEqual({
      left: 0,
      top: 0,
      minWidth: 180,
      maxWidth: null,
      drop: 'down',
    })
  })

  it('re-places on a viewport change rather than dismissing the list', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    const placed = harness()
    await opened(placed)

    placed.rect.left = 300
    window.dispatchEvent(new Event('scroll'))
    await nextTick()

    expect(placed.placement.pos.value.left).toBe(300)
    expect(placed.close).not.toHaveBeenCalled()
  })

  it('follows a trigger something else is carrying, once the motion announces itself', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    const placed = harness()
    await opened(placed)
    // Let the loop stop first: three reads for an open with nothing moving, and then nothing. What
    // is under test is the *re-arm* — a movement that begins later announces itself, and the loop
    // is restarted from that event rather than kept alive by a timer guessing an engine's delay.
    await settled()

    // The control arrives on a spring: its rect moves while nothing scrolls and nothing resizes,
    // which is the movement neither viewport listener nor a ResizeObserver can see. `transitionrun`
    // fires as the transition is created, before it has moved, which is the moment the loop has to
    // be watching from.
    placed.trigger.dispatchEvent(new Event('transitionrun', { bubbles: true }))
    await carry(placed, 420)

    await vi.waitFor(() => expect(placed.placement.pos.value.left).toBe(420))
  })

  it('releases every listener when it is stopped', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    const placed = harness()
    await opened(placed)
    placed.placement.stop()

    // A scroll, once the viewport listeners have been released: the loop is gone with them, so
    // nothing measures the control where it now is.
    placed.rect.left = 500
    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(placed.placement.pos.value.left).toBe(100)

    // And the motion listener went with them: a movement that announces itself cannot restart it.
    placed.rect.left = 100
    placed.trigger.dispatchEvent(new Event('transitionrun', { bubbles: true }))
    await carry(placed, 500)
    expect(placed.placement.pos.value.left).toBe(100)

    // Nor does a press outside still reach the caller's close.
    pressWhere(document.body)
    expect(placed.close).not.toHaveBeenCalled()
  })

  it('dismisses a press outside both boxes, and only there', async () => {
    windowOf(WINDOW.width, WINDOW.height)
    const placed = harness()
    await opened(placed)

    // The trigger's own click handler owns the toggle: dismissing here as well would close and
    // immediately reopen the list.
    pressWhere(placed.trigger)
    expect(placed.close).not.toHaveBeenCalled()
    // And a press inside the list is not a press outside it.
    pressWhere(placed.popup)
    expect(placed.close).not.toHaveBeenCalled()

    pressWhere(document.body)
    expect(placed.close).toHaveBeenCalledTimes(1)
  })
})
