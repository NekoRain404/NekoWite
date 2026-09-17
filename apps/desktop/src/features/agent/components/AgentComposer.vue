<script lang="ts">
/**
 * The composer's copy, handed in rather than reached for — see {@link AgentToolLabels} for
 * why, and for what happens when the catalogue grows keys.
 */
export interface AgentComposerLabels {
  /** The field's placeholder. */
  placeholder: string
  /** The send button's accessible name: it is a paper plane and nothing else (§5.3). */
  send: string
  /** The stop button's, likewise a square. */
  stop: string
  /** The sentence at the left of the button's own row: what Enter does, and that a run in
   *  flight keeps the text. It shares one row with the button rather than taking a line of its
   *  own, so what sits between the field and the reader's hand is a single strip. */
  hint: string
  /** The same line while a run is in flight, when Enter cannot send. */
  hintBusy: string
}
</script>

<script setup lang="ts">
/**
 * The input area: the reader's words, and the one button that acts on them.
 *
 * Props in, events out — the text arrives as a model and a send leaves as an event; nothing
 * here knows what a session is, and nothing here talks to the store (§10.2).
 *
 * **Enter does not send during an IME composition.** That is §10.2's acceptance, and it is
 * the one place in this feature where a keystroke must be read as the input method's rather
 * than the reader's: a candidate is committed with Enter, and a composer that sent on it
 * would submit half a word and, on a Chinese or Japanese layout, send on every candidate
 * change. Three signals decide it, because the engines disagree about which one they set —
 * the composition events this element saw, `KeyboardEvent.isComposing`, and the legacy 229
 * key code a browser sends for a key it handed to the input method. All three are checked:
 * the composition events are the ones that are always there, and the other two cover the
 * deliveries that arrive outside a composition as far as this element is concerned.
 *
 * **A second send while a run is in flight does nothing at all.** Not a queue, not a
 * reminder: §6.2 allows one active generation per session, and the text stays in the field
 * for the reader to send when the run ends. The text is not cleared on a refusal, which is
 * §5.1's rule about drafts surviving errors, applied to the one refusal that happens
 * without an error.
 *
 * The field grows with its content to about a third of the panel and then scrolls
 * (§5.3 「输入区初始约 96–120px，随内容增长到面板高度的约 35% 后内部滚动」). The bound is
 * measured from the nearest positioned ancestor — the panel, which is what it must not
 * outgrow — and not from the window, because the panel is not always the window.
 *
 * **The message can carry more than its words, and this is the layer that decides what travels.**
 * A turn is built from a text block plus one block per attachment (`agent_runtime/attachments.rs`
 * on the host side), and everything that puts something in is here: a paste of an image, a drag
 * over the field, and a file picked in the `+`'s own list. What may go out is the engine's own
 * report and nothing else — `promptCapabilities` decides, the host reads it again at send time, and
 * a block it does not licence is refused with the engine's own sentence rather than dropped. The
 * rules that do not need an element — what a file becomes, what fits, what is refused — live in
 * `services/agent-composer-attachments.ts` and `composables/use-agent-composer-attachments.ts`.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Send, Square } from 'lucide-vue-next'
import type {
  AgentCapabilityReport,
  AgentPromptAttachment,
} from '../../../platform/gateways/agent-contracts'
import { t } from '../../../i18n'
import { useAgentComposerAttachments } from '../composables/use-agent-composer-attachments'
import {
  textWithoutMention,
  useAgentComposerMentions,
} from '../composables/use-agent-composer-mentions'
import type { AgentConfigControl } from '../services/agent-config-options'
import { draggedReference, insertReferenceText } from '../services/agent-context-references'
import { carriesDraggedPath, draggedPath } from '../../../services/drag-payload'
import AgentComposerAttachments from './AgentComposerAttachments.vue'
import AgentComposerContext, { type AgentComposerSelection } from './AgentComposerContext.vue'
import AgentConfigRow from './AgentConfigRow.vue'
import AgentReferenceMenu, { type AgentReferenceRow } from './AgentReferenceMenu.vue'
import { FileText } from 'lucide-vue-next'

const props = defineProps<{
  /** A run is in flight: the button is a stop, and Enter will not send. */
  running: boolean
  /** Whether a send would be accepted — the store's answer, not this component's guess. */
  canSend: boolean
  /**
   * What a key means to whoever is listening above the field.
   *
   * The `/` menu's keys are taken before this component's own — an arrow moves its highlight
   * and an Enter settles on a row instead of sending — and the decision has to be made
   * *during* the keydown, before anything is emitted, which is why it arrives as a function
   * rather than as an event. `commands.onKeydown` is what the panel passes; the three answers
   * are T8's: `pass` is this component's, `handled` is the menu's, and `composing` says an
   * input method has the key — the same conclusion reached below, reported by the layer that
   * saw the composition events first.
   */
  resolveKey?: (event: KeyboardEvent) => 'pass' | 'composing' | 'handled'
  /**
   * The session's own configuration options, in the order the engine reported them — the
   * right-hand group of the bar below the field.
   *
   * Empty means this session reported none, and then the group is not drawn at all: what the
   * row holds is the engine's report rather than a list this app decided on, and a session
   * with no options has no controls to offer (`AgentConfigRow.vue`, Zed's
   * `ConfigOptionsView`).
   */
  config?: readonly AgentConfigControl[]
  /** Which of them is being set right now, by key, or null — one call at a time, and the
   *  control that is mid-call takes no second press. */
  configBusy?: string | null
  /** The last set that did not take: which control, and the reason as it arrived. The control
   *  keeps showing the engine's value either way, because a set that did not happen leaves it
   *  in force. */
  configFailure?: { key: string; message: string } | null
  /**
   * The workspace this message is addressed in — the session's own vault, handed down by the panel
   * that holds the session — or nothing when there is no folder to read.
   *
   * It is what a picked file, a dropped document, a `@` mention and the `+`'s listing are all
   * resolved against, so one value serves all four. It arrives rather than being read from the
   * store for the reason `AgentComposerContext.vue` gives for its own copy: the store's record is
   * the *focused* session, and the focus can be moved to a session whose panel is not on screen
   * (`app/pet-task-link.ts`), which would silently re-point every one of the four at a workspace
   * the turn is not being sent to.
   */
  vault?: string | null
  /**
   * The editor's live selection, for the `+`'s Selection row — see `AgentComposerContext.vue`,
   * which owns the row and what a pick puts in the message.
   *
   * Forwarded rather than read here because the row is not this component's, and left optional so
   * that the default (the app's own read) applies when nobody supplies one.
   */
  selection?: () => AgentComposerSelection | null
  /**
   * The engine's own report for this session, or null while it has not arrived.
   *
   * It reaches this component for one reason: whether a chosen file becomes an attachment the
   * engine reads or a path in the message is the engine's answer and nobody else's, and this is
   * the layer that owns both the file row and the send. Null is a state of its own — nothing has
   * answered yet — and it draws no attach affordance at all rather than a disabled one, because a
   * control nothing can licence is not a control the reader can act on.
   */
  capabilities?: readonly AgentCapabilityReport[] | null
  labels: AgentComposerLabels
}>()

