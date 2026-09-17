/**
 * The pet window's root: what it draws, what it says instead of drawing, and what it gives back.
 *
 * The states matter as much as the drawing. §7.2's rule about a capability that is not there —
 * state it — applies to this window's own host connection: a root that rendered an idle pet while
 * knowing nothing would be indistinguishable from a working one, which is the failure that costs
 * the most to find. Each of those states is one assertion below, and the alternative to each is
 * visible in what the assertion refuses.
 *
 * It lives in `components/` beside the component rather than in one of the plan's other V-gates,
 * because this file is the root's own behaviour and nothing else's.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import {
  PET_SETTINGS_DEFAULTS,
  type PetCharacterEntry,
  type PetGateway,
  type PetTaskProjection,
} from '../../../platform/gateways/pet-contracts'
import type { ImageFactory, LoadableImage } from '../rendering/sprite-sheet'
import type { Rect, SheetPixelReader, SheetPixels } from '../rendering/sprite-slicer'
import DesktopPetRoot from './DesktopPetRoot.vue'

/** A host with one answer and a listener count, which is all this file needs. */
class FakeHost implements PetGateway {
  readonly listeners = new Set<(tasks: PetTaskProjection[]) => void>()
  readonly featureListeners = new Set<(state: { enabled: boolean; visible: boolean }) => void>()
  enabled = true
  visible = true

  async feature() {
    return { enabled: this.enabled, visible: this.enabled && this.visible }
  }

  async setVisible(next: boolean) {
    this.visible = next
    return { enabled: this.enabled, visible: this.enabled && this.visible }
  }

  async capabilities(): Promise<never> {
    throw new Error('the window does not read capabilities here')
  }

  async care(): Promise<never> {
    // §7.1's isolation: the pet window carries no care surface (the file list in
    // `desktop-pet-entry.test.ts` says so), so this host is never asked and a call here is a
    // wiring mistake rather than a state to model.
    throw new Error('the window does not read the care ledger here')
  }

  async tasks(): Promise<PetTaskProjection[]> {
    return []
  }

  async subscribe(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void> {
    this.listeners.add(onTasks)
    onTasks([])
    return () => this.listeners.delete(onTasks)
  }

  // The four calls this window makes *when it is given a connection* — an appearance to draw and
  // a key to route. This file's cases pass a bare gateway, so the window is never handed the wider
  // surface and a call here is a wiring mistake rather than a state to model.
  async appearance(): Promise<never> {
    throw new Error('this window was not given a connection to read its appearance from')
  }

  async library(): Promise<never> {
    throw new Error('this window has no library page')
  }

  async importCharacter(): Promise<never> {
    throw new Error('this window does not import characters')
  }

  async catalogue(): Promise<never> {
    throw new Error('this window has no catalogue page')
  }

  async adoptCharacter(): Promise<never> {
    throw new Error('this window has no catalogue page')
  }

  async openTask(): Promise<never> {
    throw new Error('this window was not given a connection to route a task through')
  }

  async subscribeFeature(
    onFeature: (state: { enabled: boolean; visible: boolean }) => void,
  ): Promise<() => void> {
    this.featureListeners.add(onFeature)
    onFeature({ enabled: this.enabled, visible: this.enabled && this.visible })
    return () => this.featureListeners.delete(onFeature)
  }

  async readSettings(): Promise<never> {
    throw new Error('the window does not read settings here')
  }

  async updateSettings(): Promise<never> {
    throw new Error('the window does not write settings here')
  }

  async openSettings(): Promise<void> {}
}

/** Never resolves: the sheet stays "loading", which is a state this window has nothing to say about. */
const loadingImage: ImageFactory = (): LoadableImage => ({
  naturalWidth: 0,
  naturalHeight: 0,
  crossOrigin: null,
  src: '',
  onload: null,
  onerror: null,
})

/** Fails both attempts, the way upstream's loader does when a URL is not there (D2's deviation 2). */
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
    get: () => '',
  })
  return image
}

/**
 * A sheet that decodes for one character and fails for another, the way a pack with a missing file
 * and a pack without one behave on the same machine.
 *
 * The factory takes no URL — `SheetLoader` sets `src` on what it hands back — so the decision is made
 * in the `src` setter, which is also where a real `Image` learns the same thing. Both of the
 * loader's attempts go through it, so a URL this refuses is refused the way upstream refuses one.
 */
