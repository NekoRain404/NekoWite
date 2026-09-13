<script setup lang="ts">
/**
 * The chat panel: the AI rail's conversation view, its composer and the stream
 * that answers a question.
 *
 * Orchestration only (§13.3). Everything below is one of the feature's
 * composables: the turns, drafts and session switches (`useChatSession`), the
 * pending images (`useChatAttachments`), the note a question carries
 * (`useChatContext`) and the commands the buttons and keys fire
 * (`useChatCommands`). Store access lives in those composables (§10.2) and the
 * pure prompt assembly in `services/chatLogic`; what is left here is the wiring
 * between them, plus the handful of things that are genuinely the template's
 * (the file input, the scroll element, the keyboard).
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import {
  Copy,
  FilePlus2,
  FileText,
  Paperclip,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-vue-next'
import { EFFORT_OPTIONS } from '../../../stores/settings'
import { isComposingKey } from '../../../services/keyGuard'
import { t } from '../../../i18n'
import { useChatAttachments } from '../composables/useChatAttachments'
import { useChatCommands } from '../composables/useChatCommands'
import { useChatContext } from '../composables/useChatContext'
import { useChatSession } from '../composables/useChatSession'

/** The composer's half-written question. It lives here because two other
 * modules read it: a draft parks it per session (`useChatSession`) and a send
 * clears it (`useChatCommands`). */
const prompt = ref('')

const pending = useChatAttachments()
const attachments = pending.attachments

const session = useChatSession({
  prompt,
  attachments,
  releaseUrls: pending.releaseUrls,
})

const note = useChatContext()

const scrollEl = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const commands = useChatCommands({
  prompt,
  attachments,
  messages: session.messages,
  syncSession: session.syncSession,
  clearAttachments: pending.clearAttachments,
  forgetDraft: session.forgetDraft,
  attachContext: note.attachContext,
  hasActiveTab: note.hasActiveTab,
  buildActiveContext: note.buildActiveContext,
  scrollToBottom,
})

const { messages, sessions, activeId, storageWarningText, releaseDrafts } = session
const { addFiles, removeAttachment, clearAttachments, onPaste, onDrop, onDragOver } = pending
const { attachContext, hasActiveTab, toggleAttachContext } = note
const {
  modelName,
  effort,
  setEffort,
  canSend,
  send,
  stop,
  stopIfStreaming,
  clearAll,
  dispose,
  insertIntoDocument,
  copyMessage,
} = commands

const fileInput = ref<HTMLInputElement | null>(null)

const hasMessages = computed(() => messages.value.length > 0)

function onPickClick(): void {
  fileInput.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}

/** Leave the current conversation. A stream belongs to the session it was
 *  started in, so it is stopped before the store's active session moves - and
 *  only then: the app-level cancel is not a no-op, it cancels whatever the AI
 *  service is streaming. */
function leaveTo(id: string | null): void {
  stopIfStreaming()
  session.switchToSession(id)
  scrollToBottom()
}

function newSession(): void {
  leaveTo(null)
}

function onSessionChange(e: Event): void {
  const id = (e.target as HTMLSelectElement).value || null
  if (id === activeId.value) return
  leaveTo(id)
}

function deleteActiveSession(): void {
  stopIfStreaming()
  session.deleteActiveSession()
  scrollToBottom()
}