/** The half-written message. It is the session's, not this component's: the panel binds it
 *  to the store, so looking away and back does not lose it (§5.1). */
const draft = defineModel<string>({ default: '' })

const emit = defineEmits<{
  /**
   * The reader sent this text, and what the message was carrying beside it.
   *
   * The attachments travel with the send rather than through a second channel, because they are
   * part of the same act: a turn that carried the words and lost the files would be a prompt
   * nobody chose, and there is no moment between the two for a state to disagree.
   */
  send: [text: string, attachments: readonly AgentPromptAttachment[]]
  /** Stop the run in flight. */
  stop: []
  /** A composition opened or closed. The menu's filter is held still across one (T8), so the
   *  layer that owns it has to know — and the events are this element's to report. */
  composition: [phase: 'start' | 'end']
  /** The reader chose a value for one of the session's own options, named by its key. What
   *  that call means — and whether this build can make it at all — is the panel's business,
   *  not this component's. */
  setConfig: [key: string, value: string | boolean]
}>()

const field = ref<HTMLTextAreaElement | null>(null)
/** Set by the composition events this element saw, and the authority on whether Enter is the
 *  reader's or the input method's. */
const composing = ref(false)

/**
 * How long after a composition ends an Enter is still read as the input method's.
 *
 * WebKit — the engine this application ships on, WebKitGTK 4.1 — delivers the Enter that
 * *committed* a candidate after `compositionend`, by which time both `isComposing` and this
 * element's own flag say the composition is over. Trusting the flags alone would send half a
 * word on the product's own engine. A reader cannot commit a candidate and mean "send" inside
 * this window: committing is itself an Enter, so the send would have to be a second keystroke
 * inside 60ms.
 */
