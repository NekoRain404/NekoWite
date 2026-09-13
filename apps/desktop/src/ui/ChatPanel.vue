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
import { startChatCompletion, aiService, usageTotal } from '../services/ai'
import { EFFORT_OPTIONS } from '../stores/settings'
import { notifyError } from '../services/errors'
import { editorSessionManager } from '../features/editor/sessionManager'
import { insertMarkdownAtCursor } from '../services/editorInsert'
import { flushEdits } from '../services/editorOwnership'
import {
  collectClipboardImages,
  formatAttachmentBytes,
  isImageFile,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE_BYTES,
} from '../services/attachments'
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
import { isComposingKey } from '../services/keyGuard'

interface ChatAttachment {
  id: string
  name: string
  file: File
  url: string
}

/** The panel's working copy of a turn: the shared chat type plus the marker for
 * an answer that was cut off mid-stream (see `interruptStream`). The marker is
 * part of the session model, so it round-trips through `toSessionMessage`. */
interface PanelMessage extends ChatMessage {
  interrupted?: boolean
  /** Short status about this message's images (refused by the size cap, or
   *  evicted by a storage budget). Shown under the bubble; without it the
   *  attachment simply disappears between one launch and the next. */
  imageNotice?: string
  /** Token total the provider reported for this answer (see AiTokenUsage).
   *  Shown under the bubble so the cost of a request is visible without a
   *  trip to the provider dashboard - and so an unexpectedly large one is
   *  noticed while it is still relevant. Omitted when the provider reported
   *  nothing, rather than shown as zero. */
  usageTotal?: number
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
    // The user's budget, not a hardcoded one: on a long note the difference
    // between 2000 and 6000 characters is the difference between the model
    // seeing the note's title page and seeing the section being worked on.
    maxChars: settings.contextChars,
  })
}

const messages = ref<PanelMessage[]>([])
const attachments = ref<ChatAttachment[]>([])
const prompt = ref('')
const streaming = ref(false)
const scrollEl = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
let cancelFn: (() => void) | null = null
/** Set on unmount: a `send()` still encoding context/images must not start a
 * request the destroyed panel could never show, cancel or persist. */
let disposed = false

const modelName = computed(() => settings.model)

/** The store reports a write that could not store everything (see
 *  `chatSession.storageWarning`). Without this banner the user only finds out
 *  after a restart, when the images - or the whole conversation - are gone. */
const storageWarningText = computed(() => {
  const warning = chatSessions.storageWarning
  if (warning === 'images-not-persisted') return t('chat.storageImagesDropped')
  if (warning === 'history-not-persisted') return t('chat.storageFull')
  return ''
})
const canSend = computed(() => !streaming.value && (prompt.value.trim().length > 0 || attachments.value.length > 0))
const hasMessages = computed(() => messages.value.length > 0)

/** Strip transient `streaming` before persisting; keep images and the
 * interrupted marker as-is. */
function toSessionMessage(m: PanelMessage): ChatSessionMessage {
  const stored: ChatSessionMessage = { role: m.role, content: m.content }
  if (m.images && m.images.length) stored.images = m.images
  if (m.imageNotice) stored.imageNotice = m.imageNotice
  if (m.usageTotal) stored.usageTotal = m.usageTotal
  if (m.interrupted) stored.interrupted = true
  return stored
}

