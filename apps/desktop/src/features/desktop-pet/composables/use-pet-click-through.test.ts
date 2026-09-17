/**
 * The window's answer to §7.2's 鼠标穿透: when it asks, what it asks for, and what a refusal leaves
 * behind.
 *
 * The rules under test are the three the composable's header states as acceptance clauses —
 * interactive is the direction every failure falls back to, one request per change, and the
 * pointer is never consulted — plus the reason this file exists at all: that the window *asks*.
 * A window that never calls the host and a window that asks for the compositor's own default look
 * identical from the state alone, and that identity is the defect this operation was wired to
 * remove.
 *
 * The compositor is a recorded list, because what a test can observe is the request. Whether the
 * request changes what the pointer does is the window system's answer, and §12 says a browser
 * cannot give it: that half is measured in a real window.
 */
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { usePetClickThrough, type PetClickThroughOptions } from './use-pet-click-through'

/** The requests a host was given, in order — the instrument every case here reads. */
function recorder() {
  const asked: boolean[] = []
  return {
    asked,
    setClickThrough: async (ignore: boolean) => {
      asked.push(ignore)
    },
  }
}

/** Let every queued request and every watcher callback run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await nextTick()
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** The composable as a component uses it: inside a scope it can be disposed with. */
function scoped(options: PetClickThroughOptions) {
  const scope = effectScope()
  const subject = scope.run(() => usePetClickThrough(options))
  if (!subject) throw new Error('the composable did not run inside its scope')
  return { subject, stop: () => scope.stop() }
}

describe('usePetClickThrough', () => {
  it('asks the compositor to let clicks through while it has nothing to click', async () => {
    const host = recorder()
    const { subject, stop } = scoped({ ...host, needsInput: () => false })
    await subject.sync()

    expect(host.asked).toEqual([true])
    expect(subject.passthrough.value).toBe(true)
    expect(subject.error.value).toBeNull()
    stop()
  })

  it('leaves the window interactive while it has something to click', async () => {
    const host = recorder()
    const { subject, stop } = scoped({ ...host, needsInput: () => true })
    await subject.sync()

    // Not one call: a fresh window already takes clicks, so asking for the state it is in would be
    // a request per mount for nothing (§7.3's budget).
    expect(host.asked).toEqual([])
    expect(subject.passthrough.value).toBe(false)
    stop()
  })

  it('asks for the pointer back when a surface appears, and lets go when it goes', async () => {
    const host = recorder()
    const busy = ref(false)
    const { subject, stop } = scoped({ ...host, needsInput: () => busy.value })

    await subject.sync()
    expect(host.asked).toEqual([true])

    // The watcher, not a caller: the window has to notice its own content changing, because
    // nothing else in the process can tell it.
    busy.value = true
    await flush()
    expect(host.asked).toEqual([true, false])
    expect(subject.passthrough.value).toBe(false)

    busy.value = false
    await flush()
    expect(host.asked).toEqual([true, false, true])
    stop()
  })

  it('states a refusal, keeps the window where it was, and asks again on the next change', async () => {
    const asked: boolean[] = []
    let refuse = true
    const busy = ref(false)
    const { subject, stop } = scoped({
      setClickThrough: async (ignore) => {
        asked.push(ignore)
        if (refuse) throw new Error('the window is gone')
      },
      needsInput: () => busy.value,
    })

    await subject.sync()
    expect(subject.error.value).toBe('the window is gone')
    // Not recorded as applied. The compositor still holds what it held, and a caller that assumed
    // otherwise would stop asking for the state the window is not in.
    expect(subject.passthrough.value).toBe(false)

    refuse = false
    // A change to the state the window is already in costs nothing — there is nothing to ask for.
    busy.value = true
    await flush()
    expect(asked).toEqual([true])

    // And the next change asks again, because the request was never applied.
    busy.value = false
    await flush()
    await flush()
    expect(asked).toEqual([true, true])
    expect(subject.passthrough.value).toBe(true)
    expect(subject.error.value).toBeNull()
    stop()
  })

  it('collapses a burst of changes into the state the window ends in', async () => {
    const host = recorder()
    const busy = ref(false)
    const { subject, stop } = scoped({ ...host, needsInput: () => busy.value })
    await subject.sync()

    busy.value = true
    busy.value = false
    busy.value = true
    await flush()
    await flush()

    // One request for the three: the two that were overtaken describe states the window has left,
    // and a compositor told about them would be told to take clicks it must not take.
    expect(host.asked).toEqual([true, false])
    stop()
  })

  it('does not send a second request before the first has been answered', async () => {
    const asked: boolean[] = []
    const busy = ref(false)
    const releases: (() => void)[] = []
    const { subject, stop } = scoped({
      setClickThrough: (ignore) =>
        new Promise<void>((resolve) => {
          asked.push(ignore)
          releases.push(resolve)
        }),
      needsInput: () => busy.value,
    })

    void subject.sync()
    await flush()
    expect(asked).toEqual([true])

    // Queued behind the answer, not sent beside it: two requests in flight can come back in
    // either order, and the one that lands last is the state the compositor keeps.
    busy.value = true
    await flush()
    expect(asked).toEqual([true])

    releases[0]?.()
    await flush()
    // The queued step reads the state when it *runs*, which is the state the window is in now.
    expect(asked).toEqual([true, false])
    releases[1]?.()
    stop()
  })

  it('asks nothing, and stays interactive, where the host has no such operation', async () => {
    const { subject, stop } = scoped({ needsInput: () => false })
    await subject.sync()

    // The fail-safe direction, and the reason it is that direction: a pet that cannot be clicked
    // has no workaround, while one that takes a click it did not need is the smaller defect.
    expect(subject.passthrough.value).toBe(false)
    expect(subject.error.value).toBeNull()
    stop()
  })

  it('stops asking once it is disposed', async () => {
    const host = recorder()
    const busy = ref(false)
    const { subject, stop } = scoped({ ...host, needsInput: () => busy.value })
    await subject.sync()

    subject.dispose()
    busy.value = true
    await flush()
    await subject.sync()

    expect(host.asked).toEqual([true])
    stop()
  })
})
