<script setup lang="ts">
/**
 * The tasks, one row each: the 多任务 surface, and the thing a click has to land on.
 *
 * Upstream's version of this is `windows/src/bubble.ts`'s `BubbleRenderer` — a class that owns a
 * DOM tree, a row cache, three timers and three display modes, and that rebuilds its rows through
 * `innerHTML` when the structure changes. What is ported is the *content model* (the tokens, the
 * filter/sort/group/cap order) and it lives in `../services/pet-bubble-layout.ts`, where it is a
 * function of its inputs; what is not ported is the imperative DOM, the module-level config cache
 * read out of `localStorage` on every 500ms tick, and the three timers (§3.1.6: 不得把 1800 行脚本
 * 塞入 Vue `onMounted`).
 *
 * Five decisions in here are the acceptance clauses rather than taste:
 *
 *  - **A row is a task, never a group of them.** Upstream collapses same-agent sessions into one
 *    row with a `×N` badge (`groupSessions`, 141-156) and clicks it to the first session of the
 *    group — which is a row that cannot answer the question "which one did I click?". §6.3 says the
 *    list keeps showing every task, so a group is a *heading* here and each task keeps its own row.
 *  - **A row is a `<button>`.** Keyboard activation, focus and a role come free, and the accessible
 *    name is built from the layout: the state is in it even when the layout hides the state field,
 *    so a row whose only sign of "needs you" is a colour is still announced as needing the user
 *    (§6.2 — the one thing a written phrase may never change).
 *  - **The message carries the wrapping rules.** Chinese has no spaces and a session id has no
 *    break opportunity at all; `PET_BUBBLE_MESSAGE_STYLE` is applied inline rather than only in the
 *    stylesheet because that is the acceptance, and a rule only a stylesheet can see is a rule no
 *    test can hold on to.
 *  - **The rows are a bounded box, not a shorter list.** A list of six long Chinese rows is 561px
 *    tall (D13's measurement) and the window it is drawn in is the character's, so the rows scroll
 *    inside a box capped in window units (`PET_BUBBLE_MAX_HEIGHT`) instead of being cut down to
 *    what happens to fit. Nothing is dropped, and the count cap that *does* cut is a different
 *    thing: it is the user's (`maxTasks`), it reports what it left out, and a height-derived row
 *    count would be a second cap that could disagree with it.
 *  - **No timer of its own.** The elapsed field is computed from `now`, which the caller ticks
 *    (§6.3: 参数注入时钟测试，不写死到组件定时器), and the carousel does not advance by itself — a
 *    surface that hides a task the user has not answered yet, on a clock, is §3.1.3 undone.
 *
 * Everything it draws comes in as props and everything it does goes out as events: it does not know
 * what a gateway is, so it cannot open a session, answer a permission or write a setting. The
 * composition routes what it emits (§6.2).
 */
import { computed, ref } from 'vue'
import {
  petTaskToken,
  type PetTaskProjection,
  type PetTaskState,
} from '../../../platform/gateways/pet-contracts'
import {
  PET_BUBBLE_COMPACT_PREVIEW,
  PET_BUBBLE_MAX_WIDTH,
  PET_BUBBLE_SCROLL_STYLE,
  buildPetTaskDisplay,
  petAgentLabel,
  resolvePetBubbleLayout,
  type PetBubbleLayoutInput,
  type PetBubbleToken,
  type PetRowField,
  type PetTaskGroup,
} from '../services/pet-bubble-layout'
import {
  PET_TASK_LIST_LABELS,
  fillPetLabel,
  petElapsed,
  petStateLabel,
  petTaskMessage,
  type PetMessagePhrases,
  type PetTaskListLabels,
} from '../services/pet-message-template'
import PetTaskRow from './PetTaskRow.vue'

const props = withDefaults(
  defineProps<{
    /** Every task the host handed the window. The list decides what to show; the host does not. */
    tasks?: readonly PetTaskProjection[]
    /** The `message` domain's bubble fields, or the defaults (§5.2). */
    layout?: PetBubbleLayoutInput
    /** The user's own lines (§5.2's 自定义词句), already keyed by agent and state. */
    phrases?: PetMessagePhrases
    /**
     * The host's clock, in epoch ms, or 0 while the caller has none — in which case the wall clock
     * is read at render time. Either way this component starts no timer: the caller ticks it.
     */
    now?: number
    /** The agent registry the composition has, for display names. Unknown ids show as themselves. */
    agentLabels?: Readonly<Record<string, string>>
    /** State labels, for the pet's i18n namespace. The state is still what chooses the label. */
    stateLabels?: Partial<Record<PetTaskState, string>>
    /** The chrome's own wording, field by field. */
    labels?: Partial<PetTaskListLabels>
  }>(),
  {
    tasks: () => [],
    now: 0,
    layout: () => ({}),
    phrases: () => ({}),
    agentLabels: () => ({}),
    stateLabels: () => ({}),
    labels: () => ({}),
  },
)

