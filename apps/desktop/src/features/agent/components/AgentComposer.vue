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
 * **A second send while a run is in flight does nothing at all.** Not a queue, not a
 * reminder: §6.2 allows one active generation per session, and the text stays in the field
 * for the reader to send when the run ends. The text is not cleared on a refusal, which is
 * §5.1's rule about drafts surviving errors, applied to the one refusal that happens
 * without an error.
 *
 * **What the field does about itself is `use-agent-composer-field.ts`'s, and the rule that an
 * Enter during an IME composition is not a send lives there** with the three signals it is read
 * from (§10.2) — as does the growth bound and what a reference at the caret becomes.
 * `use-agent-composer-intake.ts` owns what a paste and a drag mean, and `AgentComposerMentions.vue`
 * owns the `@` list. What is left here is what only the assembly can do: place the three, decide
 * what a key means to each of them in turn, and own the turn itself.
 *
 * **The message can carry more than its words, and this is the layer that decides what travels.**
 * A turn is built from a text block plus one block per attachment (`agent_runtime/attachments.rs`
 * on the host side), and every way in passes through this component: a paste of an image and a drag
 * over the field (reported by `use-agent-composer-intake.ts`), and a file picked in the `+`'s own
 * list. What may go out is the engine's own report and nothing else — `promptCapabilities` decides,
 * the host reads it again at send time, and a block it does not licence is refused with the engine's
 * own sentence rather than dropped. The rules that do not need an element — what a file becomes,
 * what fits, what is refused — live in `services/agent-composer-attachments.ts` and
 * `composables/use-agent-composer-attachments.ts`.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Send, Square } from 'lucide-vue-next'
import type {
  AgentCapabilityReport,
  AgentPromptAttachment,
} from '../../../platform/gateways/agent-contracts'
import { t } from '../../../i18n'
import { useAgentComposerAttachments } from '../composables/use-agent-composer-attachments'
import { useAgentComposerField } from '../composables/use-agent-composer-field'
import { useAgentComposerIntake } from '../composables/use-agent-composer-intake'
import { textWithoutMention } from '../composables/use-agent-composer-mentions'
import type { AgentConfigControl } from '../services/agent-config-options'
import AgentComposerAttachments from './AgentComposerAttachments.vue'
import AgentComposerContext, { type AgentComposerSelection } from './AgentComposerContext.vue'
import AgentComposerMentions from './AgentComposerMentions.vue'
import AgentConfigRow from './AgentConfigRow.vue'

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
   * the layer that owns both the file row and the send.
   *
   * **It gates no control, and this comment used to say it did** — that a `null` report "draws no
   * attach affordance at all rather than a disabled one". Nothing here has ever drawn or withheld
   * one: the `+` is `AgentComposerContext.vue`'s, that file holds no report, and its own header
   * says so ("there is no capability gate here"), because a row there is a file a person may point
   * at and pressing one means the same thing whichever block the engine reads. A claim about a
   * gate that does not exist is worse than a missing one — it tells the next reader the question is
   * answered — so what this prop does is stated instead: `null` and an empty report part company in
   * a *sentence*, never in what may be pressed. An attachment the report does not licence is
   * refused with the engine's own words by `use-agent-composer-attachments.ts`, and a file whose
   * block is not licensed travels as its path. Both halves are pinned in
   * `AgentComposer.attachments.test.ts`.
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

/** The field's own element, bound by the template. Everything that needs it — its height, its
 *  caret, the composition events it saw — is `use-agent-composer-field.ts`'s, and it takes the
 *  element rather than reaching for it: a template ref is the template's to name. */
const el = ref<HTMLTextAreaElement | null>(null)

const field = useAgentComposerField({
  el,
  draft,
  // The event is this component's to report; the flag it is reported from is the composable's.
  composition: (phase) => emit('composition', phase),
})

/** The `@` list, drawn by its own component — and asked for its keys from here, because the keydown
 *  lands on this field rather than in that box. See {@link onKeydown}. */
const mentionMenu = ref<InstanceType<typeof AgentComposerMentions> | null>(null)