function fromSessionMessage(m: ChatSessionMessage): PanelMessage {
  const msg: PanelMessage = { role: m.role, content: m.content }
  if (m.images && m.images.length) msg.images = m.images
  // The store explains here why an image is missing ("too large", "removed,
  // storage limit"). Dropping the notice - which this did - turned a refused
  // attachment into a message that quietly sent without it.
  if (m.imageNotice) msg.imageNotice = m.imageNotice
  if (m.usageTotal) msg.usageTotal = m.usageTotal
  if (m.interrupted) msg.interrupted = true
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

/**
 * Composer state per session: the half-written question and its attachments.
 *
 * Switching to another session to check something and coming back used to find
 * the composer empty - the text you were mid-way through was simply gone, and
 * with it the images you had attached. A draft belongs to the conversation it
 * was written for, so it is parked under that session and restored with it.
 */
const drafts = new Map<string, { prompt: string; attachments: ChatAttachment[] }>()

function stashDraft(): void {
  const id = chatSessions.activeId
  if (!id) return
  if (!prompt.value && attachments.value.length === 0) {
    drafts.delete(id)
    return
  }
  drafts.set(id, { prompt: prompt.value, attachments: [...attachments.value] })
}

/** Drop a stashed draft and release the object URLs it holds. */
function discardDraft(id: string): void {
  const draft = drafts.get(id)
  if (!draft) return
  for (const a of draft.attachments) URL.revokeObjectURL(a.url)
  drafts.delete(id)
}

function restoreDraft(): void {
  const id = chatSessions.activeId
  const draft = id ? drafts.get(id) : undefined
  prompt.value = draft?.prompt ?? ''
  attachments.value = draft ? [...draft.attachments] : []
}

function switchToSession(id: string | null): void {
  if (streaming.value) stop()
  stashDraft()
  if (id === null) chatSessions.newSession()
  else chatSessions.switchSession(id)
  loadActiveSession()
  restoreDraft()
  scrollToBottom()
}

function newSession(): void {
  switchToSession(null)
}

function onSessionChange(e: Event): void {
  const id = (e.target as HTMLSelectElement).value || null
  if (id === chatSessions.activeId) return
  switchToSession(id)
}

function deleteActiveSession(): void {
  const removed = chatSessions.activeId
  if (streaming.value) stop()
  // The draft goes with the conversation it belonged to: keeping it would
  // attach a question to whatever session happens to be next.
  if (removed) discardDraft(removed)
  chatSessions.deleteSession(removed ?? '')
  loadActiveSession()
  restoreDraft()
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
  // The running total for this message, not for this call: the size budget has
  // to hold across separate picks, which is how the count cap gets evaded.
  let totalBytes = attachments.value.reduce((sum, a) => sum + a.file.size, 0)
  for (const file of files) {
    if (!isImageFile(file)) continue
    if (attachments.value.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      // Every attachment is base64-encoded into one request: past this cap the
      // send would spike memory on both processes and be refused by the model.
      notifyError(t('chat.tooManyImages', { max: MAX_ATTACHMENTS_PER_MESSAGE }))
      break
    }
    // Refuse an oversize image HERE, while the user can still act on it: the
    // send path (`fileToBase64`) enforces the same cap, and a rejection from
    // inside `send()` used to vanish — the draft and the thumbnail stayed,
    // nothing was sent, and no error explained why.
    if (file.size > MAX_ATTACHMENT_BYTES) {
      notifyError(t('chat.imageTooLarge', { max: formatAttachmentBytes(MAX_ATTACHMENT_BYTES) }))
      continue
    }
    // Refused per image, like the two caps above: the images that already fit
    // stay put and only this one is left out, so the user can drop one file
    // instead of starting the message over.
    if (totalBytes + file.size > MAX_ATTACHMENTS_PER_MESSAGE_BYTES) {
      notifyError(
        t('chat.attachmentsTotalTooLarge', {
          max: formatAttachmentBytes(MAX_ATTACHMENTS_PER_MESSAGE_BYTES),
        }),
      )
      continue
    }
    const key = `${file.name}:${file.size}:${file.type}`
    if (seen.has(key)) continue
    seen.add(key)
    totalBytes += file.size
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
  // Enter accepts the IME candidate; sending the message there would fire a
  // request with the half-composed text.
  if (isComposingKey(e)) return
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

  let context = ''
  let imageDataUrls: ChatImage[]
  try {
    if (useCurrentDoc.value) {
      const tab = tabs.activeTab
      if (!tab) {
        // No document at all: naming that is right, because the switch is on.
        notifyError(t('chat.emptyDocHint'))
        return
      }
      context = await buildActiveContext()
      // An EMPTY note is not a missing document. Refusing to send here blocked
      // exactly the scenario the feature is for — "help me outline this" on a
      // note you just created — with a message claiming no document was open
      // while one plainly was. The message goes out without context, and the
      // user is told why it carries nothing.
      if (!context) notifyError(t('chat.emptyDocSent'))
    }
    imageDataUrls = await itemDataUrls(attachments.value)
  } catch {
    // Every caller is `void send()`, so a rejection here is an unhandled one:
    // the button would look alive while nothing happened at all. State is
    // untouched on this path, so the user can drop the image and retry.
    notifyError(t('chat.sendFailed'))
    return
  }

  // The rail can close while the context/images above were still encoding;
  // starting now would leave a request running with no panel left to show or
  // cancel it (onBeforeUnmount has already made its own pass).
  if (disposed) return

  const userMessage: ChatMessage = { role: 'user', content: text, images: imageDataUrls }
  const history = [...messages.value, userMessage]
  messages.value = [...messages.value, userMessage]
  syncSession()
  prompt.value = ''
  clearAttachments()
  const sentFrom = chatSessions.activeId
  if (sentFrom) drafts.delete(sentFrom)

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
    onDone: (full, usage) => {
      const m = messages.value[index]
      if (m) {
        const total = usageTotal(usage)
        if (total !== null) m.usageTotal = total
      }
      if (m) m.content = full || m.content
      finalize(index, true)
      scrollToBottom()
    },
    onError: (msg) => {
      // An answer that already streamed text before the connection died is a
      // PARTIAL answer, and must say so: presenting half a paragraph as the
      // finished reply is how a user quotes a sentence the model never
      // completed. (The panel-close path already marks this; the failure path
      // did not.)
      const partial = (messages.value[index]?.content ?? '').length > 0
      finalize(index, partial, partial)
      notifyError(t('chat.genFailed', { msg }))
    },
  })
    .then((stream) => {
      if (streaming.value) cancelFn = stream.cancel
    })
    .catch(() => undefined)
}

