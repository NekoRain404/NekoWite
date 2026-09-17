/**
 * The floating ball: the three gestures, what each of them reports, and what it asks of a
 * desktop that cannot do everything.
 *
 * The ball's inputs are real DOM events here rather than calls into its internals, because the
 * wiring is the part that can be wrong in a way the service tests cannot see: a press handler
 * attached to the wrong event, a drag that forgets to snap, or a right-click that also toggles
 * the menu all pass `pet-ball-input.test.ts` and fail a user.
 *
 * The canvas is mocked for the reason `desktop-pet-root.test.ts` records: happy-dom implements no
 * canvas, so `getContext('2d')` answers `null` for every element, and a suite that means to
 * exercise the drawing path has to supply the context it draws on. This suite did not, and that
 * went unnoticed for as long as the ball passed no `on-unavailable` — a sprite refused its context
 * reported it to nobody, so the branch stayed mounted and every assertion here passed against a
 * canvas that could never be painted. The two defects hid each other; the cases at the bottom of
 * this file are the ones that ask about it on purpose.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import type { SpriteClock } from '../rendering/animation-bindings'
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

/** Fails both of the loader's attempts, the way a URL that is not there does (D2's deviation 2). */
const failingImage: ImageFactory = (): LoadableImage => {
  const image: LoadableImage = {
    naturalWidth: 0,
    naturalHeight: 0,
    crossOrigin: null,
    src: '',
    onload: null,
    onerror: null,
  }
  Object.defineProperty(image, 'src', {
    set() {
      queueMicrotask(() => image.onerror?.(new Event('error')))
    },
  })
  return image
}

let getContextSpy: MockInstance<HTMLCanvasElement['getContext']> | null = null
const context2d = {
  imageSmoothingEnabled: true,
  clearRect: () => undefined,
  drawImage: () => undefined,
  getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
} as unknown as CanvasRenderingContext2D

/**
 * The sprite's frame loop as numbers, so "the loop stopped" is a reading rather than a claim.
 *
 * `SpritePlayer` arms one `setTimeout` per tick and holds it, and `IdlePlaylist` arms one of its
 * own while the mood is idle, so a mounted sprite holds timers that a *refused* branch must not.
 * The handlers are never run: what is being measured is whether the ball is holding a timer at
 * all, and a clock that fired would be measuring the loop rather than its lifetime.
 */
function frameLoop(): { clock: SpriteClock; live: () => number } {
  const pending = new Set<ReturnType<typeof globalThis.setTimeout>>()
  let handle = 0
  return {
    clock: {
      setTimeout: () => {
        const id = ++handle as unknown as ReturnType<typeof globalThis.setTimeout>
        pending.add(id)
        return id
      },
      clearTimeout: (id) => {
        pending.delete(id)
      },
    },
    live: () => pending.size,
  }
}

const mounted: VueApp[] = []
let clock = 0
/** What the ball reported, in order. */
let events: string[] = []
/** What the ball said about the character it could not draw, in order. */
let failures: (string | null)[] = []

