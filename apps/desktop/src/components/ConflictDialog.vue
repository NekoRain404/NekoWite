<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { useFocusTrap } from '../composables/use-focus-trap'
import { modalStack } from '../services/modal-stack'
import { t } from '../i18n'

// The dialog names the conflict but does not resolve it (§10.2): the reload of
// the tab from disk is a store command, so the prompt reports the choice and
// the caller — which owns the tab store — performs it and closes the prompt.
defineProps<{ tabId: string; path: string }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'reload-disk'): void
  (e: 'keep-local'): void
}>()

const active = ref(true)
const dialogEl = ref<HTMLElement | null>(null)
// `initialFocus: false`: the first focusable control in this dialog is "Use
// disk (discard local)", and focusing it made the prompt appear with the
// destructive action already armed — a stray Enter discarded the user's
// unsaved edits. Focus goes to the container, so every answer (including the
// safe ones) is a deliberate move.
useFocusTrap(dialogEl, active, { initialFocus: false })

const modalToken = modalStack.claimModal('conflict-dialog')

nextTick(() => dialogEl.value?.focus())

onBeforeUnmount(() => {
  modalStack.releaseModal(modalToken)
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (!modalStack.isTopModal(modalToken)) return
    e.preventDefault()
    emit('close')
  }
}

// Deliberately no `close` here: the caller closes the prompt once the reload it
// was asked for has finished, so the dialog can never disappear before the
// user's choice has taken effect.
function reloadFromDisk(): void {
  emit('reload-disk')
}

// `keep-local` and not `close`, because this is an ANSWER and the dialog's third
// button is not: the caller records it on the tab, so the next save writes
// through instead of putting the same question again — which is what the two
// sharing one event used to make impossible (the decision left with the dialog).
function keepLocal(): void {
  emit('keep-local')
}

// "Later" keeps the question open, so it reports nothing but the prompt closing.
function later(): void {
  emit('close')
}
</script>

<template>
  <div
    class="dialog-overlay"
    @keydown="onKeydown"
  >
    <div
      ref="dialogEl"
      class="dialog conflict-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      tabindex="-1"
    >
      <div
        id="conflict-title"
        class="conflict-title"
      >
        {{ t('conflict.title') }}
      </div>
      <div class="conflict-body">
        <!-- Split around the path on purpose: the path is its own emphasised
             node, and interpolating {path} here produced a sentence with a hole
             in it ("Disk content of  changed") because the placeholder was
             filled with an empty string. -->
        {{ t('conflict.bodyPrefix') }}
        <span class="conflict-path">
          {{ path }}
        </span>
        {{ t('conflict.bodySuffix') }}
      </div>
      <!-- Shared action-row convention (see .dialog-actions in
           styles/surfaces.css): the confirm slot is the rightmost button, the
           one a hand reaches for without reading, so it holds the answer that
           keeps the user's edits. Discarding them is the one action that must
           not sit there; it goes first, styled as the danger it is. -->
      <div class="dialog-actions">
        <button
          class="btn btn-danger"
          @click="reloadFromDisk"
        >
          {{ t('conflict.reloadDisk') }}
        </button>
        <button
          class="btn btn-ghost"
          @click="later"
        >
          {{ t('conflict.later') }}
        </button>
        <button
          class="btn btn-primary"
          @click="keepLocal"
        >
          {{ t('conflict.keepLocal') }}
        </button>
      </div>
      <div class="conflict-note">
        {{ t('conflict.note') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.conflict-dialog {
  position: fixed;
  bottom: 32px;
  left: 50%;
  /* `translate`, not `transform: translateX(...)` — the shared arrival animates
     `scale`, which multiplies a `transform` rather than preserving it, so a
     prompt centred that way slides in from the side as it grows. See the note
     on the arrival in styles/motion.css. */
  translate: -50% 0;
  width: min(440px, 90vw);
  padding: 14px 16px;
  font-size: 13px;
  color: var(--app-text);
  /* Anchored to the bottom edge, so the scale is pinned to the edge it grows
     out of rather than to a centre it does not have. */
  transform-origin: bottom;
}
.conflict-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--app-text);
}
.conflict-path {
  /* The user's own monospace choice, not a stack of macOS names: this file path
     is the one string in the dialog a reader compares character by character,
     and "Monospace font" in Appearance is where they said what it should be
     drawn in. `SFMono-Regular` and `Menlo` are macOS names and could never
     resolve here, so the old value was that generic keyword plus two dead
     entries — and no CJK at all, in a path that can contain it. */
  font-family: var(--app-mono-font);
  background: var(--app-panel);
  padding: 1px 4px;
  border-radius: 3px;
  word-break: break-all;
}
.dialog-actions {
  margin-top: 10px;
}
.conflict-note {
  margin-top: 8px;
  color: var(--app-muted);
  font-size: 12px;
}
</style>
