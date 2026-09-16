<script lang="ts">
/**
 * The copy the timeline renders, handed in rather than reached for — see
 * {@link AgentToolLabels} for why, and for what happens when the catalogue grows keys.
 */
import type { AgentToolLabels } from './AgentToolActivity.vue'

export interface AgentTimelineLabels {
  /** Names the log for a screen reader. */
  aria: string
  /** Marks the reader's own turn. §5.3 keeps the user's paragraph visibly theirs, and a
   *  screen reader gets the same information from this word. */
  you: string
  /** The disclosure on the engine's own reasoning channel. */
  thoughtOpen: string
  thoughtClosed: string
  /** The button that takes the reader back to the end of the log; the count of arrivals they
   *  have not followed is rendered beside it. */
  jump: string
  tool: AgentToolLabels
}
</script>

<script setup lang="ts">
/**
 * The transcript: the rows of one session, and the container they scroll in.
 *
 * Props in, events out (§10.2) — no store, no gateway, no session id. The rows it draws are
 * what the store's view already reduced to, and the one thing it reports back is where the
 * container ended up, so the panel can keep that per session (§5.1).
 *
 * **The container is this component's**, and the composable's requirement that the rows are
 * its direct children is why: the anchor is picked from the container's own children, so the
 * scroll element cannot be a wrapper around a nested list.
 *
 * **It is re-mounted per session** rather than re-pointed: the panel keys it by session, and
 * `initialPosition` is read once, at mount, because a value that moved afterwards would be
 * another session's. Switching sessions is not what §5.3 forbids — rebuilding the tree *per
 * token* is — and the rows below are keyed by the store's own row ids, so an update to a tool
 * call writes one row and leaves the rest of the DOM alone.
 *
 * The container is deliberately not a live region. `role="log"` would make it `aria-live`
 * by default, and a region whose text grows on every frame would read the answer aloud one
 * fragment at a time (§5.2 「不能每 token 都触发朗读」). Status cues belong to the run, not to
 * the token, and the panel's status line is where they are announced.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowDown, ChevronDown, ChevronRight } from 'lucide-vue-next'
import AgentToolActivity from './AgentToolActivity.vue'
import { useAgentScroll } from '../composables/use-agent-scroll'
import type { AgentTimelineEntry } from '../services/agent-timeline'

const props = defineProps<{
  /** One session's rows, oldest first, as the store holds them. */
  rows: readonly AgentTimelineEntry[]
  /** Where this session was left (§5.1). Read once, at mount. */
  initialPosition?: number
  labels: AgentTimelineLabels
}>()

const emit = defineEmits<{
  /** Where the container ended up. The panel keeps it per session. */
  position: [scrollTop: number]
}>()

const scroller = ref<HTMLElement | null>(null)
const scroll = useAgentScroll({
  container: scroller,
  rowCount: () => props.rows.length,
  initialPosition: props.initialPosition,
  onPosition: (scrollTop) => emit('position', scrollTop),
})

/** The reasoning rows the reader opened, by row id. Reasoning is collapsed by default: the
 *  engine disclosed it, but it is not the answer. */
const openThoughts = ref<readonly number[]>([])

function isThoughtOpen(id: number): boolean {
  return openThoughts.value.includes(id)
}

function toggleThought(id: number): void {
  openThoughts.value = isThoughtOpen(id)
    ? openThoughts.value.filter((open) => open !== id)
    : [...openThoughts.value, id]
  scroll.contentChanged()
}

/** The hint is a button and not a live region: it appears once, when the reader leaves the
 *  end, and then counts. Announcing the count would announce every arrival, which is the
 *  per-token reading §5.2 rules out. */
const hint = computed(() => scroll.suspended.value && scroll.pending.value > 0)

/**
 * A container that changes size re-wraps every row, which moves the reader without a row
 * arriving — the same height change a tool row makes, from the one other cause there is
 * (§5.2 「高度变化保持可见内容锚点」). The observer watches the container's own box, so it fires
 * on a panel or window resize and not on the text growing inside it.
 *
 * Guarded rather than assumed: the composable answers before the container exists, and an
 * engine without `ResizeObserver` loses only this refinement.
 */
if (typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(() => scroll.contentChanged())
  onMounted(() => {
    if (scroller.value !== null) observer.observe(scroller.value)
  })
  onBeforeUnmount(() => observer.disconnect())
}
</script>

