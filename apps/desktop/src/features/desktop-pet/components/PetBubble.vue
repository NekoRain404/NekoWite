<script setup lang="ts">
/**
 * The bubble: one line when there is nothing to say about a task, the task list when there is.
 *
 * Upstream's `BubbleRenderer` is both of those plus the state machine that decides between them,
 * the animation of the text swap (erase → retype → ellipsis, `windows/src/bubble.ts` 169-259) and
 * the timers for all three modes. This component is the surface: it decides *which* of the two
 * things to show from props it was given, and owns neither the words nor the clock.
 *
 * The one decision it does make is the boundary between them, and it is the reason the bubble is
 * not simply a wrapper around the list: §6.3 says a task the user has not answered stays until it
 * is answered, so a list that is showing a waiting task is not something an idle sentence may
 * replace. The single line is therefore what the bubble shows when there is nothing in the list —
 * never an overlay, never a rotation — and the caller owns when it changes and how long it lives
 * (§6.3's six seconds are the composition's, and a bubble that armed its own timer would be the
 * second reminder about the same turn).
 *
 * Three smaller things it owns rather than passing on:
 *
 *  - **The wrapping rules on the line.** §12's acceptance is that a bubble does not leave the
 *    screen (气泡不越屏), and a Chinese idle sentence in a 280px surface is where that is decided.
 *    The same style object the list gives its rows is applied here, for the same reason.
 *  - **The height the line may reach.** 气泡不越屏 has a second axis: D13 measured the list at 561px
 *    in a sprite-sized window, and the line is capped by the same rule (`lineStyle`), because a
 *    caller's sentence is not bounded by the width alone.
 *  - **The right-click.** The pet window is frameless, so the browser's context menu would be a
 *    second menu for the same surface. The default is prevented and the pointer position is handed
 *    to the composition, which owns where the menu goes.
 */
import { computed } from 'vue'
import type { PetTaskProjection, PetTaskState } from '../../../platform/gateways/pet-contracts'
import {
  PET_BUBBLE_MAX_WIDTH,
  PET_BUBBLE_MESSAGE_STYLE,
  PET_BUBBLE_SCROLL_STYLE,
  filterPetTasks,
  resolvePetBubbleLayout,
  type PetBubbleLayoutInput,
} from '../services/pet-bubble-layout'
import type { PetMessagePhrases, PetTaskListLabels } from '../services/pet-message-template'
import PetTaskList from './PetTaskList.vue'

const props = withDefaults(
  defineProps<{
    /** Every task the host handed the window; the layout decides what that means for the surface. */
    tasks?: readonly PetTaskProjection[]
    /** The `message` domain's bubble fields, or the defaults (§5.2). */
    layout?: PetBubbleLayoutInput
    /** The user's own lines (§5.2's 自定义词句). */
    phrases?: PetMessagePhrases
    /** The host's clock in epoch ms, ticked by the caller; this component starts no timer. */
    now?: number
    agentLabels?: Readonly<Record<string, string>>
    stateLabels?: Partial<Record<PetTaskState, string>>
    labels?: Partial<PetTaskListLabels>
    /** What the pet says when there is no task to speak of. The caller's words, not the pet's. */
    line?: string | null
    /** The user asked for the list — the menu's "Show tasks" — even when there is nothing in it. */
    forceList?: boolean
  }>(),
  {
    tasks: () => [],
    now: 0,
    layout: () => ({}),
    phrases: () => ({}),
    agentLabels: () => ({}),
    stateLabels: () => ({}),
    labels: () => ({}),
    line: null,
    forceList: false,
  },
)

const emit = defineEmits<{
  select: [task: PetTaskProjection]
  /** A right-click, in window coordinates: the composition decides where the menu opens. */
  menu: [position: { x: number; y: number }]
}>()

const layout = computed(() => resolvePetBubbleLayout(props.layout))

/**
 * Whether the list has anything to show, computed from the same filter the list applies.
 *
 * Not `tasks.length > 0`: a filter that excludes a finished run means the pet has nothing to
 * report, and saying "nothing running" is more honest than an empty box the user did not filter
 * for. The layout's own rules answer it, so the two surfaces cannot disagree.
 */
const listCount = computed(() => filterPetTasks(props.tasks, layout.value.filter).length)
const showList = computed(() => props.forceList || listCount.value > 0)
const showLine = computed(() => !showList.value && Boolean(props.line))
const visible = computed(() => showList.value || showLine.value)
const mode = computed(() => (showList.value ? 'list' : 'line'))

function onContextMenu(event: MouseEvent): void {
  emit('menu', { x: event.clientX, y: event.clientY })
}

const surfaceStyle = { maxWidth: `${PET_BUBBLE_MAX_WIDTH}px`, boxSizing: 'border-box' } as const

/**
 * The line's own box: the wrapping rules, and the same height cap the rows get.
 *
 * The bubble is bounded whichever shape it is showing, and the cap sits on the element that grows
 * — here the sentence, in list mode the rows inside `PetTaskList` — so the two never nest two
 * scrollbars into one surface. A line is short by nature (it is one sentence at 280px), but "by
 * nature" is not a bound: a caller's words are its own, and a bubble that could be 561px tall as a
 * list and unbounded as a line would be the same defect with a different trigger.
 */
const lineStyle = { ...PET_BUBBLE_MESSAGE_STYLE, ...PET_BUBBLE_SCROLL_STYLE } as const
</script>

<template>
  <div
    v-if="visible"
    class="pet-bubble"
    :class="`pet-bubble--${mode}`"
    :data-mode="mode"
    :style="surfaceStyle"
    @contextmenu.prevent="onContextMenu"
  >
    <PetTaskList
      v-if="showList"
      :tasks="tasks"
      :layout="layout"
      :phrases="phrases"
      :now="now"
      :agent-labels="agentLabels"
      :state-labels="stateLabels"
      :labels="labels"
      @select="emit('select', $event)"
    />
    <p
      v-else
      class="pet-bubble__line"
      :style="lineStyle"
    >
      {{ line }}
    </p>
  </div>
</template>

<style scoped>
.pet-bubble {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--app-border, rgb(255 255 255 / 18%));
  /* One radius for both shapes: the line and the list are the same surface at two sizes, and a
     capsule with a list in it is the giveaway that they were built as two. */
  border-radius: var(--app-radius, 10px);
  background: var(--app-elevated, rgb(0 0 0 / 62%));
  box-shadow: var(--app-shadow-card, 0 2px 10px rgb(0 0 0 / 35%));
  color: var(--app-text, #fff);
  font-family: var(--app-font, system-ui, sans-serif);
  font-size: var(--app-body-size, 12px);
  line-height: 1.5;
}

.pet-bubble__line {
  margin: 0;
  /* Also inline, from the layout service: a Chinese line has no spaces to break at. */
  overflow-wrap: anywhere;
}
</style>
