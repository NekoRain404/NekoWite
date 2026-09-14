import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useFocusTrap } from '../../../composables/use-focus-trap'
import { modalStack } from '../../../services/modal-stack'
import { isComposingKey } from '../../../services/key-guard'
import { readAppVersion } from '../../../platform/app-version'

export interface UseSettingsDialogOptions {
  /** The dialog element, bound by the component's own `ref="dialogRef"`. The
   *  trap and the deferred first focus both write to it, so it is passed in
   *  rather than created here: a template ref belongs to the template. */
  dialogRef: Ref<HTMLElement | null>
  /** Ask the host to close the panel. Passed in rather than emitted here: the
   *  composable owns the dialog's lifecycle, the component owns its contract. */
  onClose: () => void
}

export interface SettingsDialogModel {
  /** Null until the read resolves, and null when nothing can answer. */
  appVersion: Ref<string | null>
  /** Bind to the overlay: a pointerdown that lands on the overlay itself —
   *  not on anything inside the dialog — is a click outside, and closes. */
  onOverlayPointerDown: (e: PointerEvent) => void
  /** Return focus to the dialog — used when the visible section changes, so
   *  the keyboard stays where the user's eye already is. */
  focusDialog: () => void
}

/**
 * The settings dialog's own lifecycle: the focus trap, the Escape key and the
 * app version it reports.
 *
 * Kept out of the panel component because none of it is settings (§13.3): the
 * panel composes sections, this decides which modal may answer Escape and where
 * Tab may go.
 */
export function useSettingsDialog(options: UseSettingsDialogOptions): SettingsDialogModel {
  const { dialogRef } = options
  const panelActive = ref(true)
  // aria-modal has to mean something: without a trap, Tab walked out of the
  // dialog into the tab bar and editor it was covering. Focusing the container
  // (tabindex=-1) on open matches the other dialogs and keeps Enter from
  // activating whatever control happens to be first.
  useFocusTrap(dialogRef, panelActive, { initialFocus: false })
  // The settings panel and the command palette are both full-screen modals at
  // z-index 10000, and both listen for Escape on window in the capture phase.
  // Keydown listeners on the same target cannot stop each other, so each one asks
  // the stack whether it is the topmost modal before acting.
  const modalToken = modalStack.claimModal('settings-panel')

  /** The build a bug report should name. Null until it resolves, and null
   *  when nothing can answer - showing nothing beats showing a guess. */
  const appVersion = ref<string | null>(null)
  void readAppVersion().then((v) => {
    appVersion.value = v
  }).catch(() => undefined)

  function onKeydown(e: KeyboardEvent): void {
    // Shared guard: the deprecated keyCode 229 / key="Process" signals matter on
    // Windows IMEs, where `isComposing` alone is not always set.
    if (isComposingKey(e)) return
    if (e.key === 'Escape') {
      // Only the modal the user is looking at may answer Escape.
      if (!modalStack.isTopModal(modalToken)) return
      e.preventDefault()
      options.onClose()
    }
  }

  function onOverlayPointerDown(e: PointerEvent): void {
    if (e.target === e.currentTarget) options.onClose()
  }

  function focusDialog(): void {
    void nextTick(() => dialogRef.value?.focus())
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown, true)
    focusDialog()
  })

  onBeforeUnmount(() => {
    modalStack.releaseModal(modalToken)
    window.removeEventListener('keydown', onKeydown, true)
  })

  return { appVersion, onOverlayPointerDown, focusDialog }
}
