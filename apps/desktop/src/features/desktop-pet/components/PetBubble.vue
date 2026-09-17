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
 *    screen (气泡不越屏), and a Chinese idle sentence in a 260px surface is where that is decided.
 *    The same style object the list gives its rows is applied here, for the same reason.
 *  - **The height the line may reach.** 气泡不越屏 has a second axis: D13 measured the list at 561px
 *    in a sprite-sized window, and the line is capped by the same rule (`lineStyle`), because a
 *    caller's sentence is not bounded by the width alone.
 *  - **The right-click.** The pet window is frameless, so the browser's context menu would be a
 *    second menu for the same surface. The default is prevented and the pointer position is handed
 *    to the composition, which owns where the menu goes.
 */
import { computed } from 'vue'
import { PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import type {
  PetBubbleDot,
  PetTaskProjection,
  PetTaskState,
} from '../../../platform/gateways/pet-contracts'
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
    /**
     * The user's own lines, keyed by engine and then by state (§5.2's 自定义词句).
     *
     * **No production caller passes one, and the reason is a schema gap rather than a missing
     * wire.** `message` stores the quick bubbles as one flat list (`quickBubbles`), which is what
     * this window's idle line is drawn from — `PetBubble`'s `line` prop, not this one. What this
     * prop takes is the per-engine × per-state pool upstream keeps across `ap_msg_<agent|all>_<mood>`
     * keys (`references/desktop-pet/windows/src/activity.ts:198-208`), and the settings schema has
     * no field of that shape *and no vocabulary to declare one*: both sides' structured rules are a
     * scalar member inside one container (`pet-settings-values.ts`'s `PetMemberRule`, Rust's
     * `fields::MemberRule`), so a map of maps of lists is not expressible. The plan files it as
     * 「Agent 覆盖」 (`docs/superpowers/plans/2026-09-16-desktop-pet-port.md:116`), and what it needs
     * first is a nested container kind.
     *
     * The prop stays because the mechanism it feeds is the port's: `petPhrasePool`'s precedence —
     * this engine's lines, then the ones written for every engine, then the built-in pool — is the
     * behaviour the file exists to carry, and dropping the prop would delete it rather than defer
     * it. Nothing here defaults a pool into existence: an absent one is the built-in lines, which
     * is what a fresh install shows.
     */
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
    /**
     * The bubble's background alpha (§5.2's 气泡与消息, upstream `ap_opacity`).
     *
     * `message.opacity` as the host's store read it, or the schema's default when a caller has
     * none: the same value `petBubbleOpacityOf` hands `DesktopPetRoot`, and the same rule the
     * settings page's slider is bounded by, so the control cannot produce one this surface would
     * draw differently from what the store would keep.
     */
    bubbleOpacity?: number
    /**
     * The bubble's own text size in px (§5.2's 气泡与消息, upstream `ap_font_size`).
     *
     * `message.fontSize` as the host's store read it, or the schema's default when a caller has
     * none — the same value `petBubbleFontSizeOf` hands `DesktopPetRoot`, and the same rule the
     * settings page's control is bounded by, so the control cannot produce a size this surface
     * would draw differently from what the store would keep.
     */
    fontSize?: number
    /** Which style each row's state dot is drawn in (§5.2's 气泡与消息, upstream `ap_bub_dot`). */
    dot?: PetBubbleDot
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
    bubbleOpacity: PET_SETTINGS_DEFAULTS.message.opacity,
    fontSize: PET_SETTINGS_DEFAULTS.message.fontSize,
    dot: PET_SETTINGS_DEFAULTS.message.dot,
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

/**
 * Whether this surface is on screen at all, for the caller that has to decide whether the window
 * takes the pointer (§7.2's 鼠标穿透).
 *
 * Exposed rather than recomputed by the caller: "the bubble is showing something" is
 * `filterPetTasks` plus the layout's filter plus `forceList`, and a second copy of that in the
 * window's root would be a second answer to the same question — the kind that drifts, and drifts
 * silently, because the two would only disagree about the states nobody tests.
 */
defineExpose({ visible })

/**
 * The surface's own box, and the one thing about it that is a *setting*: the background's alpha
 * (§5.2's 气泡与消息, upstream `ap_opacity`).
 *
 * The alpha and not a colour: which colour the bubble is comes from the host's palette through
 * `--app-elevated`, so this setting can never become a second place the theme is decided — which
 * is upstream's own rule too, where `applyBubble` writes `rgba(<the theme's rgb>, op)` and nothing
 * else (`windows/src/main.ts:88-100`).
 *
 * Handed over as a custom property for the stylesheet to mix, rather than as a `background` spelled
 * out here: the colour belongs to the palette and the alpha belongs to the setting, and one
 * declaration that knows both is a declaration that has to repeat the palette's fallback.
 */
const surfaceStyle = computed(
  () =>
    ({
      maxWidth: `${PET_BUBBLE_MAX_WIDTH}px`,
      boxSizing: 'border-box',
      '--pet-bubble-alpha': `${Math.round(props.bubbleOpacity * 100)}%`,
      // The size travels the same way and for the same reason: upstream sets `--bubble-font-size`
      // on the document root and everything under it inherits (`windows/src/main.ts:104`), so the
      // rows inside this surface read the property off their ancestor rather than being handed a
      // number each. A caller with no setting gets the app's body size, which is what the bubble was
      // drawn at before the field existed.
      '--pet-bubble-size': `${props.fontSize}px`,
    }) as const,
)

/**
 * The line's own box: the wrapping rules, and the same height cap the rows get.
 *
 * The bubble is bounded whichever shape it is showing, and the cap sits on the element that grows
 * — here the sentence, in list mode the rows inside `PetTaskList` — so the two never nest two
 * scrollbars into one surface. A line is short by nature — it is one sentence at the window's own
 * width — but "by nature" is not a bound: a caller's words are its own, and a bubble that could be
 * 561px tall as a list and unbounded as a line would be the same defect with a different trigger.
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
      :dot="dot"
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
  /* A column, and one whose content may be shorter than the box it is given. The surface is a flex
     item of whatever column holds it (`.pet-root` in the product), so it is also the item that
     *gives the room back*: the character's own box is not shrinkable, the window does not scroll,
     and the bound below is written against the window rather than against the room above the
     sprite. So when the two of them do not both fit, this is the surface that gets shorter — and
     the box inside it (`PET_BUBBLE_SCROLL_STYLE`) is what scrolls, so nothing is lost and the
     character stays inside the window. `min-height: 0` is the line that allows it: a flex item's
     automatic minimum size is its content, and without it the surface would refuse to shrink and
     push the sprite out of the window instead. */
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 6px 8px;
  border: 1px solid var(--app-border, rgb(255 255 255 / 18%));
  /* One radius for both shapes: the line and the list are the same surface at two sizes, and a
     capsule with a list in it is the giveaway that they were built as two. */
  border-radius: var(--app-radius, 10px);
  /* The palette's colour, mixed toward `transparent` at the setting's own alpha (`surfaceStyle`
     carries the percentage, `petBubbleOpacity` came from the host's `message` record). The second
     argument of `var()` is what a caller that renders the bubble without a setting gets. */
  background: color-mix(
    in srgb,
    var(--app-elevated, rgb(0 0 0 / 62%)) var(--pet-bubble-alpha, 92%),
    transparent
  );
  box-shadow: var(--app-shadow-card, 0 2px 10px rgb(0 0 0 / 35%));
  color: var(--app-text, #fff);
  font-family: var(--app-font, system-ui, sans-serif);
  /* The setting, then the app's body size, then this build's own 12px: the second is what the
     surface drew with before `message.fontSize` reached it, and it is the fallback for a caller
     that renders a bubble outside the product. */
  font-size: var(--pet-bubble-size, var(--app-body-size, 12px));
  line-height: 1.5;
}

.pet-bubble__line {
  margin: 0;
  /* Also inline, from the layout service: a Chinese line has no spaces to break at. */
  overflow-wrap: anywhere;
}
</style>
