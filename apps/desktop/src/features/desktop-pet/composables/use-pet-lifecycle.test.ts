/**
 * §7.1's lifecycle, as counts.
 *
 * 「禁用桌宠销毁动画/监听/计时器，不取消后台 Agent 任务」 says three things at once, and only the
 * first two are this file's: hiding and disabling have to give back everything the window holds,
 * and the third is a statement about what teardown must *not* reach. The tests below hold both
 * halves:
 *
 * - `counts()` is asserted at zero after every teardown and after fifty cycles, because
 *   「关闭/重开无泄漏」 is otherwise an impression formed by looking at a window that still draws.
 * - The host records every call it receives, so "the teardown cancelled nothing" is checked
 *   against what the window asked for rather than against a promise: after `dispose()` the only
 *   thing the host is asked for is the unsubscribe, and `PetGateway` (D1) has no method that could
 *   start, cancel or delete anything in the first place.
 */
import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import type {
  PetFeatureState,
  PetGateway,
  PetSettingsLoad,
  PetSettingsPage,
  PetSettingsUpdate,
  PetTaskProjection,
} from '../../../platform/gateways/pet-contracts'
import { usePetLifecycle, type PetLifecycleCounts } from './use-pet-lifecycle'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * A host whose every answer is decided by the test.
 *
 * It records calls rather than counting them, because the interesting assertion is not how many
 * there were but which — "the teardown asked the host for one thing, and that thing was the
 * unsubscribe" is the sentence the plan needs, and a count cannot say it.
 */
class FakeHost implements PetGateway {
  readonly calls: string[] = []
  readonly listeners = new Set<(tasks: PetTaskProjection[]) => void>()
  readonly featureListeners = new Set<(state: PetFeatureState) => void>()
  enabled = true
  visible = true
  featureFails: string | null = null
  setVisibleFails: string | null = null
  /** Held open to model a host that is still answering when the window is torn down. */
  gate: Deferred | null = null

  async feature(): Promise<PetFeatureState> {
    this.calls.push('feature')
    if (this.featureFails) throw new Error(this.featureFails)
    return { enabled: this.enabled, visible: this.enabled && this.visible }
  }

  async setVisible(next: boolean): Promise<PetFeatureState> {
    this.calls.push(`setVisible:${next}`)
    if (this.setVisibleFails) throw new Error(this.setVisibleFails)
    this.visible = next
    return { enabled: this.enabled, visible: this.enabled && this.visible }
  }

  async capabilities(): Promise<never> {
    throw new Error('the pet window does not read capabilities in these tests')
  }

  async tasks(): Promise<PetTaskProjection[]> {
    return []
  }

  async subscribe(onTasks: (tasks: PetTaskProjection[]) => void): Promise<() => void> {
    this.calls.push('subscribe')
    await this.gate?.promise
    this.listeners.add(onTasks)
    onTasks([])
    return () => {
      this.calls.push('unsubscribe')
      this.listeners.delete(onTasks)
    }
  }

  async subscribeFeature(onFeature: (state: PetFeatureState) => void): Promise<() => void> {
    this.calls.push('subscribeFeature')
    await this.gate?.promise
    this.featureListeners.add(onFeature)
    onFeature({ enabled: this.enabled, visible: this.enabled && this.visible })
    return () => {
      this.calls.push('unsubscribeFeature')
      this.featureListeners.delete(onFeature)
    }
  }

  // The parameters are left off rather than named and unused: this window never makes either call,
  // and a signature that could not receive one is the stronger statement.
  async readSettings(): Promise<PetSettingsLoad> {
    throw new Error('the pet window does not read settings in these tests')
  }

  async updateSettings(): Promise<PetSettingsUpdate> {
    throw new Error('the pet window does not write settings in these tests')
  }

  async openSettings(page: PetSettingsPage): Promise<void> {
    this.calls.push(`openSettings:${page}`)
  }

