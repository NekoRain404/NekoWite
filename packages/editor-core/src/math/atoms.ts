import * as MathLiveNS from 'mathlive'

type MathLiveGlobal = {
  convertLatexToMarkup?(latex: string): string
  makeMathField?(el: HTMLElement, opts: Record<string, unknown>): MathEditorHandle
}

function getMathLive(): MathLiveGlobal {
  const w = globalThis as unknown as { MathLive?: MathLiveGlobal }
  if (w.MathLive) return w.MathLive
  return MathLiveNS as unknown as MathLiveGlobal
}

export interface MathEditorHandle {
  getValue(): string
  setValue(latex: string): void
  dispose(): void
}

export function renderLatexMarkup(latex: string): string {
  const { convertLatexToMarkup } = getMathLive()
  if (typeof convertLatexToMarkup === 'function') {
    try {
      return convertLatexToMarkup(latex)
    } catch {
      /* fall through */
    }
  }
  return latex
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function createMathEditor(
  el: HTMLElement,
  options: { value?: string; onChange?: (latex: string) => void } = {},
): MathEditorHandle {
  const { makeMathField } = getMathLive()
  if (typeof makeMathField === 'function') {
    const mf = makeMathField(el, {
      value: options.value ?? '',
      virtualKeyboardMode: 'onfocus',
      onInput: () => options.onChange?.(mf.getValue()),
    })
    return {
      getValue: () => mf.getValue(),
      setValue: (l) => mf.setValue(l),
      dispose: () => {
        const remover = (mf as unknown as { remove?: () => void }).remove
        if (typeof remover === 'function') remover()
      },
    }
  }
  el.setAttribute('contenteditable', 'true')
  ;(el as HTMLElement).textContent = options.value ?? ''
  return {
    getValue: () => (el.textContent ?? ''),
    setValue: (l) => { el.textContent = l },
    dispose: () => { /* nothing */ },
  }
}