function mount(props: Record<string, unknown> = {}): HTMLElement {
  events = []
  failures = []
  clock = 0
  document.body.innerHTML = '<div id="host"></div>'
  const app = createApp(PetFloatingBall, {
    now: () => clock,
    createImage: loadingImage,
    onToggleMenu: () => events.push('toggle-menu'),
    onDismissMenu: () => events.push('dismiss-menu'),
    onOpenSettings: () => events.push('open-settings'),
    onDrawFailure: (notice: string | null) => failures.push(notice),
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

/**
 * A ball whose character can be changed under it, the way the settings page changes it.
 *
 * The image factory is read through a holder rather than passed by value, so a case can make the
 * *next* attempt succeed: the prop is read when the sprite branch mounts, and the branch is
 * refused and re-mounted across a failure — which is exactly the path a recovery takes.
 */
function mountChoosing(options: { url?: string; image: { current: ImageFactory } }): {
  orb: () => HTMLElement
  choose: (url: string | null) => Promise<void>
} {
  events = []
  failures = []
  clock = 0
  document.body.innerHTML = '<div id="host"></div>'
  const url = ref<string | null>(options.url ?? '/characters/cat.png')
  const app = createApp({
    render: () =>
      h(PetFloatingBall, {
        imageUrl: url.value,
        now: () => clock,
        createImage: () => options.image.current(),
        onDrawFailure: (notice: string | null) => failures.push(notice),
      }),
  })
  mounted.push(app)
  app.mount(document.getElementById('host') as Element)
  return {
    orb: () => document.querySelector('.pet-ball__orb') as HTMLElement,
    choose: async (next) => {
      url.value = next
      await flush()
    },
  }
}

beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(context2d)
})

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
  getContextSpy?.mockRestore()
  getContextSpy = null
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

/*
 * A character the ball cannot draw. Two things have to be true at once, and each of them was
 * false before: the host is *told*, and the ball stops paying for a sprite that will never
 * appear. The second is not a matter of hiding the canvas — the sprite branch is refused, which
 * unmounts `PetSprite` and destroys the player, and `frameLoop()` is what reads the difference
 * between a loop that is gone and one that is merely out of sight.
 */
describe('a character the ball cannot draw', () => {
  it('reports a sheet that will not load, and holds no frame timer afterwards', async () => {
    const loop = frameLoop()
    mount({ imageUrl: '/missing.png', createImage: failingImage, clock: loop.clock })

    // The loop this is about, running: a mounted sprite holds the player's timer and the idle
    // playlist's. Without this half the assertion below would pass for a ball that never started.
    expect(loop.live()).toBeGreaterThan(0)

    await flush()

    // `cors` and not `plain`: the branch is refused on the loader's first report, which unmounts
    // the sprite and destroys the loader before its retry can report — the same reading
    // `desktop-pet-root.test.ts` takes, and the reason a green `sprite-player` test must not be
    // read as a ball that retries.
    expect(failures.filter((notice) => notice !== null)).toHaveLength(1)
    expect(failures.at(-1)).toMatch(/did not load/)
    expect(document.querySelector('.pet-sprite')).toBeNull()
    expect(document.querySelector('.pet-ball__highlight')).not.toBeNull()
    expect(loop.live()).toBe(0)
  })

  it('says which canvas cannot be painted on, rather than leaving it ticking', async () => {
    getContextSpy?.mockReturnValue(null)
    const loop = frameLoop()
    mount({ imageUrl: '/characters/cat.png', clock: loop.clock })
    await flush()

    // The context is refused at mount, so the player was already built by the time the ball heard
    // about it — which is why the report has to refuse the branch rather than merely record it.
    expect(failures.at(-1)).toMatch(/no 2D context/)
    expect(document.querySelector('.pet-sprite')).toBeNull()
    expect(loop.live()).toBe(0)
  })

  it('says nothing at all while the character draws', () => {
    const loop = frameLoop()
    mount({ imageUrl: '/characters/cat.png', clock: loop.clock })

    // The first report is `null`, and a host that only ever heard about failures would have to
    // guess at the state it mounted with.
    expect(failures).toEqual([null])
    expect(document.querySelector('.pet-sprite')).not.toBeNull()
    expect(loop.live()).toBeGreaterThan(0)
  })

  it('says so in the orb\'s own title, because the orb is the whole window', async () => {
    const orb = mount({ imageUrl: '/missing.png', createImage: failingImage })
    const before = orb.title
    await flush()

    expect(before).not.toMatch(/did not load/)
    expect(document.querySelector('.pet-ball__orb')?.getAttribute('title')).toMatch(/did not load/)
  })

  it('withdraws the report and draws again when the next character loads', async () => {
    const image = { current: failingImage as ImageFactory }
    const ball = mountChoosing({ url: '/characters/broken.png', image })
    await flush()
    expect(document.querySelector('.pet-sprite')).toBeNull()

    image.current = loadingImage
    await ball.choose('/characters/cat.png')

    // A failure belongs to one attempt: the subject changed, so the branch is back and the host
    // that showed the sentence is told to take it down. Without the second half the ball would
    // refuse a character that loads for the rest of the window's life.
    expect(document.querySelector('.pet-sprite')).not.toBeNull()
    expect(failures.at(-1)).toBeNull()
  })
})
