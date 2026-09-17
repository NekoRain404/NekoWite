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
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Send, Square } from 'lucide-vue-next'
import type { AgentConfigControl } from '../services/agent-config-options'
import { insertReferenceText } from '../services/agent-context-references'
import AgentComposerContext from './AgentComposerContext.vue'
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
  labels: AgentComposerLabels
}>()

/** The half-written message. It is the session's, not this component's: the panel binds it
 *  to the store, so looking away and back does not lose it (§5.1). */
const draft = defineModel<string>({ default: '' })

const emit = defineEmits<{
  /** The reader sent this text. Whether it was accepted is the store's answer, not ours. */
  send: [text: string]
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

const blank = computed(() => draft.value.trim() === '')

function focus(): void {
  field.value?.focus()
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
  if (text === '' || !props.canSend) return
  emit('send', text)
  void nextTick(focus)
}

function onKeydown(event: KeyboardEvent): void {
  // The menu above is asked first: an arrow key and the Enter that settles on a row are its
  // keys while a `/token` is open, and it says so by having already called `preventDefault`.
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

watch(draft, () => {
  void nextTick(grow)
})

defineExpose({ focus })
</script>

<template>
  <form
    class="agent-composer"
    @submit.prevent="submit"
  >
    <textarea
      ref="field"
      v-model="draft"
      class="agent-composer-field"
      :placeholder="labels.placeholder"
      :aria-label="labels.placeholder"
      rows="2"
      spellcheck="false"
      @keydown="onKeydown"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
    />
    <div class="agent-composer-bar">
      <!-- The left-hand end of the row: the files of the folder the agent works in, brought into
           the message (Zed's `+` at the head of its composer's bottom row). The bar's own
           structure is untouched — this is one more child, and the hint, the button and whatever
           the right-hand end adds keep their places in it. The control carries the auto margin
           that keeps the hint beside it instead of letting `space-between` float the hint into
           the middle of the row. -->
      <AgentComposerContext @insert="insertReference" />
      <p class="agent-composer-hint">
        {{ running ? labels.hintBusy : labels.hint }}
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
  min-width: 0;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 11px;
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