  /** Deliver the list as the host's own subscription would. */
  push(tasks: PetTaskProjection[]): void {
    for (const listener of this.listeners) listener(tasks)
  }

  /** Change what the host would answer `feature()` with, and tell the subscribers, as another
   *  window's settings page does. */
  pushFeature(enabled: boolean, visible: boolean): void {
    this.enabled = enabled
    this.visible = visible
    for (const listener of this.featureListeners) {
      listener({ enabled, visible: enabled && visible })
    }
  }
}

function task(name: string): PetTaskProjection {
  return {
    key: {
      agentId: 'opencode',
      profileId: 'default',
      runtimeEpoch: 'epoch-1',
      vaultId: 'vault-1',
      sessionId: name,
      runId: `run-${name}`,
    },
    state: 'working',
    permissionRequestId: null,
    updatedAt: 1,
  }
}

const NOTHING_HELD: PetLifecycleCounts = { holds: 0, subscriptions: 0 }

describe('what the pet window holds', () => {
  it('starts from the host and subscribes only when the feature is on', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })

    await lifecycle.start()

    expect(lifecycle.state.value.enabled).toBe(true)
    expect(lifecycle.state.value.drawing).toBe(true)
    expect(host.calls).toEqual(['feature', 'subscribeFeature', 'subscribe'])
    expect(lifecycle.counts()).toEqual({ holds: 0, subscriptions: 2 })
  })

  it('subscribes to nothing at all when the host says the feature is off', async () => {
    const host = new FakeHost()
    host.enabled = false
    const lifecycle = usePetLifecycle({ gateway: host })

    await lifecycle.start()

    // §7.1 creates the window on demand, so a disabled feature has no window to listen from —
    // and a subscription kept "in case" is exactly the leak the next cycle would inherit.
    expect(lifecycle.state.value.enabled).toBe(false)
    expect(host.calls).toEqual(['feature'])
    expect(lifecycle.counts()).toEqual(NOTHING_HELD)
  })

  it('start is idempotent', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })

    await lifecycle.start()
    await lifecycle.start()

    expect(host.calls).toEqual(['feature', 'subscribeFeature', 'subscribe'])
    expect(host.listeners.size).toBe(1)
    expect(host.featureListeners.size).toBe(1)
  })

  it('reports a host that refuses rather than drawing a pet that knows nothing', async () => {
    const host = new FakeHost()
    host.featureFails = 'the host is not running'
    const lifecycle = usePetLifecycle({ gateway: host })

    await lifecycle.start()

    expect(lifecycle.state.value.error).toBe('the host is not running')
    expect(lifecycle.state.value.drawing).toBe(false)
    expect(lifecycle.counts()).toEqual(NOTHING_HELD)
  })

  it("hands the host's own list to the window", async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()

    host.push([task('a'), task('b')])

    expect(lifecycle.state.value.tasks).toHaveLength(2)
  })
})

