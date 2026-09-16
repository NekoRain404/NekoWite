/**
 * The pet window's lifetime: what it holds, what hiding gives back, and what teardown does not.
 *
 * §7.1 asks for three different amounts of stopping, and they are easy to collapse into one:
 *
 *  - **Hiding** stops the drawing and keeps the backend reminder
 *    (「隐藏时停止动画绘制但保留后端提醒」). The task subscription stays: a hidden pet that stopped
 *    hearing about work would have nothing to be un-hidden for, and on a desktop with no tray the
 *    way back is the settings page (「无托盘的 Linux 环境仍能从主设置恢复隐藏桌宠」), so hiding has
 *    to be a state the window can come out of rather than a small teardown.
 *  - **Disabling** gives back everything this window holds and cancels nothing else. `PetGateway`
 *    has no method that starts, cancels or deletes anything (D1), so there is nothing here that
 *    could reach a run or a character: the absence is in the interface, not in a promise made by
 *    a comment, and `teardown asks the host for exactly one thing` below is where that shows.
 *  - **Teardown is reversible.** Disposing releases; a new lifecycle on the same window starts
 *    again from the host's own state — no task list, no visibility and no setting was ever stored
 *    here, so there is nothing to restore and nothing to have got wrong.
 *
 * What it deliberately does not own is the pet's drawing. The sprite player, the roam engine and
 * the bubble timer belong to their own modules; this file is where they *register*, which is what
 * makes 「关闭/重开无泄漏」 a count (`counts`) rather than an impression. Two scopes, because §7.1
 * stops two different things: `drawing` releases on hide, `window` survives it.
 */
import { getCurrentScope, onScopeDispose, shallowRef, type Ref } from 'vue'
import type {
  PetFeatureState,
  PetGateway,
  PetTaskProjection,
} from '../../../platform/gateways/pet-contracts'

/**
 * Whether a hold survives hiding.
 *
 * `drawing` is everything that would otherwise keep running in a window nobody is looking at;
 * `window` is what a hidden pet still owes the user.
 */
export type PetHoldScope = 'drawing' | 'window'

/** Something the pet window has to give back. */
export interface PetHold {
  scope: PetHoldScope
  release: () => void
}

/**
 * What the window renders from.
 *
 * `enabled` and `drawing` are two fields rather than one because §5.1 lists 启用 and 显示 apart and
 * they have different consequences — see `PetFeatureState` (D1) for why collapsing them makes a
 * temporary hide indistinguishable from a disable.
 */
export interface PetWindowState {
  enabled: boolean
  drawing: boolean
  tasks: PetTaskProjection[]
  /** The host has not answered yet. Not the same as disconnected, which is `error`. */
  connecting: boolean
  /** The host could not be reached or refused. Stated rather than drawn around (§7.2's rule). */
  error: string | null
}

/**
 * What the window is still holding.
 *
 * `subscriptions` counts issued-but-not-yet-stopped task subscriptions rather than live ones, so
 * an unsubscribe that is in flight during a teardown is visible instead of reading as zero.
 */
export interface PetLifecycleCounts {
  holds: number
  /** Host subscriptions — the task list and the feature state — issued but not yet stopped. */
  subscriptions: number
}

export interface PetLifecycle {
  /** Read the feature state, and start listening if the host says the pet is on. Idempotent. */
  start(): Promise<void>
  hide(): Promise<void>
  show(): Promise<void>
  /** Give everything back. Safe to call twice, and safe to call during `start`. */
  dispose(): Promise<void>
  /** Register something to release, returning the registration's own undo. */
  hold(hold: PetHold): () => void
  counts(): PetLifecycleCounts
  state: Readonly<Ref<PetWindowState>>
}

export interface PetLifecycleOptions {
  gateway: PetGateway
}