/**
 * One task was picked: the row that was clicked, whole.
 *
 * The projection and not just a key, because §6.2's waiting row has to bring its `requestId` with
 * it — the click goes to the host's permission UI, and a consumer that had to look the task up
 * again could look up a task that has since stopped waiting.
 */
const emit = defineEmits<{ select: [task: PetTaskProjection] }>()

const layout = computed(() => resolvePetBubbleLayout(props.layout))
const labels = computed<PetTaskListLabels>(() => ({ ...PET_TASK_LIST_LABELS, ...props.labels }))
/** Which page the carousel is on. View state, and nothing outside this surface reads it. */
const page = ref(0)
/** Compact mode's fold; the same, per surface. */
const expanded = ref(false)

const display = computed(() =>
  buildPetTaskDisplay(props.tasks, layout.value, page.value, props.agentLabels),
)
const clock = computed(() => (props.now > 0 ? props.now : Date.now()))
const compact = computed(() => layout.value.mode === 'compact')

/**
 * How many rows are drawn: the whole cap, except in compact mode before the fold is opened, where
 * it is the preview. Both are "at most the cap" — a fold that opened past it would be a second cap
 * that could disagree with the first.
 */
const rowBudget = computed(() =>
  compact.value && !expanded.value ? PET_BUBBLE_COMPACT_PREVIEW : layout.value.maxTasks,
)

/**
 * The rows to draw, cut to the budget across the groups rather than within them.
 *
 * Cutting each group to two rows would show four rows in a two-agent list, which is not what the
 * fold promised; cutting the flattened list and regrouping is the honest reading of "show two".
 */
const groups = computed<PetTaskGroup[]>(() => {
  const out: PetTaskGroup[] = []
  let left = rowBudget.value
  for (const group of display.value.groups) {
    if (left <= 0) break
    const tasks = group.tasks.slice(0, left)
    left -= tasks.length
    if (tasks.length > 0) out.push({ ...group, tasks })
  }
  return out
})

const summary = computed(() =>
  display.value.groups.length > 1
    ? fillPetLabel(labels.value.summaryAgents, {
        count: String(display.value.total),
        agents: String(display.value.groups.length),
      })
    : fillPetLabel(labels.value.summary, { count: String(display.value.total) }),
)

const foldLabel = computed(() =>
  expanded.value
    ? labels.value.foldClose
    : fillPetLabel(labels.value.foldOpen, {
        count: String(Math.max(0, display.value.total - rowBudget.value)),
      }),
)

function agentNameOf(task: PetTaskProjection): string {
  return petAgentLabel(task.key.agentId, props.agentLabels)
}

/** The message for one task: its line, picked for that task and stable for as long as it runs. */
function messageOf(task: PetTaskProjection): string {
  return petTaskMessage({
    state: task.state,
    agentId: task.key.agentId,
    sessionId: task.key.sessionId,
    agentLabel: agentNameOf(task),
    phrases: props.phrases,
  })
}

/** What one field shows. `dot` has no text: it is the state as a colour, and the name carries it. */
function textOf(token: PetBubbleToken, task: PetTaskProjection): string {
  switch (token) {
    case 'dot':
      return ''
    case 'agent':
      return agentNameOf(task)
    case 'session':
      return task.key.sessionId
    case 'separator':
      return layout.value.separator
    case 'message':
      return messageOf(task)
    case 'stateLabel':
      return petStateLabel(task.state, props.stateLabels)
    case 'elapsed':
      return petElapsed(task.updatedAt, clock.value)
  }
}

function fieldsOf(task: PetTaskProjection): PetRowField[] {
  return layout.value.tokens
    .filter((item) => item.visible)
    .map((item) => ({ token: item.token, text: textOf(item.token, task) }))
}

function rowLabel(task: PetTaskProjection): string {
  return fillPetLabel(labels.value.row, {
    agent: agentNameOf(task),
    state: petStateLabel(task.state, props.stateLabels),
    message: messageOf(task),
  })
}

function pageLabel(number: number): string {
  return fillPetLabel(labels.value.page, { page: String(number), total: String(display.value.pages) })
}

const surfaceStyle = { maxWidth: `${PET_BUBBLE_MAX_WIDTH}px`, boxSizing: 'border-box' } as const
</script>