describe('hiding stops the drawing and keeps the reminder', () => {
  it('releases the drawing holds and keeps the window ones', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    let drawingHolds = 0
    let windowHolds = 0
    lifecycle.hold({ scope: 'drawing', release: () => (drawingHolds += 1) })
    lifecycle.hold({ scope: 'window', release: () => (windowHolds += 1) })

    await lifecycle.hide()

    expect(host.calls).toContain('setVisible:false')
    expect(lifecycle.state.value.drawing).toBe(false)
    expect(drawingHolds).toBe(1)
    expect(windowHolds).toBe(0)
    // The subscription is the reminder: a hidden pet that stopped hearing about work would have
    // nothing to be un-hidden for (§7.1).
    expect(host.listeners.size).toBe(1)
    expect(host.featureListeners.size).toBe(1)
    expect(lifecycle.counts().subscriptions).toBe(2)
  })

  it('keeps delivering while hidden', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    await lifecycle.hide()

    host.push([task('while-hidden')])

    expect(lifecycle.state.value.tasks).toHaveLength(1)
    expect(lifecycle.state.value.drawing).toBe(false)
  })

  it('comes back, because a desktop with no tray has no other way to', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    let released = 0
    lifecycle.hold({ scope: 'drawing', release: () => (released += 1) })
    await lifecycle.hide()

    await lifecycle.show()
    // The hold taken before the hide stays released: showing does not resurrect what hiding gave
    // back, the renderer replaces it, and a lifecycle that pretended otherwise would run old
    // timers twice.
    expect(released).toBe(1)
    expect(lifecycle.state.value.drawing).toBe(true)
    expect(host.calls).toEqual([
      'feature',
      'subscribeFeature',
      'subscribe',
      'setVisible:false',
      'setVisible:true',
    ])
  })

  it('reads the state the host ended up in, not the one it asked for', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    await lifecycle.hide()
    host.enabled = false

    // A request to show a disabled feature does nothing (D1's `setVisible` says so outright), and
    // the window has to end up believing the host rather than its own request.
    await lifecycle.show()

    expect(lifecycle.state.value.enabled).toBe(false)
    expect(lifecycle.state.value.drawing).toBe(false)
  })

  it('states a refusal instead of assuming the hide happened', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    host.setVisibleFails = 'the window system said no'

    await lifecycle.hide()

    expect(lifecycle.state.value.error).toBe('the window system said no')
    expect(lifecycle.state.value.drawing).toBe(true)
  })
})

describe('the feature state arrives without the window asking', () => {
  it('stops drawing when the switch is moved in another window', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    let released = 0
    lifecycle.hold({ scope: 'drawing', release: () => (released += 1) })

    // The settings page lives in the main window, and §7.1 makes it the way back *and* the way
    // out on a desktop with no tray. Without a push channel the window would learn about this on
    // its next `feature()` call — which nothing was going to make — so the pet would keep
    // drawing after the user hid it. This is that channel, end to end.
    host.pushFeature(true, false)

    expect(lifecycle.state.value.drawing).toBe(false)
    expect(released).toBe(1)
    // Nothing was asked for: the four calls are the start, and a push is not a call.
    expect(host.calls).toEqual(['feature', 'subscribeFeature', 'subscribe'])
  })

  it('draws again when the switch is moved back, with no restart', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    host.pushFeature(true, false)

    host.pushFeature(true, true)

    expect(lifecycle.state.value.drawing).toBe(true)
    // The hold released by the hide is not resurrected — the renderer replaces it, exactly as the
    // hide/show path does — so this asserts the state rather than a count.
    expect(lifecycle.state.value.enabled).toBe(true)
  })

  it('believes the host when the feature is switched off entirely', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()

    // Disabling closes the window as well (the host's teardown), so this is the window agreeing
    // with a state it is about to stop existing in — not the window deciding on its own.
    host.pushFeature(false, false)

    expect(lifecycle.state.value.enabled).toBe(false)
    expect(lifecycle.state.value.drawing).toBe(false)
  })

  it('ignores a push that arrives after the teardown', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    await lifecycle.dispose()

    host.pushFeature(true, true)

    // A frame in flight when the window went away is the same race the task subscription guards,
    // and the guard is the same idea: a disposed lifecycle writes nothing.
    expect(lifecycle.state.value.drawing).toBe(false)
  })
})

