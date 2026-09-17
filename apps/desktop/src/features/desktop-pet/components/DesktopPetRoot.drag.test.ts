/**
 * The character window's drag: the gesture, what it refuses, and what the window pays for it.
 *
 * A file of its own rather than a suite in `desktop-pet-root.test.ts`, because it is a different
 * subject: that one is what this window draws and what it says instead of drawing, and this one is
 * the only thing in it a pointer can do. **What it is evidence for is a port that was missed, not
 * a feature that was added.** Upstream drags its pet window from the sprite canvas
 * (`references/desktop-pet/windows/src/main.ts:555-613`) and this port had the permission, the
 * gesture and the adapter without ever asking the character window for any of them — so the ball
 * could be moved and the pet could not. Each case below is one of upstream's own rules, named
 * where it comes from, or one of this port's own rules about what having a drag costs.
 *
 * Two things about the environment are fixture rather than subject, and both are stated here
 * because a case that passed for the wrong one of them would be worthless:
 *
 *  - **The canvas.** happy-dom implements no canvas, so `getContext('2d')` answers `null` for
 *    every element and a suite that means to exercise the drawing path has to supply the context.
 *    The sibling file mocks it for the same reason.
 *  - **The layout box.** happy-dom lays nothing out, so `clientWidth` is 0 — and `hitTestSprite`
 *    divides by it with the `|| 1` upstream used for exactly this case, which turns one CSS pixel
 *    into the whole backing store and makes every point miss. So the canvas is given the box its
 *    own props already ask for (160x180, `PetSprite`'s `width`/`height`), which is the box it has
 *    in a browser; the conversion is then 1:1 and a point lands where the case puts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import {
  createMemoryPetGateway,
  type MemoryPetGateway,
} from '../../../platform/gateways/memory-pet'
import {
  PET_SETTINGS_DEFAULTS,
  type PetCharacterEntry,
} from '../../../platform/gateways/pet-contracts'
import type { ImageFactory, LoadableImage } from '../rendering/sprite-sheet'
import type { Rect, SheetPixelReader, SheetPixels } from '../rendering/sprite-slicer'
import DesktopPetRoot from './DesktopPetRoot.vue'

/** The character's box, which is also the canvas's: `DesktopPetRoot`'s default width and height. */
const BOX = { width: 160, height: 180 }

/** Where a press lands inside it, in CSS pixels — the middle of the sprite the fixture draws. */
const ON_THE_PET = { x: 80, y: 96 }

/** One character, whole on disk: what the host's appearance read hands the window to draw. */
const WORKING: PetCharacterEntry = {
  characterId: 'working',
  packName: 'Working',
  kind: 'imported',
  files: 'intact',
  installedAtMs: 2,
}

/**
 * A sheet that decodes, so the window draws a character and there is something to grab.
 *
 * The factory takes no URL — the loader sets `src` on what it hands back — so the decision is made
 * in the setter, which is where a real `Image` learns the same thing.
 */
const drawable: ImageFactory = () => {
  const image = {
    naturalWidth: 0,
    naturalHeight: 0,
    crossOrigin: null as string | null,
    src: '',
    onload: null as ((ev: Event) => void) | null,
    onerror: null as ((ev: Event) => void) | null,
  }
  Object.defineProperty(image, 'src', {
    set() {
      queueMicrotask(() => {
        image.naturalWidth = 32
        image.naturalHeight = 24
        image.onload?.(new Event('load'))
      })
    },
    get: () => '',
  })
  return image
}

/** Never resolves: the sheet stays loading, so no frame is drawn and `spriteRect` stays null. */
const loadingImage: ImageFactory = (): LoadableImage => ({
  naturalWidth: 0,
  naturalHeight: 0,
  crossOrigin: null,
  src: '',
  onload: null,
  onerror: null,
})

/** One clip of two cells, so a decoded sheet slices into something the player will draw. */
const twoCells: SheetPixelReader = (_img, width, height): SheetPixels => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const rect of [
    { x: 0, y: 0, w: 8, h: height },
    { x: 16, y: 0, w: 8, h: height },
  ] satisfies Rect[]) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) data[(y * width + x) * 4 + 3] = 255
    }
  }
  return { width, height, data }
}

let getContextSpy: MockInstance<HTMLCanvasElement['getContext']> | null = null

/**
 * The two layout readings, as they are before the suite touches them.
 *
 * happy-dom puts them on `HTMLElement.prototype`, so the suite's override is a *new own* property
 * on `HTMLCanvasElement.prototype` rather than a replacement of one — which is why there is nothing
 * to restore and something to delete. Kept as a list of the names so the afterEach below cannot
 * drift from the beforeEach above.
 */
