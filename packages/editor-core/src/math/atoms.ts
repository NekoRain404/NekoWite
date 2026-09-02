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
      .then((mod) => {
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
