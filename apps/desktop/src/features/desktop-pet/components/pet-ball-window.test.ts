/**
 * The ball window's root: what the orb wears, where its gestures go, and what it never asks for.
 *
 * The ball is the pet's second window and the opposite of the first one on the axis §7.2 is about.
 * The character window asks to be click-through whenever it has nothing for the pointer; the ball
 * is a stable click target, so the assertion that matters most here is a *negative* one — this
 * window never asks, and the double records every request so "never" is checkable rather than
 * claimed.
 *
 * The other states are the ones a window that reads from a host can be in, and each is asserted
 * because the alternative to it is invisible: a ball that drew a plain orb while knowing nothing
 * looks exactly like a ball whose host said there is no character.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import {
  PET_SETTINGS_DEFAULTS,
  type PetCharacterEntry,
  type PetMotion,
  type PetWindowGateway,
} from '../../../platform/gateways/pet-contracts'
import type { ImageFactory } from '../rendering/sprite-sheet'
import PetBallWindow from './PetBallWindow.vue'

const KITTY: PetCharacterEntry = {
  characterId: 'kitty',
  packName: 'Kitty',
  kind: 'imported',
  files: 'intact',
  installedAtMs: 1,
}
const DAMAGED: PetCharacterEntry = {
  characterId: 'torn',
  packName: 'Torn',
  kind: 'imported',
  files: 'damaged',
  installedAtMs: 2,
}

/** The character domain's own write: how a settings page tells a window which one to draw. */
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
 * A sheet that decodes, because happy-dom decodes nothing.
 *
 * `desktop-pet-root.test.ts` and `pet-floating-ball.test.ts` carry the same fixture and the same
 * reason: with no image factory the sprite reports a load error, and the orb — correctly — refuses
 * the branch. That is a state this file asserts on purpose elsewhere; here the subject is the
 * *drawn* ball, so the loader is supplied.
 */
function imagesFor(loads: (url: string) => boolean): ImageFactory {
  return () => {
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

/** happy-dom implements no canvas either, so the one the orb draws on is supplied here. */
let getContextSpy: MockInstance<HTMLCanvasElement['getContext']> | null = null
const context2d = {
  imageSmoothingEnabled: true,
  clearRect: () => undefined,
  drawImage: () => undefined,
  getImageData: (_x: number, _y: number, width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  }),
} as unknown as CanvasRenderingContext2D

const mounted: VueApp[] = []

function mount(connection: PetWindowGateway | null): void {
  document.body.innerHTML = '<div id="host"></div>'
  const app = createApp(PetBallWindow, { connection, createImage: imagesFor(() => true) })
  mounted.push(app)
  app.mount(document.getElementById('host') as Element)
}

beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(context2d)
})

/** The orb's own element, which is the button the gesture handler is on. */
function orb(): HTMLElement {
  const element = document.querySelector('.pet-ball__orb')
  if (!element) throw new Error('the orb is not mounted')
  return element as HTMLElement
}

/**
 * A primary press and release on the orb, the way the component's gesture measures one: same
 * point, inside the click window, primary button.
 *
 * `setPointerCapture` is happy-dom's gap and not the product's, and the component already treats
 * a refused capture as a desktop that costs the gesture its moves — so a stub here is the same
 * substitution `pet-floating-ball.test.ts` makes.
 */
function click(el: HTMLElement, at = 1000): void {
  el.setPointerCapture = () => undefined
  el.releasePointerCapture = () => undefined
  const pointer = { button: 0, screenX: 10, screenY: 10, pointerId: 1, bubbles: true }
  el.dispatchEvent(new PointerEvent('pointerdown', pointer))
  el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, screenX: 12, screenY: 11 }))
  void at
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount()
  document.body.innerHTML = ''
  getContextSpy?.mockRestore()
  getContextSpy = null
})

describe('the ball window draws what the host says', () => {
  it('wears the character the settings chose, and follows a change to it', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [KITTY, DAMAGED] })
    mount(host)
    await flush()

    // Nothing chosen yet: upstream's own orb, which is what this ball fell back to before there
    // was anything to wear.
    expect(document.querySelector('.pet-ball__face')).toBeNull()
    expect(orb().getAttribute('title')).toMatch(/Right-click: settings/)

    await choose(host, 'kitty', 1)
    await flush()

    // The write went through the host's own channel, so this is the path the settings page uses:
    // a character chosen in the main window reaches a ball that is already on the desktop.
    expect(document.querySelector('.pet-ball__face')).not.toBeNull()
    expect(host.clickThrough()).toEqual([])
  })

  it('draws a plain orb for a character the library cannot produce, and says why on the wrapper', async () => {
    const host = createMemoryPetGateway({ visible: true, characters: [KITTY, DAMAGED] })
    mount(host)
    await flush()
    await choose(host, 'torn', 1)
    await flush()

    const ball = document.querySelector('.pet-ball')
    expect(document.querySelector('.pet-ball__face')).toBeNull()
    // The sentence is the pet window's own (`petAppearanceView`), and it is not *drawn* here: this
    // window is an 80 px box with a 56 px orb in it, so it rides on the wrapper as the tooltip the
    // orb's margin is hoverable through.
    expect(ball?.getAttribute('title')).toMatch(/torn/)
    expect(ball?.getAttribute('title')).toMatch(/cannot be drawn/)
  })

  it('mounts a usable orb with no host at all', async () => {
    mount(null)
    await flush()

    // No host is a state, not a crash: the orb is there, it has its name, and it says what it can
    // do. A page with no Tauri behind it is what the entry's own composition answers.
    expect(orb().getAttribute('aria-label')).toBe('Desktop pet ball')
    expect(orb().getAttribute('title')).toMatch(/Right-click: settings/)
  })
})