function imagesFor(loads: (url: string) => boolean): ImageFactory {
  return () => {
    // Not annotated as `LoadableImage` where it is built: `SpriteImageLike` declares the two
    // dimensions `readonly`, and this fixture has to *become* decoded. Inferred, they are the
    // mutable numbers a test writes to, and the shape still satisfies the interface it is returned
    // through.
    const image = {
      naturalWidth: 0,
      naturalHeight: 0,
      crossOrigin: null as string | null,
      src: '',
      onload: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
    }
    Object.defineProperty(image, 'src', {
      set(value: string) {
        queueMicrotask(() => {
          if (!loads(value)) {
            image.onerror?.(new Event('error'))
            return
          }
          image.naturalWidth = 32
          image.naturalHeight = 24
          image.onload?.(new Event('load'))
        })
      },
      get: () => '',
    })
    return image
  }
}

/** One clip of two cells spanning the sheet, so a decoded sheet slices into something drawable. */
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

const BROKEN: PetCharacterEntry = {
  characterId: 'broken',
  packName: 'Broken',
  kind: 'imported',
  files: 'intact',
  installedAtMs: 1,
}
const WORKING: PetCharacterEntry = {
  characterId: 'working',
  packName: 'Working',
  kind: 'imported',
  files: 'intact',
  installedAtMs: 2,
}

/** The character's own settings write: how the settings page tells an open window which one to draw. */
async function choose(host: MemoryPetGateway, characterId: string, revision: number): Promise<void> {
  await host.updateSettings({
    domain: 'character',
    revision,
    values: { ...PET_SETTINGS_DEFAULTS.character, characterId },
  })
}

const mounted: VueApp[] = []

function mount(props: Record<string, unknown>): ReturnType<VueApp['mount']> {
  document.body.innerHTML = '<div id="host"></div>'
  const app = createApp(DesktopPetRoot, props)
  mounted.push(app)
  return app.mount(document.getElementById('host') as Element)
}

const noticeText = (): string | null =>
  document.querySelector('.pet-root__notice')?.textContent ?? null

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * happy-dom implements no canvas, so `getContext('2d')` answers `null` for every element — which is
 * the state `PetSprite` reports through `onUnavailable`, and which this window now states. A case
 * that means to exercise the *drawing* path therefore has to supply the context the drawing path
 * runs on, exactly as `rendering/pet-sprite.test.ts` does; the one case below that means to
 * exercise the other path sets the mock back to `null`.
 */
let getContextSpy: MockInstance<HTMLCanvasElement['getContext']> | null = null
const context2d = {
  imageSmoothingEnabled: true,
  clearRect: () => undefined,
  drawImage: () => undefined,
  getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
} as unknown as CanvasRenderingContext2D

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

describe('the pet window draws, or says why it cannot', () => {
  it('states a missing host connection rather than drawing a pet that knows nothing', async () => {
    mount({ createImage: loadingImage })

    expect(document.querySelector('.pet-root')).not.toBeNull()
    expect(document.querySelector('.pet-sprite')).toBeNull()
    expect(document.querySelector('.pet-root__notice')?.textContent).toMatch(/host connection/i)
  })

  it('draws the sprite the host says is showing', async () => {
    const host = new FakeHost()
    mount({ gateway: host, imageUrl: '/characters/cat.png', createImage: loadingImage })
    await flush()

    expect(document.querySelector('.pet-sprite')).not.toBeNull()
    expect(document.querySelector('.pet-root__notice')).toBeNull()
    expect(host.listeners.size).toBe(1)
  })

  it('says which state it is in when there is nothing to draw', async () => {
    const host = new FakeHost()
    mount({ gateway: host, createImage: loadingImage })
    await flush()
    expect(document.querySelector('.pet-root__notice')?.textContent).toMatch(/no character is selected/i)

    host.enabled = false
    const off = new FakeHost()
    off.enabled = false
    mount({ gateway: off, imageUrl: '/cat.png', createImage: loadingImage })
    await flush()
    // A disabled feature is §5.1's 启用 and not §5.1's 显示: saying "switched off" is what keeps the
    // user's way back obvious.
    expect(document.querySelector('.pet-root__notice')?.textContent).toMatch(/switched off/i)
  })

  it('states a sheet that will not load instead of freezing on an idle frame', async () => {
    const host = new FakeHost()
    mount({ gateway: host, imageUrl: '/missing.png', createImage: failingImage })
    await flush()

    expect(noticeText()).toMatch(/did not load/i)
  })

  it("states the loader's first report, because the retry never gets to make one", async () => {
    // The loader reports the `crossOrigin` attempt and *then* retries plain; this window refuses
    // the sprite branch on that report, which unmounts the sprite and destroys the loader before
    // the retry's callbacks land (`sprite-sheet.ts`'s `retryPlain`). The fixture fails both
    // attempts, so a window that reported the second one would say `(plain)` here. Asserted
    // because the retry has its own case in `rendering/sprite-player.test.ts`, and that green must
    // not be readable as a window that retries.
    const host = new FakeHost()
    mount({ gateway: host, imageUrl: '/missing.png', createImage: failingImage })
    // Twice: a window that let the second report through would say `(plain)` only once the retry
    // had failed too, and reading before that would pass for the wrong reason.
    await flush()
    await flush()

    expect(noticeText()).toMatch(/\(cors\)/)
    expect(document.querySelector('.pet-sprite')).toBeNull()
  })

  it('states a canvas it cannot paint on, rather than nothing at all', async () => {
    // The engine's own answer, not a mocked one: `PetSprite` reports this state rather than
    // throwing (D2's deviation 2), and a window that does not pass `onUnavailable` leaves the state
    // announced to nobody — an inert canvas where the pet should be, which is what a window with
    // nothing to draw looks like.
    getContextSpy?.mockReturnValue(null)
    mount({ gateway: new FakeHost(), imageUrl: '/cat.png', createImage: loadingImage })
    await flush()

    expect(noticeText()).toMatch(/no 2D context/i)
    expect(document.querySelector('.pet-sprite')).toBeNull()
  })
})

