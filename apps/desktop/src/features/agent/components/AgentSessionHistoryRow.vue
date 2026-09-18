<script setup lang="ts">
/**
 * One row of the history list: the option, the engine's title, the meta line under it, and the
 * free action beside it.
 *
 * Split out of `AgentSessionHistoryMenu.vue` at the line budget and along the seam the mark-up
 * already had: the menu keeps the list — the find box above it, the keyboard that walks it, the
 * answers that stand in for it — and this file draws one row of it. Nothing here decides anything:
 * which row is highlighted, whether a free action is offered at all, and what a press means are all
 * the menu's, and every one of them arrives as a prop or leaves as an event.
 *
 * The two facts the row is allowed to be certain about are the engine's own. `title` is the
 * engine's or it is absent, and the absence is drawn as a statement about the engine rather than as
 * a name this app invented (`agent.panel.history.untitled`); the age is the engine's `updatedAt`
 * read through `describeSessionAge`, against the one clock the menu passes down so the whole list
 * reads the same instant.
 *
 * **The free action is a sibling of the option, not a child of it.** A listbox may only own
 * options, and an interactive child inside one is a control whose role the AT cannot announce. The
 * three facts that decide whether it is drawn at all are the menu's to join, and its own comment
 * below keeps them; this file only honours the answer.
 */
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { describeSessionAge, type AgentSessionHistoryRow } from '../services/agent-session-history'

const props = defineProps<{
  /** The engine's own record for this session. */
  row: AgentSessionHistoryRow
  /** Where it sits in the list on screen — what the option's id and `data-index` are built from. */
  index: number
  /** The list element's id, which the trigger's `aria-controls` names. */
  listId: string
  /** Whether the arrows are on this row. The menu owns the highlight; this file draws it. */
  active: boolean
  /** Whether the question in the strip below is about this row. */
  confirming: boolean
  /** Whether the engine reported that it answers `session/close`. */
  closeable: boolean
  /** The instant the age is read against — one clock for the whole list. */
  now: number
}>()

const emit = defineEmits<{
  /** The row was chosen: a click, or Enter on the highlighted one. The menu decides what that
   *  means. */
  activate: []
  /** The pointer arrived on this row, which moves the arrows onto it. */
  hover: []
  /** The user asked to free this session on the engine. */
  ask: []
}>()

/** The second line: the engine's own stamp read as an age, then the two marks that say something
 *  pressing the row would not. Absent parts are absent, never blank. */
const meta = computed((): string[] => {
  const parts: string[] = []
  const age = describeSessionAge(props.row.updatedAt, props.now)
  if (age !== null) parts.push(age)
  if (props.row.current) parts.push(t('agent.panel.history.current'))
  if (props.row.elsewhere) {
    parts.push(t('agent.panel.history.elsewhere', { cwd: props.row.cwd }))
  }
  return parts
})
</script>

<template>
  <div
    class="agent-history-row"
    :class="{
      'is-active': active,
      'is-current': row.current,
      'is-confirming': confirming,
    }"
    :data-index="index"
  >
    <div
      :id="`${listId}-option-${index}`"
      class="agent-history-option"
      role="option"
      :aria-selected="row.current"
      :aria-current="row.current || undefined"
      tabindex="-1"
      :data-session="row.sessionId"
      :data-elsewhere="row.elsewhere || undefined"
      @mousedown.prevent
      @mouseenter="emit('hover')"
      @click="emit('activate')"
    >
      <!-- The engine's title, or the sentence saying it sent none. A row is never blank and
           never carries a name this app wrote in the engine's place. -->
      <span class="agent-history-option-title">{{ row.title ?? t('agent.panel.history.untitled') }}</span>
      <span
        v-if="meta.length > 0"
        class="agent-history-option-meta"
      >
        <span
          v-for="part in meta"
          :key="part"
          class="agent-history-option-part"
          :title="part"
        >{{ part }}</span>
      </span>
    </div>
    <!-- The row's own action, beside the option rather than inside it: the engine's records
         are not this app's to keep or drop, and freeing one is offered only where the call can
         be carried out — and never on the session the reader is in.

         Three facts, and all three are needed. `closeable` is the engine saying it answers
         `session/close`; `row.held` is *this host* saying it holds the session, which is the
         predicate `agent_close_session` checks before it asks the engine at all; `!row.current`
         is the trap the row above this one keeps. The engine's table outlives this app's run,
         so most rows of a fresh window are listed and not held — before `held` was read, every
         one of them wore a button whose only possible outcome was the host's refusal, which
         the panel then reported as the engine's. §5.2: an option that cannot act is not drawn,
         so nothing here has to be explained away. -->
    <button
      v-if="closeable && row.held && !row.current"
      class="agent-history-free"
      type="button"
      :title="t('agent.panel.history.free.label')"
      :aria-label="t('agent.panel.history.free.label')"
      :data-free="row.sessionId"
      @mousedown.prevent
      @click.stop="emit('ask')"
    >
      <X
        :size="12"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
/* The row: the option, and the action beside it. The highlight belongs to the row rather than to
   the option, so the free button is inside the same lit area as the text it acts on.
   `color` is declared *here* — the row is the element that carries the states (`is-active`,
   `is-current`, `is-confirming`) and the box a reader's eye is on — and the option inside it
   inherits rather than restating it: a row that declared none computed to the UA's `rgb(0, 0, 0)`,
   which is a colour no palette has and one every future child that forgot to declare its own
   would draw. */
.agent-history-row {
  display: flex;
  align-items: center;
  gap: 2px;
  color: var(--app-text);
  /* `--app-radius-sm` is the list-row radius this app uses (`AgentConfigOptionsPopup.vue`,
     `SelectMenu.vue`). */
  border-radius: var(--app-radius-sm);
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-history-row.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
/* The row the question in the footer is about, marked so the sentence has a subject. */
.agent-history-row.is-confirming {
  box-shadow: inset 2px 0 0 var(--app-accent);
}
.agent-history-option {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--app-radius-sm);
  background: transparent;
  /* `color` is the row's, inherited (see the row's own rule): the option is inside the lit area and
     its text is the row's text, so the two cannot drift apart. */
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
/* The engine's records are not this app's to drop, so the action is quiet by default and answers
   the pointer in colour rather than in an alarm the engine did not raise. */
.agent-history-free {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 4px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-history-free:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  color: var(--app-text);
}
.agent-history-free:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
/* The session on screen. Colour is the second signal and never the only one: the same fact is in
   the row's meta line and in its `aria-current`. `is-current` is one of the row's own states —
   the template puts it beside `is-active` and `is-confirming` — so the selector starts at the row:
   written against the option it matched nothing at all, and the session the reader is in wore the
   same colour as every other row. */
.agent-history-row.is-current .agent-history-option-title {
  color: var(--app-accent);
}
.agent-history-option-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-history-option-meta {
  display: flex;
  gap: 6px;
  min-width: 0;
  color: var(--app-muted);
  font-size: 11px;
}
.agent-history-option-part {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A folder other than the one this runtime works in: the one fact in the row that changes what
   pressing it means, so it is marked rather than left to be read out of a path. */
.agent-history-option[data-elsewhere] .agent-history-option-meta {
  color: var(--app-warn);
}
</style>
