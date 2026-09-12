<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
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
import { startChatCompletion, aiService } from '../services/ai'
import { notifyError } from '../services/errors'
import { editorSessionManager } from '../features/editor/sessionManager'
import { insertMarkdownAtCursor } from '../services/editorInsert'
import { flushEdits } from '../services/editorOwnership'
import { collectClipboardImages, isImageFile } from '../services/attachments'
import { useSettingsStore } from '../stores/settings'
import { useTabsStore } from '../stores/tabs'
import { useChatSessionStore } from '../stores/chatSession'
import { useAiPermissionStore } from '../stores/aiPermission'
import type { ChatSessionMessage } from '../stores/chatSession'
import {
  buildChatPrompt,
  buildContextBlock,
  fileToDataURL,
  nextImageId,
  type ChatImage,
  type ChatMessage,
} from './chatLogic'
import { t } from '../i18n'

interface ChatAttachment {
  id: string
  name: string
  file: File
  url: string
}

const settings = useSettingsStore()
const tabs = useTabsStore()
const chatSessions = useChatSessionStore()

/** Persisted toggle for whether to send the active note / selection as context. */
const ATTACH_KEY = 'nekowite.chat.attachContext'

function loadAttachDefault(): boolean {
  try {
    const raw = localStorage.getItem(ATTACH_KEY)
    if (raw === '0') return false
  } catch {
    /* ignore corrupted storage */
  }
  return true
}

const useCurrentDoc = ref(loadAttachDefault())

function toggleAttach(): void {
  useCurrentDoc.value = !useCurrentDoc.value
  try {
    localStorage.setItem(ATTACH_KEY, useCurrentDoc.value ? '1' : '0')
  } catch {
    /* ignore quota / private mode */
  }
}

/** YAML `title:` from the leading frontmatter block, if any (minimal scan). */
function frontmatterTitle(md: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!block) return ''
  const m = /^title:\s*["']?([^"'\n]+)["']?/m.exec(block[1])
  return m ? m[1].trim() : ''
}

function noteTitleFromPath(path: string | null): string {
  if (!path) return ''
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]+$/, '').trim()
}

function activeSelection(): string {
  const view = editorSessionManager.getView()
  if (!view) return ''
  const { state } = view
  const sel = state.selection
  if (!sel || sel.empty) return ''
  try {
    return state.doc.textBetween(sel.from, sel.to, '\n', ' ').trim()
  } catch {
    return ''
  }
}

/** Build the context block for the active tab: title (frontmatter → filename),
 * selection in priority over body. Empty string when nothing is usable. */
async function buildActiveContext(): Promise<string> {
  const tab = tabs.activeTab
  if (!tab) return ''
  // The note is sent to the model as context; flush so it is the live text
  // rather than whatever a pane had published a debounce window ago.
  await flushEdits()
  const title = frontmatterTitle(tab.content) || noteTitleFromPath(tab.path)
  return buildContextBlock({
    noteTitle: title,
    selection: activeSelection(),
    noteContent: tab.content,
  })
}

const messages = ref<ChatMessage[]>([])
const attachments = ref<ChatAttachment[]>([])
const prompt = ref('')
const streaming = ref(false)
const scrollEl = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
let cancelFn: (() => void) | null = null

const modelName = computed(() => settings.model)
const canSend = computed(() => !streaming.value && (prompt.value.trim().length > 0 || attachments.value.length > 0))
const hasMessages = computed(() => messages.value.length > 0)

/** Strip transient `streaming` before persisting; keep images as-is. */
function toSessionMessage(m: ChatMessage): ChatSessionMessage {
  const stored: ChatSessionMessage = { role: m.role, content: m.content }
  if (m.images && m.images.length) stored.images = m.images
  return stored
}

function fromSessionMessage(m: ChatSessionMessage): ChatMessage {
  const msg: ChatMessage = { role: m.role, content: m.content }
  if (m.images && m.images.length) msg.images = m.images
  return msg
}

/** Load the active session's messages (on mount and on session switch). */
function loadActiveSession(): void {
  const session = chatSessions.activeSession
  messages.value = session ? session.messages.map(fromSessionMessage) : []
}

/** Commit the working copy to the active session and persist. */
function syncSession(): void {
  chatSessions.setMessages(messages.value.map(toSessionMessage))
}

function newSession(): void {
  if (streaming.value) stop()
  chatSessions.newSession()
  loadActiveSession()
  clearAttachments()
  prompt.value = ''
  scrollToBottom()
}

function onSessionChange(e: Event): void {
  const id = (e.target as HTMLSelectElement).value || null
  if (id === chatSessions.activeId) return
  if (streaming.value) stop()
  chatSessions.switchSession(id)
  loadActiveSession()
  clearAttachments()
  prompt.value = ''
  scrollToBottom()
}

function deleteActiveSession(): void {
  if (streaming.value) stop()
  chatSessions.deleteSession(chatSessions.activeId ?? '')
  loadActiveSession()
  clearAttachments()
  prompt.value = ''
  scrollToBottom()
}

onMounted(() => {
  loadActiveSession()
})

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function addFiles(files: File[]): void {
  const seen = new Set(attachments.value.map((a) => `${a.name}:${a.file.size}:${a.file.type}`))
  for (const file of files) {
    if (!isImageFile(file)) continue
    const key = `${file.name}:${file.size}:${file.type}`
    if (seen.has(key)) continue
    seen.add(key)
    attachments.value.push({
      id: nextImageId(),
      name: file.name,
      file,
      url: URL.createObjectURL(file),
    })
  }
}

