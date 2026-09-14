<script setup lang="ts">
/**
 * The chat panel: the AI rail's conversation view.
 *
 * Orchestration only (§13.3). Everything below is one of the feature's
 * composables - the turns, drafts and session switches (`useChatSession`), the
 * pending images (`useChatAttachments`), the note a question carries
 * (`useChatContext`) and the commands the sections fire (`useChatCommands`) -
 * and the three sections render themselves. What is left here is the wiring
 * between them, the storage banner, and the ordering rules that belong to no
 * single section: a stream belongs to the conversation it was started in, so it
 * is stopped before the store's active session moves.
 *
 * Store access lives in the composables, never here (§10.2).
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import ChatComposer from './ChatComposer.vue'
import ChatSessionBar from './ChatSessionBar.vue'
import ChatTranscript from './ChatTranscript.vue'
import { isComposingKey } from '../../../services/key-guard'
import { useChatAttachments } from '../composables/use-chat-attachments'
import { useChatCommands } from '../composables/use-chat-commands'
import { useChatContext } from '../composables/use-chat-context'
import { useChatSession } from '../composables/use-chat-session'

/** The composer's half-written question. It lives here because two other
 *  modules read it: a draft parks it per session (`useChatSession`) and a send
 *  clears it (`useChatCommands`). */
const prompt = ref('')

const pending = useChatAttachments()
const attachments = pending.attachments

const session = useChatSession({
  prompt,
  attachments,
  releaseUrls: pending.releaseUrls,
})

const note = useChatContext()

/** The transcript owns the scroll element and pins it to the newest turn; the
 *  send path asks it to through `scrollToBottom`. */
const transcript = ref<InstanceType<typeof ChatTranscript> | null>(null)

function scrollToBottom(): void {
  transcript.value?.scrollToBottom()
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

const hasMessages = computed(() => messages.value.length > 0)

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

function onSessionChange(id: string): void {
  const next = id || null
  if (next === activeId.value) return
  leaveTo(next)
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
    <ChatSessionBar
      :sessions="sessions"
      :active-id="activeId"
      :has-messages="hasMessages"
      @new-session="newSession"
      @select-session="onSessionChange"
      @delete-session="deleteActiveSession"
      @clear="clearAll"
    />

    <div
      v-if="storageWarningText"
      class="chat-storage-warning"
      role="status"
    >
      {{ storageWarningText }}
    </div>

    <ChatTranscript
      ref="transcript"
      :messages="messages"
      :can-insert="hasActiveTab"
      @stop="stop"
      @insert="insertIntoDocument"
      @copy="copyMessage"
    />

    <ChatComposer
      v-model:prompt="prompt"
      :attachments="attachments"
      :model-name="modelName"
      :effort="effort"
      :attach-context="attachContext"
      :can-send="canSend"
      @update:effort="setEffort"
      @files="addFiles"
      @keydown="onComposerKeydown"
      @paste="onPaste"
      @drop="onDrop"
      @dragover="onDragOver"
      @toggle-attach="toggleAttachContext"
      @remove-attachment="removeAttachment"
      @send="send"
    />
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
.chat-storage-warning {
  margin: 6px 10px 0;
  padding: 6px 8px;
  border-radius: var(--app-radius);
  border: 1px solid color-mix(in srgb, var(--app-danger) 40%, transparent);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
  font-size: 11px;
  line-height: 1.4;
}

</style>