const BOX_PROPS = ['clientWidth', 'clientHeight'] as const

/** A 2D context whose pixels are `alpha`, which is the whole of what `hitTest` reads. */
function canvasContext(alpha: number): CanvasRenderingContext2D {
  return {
    imageSmoothingEnabled: true,
    clearRect: () => undefined,
    drawImage: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha]) }),
  } as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(canvasContext(255))
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => BOX.width,
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => BOX.height,
  })
})

const mounted: VueApp[] = []

/** The clock the press is measured against, moved by the cases rather than by waiting. */
let clock = 0

/** What the compositor was asked to do, in order. */
let calls: string[] = []

/** The mounted root, for the one case that drives the lifecycle rather than the pointer. */
let root: { lifecycle: { hide(): Promise<void> } } | null = null

/**
 * The window, with a host to talk to and — unless a case says otherwise — a character to draw.
 *
 * `imageUrl` is passed rather than chosen through the host's settings the way the sibling suite
 * does it: what these cases are about is the pointer, and a settings round trip in front of each
 * one would be machinery around the subject. It is the same prop path that suite's own hiding case
 * uses, and the host's read still runs — its answer has no character in it, so this window's
 * `?? props.imageUrl` is what supplies the sheet. The two cases about the input region pass
 * `imageUrl: null` instead, because *when* the character appears is the thing they measure.
 *
 * The canvas is *not* returned here: the window draws it after the lifecycle's first read, so a
 * caller that took the element synchronously would get `null`, and a case that then passed would
 * be a case about nothing. {@link pet} is the accessor, and every case calls it after a flush.
 */
function mount(props: Record<string, unknown> = {}): MemoryPetGateway {
  calls = []
  clock = 0
  const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
  document.body.innerHTML = '<div id="host"></div>'
  const app = createApp(DesktopPetRoot, {
    gateway: host,
    connection: host,
    imageUrl: '/cat.png',
    createImage: drawable,
    readPixels: twoCells,
    now: () => clock,
    ...props,
  })
  mounted.push(app)
  root = app.mount(document.getElementById('host') as Element) as unknown as {
    lifecycle: { hide(): Promise<void> }
  }
  return host
}

/** The sprite's canvas: the element the listeners are on, once the window has drawn it. */
function pet(): HTMLElement {
  return document.querySelector('.pet-sprite') as HTMLElement
}

/** The character's own settings write, which is how the settings page tells an open window. */
async function choose(
  host: MemoryPetGateway,
  characterId: string,
  revision: number,
): Promise<void> {
  await host.updateSettings({
    domain: 'character',
    revision,
    values: { ...PET_SETTINGS_DEFAULTS.character, characterId },
  })
}

/**
 * A platform whose one method is recorded and whose promise the case decides.
 *
 * `release` is how a case says the operating-system drag is over — which is the moment the window
 * stops drawing its dragging state, so a case that never released it would be asserting against a
 * drag that is still happening.
 */
function platform(): { platform: { startDrag: () => Promise<void> }; release: () => void } {
  let release = (): void => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    platform: {
      startDrag: () => {
        calls.push('drag')
        return pending
      },
    },
    release,
  }
}

/**
 * A pointer event by type, at a point on the character.
 *
 * `screenX`/`screenY` are what the gesture measures (`pet-ball-input.ts`: window-relative deltas
 * cancel themselves out during a drag), and `clientX`/`clientY` are what the hit test reads.
 */
function pointer(
  type: string,
  screenX: number,
  screenY: number,
  button = 0,
  at: { x: number; y: number } = ON_THE_PET,
): MouseEvent {
  return new MouseEvent(type, {
    screenX,
    screenY,
    clientX: at.x,
    clientY: at.y,
    button,
    bubbles: true,
    cancelable: true,
  })
}

