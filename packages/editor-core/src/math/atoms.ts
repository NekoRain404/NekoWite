// Referenced so consumer packages compiling this source see the lazy
// `mathlive/static.css` module type (the desktop tsconfig has no `*.css`
// wildcard for library files).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./mathlive-css.d.ts" />
import type * as MathLiveNS from 'mathlive'

type MathLiveGlobal = {
  convertLatexToMarkup?(latex: string): string
  MathfieldElement?: typeof MathLiveNS.MathfieldElement
}

type MathLiveModule = typeof MathLiveNS

let mathlivePromise: Promise<MathLiveModule | null> | null = null
let mathliveModule: MathLiveModule | null = null

function loadMathLive(): Promise<MathLiveModule | null> {
  if (!mathlivePromise) {
    mathlivePromise = import('mathlive')
      .then(async (mod) => {
        // MathLive's field styles are only needed once the math editor is
        // actually opened; load them on demand (rather than statically during
        // app bootstrap) so the startup bundle stays free of MathLive's CSS.
        // A CSS failure is cosmetic — the field just renders unstyled.
        try {
          await import('mathlive/static.css')
        } catch {
          /* no-op */
        }
        mathliveModule = mod
        return mod
      })
      .catch(() => {
        mathlivePromise = null
        mathliveModule = null
        return null
      })
  }
  return mathlivePromise
}

export function warmMathLive(): Promise<void> {
  return loadMathLive().then(() => undefined)
}

function getMathLive(): MathLiveGlobal | null {
  const w = globalThis as unknown as { MathLive?: MathLiveGlobal }
  if (w.MathLive) return w.MathLive
  if (mathliveModule) return mathliveModule as MathLiveGlobal
  return null
}

export interface MathEditorHandle {
  getValue(): string
  setValue(latex: string): void
  dispose(): void
}

/**
 * Swap the fallback editor inside `el` for a MathLive field, carrying the
 * current value across.
 *
 * Returns the new handle, or null when MathLive could not be used (the caller
 * then keeps the fallback, which is still a working editor).
 */
export async function upgradeMathEditor(
  el: HTMLElement,
  /** Read the CURRENT text at swap time, not at call time: the load is async,
   *  and anything the user typed while it was in flight would otherwise be
   *  replaced by the value captured before they typed it. */
  currentValue: () => string,
  onChange?: (latex: string) => void,
): Promise<MathEditorHandle | null> {
  const mod = await loadMathLive()
  if (!mod || typeof mod.MathfieldElement !== 'function') return null
  const current = currentValue()
  // Drop everything the fallback left in the host (its text node and the
  // contenteditable attribute) or the MathLive field would sit beside stale text.
  el.textContent = ''
  el.removeAttribute('contenteditable')
  const handle = createMathEditor(el, { value: current, onChange })
  return handle
}

export function renderLatexMarkup(latex: string): string {
  const { convertLatexToMarkup } = getMathLive() ?? {}
  if (typeof convertLatexToMarkup === 'function') {
    try {
      return convertLatexToMarkup(latex)
    } catch {
      /* fall through */
    }
  }
  warmMathLive()
  return latex
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Create the BEST editor `el` can host, waiting for MathLive if it is still
 * loading.
 *
 * `createMathEditor` degrades to a plain contenteditable box when MathLive has
 * not finished its lazy import yet — which is exactly the state on the FIRST
 * open of the dialog, so a user's first formula got a bare text field and the
 * visual editor only appeared on some later open. Callers that can wait should
 * await this instead; the sync version stays for the instant-but-degraded path.
 *
 * Resolves to `null` when MathLive is genuinely unavailable (offline, blocked),
 * in which case the caller keeps whatever it already had.
 */
export async function createMathEditorWhenReady(
  el: HTMLElement,
  options: { value?: string; onChange?: (latex: string) => void } = {},
): Promise<MathEditorHandle | null> {
  const mod = await loadMathLive()
  if (!mod || typeof mod.MathfieldElement !== 'function') return null
  return createMathEditor(el, options)
}

export function createMathEditor(
  el: HTMLElement,
  options: { value?: string; onChange?: (latex: string) => void } = {},
): MathEditorHandle {
  const { MathfieldElement: MFE } = getMathLive() ?? {}
  if (typeof MFE === 'function') {
    const mfe = new MFE()
    mfe.value = options.value ?? ''
    const onInput = (): void => options.onChange?.(mfe.value)
    mfe.addEventListener('input', onInput)
    el.appendChild(mfe)
    return {
      getValue: () => mfe.value,
      setValue: (l) => {
        mfe.value = l
      },
      dispose: () => {
        mfe.removeEventListener('input', onInput)
        mfe.remove()
      },
    }
  }
  warmMathLive()
  el.setAttribute('contenteditable', 'true')
  el.textContent = options.value ?? ''
  const onInput = (): void => options.onChange?.(el.textContent ?? '')
  el.addEventListener('input', onInput)
  return {
    getValue: () => el.textContent ?? '',
    setValue: (l) => {
      el.textContent = l
    },
    dispose: () => {
      el.removeEventListener('input', onInput)
      el.removeAttribute('contenteditable')
    },
  }
}