const COMMIT_GRACE = 60
let composedAt = Number.NEGATIVE_INFINITY

/**
 * What the message is carrying, and the three intakes that put something there.
 *
 * The vault is a prop — the panel's own session's, see {@link vault} — and every reader below
 * resolves against it: `attachments` reads it when a file is picked or pasted, `onDrop` reads it for
 * a dragged path, the `+`'s listing reads it, and the `@` menu reads it.
 */
/** The workspace a picked or dropped file is addressed in, or `null` before a session is on
 *  screen.
 *
 *  Read through a function because that is the shape all three consumers ask for — a composable
 *  option and an event handler each take a reader rather than a value, so a composer re-pointed at
 *  another session with the same instance cannot answer one of them with an older vault than
 *  another. Named for the session it belongs to rather than `vault`, which is the prop itself. */
function sessionVault(): string | null {
  return props.vault ?? null
}

const attachments = useAgentComposerAttachments({
  capabilities: () => props.capabilities ?? null,
  vault: sessionVault,
})

/**
 * The `@` menu: typing a note's name into the message.
 *
 * The rows are the workspace's own notes (`services/vault-files.ts`'s index, which is what the
 * file tree lists), and settling on one puts the file into the turn rather than its name into the
 * text — the same two outcomes `pickFile` chooses between, for the same reason. The typed word is
 * taken out of the message when it settles, because the file is now a chip and the half-written
 * name is no longer what the reader meant to say.
 */
/**
 * The file a mention settled on: the half-typed word comes out of the message, and the file goes
 * into the turn.
 *
 * One function for both ways in — the row the reader clicked and the Enter the menu took — because
 * the two have to do exactly the same thing, and the second of them is reached from inside the
 * composable that was built with this very function as its `select`.
 */
function pickMention(path: string): void {
  draft.value = textWithoutMention(draft.value)
  pickFile(path)
}

const mentions = useAgentComposerMentions({
  vault: sessionVault,
  text: () => draft.value,
  select: pickMention,
})

/** The rows the `@` menu draws. Ids are the paths themselves, so the row the reader took and the
 *  file that is attached cannot drift apart. */
const mentionRows = computed((): AgentReferenceRow[] =>
  mentions.matches.value.map((path) => ({ id: path, label: path, icon: FileText })),
)

/** A sentence for each way the `@` menu can have nothing to show. `closed` and `rows` draw the
 *  list itself, so they are not here. */
const mentionNotice = computed((): string | null => {
  switch (mentions.view.value) {
    case 'reading':
      return t('agent.panel.composer.attach.mention.reading')
    case 'empty':
      return t('agent.panel.composer.attach.mention.empty')
    case 'no-match':
      return t('agent.panel.composer.attach.mention.noMatch')
    case 'unreadable':
      return t('agent.panel.composer.attach.mention.unreadable')
    default:
      return null
  }
})

const blank = computed(() => draft.value.trim() === '')

/**
 * The message a send was just attempted with, or null when no send is outstanding.
 *
 * It exists for one decision: whether an emptied draft means the store *accepted* the turn or the
 * reader cleared the field. `send` empties the draft only on acceptance (`agent-session.ts`), so an
 * emptied draft with a send outstanding is the store's own word for "it went", while any keystroke
 * of the reader's own clears this and takes a manual clearing with it.
 */
const pendingSend = ref<string | null>(null)

function focus(): void {
  field.value?.focus()
}