/** A press that wanders far enough to be a drag, and the compositor's answer to it. */
function wander(element: HTMLElement, release: () => void): Promise<void> {
  clock = 0
  element.dispatchEvent(pointer('pointerdown', 1000, 600))
  clock = 30
  element.dispatchEvent(pointer('pointermove', 1040, 620))
  release()
  return flush()
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
  getContextSpy?.mockRestore()
  getContextSpy = null
  // Deleted rather than restored: see {@link BOX_PROPS}. Deleting the own property puts the
  // inherited one back, which is the state every other suite runs in.
  for (const name of BOX_PROPS) {
    delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the character is a drag handle, and the ball’s rule is what measures it', () => {
  it('turns a press that wanders into one compositor drag', async () => {
    const { platform: desktop, release } = platform()
    mount({ platform: desktop })
    await flush()
    const sprite = pet()

    clock = 0
    sprite.dispatchEvent(pointer('pointerdown', 1000, 600))
    // The pressed state is what the hand is told before anything is decided, and it is the orb's
    // state under the orb's name. `nextTick` because a class the renderer has to write is a frame
    // behind the event that caused it — asserting before it is asserting on the previous render.
    await nextTick()
    expect(sprite.classList.contains('is-pressed')).toBe(true)

    clock = 30
    sprite.dispatchEvent(pointer('pointermove', 1040, 620))

    // One drag, asked for once: upstream `:594` — the cursor has to move more than 4 px — and the
    // arithmetic itself is `pet-ball-input.test.ts`'s. What is asserted here is that this window
    // reaches it.
    expect(calls).toEqual(['drag'])
    await flush()
    // The compositor owns the pointer from here, so the state stays until the platform says the
    // drag is over (`main.ts:597`'s `finally`, which is what the orb's own `endDrag` waits for).
    expect(sprite.classList.contains('is-dragging')).toBe(true)
    expect(sprite.classList.contains('is-pressed')).toBe(false)

    release()
    await flush()
    expect(sprite.classList.contains('is-dragging')).toBe(false)
  })

  it('does not drag when the press never wandered', async () => {
    const { platform: desktop, release } = platform()
    mount({ platform: desktop })
    await flush()
    const sprite = pet()

    clock = 0
    sprite.dispatchEvent(pointer('pointerdown', 1000, 600))
    clock = 60
    sprite.dispatchEvent(pointer('pointerup', 1000, 600))
    await flush()
    release()

    // Upstream `:600-603`: a press released without moving is the *other* half of the gesture —
    // its `onPetClick` needs `ap_left_click_action`, which this build has not built, so what is
    // left to assert is the refusal. A click that started a drag would move the window every time
    // the user meant to poke the pet.
    expect(calls).toEqual([])
    expect(sprite.classList.contains('is-dragging')).toBe(false)
    expect(sprite.classList.contains('is-pressed')).toBe(false)
  })

  it('refuses a press that lands beside the character rather than on it', async () => {
    // Upstream `:588-590` — 「clicks on the empty area around the pet don't drag the window」 — and
    // the reason `PetSprite` has exposed `hitTest` and `geometry` since D2 for a shell that did not
    // exist. The transparent pixel is the mock's alpha, which is the one reading that rule needs.
    getContextSpy?.mockReturnValue(canvasContext(0))
    const { platform: desktop, release } = platform()
    mount({ platform: desktop })
    await flush()
    const sprite = pet()

    await wander(sprite, release)
    expect(calls).toEqual([])
    expect(sprite.classList.contains('is-dragging')).toBe(false)

    // The control, without which this case would pass on a window that never drags at all: the
    // same press, the same fixture, one opaque pixel.
    getContextSpy?.mockReturnValue(canvasContext(255))
    mount({ platform: desktop })
    await flush()
    await wander(pet(), release)
    expect(calls).toEqual(['drag'])
  })

  it('still lets the window be grabbed before the first frame is drawn', async () => {
    // Upstream `:588-589`: while the sheet is still loading there is no sprite rect to test
    // against, and it allowed the drag anyway 「so the pet is never untouchable」. The rect is what
    // refuses a press here, never the miss — `hitTest` answers false for both.
    const { platform: desktop, release } = platform()
    mount({ platform: desktop, createImage: loadingImage })
    await flush()

    await wander(pet(), release)
    expect(calls).toEqual(['drag'])
  })

  it('arms nothing but the primary button', async () => {
    const { platform: desktop, release } = platform()
    mount({ platform: desktop })
    await flush()
    const sprite = pet()

    clock = 0
    // A right-click belongs to the menu the bubble opens; upstream returned for any other button
    // (`:583`) so that its own gesture could not also become a drag.
    sprite.dispatchEvent(pointer('pointerdown', 1000, 600, 2))
    clock = 30
    sprite.dispatchEvent(pointer('pointermove', 1040, 620))
    await flush()
    release()

    expect(sprite.classList.contains('is-pressed')).toBe(false)
    expect(calls).toEqual([])
  })

  it('forgets a press the compositor has taken away', async () => {
    const { platform: desktop, release } = platform()
    mount({ platform: desktop })
    await flush()
    const sprite = pet()

    clock = 0
    sprite.dispatchEvent(pointer('pointerdown', 1000, 600))
    clock = 10
    // What the page is sent once the compositor owns the pointer, and the reason the gesture has a
    // `cancel` at all: a press that outlived its own pointer would be measured against a stale
    // origin on the next one.
    sprite.dispatchEvent(pointer('pointercancel', 1000, 600))
    clock = 30
    sprite.dispatchEvent(pointer('pointermove', 1040, 620))
    await flush()
    release()

    expect(calls).toEqual([])
    expect(sprite.classList.contains('is-pressed')).toBe(false)
  })

  it('keeps the dragging state honest when the compositor refuses', async () => {
    mount({ platform: { startDrag: () => Promise.reject(new Error('no compositor')) } })
    await flush()
    const sprite = pet()

    clock = 0
    sprite.dispatchEvent(pointer('pointerdown', 1000, 600))
    clock = 30
    sprite.dispatchEvent(pointer('pointermove', 1040, 620))
    await flush()

    // The character is where the user left it, and the window is not still pretending it is being
    // dragged — the case the orb's own suite has, read against the other surface.
    expect(sprite.classList.contains('is-dragging')).toBe(false)
  })
})

