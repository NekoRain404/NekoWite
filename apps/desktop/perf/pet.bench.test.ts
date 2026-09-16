/**
 * The desktop pet's performance gates (`pnpm perf`), on the service level.
 *
 * §12's last three bullets are what this file is for:
 *
 *  - 「单角色/上限多角色分别记录空闲、连续事件…的 CPU/RSS/帧时延」 — CPU and RSS need a real process, and
 *    D13's report records them as unmeasured with the reason (no Tauri build may be run from that
 *    task). What *is* attributable here is the cost of the work the pet does per tick and per
 *    render, at one character and at the multi-character cap.
 *  - 「连续开关 50 次后监听、窗口和计时器计数回基线」 — this one is a count rather than a duration, and
 *    it is exact: fifty mount/unmount cycles, with the frame timer, the host subscriptions and the
 *    window listener all read back at the end.
 *  - 「禁用后无角色渲染定时器、无后台图库轮询」 — the second half has nothing to test yet (the
 *    character library is D8's), and the first half is asserted as a *difference*: a disabled
 *    feature holds no timer while an enabled one holds exactly one.
 *
 * Every clock is injected (§10.2: 配置、时钟和随机源改为注入). A manual clock is what makes "is a timer
 * outstanding?" a fact rather than a race: the sprite reschedules after a real 333ms delay, so with
 * a real timer the count would depend on where in that interval the assertion happened to land.
 *
 * Run: `pnpm perf` from the repo root, or
 * `npx vitest run --config vitest.perf.config.ts perf/pet.bench.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { createApp, defineComponent, h, nextTick, ref, shallowRef, type App as VueApp } from 'vue'
import { createMemoryPetGateway } from '../src/platform/gateways/memory-pet'
import DesktopPetRoot from '../src/features/desktop-pet/components/DesktopPetRoot.vue'
import PetTaskList from '../src/features/desktop-pet/components/PetTaskList.vue'
import {
  IDLE_TICK_MS,
  createPetMotion,
  type PetMotionEngine,
} from '../src/features/desktop-pet/motion/pet-motion'
import type { MotionClock, MotionTimerHandle } from '../src/features/desktop-pet/motion/pet-motion-types'
import type {
  PetMotionPlatform,
  PhysicalPoint,
  PhysicalRect,
} from '../src/features/desktop-pet/motion/pet-platform'
import type { SpriteClock } from '../src/features/desktop-pet/rendering/animation-bindings'
import type { ImageFactory, LoadableImage } from '../src/features/desktop-pet/rendering/sprite-sheet'
import type { PetMessagePhrases } from '../src/features/desktop-pet/services/pet-message-template'
import type { PetCapabilityReport, PetGateway } from '../src/platform/gateways/pet-contracts'
import { petPhrases, petTask } from '../e2e/support/petFixture'

const results = new Map<string, number>()

function record(key: string, ms: number): number {
  results.set(key, ms)
  return ms
}

function now(): number {
  return performance.now()
}

/** Let every pending microtask and one macrotask run: the lifecycle's reads are promises. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A URL that is never fetched: nothing here needs a real sheet, only a mounted sprite. */
const SHEET_URL = 'data:image/png;base64,pet-perf'

/**
 * An image that never finishes decoding.
 *
 * Deliberate: a load that succeeded would be sliced and drawn, and one that *failed* would make the
 * root swap the canvas for a sentence — which unmounts the sprite and stops the very timer this
 * file counts. A pending image leaves the window in the state a slow character leaves it in, with
 * the frame loop running.
 */
const pendingImage: ImageFactory = () =>
  ({ crossOrigin: '', src: '', naturalWidth: 0, naturalHeight: 0 }) as unknown as LoadableImage

/** A clock that never fires, and counts what it is still holding. */
function manualClock(): { clock: SpriteClock; outstanding(): number } {
  const live = new Set<number>()
  let next = 0
  return {
    clock: {
      setTimeout: () => {
        next += 1
        live.add(next)
        return next as unknown as ReturnType<typeof globalThis.setTimeout>
      },
      clearTimeout: (handle) => {
        live.delete(handle as unknown as number)
      },
    },
    outstanding: () => live.size,
  }
}

function manualMotionClock(): MotionClock {
  let next = 0
  return {
    setTimeout: () => {
      next += 1
      return next as unknown as MotionTimerHandle
    },
    clearTimeout: () => undefined,
  }
}

interface LifecycleCounts {
  holds: number
  subscriptions: number
}

interface RootApi {
  lifecycle: { counts: () => LifecycleCounts } | null
}

/**
 * Mount `DesktopPetRoot` in a detached host, the way the pet window does, and hand back the
 * lifecycle the component exposes.
 *
 * The host element is created and dropped per cycle rather than reused: a window that is closed and
 * reopened gets a new document, so a fixture that kept the element could hide a listener left on
 * the *element* — the same leak, one layer down.
 */