/*
 * Recovery: a failure is a fact about *one* attempt, and it stops being a fact when the attempt is
 * replaced. Both cases below drive the real route a user takes — the character settings write that
 * an open window hears on `pet-settings-changed` — because that is the route the failure has to
 * come out of. A window that only recovers when it is closed and reopened is what these refuse.
 */
describe('a failure does not outlive what failed', () => {
  it('draws again when the next character loads, after one that did not', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [BROKEN, WORKING] })
    mount({
      gateway: host,
      connection: host,
      // One pack on this "machine" is whole and the other is not: `broken` is the character whose
      // file is missing, and every other URL decodes.
      createImage: imagesFor((url) => !url.includes(BROKEN.characterId)),
      readPixels: twoCells,
    })
    await flush()

    await choose(host, BROKEN.characterId, 1)
    await flush()
    // The failure is real before it is stale: without this the case would pass on a window that
    // never noticed the broken character at all.
    expect(noticeText()).toMatch(/did not load/i)
    expect(document.querySelector('.pet-sprite')).toBeNull()

    await choose(host, WORKING.characterId, 2)
    await flush()
    expect(document.querySelector('.pet-sprite')).not.toBeNull()
    expect(noticeText()).toBeNull()
  })

  it('tries a fresh canvas the next time the window is asked to draw again', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
    getContextSpy?.mockReturnValue(null)
    const vm = mount({
      gateway: host,
      connection: host,
      createImage: imagesFor(() => true),
      readPixels: twoCells,
    }) as unknown as { lifecycle: { hide(): Promise<void>; show(): Promise<void> } }
    await flush()
    await choose(host, WORKING.characterId, 1)
    await flush()
    expect(noticeText()).toMatch(/no 2D context/i)

    // A canvas element's context is decided once for that element, so the failure belongs to the
    // element and not to the character. Hiding unmounts the sprite (§7.1's drawing scope), which
    // means the window is shown again on a canvas that has never been asked.
    await vm.lifecycle.hide()
    await flush()
    getContextSpy?.mockReturnValue(context2d)
    await vm.lifecycle.show()
    await flush()

    expect(document.querySelector('.pet-sprite')).not.toBeNull()
    expect(noticeText()).toBeNull()
  })
})

/*
 * The window's own input region (§7.2's 鼠标穿透).
 *
 * This is the wiring half: the policy is `composables/use-pet-click-through.test.ts`'s, and what
 * is asserted here is that this window *has* one and that it is driven by what the window shows.
 * Two facts about the state are what make the assertions below meaningful — a fresh window takes
 * clicks, and a pet that is showing a character and nothing else has nothing to click — so the
 * first request is the one that stops the window being a 260x320 hole in the desktop, and the
 * `false` that follows is the one that keeps the bubble clickable when a task arrives.
 */