<template>
  <div
    class="pet-task"
    :style="surfaceStyle"
  >
    <p
      v-if="display.total === 0"
      class="pet-task__empty"
    >
      {{ labels.empty }}
    </p>
    <template v-else>
      <p
        v-if="compact"
        class="pet-task__summary"
      >
        {{ summary }}
      </p>

      <!--
        The rows, in a box that is bounded and scrollable. Every row the count cap kept is drawn:
        what does not fit is below the fold of this box rather than dropped, and the box is
        focusable and named so a keyboard reaches it too. The reports that say what the list holds
        — the count, the fold, the pager — are deliberately outside it.
      -->
      <div
        class="pet-task__scroll"
        :style="PET_BUBBLE_SCROLL_STYLE"
        tabindex="0"
        role="group"
        :aria-label="labels.rows"
      >
        <section
          v-for="group in groups"
          :key="group.agentId ?? 'flat'"
          class="pet-task__group"
        >
          <p
            v-if="group.label"
            class="pet-task__group-head"
          >
            {{ fillPetLabel(labels.group, { agent: group.label, count: String(group.tasks.length) }) }}
          </p>
          <ul class="pet-task__rows">
            <li
              v-for="task in group.tasks"
              :key="petTaskToken(task.key)"
              class="pet-task__item"
            >
              <PetTaskRow
                :state="task.state"
                :agent-id="task.key.agentId"
                :permission-request-id="task.permissionRequestId"
                :fields="fieldsOf(task)"
                :label="rowLabel(task)"
                @select="emit('select', task)"
              />
            </li>
          </ul>
        </section>
      </div>

      <button
        v-if="compact"
        type="button"
        class="pet-task__fold"
        @click="expanded = !expanded"
      >
        {{ foldLabel }}
      </button>
      <p
        v-if="display.hidden > 0"
        class="pet-task__more"
      >
        {{ fillPetLabel(labels.more, { count: String(display.hidden) }) }}
      </p>
      <div
        v-if="display.pages > 1"
        class="pet-task__pages"
        role="group"
        :aria-label="labels.pages"
      >
        <button
          v-for="number in display.pages"
          :key="number"
          type="button"
          class="pet-task__page"
          :class="{ 'is-current': number - 1 === display.page }"
          :aria-current="number - 1 === display.page ? 'true' : undefined"
          :aria-label="pageLabel(number)"
          @click="page = number - 1"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The rows' box is a tab stop and has to show it. Everything above this element is styled from
   `PET_BUBBLE_SCROLL_STYLE` and this file has never carried a rule for it, so the indicator the
   engine drew was its own `outline: auto` — which is the accented blue of the engine's theme and
   not this app's, and would be the one control in the pet's window that speaks a different focus
   language from `.pet-task__row` a line below it. INSET, like the other scroll containers in this
   app: the box is bounded to `PET_BUBBLE_MAX_HEIGHT` and an outside ring would be drawn over the
   bubble it sits in. */
.pet-task__scroll:focus-visible {
  outline: 2px solid var(--app-accent, #6aa3ff);
  outline-offset: -2px;
}
.pet-task {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  /* The list is the bubble's only child, so it is the item the surface hands its own height to: it
     shrinks (with `min-height: 0` to let it go below its content) and its own children below decide
     what that height is spent on — the rows box, which scrolls, and the reports, which do not. */
  flex: 1 1 auto;
  min-height: 0;
  color: var(--app-text, #fff);
  font-family: var(--app-font, system-ui, sans-serif);
  font-size: var(--app-body-size, 12px);
  line-height: 1.5;
  /* The row is the click target, not the sentence inside it: selecting text in a bubble the user
     is trying to click is how a click becomes a drag. */
  user-select: none;
}

.pet-task__group-head,
.pet-task__summary,
.pet-task__more,
.pet-task__empty {
  margin: 0;
  padding: 2px 6px;
  color: var(--app-muted, rgb(255 255 255 / 65%));
  font-size: 11px;
  /* What says what the list holds keeps its own height, so the room the column gives back comes out
     of the rows rather than out of the sentence that reports them. A shrinkable flex item is the
     default, and one of these squashed to a few pixels would be a report that is drawn and cannot
     be read. */
  flex: none;
}

.pet-task__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pet-task__fold {
  align-self: flex-start;
  /* The same rule as the reports above: a control keeps its own height and the rows give the room. */
  flex: none;
  margin: 0;
  padding: 2px 6px;
  border: 0;
  background: transparent;
  color: var(--app-accent, #6aa3ff);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.pet-task__pages {
  display: flex;
  justify-content: center;
  gap: 5px;
  padding: 3px 0;
  flex: none;
}

.pet-task__page {
  width: 6px;
  height: 6px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--app-border, rgb(255 255 255 / 25%));
  cursor: pointer;
}

.pet-task__page.is-current {
  background: var(--app-accent, #6aa3ff);
}
</style>
