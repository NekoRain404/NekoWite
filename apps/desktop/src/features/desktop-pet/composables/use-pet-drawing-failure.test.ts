/**
 * The rule this composable is: a failure outlives nothing but the thing that failed.
 *
 * The cases are written as two lists, because the rule has two halves and only one of them is about
 * clearing. "Clears" is what the recovery is; "keeps" is what stops the recovery from being the old
 * defect read backwards — a failure dropped while it is still true is a window that flickers between
 * a sentence and an empty canvas, and a user who sees that learns that neither means anything.
 * `DesktopPetRoot.test.ts` drives the same rule through the component a user actually meets.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { usePetDrawingFailure, type PetDrawingFailure } from './use-pet-drawing-failure'

/**
 * The composable in a scope of its own, which is what a component would give it and what a bare
 * call in a test cannot: the watchers it registers are owned by the scope and stop with it.
 */
function build(
  imageUrl: Ref<string | null>,
  drawing: Ref<boolean>,
): { failure: PetDrawingFailure; stop: () => void } {
  const scope = effectScope()
  const made = scope.run(() => usePetDrawingFailure({ imageUrl, drawing }))
  if (!made) throw new Error('the composable registered nothing')
  return { failure: made, stop: () => scope.stop() }
}

/** A window that is drawing `url`, with one host answer already in. */
function drawing(url: string | null): {
  failure: PetDrawingFailure
  imageUrl: Ref<string | null>
  drawing: Ref<boolean>
  stop: () => void
} {
  const imageUrl = ref<string | null>(url)
  const visible = ref(true)
  const { failure, stop } = build(imageUrl, visible)
  return { failure, imageUrl, drawing: visible, stop }
}

const scopes: (() => void)[] = []

afterEach(() => {
  for (const stop of scopes.splice(0)) stop()
})

function open(url: string | null) {
  const made = drawing(url)
  scopes.push(made.stop)
  return made
}

describe('a failed sheet', () => {
  it('is stated with the phase the loader gave up in', () => {
    const { failure } = open('a.png')
    failure.onLoadError({ url: 'a.png', phase: 'plain' })
    expect(failure.notice.value).toBe("The character's spritesheet did not load (plain).")
  })

  it('stops being stated when the window is asked to draw a different character', async () => {
    const { failure, imageUrl } = open('broken.png')
    failure.onLoadError({ url: 'broken.png', phase: 'plain' })
    expect(failure.notice.value).toMatch(/did not load/i)

    imageUrl.value = 'working.png'
    await nextTick()
    expect(failure.notice.value).toBeNull()
  })

  it('is dropped by a character that goes away entirely, not only by one that replaces it', async () => {
    // "No character is selected" and "this sheet did not load" are different states, and a window
    // that kept the second after the first became true would be reporting a sheet that is no longer
    // being requested at all.
    const { failure, imageUrl } = open('broken.png')
    failure.onLoadError({ url: 'broken.png', phase: 'plain' })

    imageUrl.value = null
    await nextTick()
    expect(failure.notice.value).toBeNull()
  })

  it('survives the same URL arriving again — a new appearance object is not a new load', async () => {
    // What `usePetWindow` produces on every applied `character` write: the host is re-read, a new
    // appearance view is built, and a write that moved the size and not the character leaves the
    // sheet where it was. Clearing here would drop a failure that is still true.
    const { failure, imageUrl } = open('broken.png')
    failure.onLoadError({ url: 'broken.png', phase: 'plain' })

    imageUrl.value = 'broken.png'
    await nextTick()
    expect(failure.notice.value).toMatch(/did not load/i)
  })

  it('survives the pet being hidden and shown again', async () => {
    // The retry `hide()`/`show()` performs loads the same URL — the one that already failed — so
    // clearing here would blink the sentence for a load nobody changed.
    const { failure, drawing } = open('broken.png')
    failure.onLoadError({ url: 'broken.png', phase: 'plain' })

    drawing.value = false
    await nextTick()
    drawing.value = true
    await nextTick()
    expect(failure.notice.value).toMatch(/did not load/i)
  })
})

describe('a canvas with no 2D context', () => {
  it('is stated in the window vocabulary rather than the code', () => {
    const { failure } = open('a.png')
    failure.onUnavailable('no-2d-context')
    expect(failure.notice.value).toBe('The pet cannot be drawn: the canvas has no 2D context.')
  })

  it('stops being stated when the window is asked to draw a different character', async () => {
    // A different character remounts the branch, so the canvas is a new element and the context is
    // unasked: the element that refused is gone with the thing that failed.
    const { failure, imageUrl } = open('a.png')
    failure.onUnavailable('no-2d-context')

    imageUrl.value = 'b.png'
    await nextTick()
    expect(failure.notice.value).toBeNull()
  })

  it('stops being stated when the pet is shown again, which is a canvas that has never been asked', async () => {
    // §7.1's drawing scope unmounts the sprite on hide. A context, once refused for an element, is
    // refused for that element for good — so a fresh element is a genuinely fresh attempt, and this
    // is the one retry that can replace what failed without the character having moved.
    const { failure, drawing } = open('a.png')
    failure.onUnavailable('no-2d-context')

    drawing.value = false
    await nextTick()
    expect(failure.notice.value).toMatch(/no 2D context/i)

    drawing.value = true
    await nextTick()
    expect(failure.notice.value).toBeNull()
  })

  it('outranks the sheet failure when both are set, because it explains the whole window', () => {
    // Both in one mount is possible: the context is refused in the same turn the load is started.
    // "Nothing can be painted here" is the one that also tells the user that choosing another
    // character will not help.
    const { failure } = open('broken.png')
    failure.onLoadError({ url: 'broken.png', phase: 'plain' })
    failure.onUnavailable('no-2d-context')
    expect(failure.notice.value).toMatch(/no 2D context/i)
  })
})
