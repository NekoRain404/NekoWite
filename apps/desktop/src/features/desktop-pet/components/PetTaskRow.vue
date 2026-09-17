<script setup lang="ts">
/**
 * One task's row: the fields the layout asked for, in the order it asked for them.
 *
 * Split out of `PetTaskList.vue` because they are two different jobs — the list decides *which*
 * rows there are (filter, ranking, pages, the cap) and this decides what one row looks like and
 * what a click on it does. It is also the unit the acceptance is judged on: 点击准确路由 is a claim
 * about one row of a multi-task list, and a row that is a component with a name is a row a test can
 * point at.
 *
 * It gets fields that are already text — `{ token, text }`, resolved by the list — so it holds no
 * task, no clock, no phrases and no state labels. That is what keeps the two things this row could
 * get wrong out of reach: it cannot disagree with the list about what a row says, and it cannot
 * resolve a phrase a second time and pick a different one (§6.1's identity for a task, and the
 * reason the phrase is stable).
 *
 * Two things it does own, because they are per-row and both are acceptance:
 *
 *  - **The wrap rules.** The message field is the one that has to break anywhere — 长中文 and a
 *    session id have no spaces between them — and the short fields keep their size so the message
 *    is what gives way. The declarations come from the layout service and are applied inline; the
 *    test environment injects no SFC styles, and a rule only a stylesheet can see is a rule the
 *    acceptance cannot be tested against.
 *  - **The accessible name.** Passed in whole, because the state is always in it: the default
 *    layout hides the state *field*, and a row whose only sign of "needs you" would then be a
 *    colour is a row a screen reader reads as "Working" (§5.2: a written phrase may not disguise
 *    which state a task is in — and neither may a layout).
 */
import type { PetBubbleDot } from '../../../platform/gateways/pet-contracts'
import { petTokenStyle, type PetRowField } from '../services/pet-bubble-layout'

withDefaults(
  defineProps<{
    /** The row's state, as the attribute the surface colours the dot from. */
    state: string
    /** The engine, for the same reason: which row belongs to which agent is per-row data. */
    agentId: string
    /** The request the row is waiting on, when it is, so a click can be routed to it (§6.2). */
    permissionRequestId?: string | null
    /** What to draw, in order, already resolved to text. */
    fields?: readonly PetRowField[]
    /** The row's accessible name. Built by the list, which knows the state label and the phrase. */
    label: string
    /**
     * Which style the state dot is drawn in (`message.dot`, §5.2's 气泡与消息).
     *
     * A *shape* and never a colour. Upstream's two styles are an 8px disc and a spinning `✻`
     * (`references/desktop-pet/windows/src/styles.css:130-158`), and the colours in both come from
     * the state through the same `data-state` rules below — so a row's state is still readable from
     * the dot whatever the user picked, and a second palette is not something this setting can ask
     * for. Upstream also spins the asterisk while the task is `working`; this build's window carries
     * no CSS animation at all and `DesktopPetRoot.vue` records why (`general.motion` has nothing to
     * remove here), so the working state is the colour it already was.
     */
    dot?: PetBubbleDot
  }>(),
  { permissionRequestId: null, fields: () => [], dot: 'plain' },
)

const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <button
    type="button"
    class="pet-task__row"
    :style="{ flexWrap: 'wrap' }"
    :data-state="state"
    :data-agent="agentId"
    :data-permission="permissionRequestId ?? undefined"
    :aria-label="label"
    @click="emit('select')"
  >
    <span
      v-for="field in fields"
      :key="field.token"
      class="pet-task__field"
      :class="`pet-task__field--${field.token}`"
      :style="petTokenStyle(field.token)"
      :data-token="field.token"
    >
      <span
        v-if="field.token === 'dot'"
        class="pet-task__dot"
        :class="`pet-task__dot--${dot}`"
        :data-dot="dot"
        aria-hidden="true"
      />
      <template v-else>{{ field.text }}</template>
    </span>
  </button>
</template>

<style scoped>
.pet-task__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px;
  width: 100%;
  /* `border-box`, so the surface's cap is the row the user sees and not the row plus its padding. */
  box-sizing: border-box;
  margin: 0;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--app-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.pet-task__row:hover,
.pet-task__row:focus-visible {
  background: var(--app-accent-soft, rgb(255 255 255 / 10%));
}

.pet-task__field--message {
  /* Also inline, from the layout service; kept here so the row reads correctly even where the
     binding is dropped (a plain copy of the markup, an export). */
  overflow-wrap: anywhere;
}

.pet-task__field--session {
  color: var(--app-muted, rgb(255 255 255 / 65%));
  font-family: var(--app-mono-font, monospace);
  font-size: 11px;
}

.pet-task__field--elapsed,
.pet-task__field--stateLabel {
  color: var(--app-muted, rgb(255 255 255 / 65%));
  font-size: 11px;
}

/* The dot's **colour** and its **shape** are two decisions and are kept apart here, because the
   style setting chooses only the second: the state sets `color` below, and the shape paints it —
   as a filled disc by default, and as a glyph with `message.dot` set to `claude`. A rule that set
   `background` per state would have to be rewritten, per state, for the second shape. */
.pet-task__dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  color: var(--app-muted, rgb(255 255 255 / 60%));
  background: currentColor;
}

.pet-task__row[data-state='waiting-input'] .pet-task__dot {
  /* No fallback: `styles/tokens.test.ts` asserts this token is read bare, because a value hardcoded
     here outranks every theme — the token could lose its definition and this row would still
     render, in a colour nobody chose, without anything failing. */
  color: var(--app-warn);
}

.pet-task__row[data-state='working'] .pet-task__dot {
  color: var(--app-accent, #6aa3ff);
}

.pet-task__row[data-state='failed'] .pet-task__dot,
.pet-task__row[data-state='refused'] .pet-task__dot,
.pet-task__row[data-state='interrupted'] .pet-task__dot {
  color: var(--app-danger, #e05a5a);
}

.pet-task__row[data-state='turn-finished'] .pet-task__dot {
  color: var(--app-success, #4fbf7f);
}

/* Upstream's `claude` style: the row's own state colour on a glyph instead of a disc
   (`references/desktop-pet/windows/src/styles.css:149-158` carries a 14px box for a 12px glyph;
   this row's field is 11px, which is the size the state label beside it is set in). The glyph and
   the box are the whole of it — the spin upstream adds while a task is `working` is not carried,
   and the prop's own note says why.

   `[data-state]` rather than a bare class: the state rules above are (0,3,0) and this has to outrank
   them, because `background: none` is what takes the disc away. Matching their shape and coming
   after them is the whole of the argument. */
.pet-task__row[data-state] .pet-task__dot--claude {
  width: 11px;
  height: 11px;
  border-radius: 0;
  background: none;
  font-size: 11px;
  font-weight: 700;
  line-height: 11px;
  text-align: center;
}

.pet-task__dot--claude::before {
  /* The element's own `color`, which is the state's: the colour is written once, above. */
  content: '✻';
}
</style>