function onComposerKeydown(e: KeyboardEvent): void {
  // Enter accepts the IME candidate; sending the message there would fire a
  // request with the half-composed text.
  if (isComposingKey(e)) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

onBeforeUnmount(() => {
  // A stream can still be running when the rail closes (`v-if` in AppShell
  // unmounts this panel): stop it and persist the partial answer before the
  // working copy dies with the component.
  dispose()
  clearAttachments()
  releaseDrafts()
})
</script>

<template>
  <section class="chat-panel">
    <header class="chat-header">
      <div class="chat-session-row">
        <button
          class="chat-tool"
          :title="t('chat.newSession')"
          :aria-label="t('chat.newSession')"
          @click="newSession"
        >
          <Plus
            :size="14"
            :stroke-width="1.8"
          />
        </button>
        <select
          class="chat-session-select"
          :value="activeId ?? undefined"
          :title="t('chat.sessions')"
          :aria-label="t('chat.sessions')"
          @change="onSessionChange"
        >
          <option
            v-for="s in sessions"
            :key="s.id"
            :value="s.id"
          >
            {{ s.title || t('chat.untitled') }}
          </option>
        </select>
        <button
          class="chat-tool"
          :title="t('chat.deleteSession')"
          :aria-label="t('chat.deleteSession')"
          :disabled="sessions.length <= 1"
          @click="deleteActiveSession"
        >
          <Trash2
            :size="13"
            :stroke-width="1.8"
          />
        </button>
      </div>
      <span class="chat-title">
        {{ t('chat.title') }}
      </span>
      <button
        class="chat-clear"
        :title="t('chat.clear')"
        :disabled="!hasMessages"
        @click="clearAll"
      >
        <Trash2
          :size="13"
          :stroke-width="1.8"
        />
      </button>
    </header>

    <div
      v-if="storageWarningText"
      class="chat-storage-warning"
      role="status"
    >
      {{ storageWarningText }}
    </div>

    <div
      ref="scrollEl"
      class="chat-scroll"
      role="log"
      aria-live="polite"
    >
      <div
        v-if="!hasMessages"
        class="chat-empty"
      >
        <Sparkles
          class="chat-empty-icon"
          :size="20"
          :stroke-width="1.6"
        />
        <p class="chat-empty-title">
          {{ t('chat.emptyTitle') }}
        </p>
        <p class="chat-empty-hint">
          {{ t('chat.emptyMsg') }}
        </p>
        <p class="chat-empty-hint">
          {{ t('chat.emptyImages') }}
        </p>
      </div>

      <div
        v-for="(m, index) in messages"
        :key="index"
        class="chat-row"
        :class="m.role"
      >
        <div class="chat-bubble">
          <div
            v-if="m.images && m.images.length"
            class="chat-msg-images"
          >
            <img
              v-for="img in m.images"
              :key="img.id"
              :src="img.dataUrl"
              :alt="img.name"
              draggable="false"
            >
          </div>
          <div
            v-if="m.imageNotice"
            class="chat-image-notice"
          >
            {{ m.imageNotice }}
          </div>
          <div
            v-if="m.usageTotal"
            class="chat-usage"
          >
            {{ t('chat.usage', { count: m.usageTotal }) }}
          </div>
          <div class="chat-content">
            {{ m.content }}
            <span
              v-if="m.streaming"
              class="chat-caret"
              aria-hidden="true"
            />
          </div>
        </div>
        <div
          v-if="m.role === 'assistant'"
          class="chat-actions"
        >
          <span
            v-if="m.interrupted"
            class="chat-interrupted"
            :title="t('chat.interruptedHint')"
          >{{ t('chat.interrupted') }}</span>
          <button
            v-if="m.streaming"
            class="chat-action chat-stop"
            :title="t('chat.stop')"
            @click="stop"
          >
            <Square
              :size="12"
              :stroke-width="1.8"
            />
            <span>{{ t('chat.stop') }}</span>
          </button>
          <template v-else>
            <button
              class="chat-action"
              :title="t('chat.insertToDoc')"
              :disabled="!hasActiveTab"
              @click="insertIntoDocument(m)"
            >
              <FilePlus2
                :size="12"
                :stroke-width="1.8"
              />
              <span>{{ t('chat.insertDoc') }}</span>
            </button>
            <button
              class="chat-action"
              :title="t('chat.copyContent')"
              @click="copyMessage(m)"
            >
              <Copy
                :size="12"
                :stroke-width="1.8"
              />
              <span>{{ t('chat.copy') }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>

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
            @click="removeAttachment(a.id)"
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
        @drop="onDrop"
        @dragover="onDragOver"
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
          @click="toggleAttachContext"
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
          v-model="prompt"
          class="chat-textarea"
          rows="1"
          :placeholder="t('chat.placeholder')"
          @keydown="onComposerKeydown"
          @paste="onPaste"
        />
        <button
          class="chat-send"
          :title="t('chat.send')"
          :disabled="!canSend"
          @click="send"
        >
          <Send
            :size="15"
            :stroke-width="1.8"
          />
        </button>
      </div>
      <div class="chat-model">
        <span>{{ modelName }}</span>
        <label class="chat-effort">
          <span class="chat-effort-label">{{ t('aiSettings.effort') }}</span>
          <select
            :value="effort"
            :title="t('aiSettings.effortHint')"
            @change="setEffort(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="opt in EFFORT_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ t(opt.labelKey) }}
            </option>
          </select>
        </label>
        <span class="chat-hint">{{ t('chat.hint') }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex: none;
  padding: 12px 14px 6px;
}
.chat-session-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.chat-session-select {
  flex: 1;
  min-width: 0;
  max-width: 130px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1.4;
  outline: none;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.chat-session-select:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
}
.chat-session-select:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.chat-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.chat-clear:hover:not(:disabled) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.chat-clear:disabled {
  cursor: default;
  opacity: 0.5;
}
.chat-clear:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: 1;
  min-height: 160px;
  padding: 16px;
  text-align: center;
  color: var(--app-muted);
}
.chat-empty-icon {
  margin-bottom: 4px;
  color: color-mix(in srgb, var(--app-accent) 60%, var(--app-muted));
}
.chat-empty-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text);
}
.chat-empty-hint {
  margin: 0;
  max-width: 220px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--app-muted);
}
.chat-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.chat-row.user {
  align-items: flex-end;
}
.chat-bubble {
  max-width: 100%;
  padding: 8px 10px;
  border-radius: var(--app-radius-lg);
  background: var(--app-elevated);
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-word;
  white-space: pre-wrap;
}
.chat-row.user .chat-bubble {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.chat-content {
  margin: 0;
}
.chat-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--app-accent);
  animation: chat-caret-blink var(--app-motion-blink) steps(2, start) infinite;
}
@keyframes chat-caret-blink {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}
.chat-msg-images {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.chat-msg-images img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--app-radius-sm);
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
}
.chat-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.chat-storage-warning {
  margin: 6px 10px 0;
  padding: 6px 8px;
  border-radius: var(--app-radius);
  border: 1px solid color-mix(in srgb, var(--app-danger) 40%, transparent);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
  font-size: 11px;
  line-height: 1.4;
}

.chat-image-notice {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--app-text-muted);
  font-style: italic;
}

.chat-interrupted {
  display: inline-flex;
  align-items: center;
  height: 20px;
  margin-right: 2px;
  padding: 0 7px;
  border: 1px dashed color-mix(in srgb, var(--app-muted) 55%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-elevated) 55%, transparent);
  color: var(--app-muted);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: -0.01em;
}
.chat-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.chat-action:hover:not(:disabled) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.chat-action:disabled {
  cursor: default;
  opacity: 0.45;
}
.chat-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.chat-stop {
  color: var(--app-danger);
}
.chat-stop:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
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
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
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
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.chat-usage {
  margin-top: 2px;
  font-size: 10px;
  color: color-mix(in srgb, var(--app-muted) 78%, transparent);
  font-variant-numeric: tabular-nums;
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
.chat-effort select {
  max-width: 96px;
  padding: 1px 2px;
  font: inherit;
  font-size: 10px;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--app-muted) 34%, transparent);
  border-radius: 4px;
}
.chat-effort select:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
