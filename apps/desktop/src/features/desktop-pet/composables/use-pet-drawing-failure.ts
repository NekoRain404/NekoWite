/**
 * What the window says when it cannot draw: the two states `PetSprite` reports, and when each of
 * them stops being true.
 *
 * Both are failures of the *sprite* rather than of the window — the sheet will not load, or the
 * canvas has no 2D context — and both are the same shape of claim: "I was asked to draw this and
 * could not". The window's other silences (no host, switched off, no character chosen) are facts
 * about the host connection and stay in `DesktopPetRoot.vue`, which is also where these sentences
 * are ordered against those; this owns the invalidation, because that is the part with a rule in
 * it and the part that goes wrong quietly.
 *
 * **A failure is a fact about one attempt, and it stops being a fact when the attempt's subject is
 * replaced.** That is the whole rule, and it is why nothing here clears on a render, on a timer or
 * on a mount:
 *
 *  - clearing on a render would hide a genuinely broken character as readily as a stale one, and
 *    the window would flicker between a sentence and an empty canvas — which is how a user learns
 *    that neither means anything;
 *  - clearing on a timer would measure elapsed time, where the cause is a failed load;
 *  - clearing on a mount is the same mistake as clearing on a render, since a re-render is what
 *    most mounts here are.
 *
 * The state that is left is a *permanent* one while the sheet is genuinely missing, which is
 * deliberate: the window says so, and the way out is the settings page that chose the character.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { LoadFailure } from '../rendering/sprite-sheet'

export interface PetDrawingFailureOptions {
  /** The sheet the window is trying to draw; null draws nothing. */
  imageUrl: Readonly<Ref<string | null>>
  /** Whether the window is drawing at all — §7.1's `drawing` scope, false while hidden. */
  drawing: Readonly<Ref<boolean>>
}

export interface PetDrawingFailure {
  /** What to show instead of the sprite, or null when there is nothing to say. */
  readonly notice: ComputedRef<string | null>
  /** `PetSprite`'s `on-load-error`. */
  readonly onLoadError: (failure: LoadFailure) => void
  /** `PetSprite`'s `on-unavailable`. */
  readonly onUnavailable: (reason: 'no-2d-context') => void
}

export function usePetDrawingFailure(options: PetDrawingFailureOptions): PetDrawingFailure {
  /** The sheet that would not load, in the phase that gave up on it. */
  const sheetFailure = ref<string | null>(null)
  /** The canvas that never gave a 2D context, so nothing can be painted on it. */
  const canvasFailure = ref<string | null>(null)

  /**
   * A sheet failure is about a *URL*, and every way this window can be asked to draw a different
   * character moves it: `appearance` reaches the sprite through this one prop (`DesktopPetRoot`'s
   * `imageUrl`), and a new URL is a new load that deserves its own verdict.
   *
   * Watched on the computed and not on the prop, because with a connection the URL arrives from the
   * host: `usePetWindow` re-reads the appearance for every applied `character` write, and a write
   * that moved the size but not the character produces a new appearance object holding the *same*
   * sheet. A cleared-on-anything rule would drop a failure that is still true.
   *
   * The canvas failure is cleared here too, for the plainest reason: the branch that mounts the
   * sprite is remounted with the new URL, so the canvas is a new element and the context is
   * unasked.
   *
   * Deliberately *not* cleared by `hide()`/`show()`: that draws the same URL again, and a sentence
   * that blinked every time the pet was hidden would be reporting a retry nobody asked for.
   */
  watch(options.imageUrl, () => {
    sheetFailure.value = null
    canvasFailure.value = null
  })

  /**
   * The context failure belongs to a *canvas element*, and a canvas element lives exactly as long
   * as one mount of the sprite branch — a context, once refused for an element, is refused for that
   * element for good. §7.1's drawing scope unmounts the sprite on hide, so being shown again is a
   * canvas that has never been asked, and asking is the whole of the retry.
   *
   * The sheet failure is not cleared here, which is the same rule read the other way: showing the
   * window again loads the same URL, and that is the load that already failed.
   */
  watch(options.drawing, (visible) => {
    if (visible) canvasFailure.value = null
  })

  return {
    // The canvas first when both are set: "nothing can be painted here" explains the window, where
    // "this sheet would not load" explains one character — and it is the one that tells the user
    // that choosing another character will not help.
    notice: computed(() => canvasFailure.value ?? sheetFailure.value),
    onLoadError: (failure) => {
      sheetFailure.value = `The character's spritesheet did not load (${failure.phase}).`
    },
    // The reason is in the sentence's own words rather than interpolated: the union has one member
    // and `no-2d-context` is a code, not something to put in front of a user.
    onUnavailable: () => {
      canvasFailure.value = 'The pet cannot be drawn: the canvas has no 2D context.'
    },
  }
}