/**
 * What the message is carrying, and the three intakes that put something there.
 *
 * The vault is a prop — the panel's own session's, see {@link vault} — and every reader below
 * resolves against it: `attachments` reads it when a file is picked or pasted, the intake reads it
 * for a dragged path, the `+`'s listing reads it, and the `@` list reads it through its own
 * component.
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
 * The file a mention settled on: the half-typed word comes out of the message, and the file goes
 * into the turn.
 *
 * One path for both ways in — the row the reader clicked and the Enter the list took — because the
 * two have to do exactly the same thing, and both of them arrive here as one `pick` from
 * `AgentComposerMentions.vue`, whose own composable was built with it as its `select`.
 */
function onMentionPick(path: string): void {
  draft.value = textWithoutMention(draft.value)
  pickFile(path)
}

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
    if (outcome === 'path-in-message') field.insertReference(path)
  })
}

/** The two intakes that arrive as events on the field. Bound below, and both of them end in one of
 *  the two routes above: a transfer's files go to the attachments composable, and a dragged path
 *  goes through `pickFile` exactly as a `+` row does. */
const intake = useAgentComposerIntake({
  vault: sessionVault,
  addFromTransfer: attachments.addFromTransfer,
  pick: pickFile,
})

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
  void nextTick(field.focus)
}

function onKeydown(event: KeyboardEvent): void {
  // The menus are asked first, and the `@` list before the engine's: a word starting `@` cannot be
  // a `/command` (that one has to start the message), so the two never both have a claim, and the
  // order only decides which one answers when neither does. Both say "mine" by having already
  // called `preventDefault`, and both tell the IME apart from a key of their own. The `@` list is
  // asked through the instance because the keydown lands on this field rather than in its box —
  // `AgentComposerMentions.vue` exposes the one function and says why.
  const mentioned = mentionMenu.value?.onKeydown(event) ?? 'pass'
  if (mentioned !== 'pass') return
  const verdict = props.resolveKey?.(event) ?? 'pass'
  if (verdict !== 'pass') return
  if (event.key !== 'Enter') return
  // A composition's Enter — including the one an engine delivers just after its `compositionend` —
  // is the input method committing a candidate rather than the reader sending. The three signals
  // and the grace window are `use-agent-composer-field.ts`'s.
  if (field.inputMethodOwnsEnter(event)) return
  // Shift+Enter is a newline, which is the field's own behaviour — nothing to do.
  if (event.shiftKey) return
  event.preventDefault()
  submit()
}

watch(draft, (value) => {
  // The store took the turn: the words are in the timeline and the files went with them. The
  // attachments are cleared here rather than at the press because this is the first moment
  // anything has said the send was accepted.
  if (value === '' && pendingSend.value !== null) {
    pendingSend.value = null
    attachments.clear()
  }
  void nextTick(field.grow)
})

/** A keystroke of the reader's own: whatever send was outstanding is no longer what this draft is
 *  about, so an empty field from here on is theirs rather than the store's. */
function onInput(): void {
  if (pendingSend.value !== null && draft.value !== pendingSend.value) pendingSend.value = null
}

/** The panel's way in for a caller that wants the reader in the field — kept where it has always
 *  been exposed, on this component, though the element and the call are the field's own. */
defineExpose({ focus: field.focus })
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
    <!-- The `@` list, over the field it is being typed into: its own box, its own rows, its own
         sentences and its own keys, all `AgentComposerMentions.vue`'s. The instance is held here
         because the keydown lands on the field below and `onKeydown` asks it before anything else. -->
    <AgentComposerMentions
      ref="mentionMenu"
      :text="draft"
      :vault="vault"
      @pick="onMentionPick"
    />
    <textarea
      ref="el"
      v-model="draft"
      class="agent-composer-field"
      :placeholder="labels.placeholder"
      :aria-label="labels.placeholder"
      :title="t('agent.panel.composer.attach.mention.hint')"
      rows="2"
      spellcheck="false"
      @keydown="onKeydown"
      @compositionstart="field.onCompositionStart"
      @compositionend="field.onCompositionEnd"
      @input="onInput"
      @paste="intake.onPaste"
      @dragover="intake.onDragOver"
      @drop="intake.onDrop"
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
        @insert="field.insertReference"
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
