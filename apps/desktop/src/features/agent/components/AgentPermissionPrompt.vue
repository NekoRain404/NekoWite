<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { Ban, Check, CheckCheck, Ellipsis, TriangleAlert, X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import AgentToolDiff from './AgentToolDiff.vue'
import type {
  AgentPermissionKind,
  AgentPermissionOption,
  AgentPermissionRequest,
  AgentToolContent,
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
     * "Not known" (`null`) is not "over". The request carries the call's id but no status
     * — status is the transcript's, arriving on the call's own frames — so a panel whose
     * row has not arrived yet knows nothing here, and that must not end the prompt. Only a
     * settled status does: a call that moves `pending -> in_progress` while the user is
     * still deciding is still waiting for the same answer, and an ecosystem survey found a
     * client that tore its prompt down on exactly that change.
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

/**
 * The blocks to draw: **the request's own**, and nothing else.
 *
 * They arrive on the request — the engine attaches them to the frame it asks with, and the
 * host carries them through (`agent_runtime/permissions.rs`'s `content_of`) — so this prompt
 * needs no second reading of the same call. It used to take them from the transcript's row,
 * joined by `toolCallId`; that join is gone deliberately. A row's blocks are whatever the
 * transcript last held, which is not what this request said, and with the two merged there
 * was no way to tell at the pixels between "this request carried no diff" and "its diff
 * happens to equal the row's" — the case a person allowing an edit is least able to check.
 *
 * Empty is the ordinary answer for a request that proposed no edit. Nothing is drawn for it,
 * and nothing else is consulted: an empty frame would be a statement about the engine that
 * the engine did not make.
 */
const content = computed<readonly AgentToolContent[]>(() => props.request.content)

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

/**
 * The glyph each of the engine's four kinds wears.
 *
 * Zed's mapping, ported as a mechanism rather than as a design: one check for the answer that
 * covers this call, a double check for the one that covers every later one, a cross for either
 * refusal. The distinction that matters is between the two *allows* — they are the two buttons a
 * tired reader is most likely to confuse, and the icon is the one signal that survives not being
 * read. `reject_always` is in the same arm as an unknown kind for Zed's reason: a refusal is a
 * refusal, and an engine that grows a fifth kind must not get an approving icon by default.
 *
 * The colour is this app's, not Zed's (`--app-success` / `--app-danger`), and it is carried on the
 * button's own icon rather than on the whole button: §5.3 wants a state carried by more than a
 * colour, and here the glyph and the engine's own wording carry it while the colour agrees.
 */
function kindIcon(kind: AgentPermissionKind) {
  switch (kind) {
    case 'allow_once':
      return Check
    case 'allow_always':
      return CheckCheck
    default:
      return X
  }
}

/**
 * Whether the engine offered an answer that stops it asking about this tool again.
 *
 * The test is the *kind*, not the id: §6.3 leaves the ids to the engine, and `allow_always` is the
 * kind the protocol defines as the lasting grant. This is what the note below the options is drawn
 * for, and it is drawn only when there is something to warn about.
 */
const offersLastingGrant = computed(() => props.request.options.some((o) => o.kind === 'allow_always'))

/**
 * Where a lasting grant can be read back and taken back, as that place names itself.
 *
 * The settings rail's row, the permission page's heading and the list's own heading, each read
 * from the key the surface draws it from — so the sentence under the button and the page it
 * points at cannot drift apart, and a translator gets one string per place rather than a second
 * copy of each inside this sentence. This is the whole of the correction N5 names: the sentence
 * used to say this app had no such surface, and it is drawn at the moment the reader decides.
 */
const lastingGrantPlaces = computed(() => ({
  section: t('settings.section.agents'),
  page: t('agent.settings.permission.section.title'),
  surface: t('agent.settings.permission.grants.title'),
}))

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

    <!-- The change itself, above the arguments: this is the surface where the decision is
         taken (§6.3 「等待授权时不锁死整个编辑器」, and the prompt sits beside the composer
         precisely so it does not scroll away), and §6.3 requires the user to see the
         target of the action they authorize. Where the call proposed an edit, the target
         is the text — so the diff is drawn here rather than only one click deep in the
         transcript, and it draws nothing at all when the call reported no diff block. -->
    <AgentToolDiff
      class="agent-perm-diff"
      :content="content"
    />
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
          :data-option-kind="option.kind"
          @click="choose(option)"
        >
          <component
            :is="kindIcon(option.kind)"
            :size="14"
            :stroke-width="1.8"
            aria-hidden="true"
            :class="isReject(option.kind) ? 'agent-perm-glyph is-no' : 'agent-perm-glyph is-yes'"
          />
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

    <!-- What the lasting answer commits the user to, said at the moment it is offered.
         The engine's own label for it is "Always allow", which does not say *how long* — and the
         answer outlives this prompt: the engine stops raising the question for that tool, so
         nothing later reaches this app, and nothing later tells the user either. One sentence
         under the row is cheaper than a user discovering it from a write they never approved.
         The three names in it are read from the catalogue rather than written into the sentence:
         what the reader is sent to look for has to wear the same name on the page they arrive
         at, and these keys are the page's own (`settings.section.agents`,
         `agent.settings.permission.section.title`, `agent.settings.permission.grants.title`). -->
    <p
      v-if="phase === 'open' && offersLastingGrant"
      class="agent-perm-lasting"
      data-test="permission-lasting-note"
    >
      {{ t('agent.permission.lastingGrant', lastingGrantPlaces) }}
    </p>

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
/* The proposed change, given the prompt's own gutter and nothing else: the component draws its
   own frame, and a second border around it would be this prompt's chrome rather than the diff's.
   It sits above the arguments so that a long diff does not push the one thing the buttons are
   about off the top of the card. */
.agent-perm-diff {
  margin: 0 8px 6px;
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
/* The tab stop above is a stop a keyboard reader has to be able to see they are on, and the
   engine's own ring is not enough of an answer: measured in WebKitGTK, `outline: auto` on this
   element paints a five-pixel bar down its left edge and nothing along the other three — a
   fragment of an indicator, not one. This is the rule the agent transcript's container already
   carries (§7: the same defect, the same fix), and it is drawn INSET for the same reason: the
   element is the full size of its scroll body, so a ring outside it would be drawn over the
   prompt's own card and clipped by it at the edges. */
.agent-perm-args:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
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
/* The two allows are the pair a reader is most likely to confuse, so the glyph carries the
   difference and the colour agrees with it. Both are set on the icon rather than the button: a
   button painted green and one painted red would be the colour-only signal §5.3 forbids. */
.agent-perm-glyph.is-yes { color: var(--app-success); }
.agent-perm-glyph.is-no { color: var(--app-danger); }
/* Not `is-warn`: this is not a fault, it is the consequence of a button in the row above, and a
   warning colour on an ordinary prompt is the kind of alarm users learn to skip. */
.agent-perm-lasting {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--app-muted);
}
.agent-perm-foot {
  display: flex;
  justify-content: flex-end;
}
</style>