describe('teardown gives everything back and reaches nothing else', () => {
  it('asks the host for nothing but the two unsubscribes', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    lifecycle.hold({ scope: 'window', release: () => {} })
    const before = host.calls.length

    await lifecycle.dispose()

    // The whole of "disabling the pet does not cancel agent work": there is no call here that
    // could reach a run, a note or a character, and `PetGateway` (D1) has no method that could —
    // the absence is in the interface rather than in the order of these statements.
    expect(host.calls.slice(before)).toEqual(['unsubscribe', 'unsubscribeFeature'])
    expect(lifecycle.counts()).toEqual(NOTHING_HELD)
    expect(host.listeners.size).toBe(0)
    expect(host.featureListeners.size).toBe(0)
  })

  it('is idempotent, and asks twice for nothing', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()

    await lifecycle.dispose()
    await lifecycle.dispose()

    expect(host.calls.filter((call) => call === 'unsubscribe')).toHaveLength(1)
    expect(host.calls.filter((call) => call === 'unsubscribeFeature')).toHaveLength(1)
  })

  it('releases a hold taken during its own teardown', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    await lifecycle.dispose()
    let released = 0

    lifecycle.hold({ scope: 'drawing', release: () => (released += 1) })

    // A renderer that finishes mounting into a window that is already gone is the shape of leak
    // that makes "close and reopen" unreliable rather than obviously broken, so the hold is
    // released on arrival instead of waiting for a teardown that has already happened.
    expect(released).toBe(1)
    expect(lifecycle.counts()).toEqual(NOTHING_HELD)
  })

  it('unsubscribes a subscription that arrives after the teardown', async () => {
    const host = new FakeHost()
    host.gate = deferred()
    const lifecycle = usePetLifecycle({ gateway: host })
    const starting = lifecycle.start()
    await Promise.resolve()

    // The window is torn down while the host is still answering. Without the check in
    // `subscribe`, this listener would be registered after the teardown and never called again.
    const disposing = lifecycle.dispose()
    host.gate.resolve()
    await Promise.all([starting, disposing])

    expect(host.listeners.size).toBe(0)
    expect(host.featureListeners.size).toBe(0)
    expect(lifecycle.counts()).toEqual(NOTHING_HELD)
  })

  it('does not start after it has been disposed', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.dispose()

    await lifecycle.start()

    expect(host.calls).toEqual([])
    expect(host.listeners.size).toBe(0)
    expect(host.featureListeners.size).toBe(0)
  })

  it('lets a caller take a hold back on its own', async () => {
    const host = new FakeHost()
    const lifecycle = usePetLifecycle({ gateway: host })
    await lifecycle.start()
    let released = 0
    const undo = lifecycle.hold({ scope: 'window', release: () => (released += 1) })

    undo()
    undo()

    expect(released).toBe(1)
    expect(lifecycle.counts().holds).toBe(0)
  })

  it('survives fifty cycles with nothing left over', async () => {
    const host = new FakeHost()

    for (let cycle = 0; cycle < 50; cycle += 1) {
      const lifecycle = usePetLifecycle({ gateway: host })
      await lifecycle.start()
      lifecycle.hold({ scope: 'drawing', release: () => {} })
      lifecycle.hold({ scope: 'window', release: () => {} })
      await lifecycle.dispose()

      // Every cycle, not only the last: a leak that grows by one per cycle is indistinguishable
      // from a clean one until it is measured, which is §12's 50-开关 acceptance.
      expect(lifecycle.counts()).toEqual(NOTHING_HELD)
      expect(host.listeners.size).toBe(0)
      expect(host.featureListeners.size).toBe(0)
    }

    expect(host.calls.filter((call) => call === 'subscribe')).toHaveLength(50)
    expect(host.calls.filter((call) => call === 'unsubscribe')).toHaveLength(50)
    expect(host.calls.filter((call) => call === 'subscribeFeature')).toHaveLength(50)
    expect(host.calls.filter((call) => call === 'unsubscribeFeature')).toHaveLength(50)
  })

  it('disposes with the scope that created it', async () => {
    const host = new FakeHost()
    const scope = effectScope()
    const lifecycle = scope.run(() => usePetLifecycle({ gateway: host }))
    await lifecycle?.start()
    expect(host.listeners.size).toBe(1)
    expect(host.featureListeners.size).toBe(1)

    // An unmounted window that forgot to dispose is the leak this replaces: the composable knows
    // the scope it was created in, so the wiring in a component is a convenience and not the
    // mechanism.
    scope.stop()

    expect(host.listeners.size).toBe(0)
    expect(host.featureListeners.size).toBe(0)
    expect(lifecycle?.counts()).toEqual(NOTHING_HELD)
  })
})
