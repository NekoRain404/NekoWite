<script setup lang="ts">
/**
 * The composer: the attachments of the question being written, its input row
 * (attach the note, add an image, type, send) and the model row under it.
 *
 * The pickers and the drag/drop/paste plumbing are the template's own; what a
 * pasted or dropped thing has to satisfy, and what happens to the question, is
 * not (§10.2). So the native events are forwarded as they arrived - the panel
 * binds them to the attachment policy, which has to be able to call
 * `preventDefault()` on the very event that came in.
 */
import { computed, ref } from 'vue'
import { FileText, Paperclip, Send, X } from 'lucide-vue-next'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { EFFORT_OPTIONS, type ReasoningEffort } from '../../../stores/settings'
import { t } from '../../../i18n'
import type { ChatAttachment } from '../types'

const props = defineProps<{
  prompt: string
  attachments: ChatAttachment[]
  modelName: string
  effort: ReasoningEffort
  /** Send the active note / selection along with the question. */
  attachContext: boolean
  canSend: boolean
}>()

const emit = defineEmits<{
  'update:prompt': [value: string]
  'update:effort': [value: string]
  files: [files: File[]]
  send: []
  keydown: [e: KeyboardEvent]
  paste: [e: ClipboardEvent]
  drop: [e: DragEvent]
  dragover: [e: DragEvent]
  toggleAttach: []
  removeAttachment: [id: string]
}>()

/** `v-model` on the textarea, over the prop/emit pair: the built-in text
 *  binding is what skips the input events an IME fires mid-composition. */
const text = computed({
  get: () => props.prompt,
  set: (value: string) => emit('update:prompt', value),
})

const fileInput = ref<HTMLInputElement | null>(null)

// Same list, same keys as the settings dialog's: the depth chosen here and
// there is one setting, so the two must not drift into different labels.
const effortChoices = computed<SelectOption[]>(() =>
  EFFORT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
)

function onPickClick(): void {
  fileInput.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  emit('files', Array.from(input.files ?? []))
  input.value = ''
}
</script>

<template>
  <div class="chat-composer">
    <div
      v-if="attachments.length"
      class="chat-attachments"
    >
      <div
        v-for="a in attachments"
        :key="a.id"
        class="chat-attach"
      >
        <img
          :src="a.url"
          :alt="a.name"
          draggable="false"
        >
        <button
          class="chat-attach-remove"
          :title="t('chat.remove', { name: a.name })"
          @click="emit('removeAttachment', a.id)"
        >
          <X
            :size="10"
            :stroke-width="2"
          />
        </button>
      </div>
    </div>
    <div
      class="chat-input-row"
      @drop="emit('drop', $event)"
      @dragover="emit('dragover', $event)"
    >
      <input
        ref="fileInput"
        class="chat-file-input"
        type="file"
        accept="image/*"
        multiple
        tabindex="-1"
        @change="onFileChange"
      >
      <button
        class="chat-tool"
        :class="{ 'is-active': attachContext }"
        :title="t('chat.attachContextLabel')"
        :aria-label="t('chat.attachContext')"
        :aria-pressed="attachContext"
        @click="emit('toggleAttach')"
      >
        <FileText
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <button
        class="chat-tool"
        :title="t('chat.addImage')"
        @click="onPickClick"
      >
        <Paperclip
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <textarea
        v-model="text"
        class="chat-textarea"
        rows="1"
        :placeholder="t('chat.placeholder')"
        @keydown="emit('keydown', $event)"
        @paste="emit('paste', $event)"
      />
      <button
        class="chat-send"
        :title="t('chat.send')"
        :disabled="!canSend"
        @click="emit('send')"
      >
        <Send
          :size="15"
          :stroke-width="1.8"
        />
      </button>
    </div>
    <div class="chat-model">
      <span>{{ modelName }}</span>
      <label
        class="chat-effort"
        for="chat-effort-depth"
      >
        <span class="chat-effort-label">{{ t('aiSettings.effort') }}</span>
        <SelectMenu
          id="chat-effort-depth"
          class="chat-effort-select"
          :model-value="effort"
          :title="t('aiSettings.effortHint')"
          :options="effortChoices"
          @update:model-value="emit('update:effort', $event as string)"
        />
      </label>
      <span class="chat-hint">{{ t('chat.hint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.chat-composer {
  flex: none;
  padding: 6px 10px 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chat-attachments {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 2px 2px;
}
.chat-attach {
  position: relative;
  flex: none;
  width: 48px;
  height: 48px;
}
.chat-attach img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--app-radius-sm);
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
}
.chat-attach-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 999px;
  background: var(--app-elevated);
  color: var(--app-muted);
  box-shadow: 0 1px 3px rgb(0 0 0 / 18%);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.chat-attach-remove:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 12%, var(--app-elevated));
}
.chat-attach-remove:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.chat-input-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.chat-file-input {
  display: none;
}
.chat-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.chat-tool:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.chat-tool:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.chat-tool.is-active {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent-soft) 62%, transparent);
}
.chat-textarea {
  flex: 1;
  min-width: 0;
  max-height: 132px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  line-height: 1.6;
  resize: none;
  outline: none;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.chat-textarea::placeholder {
  color: var(--app-muted);
}
.chat-textarea:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background: color-mix(in srgb, var(--app-elevated) 72%, var(--app-panel));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
}
.chat-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  border: none;
  border-radius: var(--app-radius);
  background: var(--app-accent);
  color: var(--app-accent-contrast);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              opacity var(--app-motion-fast) var(--app-ease);
}
.chat-send:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent) 88%, var(--app-elevated));
}
.chat-send:disabled {
  opacity: 0.45;
  cursor: default;
}
.chat-send:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}
.chat-model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: var(--app-muted);
}
.chat-hint {
  font-variant-numeric: tabular-nums;
}
/* Thinking depth sits next to the model name because that is where the user
 * notices the wait: a reasoning model stays silent for seconds before the first
 * word, and the fix ("ask for less thinking") should not require a trip to the
 * settings dialog mid-conversation. */
.chat-effort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.chat-effort-label {
  white-space: nowrap;
}
.chat-effort-select {
  max-width: 96px;
  /* One pixel narrower than the closed select's, because the caret the control
     draws itself needs the room the system arrow used to take for free. */
  padding: 1px 4px;
  font: inherit;
  font-size: 10px;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--app-muted) 34%, transparent);
  border-radius: 4px;
}
.chat-effort-select:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