/**
 * A file the reader picked in the `+`'s list, and what becomes of it.
 *
 * Two outcomes and the engine's own report decides between them, which is Zed's reading too: it
 * builds a mention's block at *send* time from the capability it has in hand
 * (`zed-main/crates/agent_ui/src/message_editor.rs:2138-2180` `mention_to_content_block`, whose
 * `supports_embedded_context` branch produces `Resource` and whose other branch produces
 * `ResourceLink`). The difference from Zed is what the second branch does: Zed sends a link the
 * engine may or may not follow, and this app has not measured that the pinned engine follows one —
 * so the file's *path* goes into the message as text instead, which is what pressing the same row
 * has always done and is the one shape whose effect is known. Nothing is claimed about the model
 * having been shown the file, and the chip says which of the two happened.
 *
 * **Which of the two it is, is not decided here.** It cannot be: an image and a note are licensed
 * by two different features of the report, so the answer depends on the *file*, and this component
 * holds a path. `attachFile` makes the call and answers with which one it took; all that is left
 * for this component is the half only it can do — putting the path into the field it owns.
 */
function pickFile(path: string): void {
  void attachments.attachFile(path).then((outcome) => {
    if (outcome === 'path-in-message') insertReference(path)
  })
}

/**
 * A paste. Images become attachments; anything else is left to the field.
 *
 * The event is only taken when the clipboard actually carried an image: a paste of text must reach
 * the textarea unchanged, and preventing the default on every paste would be this component
 * swallowing the reader's copy of a sentence to look for a screenshot in it.
 */
function onPaste(event: ClipboardEvent): void {
  const clipboard = event.clipboardData
  const carriesImage = Array.from(clipboard?.items ?? []).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/'),
  )
  if (!carriesImage) return
  event.preventDefault()
  void attachments.addFromTransfer(clipboard)
}

/** A drag over the field. Only claimed when the drag carries files or a document of this app's
 *  own, and refused by default otherwise so the field keeps its ordinary text-drop behaviour. */
function onDragOver(event: DragEvent): void {
  const data = event.dataTransfer
  if (!carriesFiles(data) && !carriesDraggedPath(data)) return
  event.preventDefault()
  if (data !== null) data.dropEffect = offeredEffect(data)
}

function onDrop(event: DragEvent): void {
  // The whole reason a document drag is not a file drag: the bytes were never in the transfer.
  // What arrives is a path this window dragged, and it goes exactly where the `+`'s file row goes —
  // through `attachFile`, the one place that decides between an image, a resource block and a path
  // in the message by asking the engine's own report. See {@link pickFile}.
  //
  // The conversion is `draggedReference`'s and not this component's: a reference is vault-relative
  // because that is the only spelling the engine can resolve, and the same rule produces the `+`'s
  // rows. A path that cannot become one — from outside the vault, or with no vault open yet —
  // leaves the drag unclaimed rather than inserting a path that names nothing the turn can read.
  const dropped = draggedReference(draggedPath(event.dataTransfer), sessionVault())
  if (dropped !== null) {
    event.preventDefault()
    pickFile(dropped)
    return
  }
  if (!carriesFiles(event.dataTransfer)) return
  event.preventDefault()
  void attachments.addFromTransfer(event.dataTransfer)
}

function carriesFiles(data: DataTransfer | null): boolean {
  if (data === null) return false
  return Array.from(data.types).includes('Files')
}

/**
 * Which effect to ask for, out of the ones the source is offering.
 *
 * The two producers of a document drag do not offer the same thing: the tab strip offers a copy
 * (the document stays where it was) and the vault tree offers a move (its drag re-parents a node).
 * A target may only accept an effect the source offers — asking for a copy of a move-only drag
 * makes the browser cancel the drop before this handler ever runs — so the field asks for the copy
 * when it may and settles for the move when it may not. Either way the message is the same: the
 * *effect* is a promise about the source, not about what this component does with the path.
 */
