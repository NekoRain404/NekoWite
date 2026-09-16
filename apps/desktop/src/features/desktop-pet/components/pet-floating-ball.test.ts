/**
 * The floating ball: the three gestures, what each of them reports, and what it asks of a
 * desktop that cannot do everything.
 *
 * The ball's inputs are real DOM events here rather than calls into its internals, because the
 * wiring is the part that can be wrong in a way the service tests cannot see: a press handler
 * attached to the wrong event, a drag that forgets to snap, or a right-click that also toggles
 * the menu all pass `pet-ball-input.test.ts` and fail a user.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import type { ImageFactory, LoadableImage } from '../rendering/sprite-sheet'
import PetFloatingBall from './PetFloatingBall.vue'

/** A sheet that never finishes loading: this file is about the ball, not about D2's drawing. */
const loadingImage: ImageFactory = (): LoadableImage => ({
  naturalWidth: 0,
  naturalHeight: 0,
  crossOrigin: null,
  src: '',
  onload: null,
  onerror: null,
})

const mounted: VueApp[] = []
let clock = 0
/** What the ball reported, in order. */
let events: string[] = []

function mount(props: Record<string, unknown> = {}): HTMLElement {
  events = []
  clock = 0
  document.body.innerHTML = '<div id="host"></div>'
  const app = createApp(PetFloatingBall, {
    now: () => clock,
    createImage: loadingImage,
    onToggleMenu: () => events.push('toggle-menu'),
    onDismissMenu: () => events.push('dismiss-menu'),
    onOpenSettings: () => events.push('open-settings'),
    ...props,
  })
  mounted.push(app)
  app.mount(document.getElementById('host') as Element)
  return document.querySelector('.pet-ball__orb') as HTMLElement
}

/** A pointer event by type. Screen coordinates, as the gesture reads them. */
function pointer(type: string, screenX: number, screenY: number, button = 0): MouseEvent {
  return new MouseEvent(type, { screenX, screenY, button, bubbles: true, cancelable: true })
}

/** Press, release: the shape of a click, with the clock moving between them. */
function click(orb: HTMLElement, startedAt = 0, releasedAt = 100): void {
  clock = startedAt
  orb.dispatchEvent(pointer('pointerdown', 1000, 600))
  clock = releasedAt
  orb.dispatchEvent(pointer('pointerup', 1000, 600))
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
})

describe('the ball and its gestures', () => {
  it('asks for the menu when it is clicked', () => {
    const orb = mount()

    click(orb)

    expect(events).toEqual(['toggle-menu'])
  })

  it('does not ask for the menu when the press was a drag', () => {
    const orb = mount()

    clock = 0
    orb.dispatchEvent(pointer('pointerdown', 1000, 600))
    clock = 40
    orb.dispatchEvent(pointer('pointermove', 1020, 600))
    clock = 80
    orb.dispatchEvent(pointer('pointerup', 1020, 600))

    expect(events).toEqual([])
  })

  it('does not ask for the menu when the press was held too long', () => {
    const orb = mount()

    click(orb, 0, 400)

    expect(events).toEqual([])
  })

  it('leaves a secondary press to the context menu', () => {
    const orb = mount()

    clock = 0
    orb.dispatchEvent(pointer('pointerdown', 1000, 600, 2))
    clock = 50
    orb.dispatchEvent(pointer('pointerup', 1000, 600, 2))

    expect(events).toEqual([])
  })

  it('puts its own menu away on a press, and does not reopen it on the release', () => {
    const orb = mount({ menuOpen: true })

    click(orb, 0, 60)

    // Upstream's rule (`floating-ball.ts:199`): one press, one closing, never a close
    // immediately followed by the reopen its own release would otherwise cause.
    expect(events).toEqual(['dismiss-menu'])
  })

  it('reports a right-click, and does not touch the menu', () => {
    const orb = mount()

    orb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    expect(events).toEqual(['open-settings'])
  })

  it('opens the menu from the keyboard', () => {
    const orb = mount()

    orb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(events).toEqual(['toggle-menu'])
  })
})

describe('the ball and the desktop it stands on', () => {
  it('asks the platform to drag, and to snap once the drag is over', async () => {
    let release = (): void => {}
    const dragged = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const orb = mount({
      platform: {
        startDrag: () => {
          calls.push('drag')
          return dragged
        },
        snap: () => {
          calls.push('snap')
          return Promise.resolve()
        },
      },
    })

    clock = 0
    orb.dispatchEvent(pointer('pointerdown', 1000, 600))
    clock = 30
    orb.dispatchEvent(pointer('pointermove', 1040, 620))

    expect(calls).toEqual(['drag'])
    // The drag is the compositor's from here, so the ball shows it until the platform says it
    // is over — upstream waited for the same promise (`floating-ball.ts:219-223`).
    await nextTick()
    expect(orb.classList.contains('is-dragging')).toBe(true)

    release()
    await flush()

    expect(calls).toEqual(['drag', 'snap'])
    expect(orb.classList.contains('is-dragging')).toBe(false)
    expect(events).toEqual([])
  })

  it('still keeps the drag from becoming a menu when there is nothing to move it with', () => {
    const orb = mount()

    clock = 0
    orb.dispatchEvent(pointer('pointerdown', 1000, 600))
    clock = 30
    orb.dispatchEvent(pointer('pointermove', 1040, 620))
    clock = 60
    orb.dispatchEvent(pointer('pointerup', 1040, 620))

    expect(events).toEqual([])
    expect(orb.classList.contains('is-dragging')).toBe(false)
  })

  it('says whether this desktop can move it, rather than looking movable and not being', () => {
    const still = mount()
    expect(still.title).toMatch(/cannot move it/)
    expect(still.title).not.toMatch(/Drag to move/)

    const movable = mount({ platform: { startDrag: () => Promise.resolve() } })
    expect(movable.title).toMatch(/Drag to move/)
  })

  it('keeps the dragging state honest when the platform refuses the drag', async () => {
    const orb = mount({ platform: { startDrag: () => Promise.reject(new Error('no compositor')) } })

    clock = 0
    orb.dispatchEvent(pointer('pointerdown', 1000, 600))
    clock = 30
    orb.dispatchEvent(pointer('pointermove', 1040, 620))
    await flush()

    // The ball is where the user left it, and it is not still pretending to be dragged.
    expect(orb.classList.contains('is-dragging')).toBe(false)
    expect(events).toEqual([])
  })
})

describe('what the ball draws', () => {
  it('draws nothing at all when the pet is hidden', () => {
    mount({ visible: false })

    expect(document.querySelector('.pet-ball')).toBeNull()
  })

  it('draws the character it is given, and the plain orb when there is none', () => {
    mount({ imageUrl: '/characters/cat.png' })
    expect(document.querySelector('.pet-sprite')).not.toBeNull()

    mount()
    expect(document.querySelector('.pet-sprite')).toBeNull()
    expect(document.querySelector('.pet-ball__highlight')).not.toBeNull()
  })

  it('leaves the transition out when the app asked for less motion', () => {
    expect(mount().classList.contains('is-still')).toBe(false)
    expect(mount({ reduceMotion: true }).classList.contains('is-still')).toBe(true)
  })
})
