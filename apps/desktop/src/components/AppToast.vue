<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { onNotify, onRecovery } from '../services/errors'
import type { RecoveryPrompt } from '../services/errors'
import { t } from '../i18n'

interface ToastMsg {
  id: number
  message: string
}

interface RecoveryPromptState extends RecoveryPrompt {
  id: number
}

let seq = 0
const toasts = ref<ToastMsg[]>([])
const recovery = ref<RecoveryPromptState | null>(null)

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function show(message: string): void {
  const id = ++seq
  toasts.value.push({ id, message })
  window.setTimeout(() => dismiss(id), 3000)
}

/**
 * Recovery prompts queue instead of replacing each other.
 *
 * There is one slot, and a second prompt used to overwrite the first WITHOUT
 * settling it: the callbacks of the dropped prompt never ran. One of those
 * callbacks is `requestUntitledVaultSwitch`'s, whose promise the vault switch
 * awaits — so if a crash-recovery or `.tmp` notice arrived while the
 * "you have untitled documents" prompt was up, the switch waited forever:
 * choosing "open folder" did nothing at all, with no error and no progress.
 * Queued prompts are shown one at a time, oldest first.
 */
const recoveryQueue = ref<Array<{ id: number } & RecoveryPrompt>>([])

function showRecovery(p: RecoveryPrompt): void {
  if (!recovery.value) {
    recovery.value = { id: ++seq, ...p }
    return
  }
  recoveryQueue.value.push({ id: ++seq, ...p })
}

function nextRecovery(): void {
  const next = recoveryQueue.value.shift()
  recovery.value = next ?? null
}

function dismissRecovery(): void {
  if (!recovery.value) return
  const p = recovery.value
  recovery.value = null
  p.onDismiss()
  // The callback can raise its own prompt (a vault switch that then finds
  // unsaved work); advancing after it keeps that one visible rather than
  // dropped behind the queue.
  nextRecovery()
}

function confirmRecovery(): void {
  if (!recovery.value) return
  const p = recovery.value
  recovery.value = null
  p.onRestore()
  // The callback can raise its own prompt (a vault switch that then finds
  // unsaved work); advancing after it keeps that one visible rather than
  // dropped behind the queue.
  nextRecovery()
}

const off = onNotify(show)
const offRecovery = onRecovery(showRecovery)

onBeforeUnmount(() => {
  off()
  offRecovery()
})
</script>

<template>
  <div class="toast-stack">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        role="alert"
        @click="dismiss(toast.id)"
      >
        {{ toast.message }}
      </div>
    </TransitionGroup>
    <div
      v-if="recovery"
      class="toast recovery"
      role="alertdialog"
      aria-live="assertive"
    >
      <span class="recovery-msg">{{ recovery.message }}</span>
      <div class="recovery-actions">
        <button
          class="btn btn-primary btn-sm"
          @click="confirmRecovery"
        >
          {{ t('toast.restore') }}
        </button>
        <button
          class="btn btn-secondary btn-sm"
          @click="dismissRecovery"
        >
          {{ t('toast.dismiss') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  top: calc(var(--app-titlebar-height) + 10px);
  right: 12px;
  /* Above the modal layer (10000), not below it. A toast reports a failure —
     often a failure of the very dialog that is open — and the modal overlays
     carry `backdrop-filter: blur(2px)`, so a toast underneath was both hidden
     and smeared into an unreadable smudge. See the scale in components.css. */
  z-index: 11000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 340px;
}
.toast {
  background: var(--app-elevated);
  color: var(--app-danger);
  border: 1px solid color-mix(in srgb, var(--app-danger) 40%, var(--app-border));
  border-radius: var(--app-radius-lg);
  padding: 9px 12px;
  font-size: 12px;
  letter-spacing: -0.006em;
  box-shadow: var(--app-shadow-menu);
  cursor: pointer;
  word-break: break-word;
  /* The stack hangs off the window's top-right corner and grows downward, so
     that corner is where a toast conceptually lives: it grows out of the anchor
     rather than fading in over it. Set here and not on the transition classes,
     which are removed a frame into the transition and would snap the origin
     back to the centre mid-flight. */
  transform-origin: top right;
}
.toast.recovery {
  color: var(--app-text);
  border-color: var(--app-border);
  cursor: default;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.recovery-actions {
  display: flex;
  gap: 6px;
}
/* The stack is a group, and it must not be the one group that snaps: when a
   toast is dismissed the ones under it close the gap instead of teleporting up
   by a toast's height. Vue drives this through the FLIP technique — it inverts
   the shift as a transform and this is the transition it plays out. */
.toast-move {
  transition: transform var(--app-motion) var(--app-ease);
}
.toast-enter-active {
  transition: opacity var(--app-motion) var(--app-ease-surface),
              transform var(--app-motion) var(--app-ease-surface);
  /* Promotion is taken out only for as long as the transition that needs it.
     The stack itself is permanent, so a `will-change` in the base rule would
     hold every toast on its own compositing layer for its whole life — see the
     note in styles/motion.css. */
  will-change: opacity, transform;
}
/* Leaving steps down one rung on the ladder and accelerates away: a toast that
   takes as long to go as it took to arrive reads as lag on the next action. The
   leave is deliberately not staggered and not slowed — a departing toast is
   already old news. */
.toast-leave-active {
  transition: opacity var(--app-motion-fast) var(--app-ease-exit),
              transform var(--app-motion-fast) var(--app-ease-exit);
  will-change: opacity, transform;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  /* Travel is a few pixels in from the edge the stack is anchored to, not a
     slide across the window. */
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(0.98);
}
</style>