/*
 * The bubble's background alpha, from the host read to the surface it is drawn on (§5.2's
 * 气泡与消息).
 *
 * This is the end of the chain the settings page's control starts: the page writes
 * `message.opacity`, the host hands it to a window on the appearance read, and the bubble inside
 * this root draws with it. Before that chain existed the control wrote a value nothing read, which
 * is the defect these two cases are the acceptance for.
 */
describe('the bubble is drawn at the alpha the host read carried', () => {
  /** The alpha the surface is actually carrying, which is what the stylesheet mixes. */
  const drawnAlpha = (): string | undefined =>
    document.querySelector<HTMLElement>('.pet-bubble')?.style.getPropertyValue('--pet-bubble-alpha')

  /**
   * The `message` domain's own write, as §5.2's 气泡与消息 page makes it.
   *
   * Through the host's channel rather than by handing the window a hand-built appearance: the
   * double answers the alpha out of the settings store it shares with the gateway, so what these
   * cases drive is the chain a user's save takes — the route the ball's own policy cases use.
   */
  async function setAlpha(host: MemoryPetGateway, opacity: number, revision: number): Promise<void> {
    await host.updateSettings({
      domain: 'message',
      revision,
      values: { ...PET_SETTINGS_DEFAULTS.message, opacity },
    })
  }

  it('uses the alpha the read carried, over a task the bubble is showing', async () => {
    const host = createMemoryPetGateway({ visible: true })
    // Stored before the window opens, so the read this case is about is the one that draws the
    // first frame — an alpha the window had to re-read could pass here for the wrong reason.
    await setAlpha(host, 0.6, 1)
    mount({
      gateway: host,
      connection: host,
      createImage: imagesFor(() => true),
      readPixels: twoCells,
    })
    await flush()
    host.startRun()
    await flush()
    await flush()

    expect(document.querySelector('.pet-bubble')).not.toBeNull()
    expect(drawnAlpha()).toBe('60%')
  })

  it('re-reads it when another window writes the message domain', async () => {
    const host = createMemoryPetGateway({ visible: true })
    mount({
      gateway: host,
      connection: host,
      createImage: imagesFor(() => true),
      readPixels: twoCells,
    })
    await flush()
    host.startRun()
    await flush()
    await flush()
    // The schema's own default, which is what a store holding no `opacity` answers: 0.92 is the
    // value the bubble was drawn with before the field existed.
    expect(drawnAlpha()).toBe('92%')

    // A settings page saving the bubble's opacity. The window is already on screen, and the only
    // thing that tells it the domain moved is the `pet-settings-changed` frame: without the
    // listener, the surface would keep the alpha it was mounted with until the pet was restarted.
    await setAlpha(host, 0.7, 1)
    await flush()

    expect(drawnAlpha()).toBe('70%')
  })
})

/**
 * The bubble's theme, at the end of the chain the settings page's control starts.
 *
 * The defect this closes is the one the whole 气泡与消息 page was built around: `message.theme` was
 * stored, had a three-way control, and was read by the settings page's own preview and by nothing on
 * the desktop — so a user picked Light, watched the preview change, and the bubble beside their
 * character did not.
 *
 * **What is asserted is the page, not the component.** A theme is not a property of a subtree: the
 * light palette is the baseline `palettes.css` declares on `:root` and the dark one is a re-point of
 * it on `[data-theme="dark"]`, so the attribute goes on the element both selectors match — this
 * window's root, since the pet window is a page of its own. A case that looked for a class on
 * `.pet-bubble` would pass on a component that painted its own colours and never followed the
 * app's, which is exactly what the preview does and what this window must not.
 *
 * The document element is watched directly here rather than through an injected root: the root
 * component takes no such parameter because the *product* has no other page to draw on, and the
 * teardown puts the attribute back, so this file does not colour the next case in it.
 */
