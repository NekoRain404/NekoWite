<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { Ban, Ellipsis, TriangleAlert } from 'lucide-vue-next'
import { t } from '../../../i18n'
import type {
  AgentPermissionKind,
  AgentPermissionOption,
  AgentPermissionRequest,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'

/**
 * The permission prompt: what the engine is asking to do, and the answers it offers.
 *
 * Props in, events out (§10.2) — no gateway, no store, no session, no protocol. The
 * panel hands it one request and forwards whatever it emits, which is what keeps the
 * decision about *what is being asked* in the layer that can see the frame's fields and
 * the decision about *who may answer it* in the store that owns the session.
 *
 * The buttons are the request's own option list, in the engine's order, wearing the
 * engine's own labels. §6.3: 「授权 UI 使用引擎提供的选项与 option ID，不能自行发明
 * 「永久允许」」. The three-button row P0 §7.1 measured on our pinned build is a property
 * of *that request* and not of this template: the engine offered `allow_always` there,
 * so a lasting-allow button is legitimate there and illegitimate for any request whose
 * options do not include one. A request offering two options gets two buttons; one
 * offering none gets no answer button at all.
 */
const props = withDefaults(
  defineProps<{
    /** The request to render: the engine's id, its sentence for the call, its options. */
    request: AgentPermissionRequest
    /**
     * The status of the tool call this request belongs to, when the host knows it.
     *
     * "Not known" (`null`) is not "over". The contract's request carries no tool call id
     * and no status, so a panel that cannot join a request to its tool row knows nothing
     * here — and that must not end the prompt. Only a settled status does: a call that
     * moves `pending -> in_progress` while the user is still deciding is still waiting
     * for the same answer, and an ecosystem survey found a client that tore its prompt
     * down on exactly that change.
     */
    toolStatus?: AgentToolStatus | null
    /**
     * The host's word that this request can no longer be answered: the runtime exited,
     * the turn was cancelled, or the answer went out elsewhere (§6.2 「进程退出使所有悬挂
     * 请求结束，旧授权按钮失效」, §10.2 「过期响应拒绝」).
     */
    expired?: boolean
  }>(),
  { toolStatus: null, expired: false },
)

const emit = defineEmits<{
  /** The user's answer: the engine's own option id, under the request it came from. */
  (e: 'answer', requestId: string, optionId: string): void
  /** Stop the turn. Not an answer — see {@link cancelRun}. */
  (e: 'cancel'): void
}>()

/**
 * The statuses that mean the call this request is about has settled, so nothing is
 * waiting on consent any more.
 *
 * `cancelled` is the host's own derivation for a call that was still `pending` or
 * `in_progress` when the turn ended (the contract's `AgentToolStatus` says the host
 * derives it, the engine never sends it), so it settles the prompt for the same reason
 * `completed` does.
 */
const SETTLED: readonly AgentToolStatus[] = ['completed', 'failed', 'cancelled']

/**
 * Which of three things this prompt is.
 *
 * One question with three answers rather than a flag per state (§13.7). "answered" and
 * "dead" are both non-actionable but they are not the same thing to show, and a prompt
 * that is somehow both must not be rendered as a choice the user still has.
 */
type PromptPhase = 'open' | 'answered' | 'dead'

/** The answer already given, kept with the request id it was given for. */
const chosen = ref<{ requestId: string; option: AgentPermissionOption } | null>(null)

/** The answer, when it belongs to the request currently on screen. */
const answer = computed<AgentPermissionOption | null>(() =>
  chosen.value !== null && chosen.value.requestId === props.request.requestId
    ? chosen.value.option
    : null,
)

const phase = computed<PromptPhase>(() => {
  // Matched by the request id, so a request the panel swaps into this instance is a new
  // question: a latch remembered from the previous one would render it as already
  // answered — under the previous request's id.
  if (answer.value !== null) return 'answered'
  if (props.expired) return 'dead'
  if (props.toolStatus !== null && SETTLED.includes(props.toolStatus)) return 'dead'
  return 'open'
})

const answeredOptionId = computed<string | null>(() => answer.value?.optionId ?? null)

/**
 * Whether an option is one of the engine's refusals.
 *
 * `kind` carries the engine's own four kinds rather than a collapsed allow/reject pair
 * (payloads.ts), so the refusals are `reject_once` and `reject_always`. Both mean no —
 * whether the engine remembers the choice is a difference in the option's own name, not in
 * what pressing it does here — and this is the test the button's styling is chosen by.
 */
function isReject(kind: AgentPermissionKind): boolean {
  return kind === 'reject_once' || kind === 'reject_always'
}

function choose(option: AgentPermissionOption): void {
  // Guarded on the state machine rather than on the DOM. The buttons are gone one tick
  // later, so the second half of a double click still reaches this handler — and §6.3
  // makes a repeated click idempotent rather than a second answer. The same guard covers
  // the click that arrives on a button this component has already stopped rendering: a
  // detached element keeps the listener it was given.
  if (phase.value !== 'open') return
  chosen.value = { requestId: props.request.requestId, option }
  emit('answer', props.request.requestId, option.optionId)
}

function cancelRun(): void {
  // Cancelling the run is *not* an answer to this request. The protocol has exactly two
  // outcomes and a refusal is one of them — `selected` with a `reject_*` option id —
  // while a cancelled turn is answered `cancelled` by the host (§6.2). So this is an
  // event of its own, it never carries an option id, and it is not one of the buttons
  // above: it sits apart so it cannot be mistaken for a way to say no.
  if (phase.value !== 'open') return
  emit('cancel')
}

function onEscape(): void {
  // Scoped to this element rather than bound on the window: the prompt is not modal
  // (§5.1 「等待授权时不锁死整个编辑器」), so it has no claim on a key pressed elsewhere
  // in the app. Focus lands inside it on arrival, which is what makes the binding
  // reachable at all. It lands on the dismissive control because that is what Escape
  // means everywhere else in this app — and cancelling can never approve anything.
  cancelRun()
}

/**
 * The arguments, pretty-printed when they are JSON and left alone when they are not.
 *
 * The contract keeps them serialized because their shape is the engine's (payloads.ts),
 * which makes the formatting this layer's business. A string that does not parse is
 * shown as it arrived rather than replaced by a parse error: §6.3 requires the user to
 * see what they are approving, and the raw text beats a message about the parser.
 */
const inputText = computed<string | null>(() => {
  if (props.request.input.state !== 'text') return null
  const raw = props.request.input.json
  try {
    const pretty = JSON.stringify(JSON.parse(raw), null, 2)
    return typeof pretty === 'string' ? pretty : raw
  } catch {
    return raw
  }
})

const rootEl = ref<HTMLElement | null>(null)

// One prompt per pending request, so a constant id would collide the moment the panel
// shows two. `useId` rather than the engine's request id: that string is the engine's
// and nothing constrains it to be usable as an HTML id.
const titleId = `agent-perm-title-${useId()}`

// Focus the prompt itself, never an option button: the panel can be showing this while
// the user is still typing, and an Enter arriving as the tail of that typing must not
// answer a permission nobody has read yet — the same reasoning the AI write prompt
// records for `initialFocus: false`. The labelled dialog below is what a screen reader
// announces when focus lands, so the engine's own sentence is what says what is asked.
nextTick(() => rootEl.value?.focus())
</script>

<template>
  <div
    ref="rootEl"
    class="agent-perm"
    :class="`is-${phase}`"
    :data-phase="phase"
    :data-input-state="request.input.state"
    role="dialog"
    aria-modal="false"
    :aria-labelledby="titleId"
    tabindex="-1"
    @keydown.escape="onEscape"
  >
    <div class="agent-perm-head">
      <!-- The engine's own sentence for the call, verbatim: §5.1 wants the pending
           authorization to name its exact target and action, and this string is where
           both of them come from. -->
      <span
        :id="titleId"
        class="agent-perm-title"
      >{{ request.title }}</span>
      <!-- §5.3 wants a state carried by more than a colour, and this is the state
           where the colour is the *only* thing that changed — the buttons are gone,
           so without a word the prompt reads as broken rather than as finished. -->
      <span
        v-if="phase === 'dead'"
        class="agent-perm-dead-mark"
      >
        <Ban
          :size="14"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ t('agent.permission.expired') }}
      </span>
    </div>

    <!-- `tabindex="0"`: the block scrolls, and a diff is exactly the thing that
         overflows it. Without a tab stop the arguments §6.3 requires the user to read
         before approving are the one part of this prompt a keyboard cannot reach. -->
    <pre
      v-if="inputText !== null"
      class="agent-perm-args"
      tabindex="0"
    >{{ inputText }}</pre>
    <!-- The two non-text states are marked apart on purpose. "The engine has sent no
         arguments yet" and "the engine sent arguments this host could not read" arrive
         identically on the wire (ACP deserializes `rawInput` default-on-error), and §6.3
         makes this the surface where the user judges what they are approving — so they
         must not look the same here. An engine that fills the arguments in later sends a
         request whose `input` is text, which re-renders this block with no help from
         anything on this side. -->
    <div
      v-else
      class="agent-perm-args-none"
      :data-input-state="request.input.state"
    >
      <Ellipsis
        v-if="request.input.state === 'absent'"
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <TriangleAlert
        v-else
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="agent-perm-args-note">{{
        request.input.state === 'absent'
          ? t('agent.permission.argumentsPending')
          : t('agent.permission.argumentsUnreadable')
      }}</span>
    </div>

    <div class="agent-perm-options">
      <!-- Buttons or text, never a disabled button: "dead" is a state in which there is
           nothing to press, not a button that happens to be greyed out — which is also
           what makes a stale answer unclickable rather than merely unconvincing. Keeping
           the options as text on the way out means the record still says what was
           offered. -->
      <template v-if="phase === 'open'">
        <button
          v-for="option in request.options"
          :key="option.optionId"
          type="button"
          class="btn"
          :class="isReject(option.kind) ? 'btn-ghost' : 'btn-secondary'"
          :data-option-id="option.optionId"
          @click="choose(option)"
        >
          {{ option.name }}
        </button>
      </template>
      <template v-else>
        <span
          v-for="option in request.options"
          :key="option.optionId"
          class="agent-perm-option"
          :class="{ 'is-answered': option.optionId === answeredOptionId }"
          :data-option-id="option.optionId"
        >{{ option.name }}</span>
      </template>
    </div>

    <div
      v-if="phase === 'open'"
      class="agent-perm-foot"
    >
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        data-action="cancel-run"
        @click="cancelRun()"
      >
        {{ t('common.cancel') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.agent-perm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  color: var(--app-text);
  font-size: 13px;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}
/* A prompt that is over recedes rather than disappearing: the engine's sentence and the
   options stay readable as the record of what was asked. */
.agent-perm.is-dead,
.agent-perm.is-answered {
  background: color-mix(in srgb, var(--app-elevated) 70%, var(--app-canvas));
}
.agent-perm-head {
  display: flex;
  gap: 6px;
  align-items: center;
  font-weight: 600;
}
.agent-perm-title {
  min-width: 0;
  /* Paths and commands have no spaces to break at. */
  overflow-wrap: anywhere;
}
.agent-perm-dead-mark {
  /* Was a bare icon; it carries the sentence now, so it has to lay its own
     contents out rather than being a single glyph in the head's flex row. */
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.3;
}
.agent-perm-args {
  margin: 0;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  color: var(--app-muted);
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--app-panel) 55%, var(--app-canvas));
  border-radius: var(--app-radius-sm);
}
/* Not the same state, not the same look: nothing sent yet is drawn quietly, something
   sent that this host could not read is drawn in the warning colour. The two states
   stand where the arguments would be, so this box shares the arguments' geometry
   without sharing their class — one class is one thing, and a marker that answered to
   `.agent-perm-args` would make "are there arguments here?" unanswerable by reading
   the DOM. */
.agent-perm-args-none {
  display: flex;
  align-items: center;
  min-height: 22px;
  padding: 6px 8px;
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-panel) 55%, var(--app-canvas));
}
.agent-perm-args-none[data-input-state='unreadable'] {
  color: var(--app-warn);
  background: color-mix(in srgb, var(--app-warn) 12%, transparent);
}
.agent-perm-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.agent-perm-option {
  padding: 4px 8px;
  color: var(--app-muted);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
}
.agent-perm-option.is-answered {
  color: var(--app-text);
  border-color: var(--app-accent);
}
.agent-perm-foot {
  display: flex;
  justify-content: flex-end;
}
</style>