/**
 * A host whose appearance read answers a policy this file can change, wrapping the double.
 *
 * The double's own `appearance()` builds its arms from the character domain and carries no
 * `general` field, which is why the policy is supplied here: what is under test is the window's
 * handling of an answer, and the answer has to be one this file can move. Everything else — the
 * listener, the revision check, the channel an applied write is published on — is the double's.
 */
function hostWithPolicy(policy: { motion: PetMotion }, characters: PetCharacterEntry[] = [KITTY]) {
  const host = createMemoryPetGateway({ visible: true, characters })
  const connection: PetWindowGateway = {
    ...host,
    appearance: async () => ({ status: 'unset', motion: policy.motion }),
  }
  return { host, connection }
}

/**
 * Write the 动效 setting the way the settings page does: through the host's own channel.
 *
 * `general` is the second domain this window draws from, and the write is an *applied* one, so the
 * host publishes a change for it — which is the only way a ball already on the desktop hears about
 * a click in the main window's settings.
 */
async function setMotion(host: MemoryPetGateway, motion: PetMotion, revision: number): Promise<void> {
  await host.updateSettings({
    domain: 'general',
    revision,
    values: { ...PET_SETTINGS_DEFAULTS.general, motion },
  })
}

describe('the ball window and §5.2’s 动效', () => {
  it('stops the orb’s motion when the app’s setting says so, and starts it again when it does not', async () => {
    const policy: { motion: PetMotion } = { motion: 'system' }
    const { host, connection } = hostWithPolicy(policy)
    mount(connection)
    await flush()

    // The setting is 「跟随系统」, the schema's default: the orb keeps its own travel, and the
    // system's own preference is a question its stylesheet asks the engine (the media query in
    // `PetFloatingBall.vue`), not something this read decides.
    expect(orb().classList.contains('is-still')).toBe(false)

    // A user picks 「减少动效」 in the main window's settings. Before this wiring the value was
    // stored, drawn on 常规与交互 and read by nothing that moves: the orb scaled under the pointer
    // either way.
    policy.motion = 'reduced'
    await setMotion(host, 'reduced', 1)
    await flush()
    expect(orb().classList.contains('is-still')).toBe(true)

    // And back, because the policy is read rather than latched — a user who returns to
    // 「跟随系统」 gets the orb's motion back without a restart.
    policy.motion = 'system'
    await setMotion(host, 'system', 2)
    await flush()
    expect(orb().classList.contains('is-still')).toBe(false)
  })

  it('reads an appearance with no policy as the schema default, not as reduced', async () => {
    // The double answers without the field at all, which is what an answer that did not come from
    // this host looks like (a browser build, or a host from before the field existed). `reduced`
    // there would invent a restriction the user never chose.
    const host = createMemoryPetGateway({ visible: true, characters: [KITTY] })
    mount(host)
    await flush()

    expect(orb().classList.contains('is-still')).toBe(false)
  })
})

describe('the ball window’s gestures', () => {
  it('sends a right-click to the settings page the ball belongs to', async () => {
    const host = createMemoryPetGateway({ visible: true })
    mount(host)
    await flush()
    await choose(host, 'kitty', 1)
    await flush()

    orb().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flush()

    // §5.1's 常规与交互 — 启用、窗口行为、点击动作、悬浮球 — and upstream's own 「right = Settings」
    // (`lib.rs:306-309`). A page and never a window: §7.1 gives the window identity to the host.
    expect(host.openedSettings()).toEqual(['general'])
  })

  it('opens nothing on a left click, because there is nothing in this window to open', async () => {
    const host = createMemoryPetGateway({ visible: true })
    mount(host)
    await flush()

    click(orb())
    await flush()

    // Upstream's left click opens a 300x420 quick-bubble menu by *growing this window*
    // (`floating-ball.ts:117`, `:161`), which needs a window-resize permission the pet's capability
    // does not hold — and what the left click does is `ap_left_click_action`, a setting this build
    // has not built (ledger:114). So the gesture lands nowhere, and this assertion is here so that
    // "nowhere" is a decision rather than a handler somebody forgot to write.
    expect(host.openedSettings()).toEqual([])
  })

  it('never asks the compositor to let its clicks through', async () => {
    const host = createMemoryPetGateway({ visible: true })
    mount(host)
    await flush()
    await choose(host, 'kitty', 1)
    await flush()
    click(orb())
    orb().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flush()

    // The negative that matters (§7.2): the character window asks for click-through whenever it has
    // nothing for the pointer, and this window is the opposite surface — a stable click target. A
    // request here would be the defect, and the double records requests rather than the resulting
    // state so that "did not ask" is distinguishable from "asked and was ignored".
    expect(host.clickThrough()).toEqual([])
  })
})
