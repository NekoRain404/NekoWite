import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/** Selector for elements that can receive focus inside a modal / dialog.
 *  Mirrors the browser's default focusability (minus contenteditable, which is
 *  never a focus trap boundary border in the UIs this is composed into). */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export interface UseFocusTrapOptions {
  /** When true, focus the first focusable element on activation. */
  initialFocus?: boolean
}

/**
 * Trap keyboard focus inside `container` while `active` is truthy.
 *
 * - On activation: remembers the previously focused element and moves focus to
 *   the first focusable element inside the container.
 * - While active: Tab / Shift+Tab cycle within the container (never escapes).
 * - On deactivation: restores focus to the previously focused element.
 *
 * Returns `{ activate, deactivate }`. The composable auto-activates/deactivates
 * by observing `active`, and cleans up on unmount.
 */
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  options: UseFocusTrapOptions = {},
): { activate: () => void; deactivate: () => void } {
  let prevFocus: HTMLElement | null = null
  let trapped = false

  function focusables(): HTMLElement[] {
    const el = container.value
    if (!el) return []
    return [...el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
  }

  function firstFocusable(): HTMLElement | null {
    return focusables()[0] ?? null
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return
    const list = focusables()
    if (list.length === 0) return
    const first = list[0]
    const last = list[list.length - 1]
    const current = document.activeElement
    if (e.shiftKey) {
      if (current === first || !container.value?.contains(current)) {
        e.preventDefault()
        last.focus()
      }
    } else if (current === last || !container.value?.contains(current)) {
      e.preventDefault()
      first.focus()
    }
  }

  function activate(): void {
    if (trapped) return
    trapped = true
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', onKeydown, true)
    if (options.initialFocus !== false) {
      void nextTick(() => {
        if (!trapped) return
        firstFocusable()?.focus()
      })
    }
  }

  function deactivate(): void {
    if (!trapped) return
    trapped = false
    document.removeEventListener('keydown', onKeydown, true)
    const el = prevFocus
    prevFocus = null
    if (el && el.isConnected) el.focus()
  }

  watch(
    active,
    (isActive) => {
      if (isActive) activate()
      else deactivate()
    },
    { immediate: true },
  )

  onBeforeUnmount(deactivate)

  return { activate, deactivate }
}
