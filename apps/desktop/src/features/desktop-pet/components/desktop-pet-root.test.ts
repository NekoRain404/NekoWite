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
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import type { PetGateway, PetTaskProjection } from '../../../platform/gateways/pet-contracts'
import type { ImageFactory, LoadableImage } from '../rendering/sprite-sheet'
import DesktopPetRoot from './DesktopPetRoot.vue'

/** A host with one answer and a listener count, which is all this file needs. */
class FakeHost implements PetGateway {
  readonly listeners = new Set<(tasks: PetTaskProjection[]) => void>()
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

  async tasks(): Promise<PetTaskProjection[]> {
    return []
  }

  async subscribe(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void> {
    this.listeners.add(onTasks)
    onTasks([])
    return () => this.listeners.delete(onTasks)
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

const mounted: VueApp[] = []

function mount(props: Record<string, unknown>): ReturnType<VueApp['mount']> {
  document.body.innerHTML = '<div id="host"></div>'
  const app = createApp(DesktopPetRoot, props)
  mounted.push(app)
  return app.mount(document.getElementById('host') as Element)
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
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

    expect(document.querySelector('.pet-root__notice')?.textContent).toMatch(/did not load/i)
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