function offeredEffect(data: DataTransfer): 'copy' | 'move' {
  const allowed = data.effectAllowed
  const copies = allowed === 'copy' || allowed === 'copyMove' || allowed === 'copyLink' || allowed === 'all'
  // `uninitialized` is the value a source that never set one leaves behind, and every effect is
  // available there; `link` alone is the one case with no copy and no move to ask for, and the
  // field asks for neither rather than inventing a third.
  if (copies || allowed === 'uninitialized') return 'copy'
  return 'move'
}

/** How tall the field may grow: about a third of the panel (§5.3).
 *
 *  Measured from the panel's own marker rather than from `offsetParent`: the panel is what the
 *  field must not outgrow, and between the two of them now sits the menu's positioning box —
 *  an ancestor, but not the bound. */
function limit(el: HTMLTextAreaElement): number {
  const panel = el.closest('[data-agent-panel]') as HTMLElement | null
  return Math.round((panel?.clientHeight ?? 480) * 0.35)
}

/** Grow to fit the text, then let the panel's share cap it. Runs after the DOM has the new
 *  value, because `scrollHeight` is measured from it. */
function grow(): void {
  const el = field.value
  if (el === null) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, limit(el))}px`
}

function submit(): void {
  // The ends are trimmed and nothing else is touched: a trailing newline from Shift+Enter is
  // not part of what the reader meant to say, and anything more would be this layer editing
  // their prompt.
  const text = draft.value.trim()
  // A message with words but nothing attached is the ordinary case; a message with attachments and
  // no words is not — the attachments have nothing to refer to, and the host's prompt would carry
  // an empty text block. So the field's own rule stands unchanged and the attachments ride along.
  if (text === '' || !props.canSend) return
  // One value, read once: what travels and what the strip is cleared against cannot be two
  // different readings of it.
  const carried = attachments.held.value
  // Sent, not cleared. Whether the turn was *accepted* is the store's answer, and this component
  // is not told it: `AgentPanel.onSend` has the outcome and this is not where it lands
  // (`agent-session.ts` refuses a second turn on a session with `run-in-flight` and puts the text
  // straight back). So the strip is cleared on the store's own signal — the draft going empty,
  // which `send` does only once the turn is accepted — and never on the mere press of Enter. A
  // refusal therefore leaves the chips exactly where they were, beside the text that came back.
  pendingSend.value = text
  emit('send', text, carried)
  void nextTick(focus)
}

function onKeydown(event: KeyboardEvent): void {
  // The menus are asked first, and the `@` list before the engine's: a word starting `@` cannot be
  // a `/command` (that one has to start the message), so the two never both have a claim, and the
  // order only decides which one answers when neither does. Both say "mine" by having already
  // called `preventDefault`, and both tell the IME apart from a key of their own.
  const mentioned = mentions.onKeydown(event)
  if (mentioned !== 'pass') return
  const verdict = props.resolveKey?.(event) ?? 'pass'
  if (verdict !== 'pass') return
  if (event.key !== 'Enter') return
  // Enter during a composition is the input method committing a candidate. See the header.
  if (composing.value || event.isComposing || event.keyCode === 229) return
  // …and so is the Enter a WebKit delivers just after one ended. See COMMIT_GRACE.
  if (performance.now() - composedAt < COMMIT_GRACE) return
  // Shift+Enter is a newline, which is the field's own behaviour — nothing to do.
  if (event.shiftKey) return
  event.preventDefault()
  submit()
}

/**
 * Put a reference the reader picked into the message, at the caret.
 *
 * The caret is where the reader was typing, so the text lands there; a field that has never been
 * focused has no selection to read and the reference is appended. What the message becomes is
 * `insertReferenceText`'s decision rather than this component's — the spaces, the clamp and the
 * new caret live with the rest of the reference rules — and what is left here is the two things
 * only the element can do: read the caret off the textarea, and put focus and the caret back.
 *
 * Focus goes to the field, and it goes there in a `nextTick`: the list that produced the reference
 * is being torn down in this same turn, and a field that asked for focus before that patch would
 * be handing it straight back to a dying menu. Choosing a row is the one way out of that list that
 * ends here rather than on the control (`AgentComposerContext` returns focus to the control when
 * the reader *dismisses* it), because the reader's next act is a word, not another file.
 */
function insertReference(reference: string): void {
  const el = field.value
  const placed = insertReferenceText(draft.value, el?.selectionStart ?? draft.value.length, reference)
  draft.value = placed.text
  void nextTick(() => {
    const target = field.value
    if (target === null) return
    target.focus()
    target.setSelectionRange(placed.caret, placed.caret)
  })
}

function onCompositionStart(): void {
  composing.value = true
  emit('composition', 'start')
}

function onCompositionEnd(): void {
  composing.value = false
  composedAt = performance.now()
  emit('composition', 'end')
}

watch(draft, (value) => {
  // The store took the turn: the words are in the timeline and the files went with them. The
  // attachments are cleared here rather than at the press because this is the first moment
  // anything has said the send was accepted.
  if (value === '' && pendingSend.value !== null) {
    pendingSend.value = null
    attachments.clear()
  }
  void nextTick(grow)
})

/** A keystroke of the reader's own: whatever send was outstanding is no longer what this draft is
 *  about, so an empty field from here on is theirs rather than the store's. */
function onInput(): void {
  if (pendingSend.value !== null && draft.value !== pendingSend.value) pendingSend.value = null
}

defineExpose({ focus })
</script>

<template>
  <form
    class="agent-composer"
    @submit.prevent="submit"
  >
    <!-- What the turn is carrying, above the words it carries them with. Drawn only when there is
         something in it: an empty frame with a heading would be a surface telling a reader about a
         state they are not in. -->
    <AgentComposerAttachments
      v-if="attachments.hasAny.value"
      :attachments="attachments.held.value"
      @remove="attachments.remove"
    />
    <!-- The `@` list, over the field it is being typed into. Its own positioning box, because
         `AgentReferenceMenu` places itself against the element that owns it and this is not the
         `+`'s control: it belongs to the field, and it opens upward from the field's top edge. -->
    <div class="agent-composer-mentions">
      <Transition name="v">
        <AgentReferenceMenu
          v-if="mentions.view.value !== 'closed'"
          :rows="mentionRows"
          :label="t('agent.panel.composer.attach.mention.list')"
          @select="pickMention"
          @close="mentions.close"
          @leave="mentions.close"
        />
      </Transition>
      <!-- A list with nothing in it says which nothing it is: still being read, a workspace with
           no notes, a word that matches none, or an index that could not be walked. Drawn in the
           field's own box rather than as an empty menu, because an empty frame is the failure
           this sentence exists to avoid. -->
      <p
        v-if="mentionRows.length === 0 && mentionNotice !== null"
        class="agent-composer-mention-notice"
        role="status"
      >
        {{ mentionNotice }}
      </p>
    </div>
    <textarea
      ref="field"
      v-model="draft"
      class="agent-composer-field"
      :placeholder="labels.placeholder"
      :aria-label="labels.placeholder"
      :title="t('agent.panel.composer.attach.mention.hint')"
      rows="2"
      spellcheck="false"
      @keydown="onKeydown"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
      @input="onInput"
      @paste="onPaste"
      @dragover="onDragOver"
      @drop="onDrop"
    />
    <div class="agent-composer-bar">
      <!-- The left-hand end of the row: the files of the folder the agent works in, brought into
           the message (Zed's `+` at the head of its composer's bottom row). The bar's own
           structure is untouched — this is one more child, and the hint, the button and whatever
           the right-hand end adds keep their places in it. The control carries the auto margin
           that keeps the hint beside it instead of letting `space-between` float the hint into
           the middle of the row. -->
      <AgentComposerContext
        :vault="vault"
        :selection="selection"
        @insert="insertReference"
        @pick="pickFile"
      />
      <p class="agent-composer-hint">
        <span>{{ running ? labels.hintBusy : labels.hint }}</span>
      </p>
      <!-- The right-hand end of the row: the session's own configuration options, then the one
           button that acts on the words above. That order is Zed's (`agent_ui`'s thread view:
           the config options, then the send button — `conversation_view/thread_view.rs:4458-4476`),
           and the group draws itself away entirely when the session reported no options, so an
           engine with none gets exactly the row that was here before. -->
      <AgentConfigRow
        :controls="config ?? []"
        :busy="configBusy ?? null"
        :failure="configFailure ?? null"
        @set="(key, value) => emit('setConfig', key, value)"
      />
      <!-- A paper plane to send, a square to stop (§5.3), and never both at once: a run in
           flight is the one state in which the reader's next action is not a send. -->
      <button
        v-if="running"
        class="agent-composer-action"
        type="button"
        :title="labels.stop"
        :aria-label="labels.stop"
        data-action="stop"
        @click="emit('stop')"
      >
        <Square
          :size="12"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>
      <button
        v-else
        class="agent-composer-action"
        type="submit"
        :title="labels.send"
        :aria-label="labels.send"
        :disabled="blank || !canSend"
        data-action="send"
      >
        <Send
          :size="14"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>
    </div>
  </form>
</template>

<style scoped>
.agent-composer {
  flex: none;
  padding: 8px;
  border-top: 1px solid var(--app-border);
  background: var(--app-panel);
}
.agent-composer-field {
  display: block;
  width: 100%;
  /* The initial rung of §5.3's 96–120px, with the bar below it making up the rest. */
  min-height: 64px;
  padding: 6px 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 14px;
  line-height: 1.55;
  resize: none;
  overflow-y: auto;
}
.agent-composer-field:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
.agent-composer-field::placeholder {
  color: var(--app-muted);
}
/* The `@` list's positioning box: the anchor `AgentReferenceMenu` places itself against, and the
   place the "nothing to show" sentences are drawn that is not the menu box. `position: relative`
   and no size of its own — it must not take a line of the composer's height when it is empty. */
.agent-composer-mentions {
  position: relative;
}
/* The sentence a state with no rows is said with. It sits below the field's top edge, over the
   field rather than pushing it, so the composer does not change height as the reader types. */
.agent-composer-mention-notice {
  position: absolute;
  top: 4px;
  left: 0;
  z-index: 300;
  margin: 0;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  color: var(--app-muted);
  font-size: 12px;
}
.agent-composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  margin-top: 4px;
}
.agent-composer-hint {
  margin: 0;
  /* What is left of the bar after everything else has taken its size — and the first thing to
     give it back. The zero basis is the mechanism, not a shortcut: a flex item with a content
     basis takes a share of a shortfall in proportion to how much it holds, and this one must
     take none of it. Sharing it would take the control row below its own width — and the row's
     controls are chips that do not shrink, so they would wrap onto a second line at the panel's
     DEFAULT width, where they fit today with room to spare. With the basis at zero the row keeps
     every pixel it asks for until the panel is narrower than the row and the two fixed buttons;
     below that the sentence is already gone and the row is what gives way
     (`AgentConfigRow.vue`).

     The box may therefore be wider than the sentence — that is what taking the free space means
     — so the sentence is pinned to its END (`justify-content`, over the span below) and stays
     where it has always been drawn: against the control row it describes, not floating at the
     left end of a box that grew. Capping the box is the obvious alternative and it is not one
     this engine offers: `max-width: max-content` is resolved against the free space rather than
     against the text (measured in the width sweep below: the box took all 346.36px of it at a
     639px rail while the sentence is 317.53px wide), so the pinning has to be on the sentence
     itself. */
  display: flex;
  justify-content: flex-end;
  flex: 1 1 0;
  min-width: 0;
  color: var(--app-muted);
  font-size: 11px;
}
/* The sentence itself. A flex item may be given less than its text, and this is where that
   shows: `min-width: 0` lets it be squeezed, and the ellipsis is drawn on the element that is
   actually clipping. */
.agent-composer-hint > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-composer-action {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  /* §5.3's minimum hit area, for a control whose visible mark is 14px. */
  width: 28px;
  height: 28px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-composer-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
/* A field with nothing in it shows a dimmed plane rather than a missing one: the button keeps
   its place, its border and its hit area, so the row does not reflow when the reader types the
   first character — what changes is that the mark is muted and has nothing behind it. */
.agent-composer-action:disabled {
  border-color: color-mix(in srgb, var(--app-border) 55%, transparent);
  background: transparent;
  color: var(--app-muted);
  cursor: default;
  opacity: 0.55;
}
.agent-composer-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