function mountPet(
  gateway: PetGateway,
  imageUrl: string | null,
): {
  app: VueApp
  api: () => RootApi | null
  clock: ReturnType<typeof manualClock>
  host: HTMLElement
} {
  const clock = manualClock()
  const api = shallowRef<RootApi | null>(null)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DesktopPetRoot, {
            gateway,
            imageUrl,
            createImage: pendingImage,
            clock: clock.clock,
            ref: (value: unknown) => {
              api.value = value as RootApi
            },
          })
      },
    }),
  )
  app.mount(host)
  return { app, api: () => api.value, clock, host }
}

afterAll(() => {
  console.log('\n=== NekoWite desktop pet perf (ms) ===')
  for (const [key, value] of results) console.log(`${key.padEnd(34)} ${value.toFixed(3)}`)
  console.log('=== end ===')
})

describe('the pet window: opening and closing it', () => {
  it('holds one frame timer while it is up, and nothing after 50 cycles', async () => {
    const gateway = createMemoryPetGateway({ visible: true })
    const cycles = 50
    let mountedTimers = 0
    let mountedSubscriptions = 0

    // The window's own listener bookkeeping, so a leak is attributable rather than inferred from the
    // timer count alone. `resize` is the one `PetSprite` registers (`syncCanvasSize`), and the one
    // §7.3's resize handling would leak first.
    let resizeListeners = 0
    const add = window.addEventListener
    const remove = window.removeEventListener
    window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
      if (type === 'resize') resizeListeners += 1
      return (add as unknown as (t: string, ...a: unknown[]) => void).call(this, type, ...rest)
    } as unknown as typeof window.addEventListener
    window.removeEventListener = function (this: Window, type: string, ...rest: unknown[]) {
      if (type === 'resize') resizeListeners -= 1
      return (remove as unknown as (t: string, ...a: unknown[]) => void).call(this, type, ...rest)
    } as unknown as typeof window.removeEventListener

    try {
      const start = now()
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const mounted = mountPet(gateway, SHEET_URL)
        await flush()

        // The lifecycle is kept rather than its numbers: the ref is cleared by the unmount, and the
        // point of this test is to read the *same* window's counts after it has gone.
        const lifecycle = mounted.api()?.lifecycle
        if (lifecycle === undefined || lifecycle === null) {
          throw new Error('the root exposed no lifecycle')
        }
        // While the window is up: two host subscriptions — the feature state (§7.1's way back) and
        // the task list — and one frame timer from the sprite's own loop.
        const whileUp = lifecycle.counts()
        mountedSubscriptions = whileUp.subscriptions
        mountedTimers = mounted.clock.outstanding()
        expect(whileUp.subscriptions, 'a visible pet listens to the host').toBe(2)
        expect(whileUp.holds, 'and holds nothing of its own beyond them').toBe(0)
        expect(mounted.clock.outstanding(), 'the sprite schedules one frame at a time').toBe(1)
        expect(resizeListeners, 'the sprite watches the window while it is up').toBe(1)

        mounted.app.unmount()
        await flush()

        // §7.1: 「关闭桌宠销毁动画/监听/计时器」. All three are read back rather than described, and the
        // assertion is inside the loop: a leak that only shows on the fiftieth cycle is a different
        // defect from one that shows on the first, and this catches both.
        const after = lifecycle.counts()
        expect(after.subscriptions, `cycle ${cycle}: subscriptions are given back`).toBe(0)
        expect(mounted.clock.outstanding(), `cycle ${cycle}: no frame timer survives`).toBe(0)
        expect(resizeListeners, `cycle ${cycle}: the resize listener is released`).toBe(0)
        mounted.host.remove()
      }
      record('pet-window-50-cycles', now() - start)
    } finally {
      window.addEventListener = add
      window.removeEventListener = remove
    }

    console.log(
      `[pet-perf] mounted: ${mountedSubscriptions} subscriptions, ${mountedTimers} frame timer; after ${cycles} cycles: ${resizeListeners} resize listeners`,
    )
  })

  it('starts nothing at all while the feature is switched off', async () => {
    const off = createMemoryPetGateway({ visible: true })
    const loaded = await off.readSettings('general')
    if (loaded.status !== 'current') throw new Error('the double would not read its own record')
    await off.updateSettings({
      domain: 'general',
      revision: loaded.record.revision,
      values: { ...loaded.record.values, enabled: false },
    })
    expect(await off.feature()).toEqual({ enabled: false, visible: false })

    const on = createMemoryPetGateway({ visible: true })
    expect(await on.feature()).toEqual({ enabled: true, visible: true })

    // The difference is the assertion: same component, same character, same clock — one switch.
    const disabled = mountPet(off, SHEET_URL)
    await flush()
    const enabled = mountPet(on, SHEET_URL)
    await flush()

    const disabledCounts = disabled.api()?.lifecycle?.counts()
    const enabledCounts = enabled.api()?.lifecycle?.counts()
    console.log(
      `[pet-perf] disabled: ${JSON.stringify(disabledCounts)} timers ${disabled.clock.outstanding()}; enabled: ${JSON.stringify(enabledCounts)} timers ${enabled.clock.outstanding()}`,
    )
    // A disabled feature has no window to listen from, so it takes no subscription and starts no
    // frame loop — which is what makes the switch a rollback rather than a hidden window (§7.1).
    expect(disabledCounts?.subscriptions).toBe(0)
    expect(disabled.clock.outstanding()).toBe(0)
    expect(enabledCounts?.subscriptions).toBe(2)
    expect(enabled.clock.outstanding()).toBe(1)

    disabled.app.unmount()
    enabled.app.unmount()
    await flush()
    disabled.host.remove()
    enabled.host.remove()
  })
})