function finalize(index: number, retainEmpty: boolean, interrupted = false): void {
  const m = messages.value[index]
  if (m) {
    if (retainEmpty || m.content) {
      m.streaming = false
      if (interrupted) m.interrupted = true
    } else {
      messages.value = messages.value.filter((_, i) => i !== index)
    }
  }
  streaming.value = false
  cancelFn = null
  syncSession()
}

/** Cancel through both levels: this panel's own stream handle AND the app-level
 * registry. The handle is null until the start promise settles, so the registry
 * is what covers the "cancelled before it was cancellable" window. */
function cancelCompletion(): void {
  const fn = cancelFn
  cancelFn = null
  fn?.()
  aiService.cancelStream()
}

function stop(): void {
  cancelCompletion()
  finalize(messages.value.length - 1, false)
}

/** Unmount path. Closing the info rail destroys this panel, but the request is
 * owned by the app-level AI service and would keep streaming — and keep being
 * billed — into a component nobody can see. Cancel it and persist the turns
 * received so far, flagging the answer so a reopened panel shows it as cut off
 * instead of leaving the user's question looking unanswered. */
/** Release the object URLs of every parked draft. Called on unmount: the
 *  drafts live only as long as this panel, so nothing must survive it. */
function releaseDrafts(): void {
  for (const id of [...drafts.keys()]) discardDraft(id)
}

function interruptStream(): void {
  if (!streaming.value) return
  cancelCompletion()
  // Retain an empty placeholder too: a bubble that says "interrupted" is more
  // honest than a question whose reply simply vanished.
  finalize(messages.value.length - 1, true, true)
}

function clearAll(): void {
  cancelCompletion()
  streaming.value = false
  messages.value = []
  chatSessions.clearMessages()
  clearAttachments()
  prompt.value = ''
  const id = chatSessions.activeId
  if (id) drafts.delete(id)
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
  // A stream can still be running when the rail closes (`v-if` in AppShell
  // unmounts this panel): stop it and persist the partial answer before the
  // working copy dies with the component.
  disposed = true
  interruptStream()
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
        <label class="chat-effort">
          <span class="chat-effort-label">{{ t('aiSettings.effort') }}</span>
          <select
            :value="settings.reasoningEffort"
            :title="t('aiSettings.effortHint')"
            @change="settings.reasoningEffort = ($event.target as HTMLSelectElement).value as typeof settings.reasoningEffort"
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