const CLOSED: PetWindowState = {
  enabled: false,
  drawing: false,
  tasks: [],
  connecting: false,
  error: null,
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function usePetLifecycle({ gateway }: PetLifecycleOptions): PetLifecycle {
  const state = shallowRef<PetWindowState>({ ...CLOSED })
  let holds: PetHold[] = []
  let unsubscribe: (() => void) | null = null
  let unsubscribeFeature: (() => void) | null = null
  let pending: Promise<void> | null = null
  let pendingFeature: Promise<void> | null = null
  let issued = 0
  let stopped = 0
  let generation = 0
  let featureGeneration = 0
  let disposed = false
  let started = false

  const patch = (change: Partial<PetWindowState>): void => {
    state.value = { ...state.value, ...change }
  }

  function releaseScope(scope: PetHoldScope): void {
    const kept: PetHold[] = []
    for (const hold of holds) {
      if (hold.scope === scope) hold.release()
      else kept.push(hold)
    }
    holds = kept
  }

  /**
   * A release that runs once, and that counts as run.
   *
   * `stopped` is incremented here rather than at the call site because the two ways a subscription
   * ends — an explicit teardown, and the race below — are the same event, and a counter updated in
   * one of them would let the other leak invisibly.
   */
  function once(release: () => void): () => void {
    let done = false
    return () => {
      if (done) return
      done = true
      stopped += 1
      release()
    }
  }

  function hold(next: PetHold): () => void {
    // A hold taken while the window is being torn down cannot be left to a teardown that has
    // already happened, so it is released immediately. This is the shape of the leak that makes
    // "close and reopen" unreliable rather than obviously broken.
    if (disposed) {
      next.release()
      return () => {}
    }
    holds = [...holds, next]
    let live = true
    return () => {
      if (!live) return
      live = false
      holds = holds.filter((held) => held !== next)
      next.release()
    }
  }

  async function subscribe(): Promise<void> {
    generation += 1
    const mine = generation
    issued += 1
    let stop: (() => void) | null = null
    const answer = gateway
      .subscribe((tasks) => patch({ tasks }))
      .then((released) => {
        stop = once(released)
        // The await is where a leak hides: a window torn down while the host is still answering
        // would take its subscription after the teardown had run, and nothing would ever call it.
        if (disposed || mine !== generation) stop()
        else unsubscribe = stop
      })
      .catch((cause: unknown) => {
        patch({ error: reason(cause) })
      })
      .then(() => {
        if (pending === answer) pending = null
      })
    pending = answer
    await answer
  }

  /**
   * Listen for the feature state changing under this window.
   *
   * §7.1's way back: hiding stops the drawing and keeps the reminder, and on a desktop with no
   * tray the switch that un-hides is in the settings — another window. Without this channel the
   * window would only learn about it if something made it ask again, which nothing did, so
   * "hidden" would have meant "hidden until the app restarts".
   *
   * The host's answer is the authority for both fields, `enabled` included: a pet switched off
   * from the settings page is a pet with no window to draw in. The host closes it too — this is
   * this window agreeing with the host about what it is, not the window deciding on its own.
   */
  async function subscribeFeature(): Promise<void> {
    featureGeneration += 1
    const mine = featureGeneration
    issued += 1
    let stop: (() => void) | null = null
    const answer = gateway
      .subscribeFeature((next) => {
        if (disposed || mine !== featureGeneration) return
        patch({ enabled: next.enabled, drawing: next.enabled && next.visible })
        if (!next.enabled || !next.visible) releaseScope('drawing')
      })
      .then((released) => {
        stop = once(released)
        // The same handover race the task subscription guards: a window torn down while the host
        // is still answering would take its subscription after the teardown had run.
        if (disposed || mine !== featureGeneration) stop()
        else unsubscribeFeature = stop
      })
      .catch((cause: unknown) => {
        patch({ error: reason(cause) })
      })
      .then(() => {
        if (pendingFeature === answer) pendingFeature = null
      })
    pendingFeature = answer
    await answer
  }

  async function start(): Promise<void> {
    if (disposed || started) return
    started = true
    patch({ connecting: true, error: null })

    let feature: PetFeatureState
    try {
      feature = await gateway.feature()
    } catch (cause) {
      patch({ connecting: false, enabled: false, drawing: false, error: reason(cause) })
      return
    }
    if (disposed) return

    patch({ connecting: false, enabled: feature.enabled, drawing: feature.enabled && feature.visible })
    // A disabled feature has no window to listen from (§7.1 creates one on demand), so there is
    // nothing to subscribe to rather than a subscription worth keeping in case.
    //
    // Issued together and awaited once, because neither depends on the other: the feature channel
    // decides whether this window draws and the task channel decides what it has to say, and a
    // hide that lands while the task list is still being handed over is handled either way — the
    // feature callback releases the drawing scope, which the task subscription never touches.
    if (feature.enabled) await Promise.all([subscribeFeature(), subscribe()])
  }

  async function setVisible(visible: boolean): Promise<void> {
    if (disposed || !state.value.enabled) return

    let next: PetFeatureState
    try {
      next = await gateway.setVisible(visible)
    } catch (cause) {
      patch({ error: reason(cause) })
      return
    }
    if (disposed) return

    // The host is the authority, and it answers with the state it ended up in: a request to show a
    // disabled feature does nothing, and this reads that instead of assuming the request landed.
    const drawing = next.enabled && next.visible
    patch({ enabled: next.enabled, drawing })
    if (!drawing) releaseScope('drawing')
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    releaseScope('drawing')
    releaseScope('window')
    unsubscribe?.()
    unsubscribe = null
    unsubscribeFeature?.()
    unsubscribeFeature = null
    patch({ drawing: false, connecting: false })
    // Waits for a subscription that is still being handed over, so `counts()` is the truth as soon
    // as this resolves rather than one microtask later.
    await pending
    await pendingFeature
  }

  // A window that unmounts without disposing is the leak this whole file exists to prevent, and a
  // component that forgot to call `dispose` would be indistinguishable from one that did until
  // memory was measured. Registered only inside a scope, so the composable stays usable from a
  // plain test.
  if (getCurrentScope()) onScopeDispose(() => void dispose())

  return {
    start,
    hide: () => setVisible(false),
    show: () => setVisible(true),
    dispose,
    hold,
    counts: () => ({ holds: holds.length, subscriptions: issued - stopped }),
    state,
  }
}