describe('the bubble is drawn in the theme the host read carried', () => {
  /** The `message` domain's own write, as §5.2's 气泡与消息 page makes it. */
  async function setTheme(
    host: MemoryPetGateway,
    theme: (typeof PET_SETTINGS_DEFAULTS)['message']['theme'],
    revision: number,
  ): Promise<void> {
    await host.updateSettings({
      domain: 'message',
      revision,
      values: { ...PET_SETTINGS_DEFAULTS.message, theme },
    })
  }

  it('puts the page in the theme the read carried, over a character that is drawing', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
    // Stored before the window opens, so the read this case is about is the one that draws the
    // first frame.
    await setTheme(host, 'dark', 1)
    mount({ gateway: host, connection: host, createImage: imagesFor(() => true), readPixels: twoCells })
    await flush()

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('re-reads it when another window writes the message domain', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
    mount({ gateway: host, connection: host, createImage: imagesFor(() => true), readPixels: twoCells })
    await flush()
    // `system`, and this runner's engine states no preference: the schema's default, which is the
    // theme the bubble was drawn in before the field reached this window.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    // A settings page saving the bubble's theme while the pet is already on the desktop — which is
    // the case the defect was reported from.
    await setTheme(host, 'dark', 1)
    await flush()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    // And back: the light arm is the absence of the attribute, so a window that only ever wrote it
    // would stay dark for a user who returned to Light.
    const read = await host.readSettings('message')
    if (read.status !== 'current') throw new Error('the double would not read message')
    await setTheme(host, 'light', read.record.revision)
    await flush()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('gives the page back when the window goes away', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
    await setTheme(host, 'dark', 1)
    mount({ gateway: host, connection: host, createImage: imagesFor(() => true), readPixels: twoCells })
    await flush()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    // The window's own unmount, and the only one this file performs inside a case: the attribute is
    // put back where it was found, so a window that closes does not leave a theme on a document it
    // is about to stop owning — and so the cases after this one start from no attribute at all.
    mounted.at(-1)?.unmount()
    await flush()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('the window takes the pointer only while it has something to click', () => {
  it('asks for pass-through as soon as it is showing a character and no task', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
    mount({
      gateway: host,
      connection: host,
      createImage: imagesFor(() => true),
      readPixels: twoCells,
    })
    await flush()

    expect(host.clickThrough()).toEqual([true])
  })

  it('asks for the pointer back while the bubble is showing a task', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
    mount({
      gateway: host,
      connection: host,
      createImage: imagesFor(() => true),
      readPixels: twoCells,
    })
    await flush()
    expect(host.clickThrough()).toEqual([true])

    host.startRun()
    await flush()
    await flush()

    // The bubble is the window's only clickable surface today, so its appearing is the one event
    // that has to turn the compositor's switch back — and it is the bubble's *own* visibility that
    // decides, not a second copy of "is there a task" in the root.
    expect(document.querySelector('.pet-bubble')).not.toBeNull()
    expect(host.clickThrough()).toEqual([true, false])
  })

  it('lets go again when the surface it was holding the pointer for is gone', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [WORKING] })
    const vm = mount({
      gateway: host,
      connection: host,
      createImage: imagesFor(() => true),
      readPixels: twoCells,
    }) as unknown as { lifecycle: { hide(): Promise<void>; show(): Promise<void> } }
    await flush()
    host.startRun()
    await flush()
    await flush()
    expect(host.clickThrough()).toEqual([true, false])

    // §7.1's drawing scope: hiding takes the bubble away (§7.1's 隐藏时停止动画绘制), and a window with
    // nothing on screen has nothing to hold the pointer for. Showing it again is the same rule
    // read the other way, and the task is still in the list when it comes back.
    await vm.lifecycle.hide()
    await flush()
    await flush()
    expect(host.clickThrough()).toEqual([true, false, true])

    await vm.lifecycle.show()
    await flush()
    await flush()
    expect(host.clickThrough()).toEqual([true, false, true, false])
  })
})

describe('hiding takes the sprite away and keeps the window listening', () => {
  it('stops drawing while the host still reaches the window', async () => {
    const host = new FakeHost()
    const vm = mount({
      gateway: host,
      imageUrl: '/cat.png',
      createImage: loadingImage,
    }) as unknown as { lifecycle: { hide(): Promise<void> } }
    await flush()

    await vm.lifecycle.hide()

    expect(document.querySelector('.pet-sprite')).toBeNull()
    // §7.1: 隐藏时停止动画绘制但保留后端提醒. The listener is the reminder.
    expect(host.listeners.size).toBe(1)
  })

  it("gives the host's listener back when the window goes away", async () => {
    const host = new FakeHost()
    document.body.innerHTML = '<div id="host"></div>'
    const app = createApp(DesktopPetRoot, {
      gateway: host,
      imageUrl: '/cat.png',
      createImage: loadingImage,
    })
    mounted.push(app)
    app.mount(document.getElementById('host') as Element)
    await flush()
    expect(host.listeners.size).toBe(1)

    app.unmount()

    // Unmount is the destruction path (§10.2): no listener survives the component, which is what
    // "closing and reopening the pet window leaks nothing" reduces to on this side.
    expect(host.listeners.size).toBe(0)
  })
})