function removeAttachment(id: string): void {
  const index = attachments.value.findIndex((a) => a.id === id)
  if (index < 0) return
  const [removed] = attachments.value.splice(index, 1)
  if (removed) URL.revokeObjectURL(removed.url)
}

function clearAttachments(): void {
  for (const a of attachments.value) URL.revokeObjectURL(a.url)
  attachments.value = []
}

function onPickClick(): void {
  fileInput.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}

function onPaste(e: ClipboardEvent): void {
  const files = collectClipboardImages(e.clipboardData ?? null)
  if (files.length) addFiles(files)
}

function onDrop(e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) {
    addFiles(files)
    e.preventDefault()
  }
}

function onDragOver(e: DragEvent): void {
  if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.type.startsWith('image/'))) {
    e.preventDefault()
  }
}

function onComposerKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.key === 'Process') return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

async function itemDataUrls(list: ChatAttachment[]): Promise<ChatImage[]> {
  const images: ChatImage[] = []
  for (const a of list) {
    images.push({ id: a.id, name: a.name, dataUrl: await fileToDataURL(a.file) })
  }
  return images
}

async function send(): Promise<void> {
  if (streaming.value) return
  const text = prompt.value.trim()
  if (!text && attachments.value.length === 0) return

  const context = useCurrentDoc.value ? await buildActiveContext() : ''
  if (useCurrentDoc.value && !context) {
    notifyError(t('chat.emptyDocHint'))
    return
  }

  const imageDataUrls = await itemDataUrls(attachments.value)
  const userMessage: ChatMessage = { role: 'user', content: text, images: imageDataUrls }
  const history = [...messages.value, userMessage]
  messages.value = [...messages.value, userMessage]
  syncSession()
  prompt.value = ''
  clearAttachments()

  const chatPrompt = buildChatPrompt(history.map((m) => ({ role: m.role, content: m.content })), { context })
  const assistant: ChatMessage = { role: 'assistant', content: '', streaming: true }
  messages.value = [...messages.value, assistant]
  const index = messages.value.length - 1
  streaming.value = true
  cancelFn = null
  scrollToBottom()

  const config = settings.config()
  const imageUrls = imageDataUrls.map((img) => img.dataUrl)
  void startChatCompletion(config, chatPrompt, imageUrls, {
    onChunk: (chunk) => {
      const m = messages.value[index]
      if (m) m.content = chunk
      scrollToBottom()
    },
    onDone: (full) => {
      const m = messages.value[index]
      if (m) m.content = full || m.content
      finalize(index, true)
      scrollToBottom()
    },
    onError: (msg) => {
      finalize(index, false)
      notifyError(t('chat.genFailed', { msg }))
    },
  })
    .then((stream) => {
      if (streaming.value) cancelFn = stream.cancel
    })
    .catch(() => undefined)
}

function finalize(index: number, retainEmpty: boolean): void {
  const m = messages.value[index]
  if (m) {
    if (retainEmpty || m.content) {
      m.streaming = false
    } else {
      messages.value = messages.value.filter((_, i) => i !== index)
    }
  }
  streaming.value = false
  cancelFn = null
  syncSession()
}

function stop(): void {
  const fn = cancelFn
  cancelFn = null
  fn?.()
  aiService.cancelStream()
  finalize(messages.value.length - 1, false)
}

function clearAll(): void {
  cancelFn = null
  aiService.cancelStream()
  streaming.value = false
  messages.value = []
  chatSessions.clearMessages()
  clearAttachments()
  prompt.value = ''
}

async function insertIntoDocument(msg: ChatMessage): Promise<void> {
  // Permission first: an insert the user declines must not touch the editor at
  // all (and must not half-apply before the question is answered).
  const approved = await useAiPermissionStore().ask({
    kind: 'insert',
    summary: t('aiperm.action.insert'),
    target: msg.content.trim().slice(0, 120),
  })
  if (!approved) {
    notifyError(t('aiperm.denied'))
    return
  }
  if (!tabs.activeTab) return
  try {
    // Mode-aware: in source mode the message has to land in the CodeMirror
    // text rather than in the hidden rendered model.
    const inserted = await insertMarkdownAtCursor(`\n\n${msg.content}\n\n`)
    if (inserted === false) notifyError(t('chat.editorNotReady'))
  } catch {
    notifyError(t('chat.insertFailed'))
  }
}

async function copyMessage(msg: ChatMessage): Promise<void> {
  try {
    await navigator.clipboard.writeText(msg.content)
  } catch {
    notifyError(t('chat.copyFailed'))
  }
}

onBeforeUnmount(() => {
  clearAttachments()
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
          :value="chatSessions.activeId ?? undefined"
          :title="t('chat.sessions')"
          :aria-label="t('chat.sessions')"
          @change="onSessionChange"
        >
          <option
            v-for="s in chatSessions.sessions"
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
          :disabled="chatSessions.sessions.length <= 1"
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
              :disabled="!tabs.activeTab"
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
          :class="{ 'is-active': useCurrentDoc }"
          :title="t('chat.attachContextLabel')"
          :aria-label="t('chat.attachContext')"
          :aria-pressed="useCurrentDoc"
          @click="toggleAttach"
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
  animation: chat-caret-blink 1s steps(2, start) infinite;
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
.chat-hint {
  font-variant-numeric: tabular-nums;
}
</style>