<template>
  <div class="agent-timeline-wrap">
    <div
      ref="scroller"
      class="agent-timeline"
      role="log"
      aria-live="off"
      :aria-label="labels.aria"
      @scroll="scroll.onScroll"
    >
      <template
        v-for="row in rows"
        :key="row.id"
      >
        <p
          v-if="row.kind === 'user'"
          class="agent-row agent-row-user"
          :data-row="row.id"
          :data-origin="row.origin"
        >
          <span class="agent-row-who">{{ labels.you }}</span>
          <span class="agent-row-text">{{ row.text }}</span>
        </p>
        <p
          v-else-if="row.kind === 'text'"
          class="agent-row agent-row-reply"
          :data-row="row.id"
        >
          {{ row.text }}
        </p>
        <div
          v-else-if="row.kind === 'thought'"
          class="agent-row agent-row-thought"
          :data-row="row.id"
        >
          <button
            class="agent-thought-head"
            type="button"
            :aria-expanded="isThoughtOpen(row.id)"
            @click="toggleThought(row.id)"
          >
            <component
              :is="isThoughtOpen(row.id) ? ChevronDown : ChevronRight"
              :size="12"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ isThoughtOpen(row.id) ? labels.thoughtOpen : labels.thoughtClosed }}
          </button>
          <p
            v-if="isThoughtOpen(row.id)"
            class="agent-thought-text"
          >
            {{ row.text }}
          </p>
        </div>
        <AgentToolActivity
          v-else
          :entry="row"
          :labels="labels.tool"
          @toggle="scroll.contentChanged()"
        />
      </template>
    </div>
    <button
      v-if="hint"
      class="agent-jump"
      type="button"
      @click="scroll.resume()"
    >
      <ArrowDown
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      {{ labels.jump }}
      <span class="agent-jump-count">{{ scroll.pending.value }}</span>
    </button>
  </div>
</template>

<style scoped>
.agent-timeline-wrap {
  /* The hint floats over the log rather than living in it: the composable reads the
     container's children as rows, and a control among them would be measured as one. */
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.agent-timeline {
  flex: 1;
  min-width: 0;
  padding: 10px 12px 14px;
  overflow-y: auto;
  /* Reserving the gutter keeps the column still when a scrollbar appears: the same 10px the
     rail body already reserves, for the same reason. */
  scrollbar-gutter: stable;
  /* §5.3's body: 14px from the app's own font, and the app's zoom applies to it as it does
     everywhere else. 1.55 is the panel's rung, not the editor's 1.8 — a transcript is read in
     passes, and a wider leading costs rows off the screen for no gain. */
  font-family: var(--app-font);
  font-size: 14px;
  line-height: 1.55;
}
.agent-row + .agent-row,
.agent-row + .agent-tool,
.agent-tool + .agent-row,
.agent-tool + .agent-tool {
  margin-top: 10px;
}
.agent-row {
  margin: 0;
  /* A tool's output or a long path must not widen the panel (§5.3). */
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.agent-row-user {
  padding: 8px 10px;
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 72%, transparent);
}
.agent-row-who {
  display: block;
  margin-bottom: 2px;
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.agent-row-user .agent-row-text {
  color: var(--app-text);
}
.agent-row-reply {
  color: var(--app-text);
}
.agent-row-thought {
  border-left: 2px solid var(--app-border);
  padding-left: 8px;
}
.agent-thought-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 6px 0 0;
  border: none;
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 12px;
  cursor: pointer;
}
.agent-thought-head:hover {
  color: var(--app-text);
}
.agent-thought-head:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}
.agent-thought-text {
  margin: 0;
  color: var(--app-muted);
  font-size: 13px;
}
.agent-jump {
  position: absolute;
  bottom: 12px;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-elevated);
  box-shadow: var(--app-shadow-card);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  transform: translateX(-50%);
  cursor: pointer;
  /* Arrival only, and opacity only: it fades in where it lands. Nothing here moves the log
     under the reader, and the fade rides the app's 140–220ms band with reduced motion
     handled by the global sweep (§5.2). */
  animation: agent-jump-in var(--app-motion-fade) var(--app-ease);
}
.agent-jump:hover {
  background: color-mix(in srgb, var(--app-elevated) 86%, var(--app-accent-soft));
}
.agent-jump:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-jump-count {
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
@keyframes agent-jump-in {
  from {
    opacity: 0;
  }
}
</style>