describe('a desktop that cannot move the character says so', () => {
  it('offers the grab cursor and the tooltip only where there is a drag to make', async () => {
    mount()
    await flush()
    const still = pet()
    expect(still.title).toBe('This desktop cannot move it')
    expect(still.classList.contains('is-movable')).toBe(false)

    const { platform: desktop, release } = platform()
    mount({ platform: desktop })
    await flush()
    const movable = pet()
    // One sentence for one state, and it is the orb's sentence: `PetFloatingBall.vue` chooses
    // between 「Drag to move」 and 「This desktop cannot move it」 on the same test, so the two
    // surfaces cannot describe the same machine differently.
    expect(movable.title).toBe('Drag to move')
    expect(movable.classList.contains('is-movable')).toBe(true)

    // And the cursor is not a promise: the same press on a window that cannot move anything is
    // refused before it is measured, so `is-movable` is not decoration over a drag that never
    // comes. Both presses run against the same recording, so the second is the only one counted.
    await wander(movable, release)
    expect(calls).toEqual(['drag'])
    mount()
    await flush()
    calls = []
    await wander(pet(), release)
    expect(calls).toEqual([])
  })
})

describe('the window takes the pointer for the character, because a drag handle is what it is', () => {
  it('asks for the character and takes the pointer back, in that order', async () => {
    const { platform: desktop } = platform()
    const host = mount({ platform: desktop, imageUrl: null, createImage: loadingImage })
    await flush()

    // A window with nothing to act on asks the compositor to let clicks through — the rule this
    // window had before it could be dragged, and the state a case has to start from: an assertion
    // that the window asked for *nothing* would be indistinguishable from a window that never
    // asked at all (the same reason the sibling suite reads the whole list and not the last value).
    expect(host.clickThrough()).toEqual([true])

    await choose(host, WORKING.characterId, 1)
    await flush()
    await flush()

    // `needsInput`'s third term, and the trade-off this component's own comment used to defer:
    // `usePetClickThrough`'s switch is per window, so a window whose character can be grabbed
    // cannot also pass the empty part of its 260x320 box through. A click-through window is sent
    // no pointer events at all, which is what makes the choice one-way — and the alternative is
    // the failure this repository names most often: a control nothing can reach.
    expect(pet()).not.toBeNull()
    expect(host.clickThrough()).toEqual([true, false])
  })

  it('keeps the pass-through it had where this desktop cannot move anything', async () => {
    const host = mount({ imageUrl: null, createImage: loadingImage })
    await flush()
    await choose(host, WORKING.characterId, 1)
    await flush()
    await flush()

    // The same window, the same character, no platform: `dragHandle` is false, so the character is
    // not a control and the window has nothing to take the pointer for. This is the existing
    // suite's own assertion (`desktop-pet-root.test.ts`), and it is what keeps the rule above from
    // being "a window with a pet is always interactive".
    expect(pet()).not.toBeNull()
    expect(host.clickThrough()).toEqual([true])
  })

  it('gives the pointer back when the character it was holding it for is gone', async () => {
    const { platform: desktop } = platform()
    const host = mount({ platform: desktop, imageUrl: null, createImage: loadingImage })
    await flush()
    await choose(host, WORKING.characterId, 1)
    await flush()
    await flush()
    expect(host.clickThrough()).toEqual([true, false])

    // §7.1's drawing scope, read against the new term: hiding takes the sprite away, and a window
    // with no sprite has no drag handle either — so it goes back to being click-through.
    await root?.lifecycle.hide()
    await flush()
    await flush()
    expect(host.clickThrough()).toEqual([true, false, true])
  })
})