describe('the roam engine: the cost of one tick', () => {
  const workArea: PhysicalRect = { x: 0, y: 0, width: 1920, height: 1080 }
  const pointer: PhysicalPoint = { x: 1600, y: 900 }
  const verified = (): readonly PetCapabilityReport[] => [
    { capability: 'pointer-follow', finding: { status: 'available' } },
  ]

  function engine(): PetMotionEngine {
    const platform: PetMotionPlatform = {
      async scaleFactor() {
        return 1
      },
      async readWindowPosition() {
        return { x: 400, y: 300 }
      },
      async moveWindow() {},
      async readWorkArea() {
        return workArea
      },
      async readPointer() {
        return pointer
      },
    }
    return createPetMotion({
      platform,
      capabilities: verified,
      // `follow-pointer` is the only roaming mode that can be reached at all: `PetRoamMode` has no
      // `wander` (D11a's recorded gap, and `pet-motion.test.ts` says the same in its own header), so
      // this is the walking path the product can actually take.
      settings: () => ({ roam: 'follow-pointer', motion: 'system' }),
      clock: manualMotionClock(),
      now: () => 1_700_000_000_000,
      random: () => 0.5,
    })
  }

  it('costs the same per character at one and at the multi-character cap', async () => {
    const ticks = 300
    for (const characters of [1, 3]) {
      const pets = Array.from({ length: characters }, () => engine())
      // One warm-up tick per engine, outside the measurement: the first tick builds the environment
      // cache, which is a one-off rather than the steady-state cost.
      for (const pet of pets) await pet.tick()

      const samples: number[] = []
      for (let i = 0; i < ticks; i += 1) {
        const start = now()
        for (const pet of pets) await pet.tick()
        samples.push((now() - start) / characters)
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0
      const worst = sorted[sorted.length - 1] ?? 0
      record(`pet-motion-tick-${characters}c-p50`, median)
      record(`pet-motion-tick-${characters}c-max`, worst)
      console.log(
        `[pet-perf] ${characters} character(s): tick p50 ${median.toFixed(4)}ms, max ${worst.toFixed(4)}ms against a ${IDLE_TICK_MS}ms resting delay`,
      )
      // The budget is a fifth of the tick's own interval: a tick that cost that much would already
      // be a problem, and this bound still fails at a large multiple of the measured value.
      expect(median, `${characters} character(s) fit in the tick`).toBeLessThan(IDLE_TICK_MS / 5)
    }
  })
})

describe('the task surface: building the list', () => {
  const phrases = petPhrases() as unknown as PetMessagePhrases

  /** `count` tasks, one per session, so a list of any size can be asked for. */
  function tasks(count: number) {
    return Array.from({ length: count }, (_, i) =>
      petTask(i % 3 === 0 ? 'working' : i % 3 === 1 ? 'waiting-input' : 'failed', {
        sessionId: `session-${i}`,
        runId: `run-${i}`,
        agentId: i % 2 === 0 ? 'memory' : 'opencode',
        updatedAt: 1_700_000_000_000 + i,
      }),
    )
  }

  it('re-renders the multi-task list, with the long Chinese rows, at the cap', async () => {
    for (const count of [5, 10]) {
      const renders = 50
      const list = tasks(count)
      // The clock the rows read is a prop, and moving it is what makes each iteration a real
      // re-render — every row recomputes its elapsed text. A loop that changed nothing would time an
      // empty flush, which is the failure mode this harness's own header warns about.
      const tick = ref(1_700_000_010_000)
      const host = document.createElement('div')
      document.body.appendChild(host)
      const app = createApp({
        render: () =>
          h(PetTaskList, {
            tasks: list,
            phrases,
            layout: { maxTasks: count },
            now: tick.value,
          }),
      })
      app.mount(host)
      await nextTick()
      const rows = host.querySelectorAll('.pet-task__row').length
      // A list that rendered nothing would be fast and would gate nothing.
      expect(rows, `${count} tasks are ${count} rows`).toBe(count)

      const samples: number[] = []
      for (let i = 0; i < renders; i += 1) {
        const start = now()
        tick.value += 1000
        await nextTick()
        samples.push(now() - start)
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0
      record(`pet-task-list-${count}-render-p50`, median)
      console.log(`[pet-perf] ${count} rows: re-render p50 ${median.toFixed(3)}ms`)
      expect(median).toBeLessThan(8)
      app.unmount()
      host.remove()
    }
  })
})
