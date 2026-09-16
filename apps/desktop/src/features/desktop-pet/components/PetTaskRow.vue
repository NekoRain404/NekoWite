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
  }>(),
  { permissionRequestId: null, fields: () => [] },
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

.pet-task__dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--app-muted, rgb(255 255 255 / 60%));
}

.pet-task__row[data-state='waiting-input'] .pet-task__dot {
  /* No fallback: `styles/tokens.test.ts` asserts this token is read bare, because a value hardcoded
     here outranks every theme — the token could lose its definition and this row would still
     render, in a colour nobody chose, without anything failing. */
  background: var(--app-warn);
}

.pet-task__row[data-state='working'] .pet-task__dot {
  background: var(--app-accent, #6aa3ff);
}

.pet-task__row[data-state='failed'] .pet-task__dot,
.pet-task__row[data-state='refused'] .pet-task__dot,
.pet-task__row[data-state='interrupted'] .pet-task__dot {
  background: var(--app-danger, #e05a5a);
}

.pet-task__row[data-state='turn-finished'] .pet-task__dot {
  background: var(--app-success, #4fbf7f);
}
</style>
