<script lang="ts">
/**
 * The copy the timeline renders, handed in rather than reached for — see
 * {@link AgentToolLabels} for why, and for what happens when the catalogue grows keys.
 */
import type { AgentTimelineControlLabels } from './AgentTimelineControls.vue'
import type { AgentToolLabels } from './AgentToolActivity.vue'

export interface AgentTimelineLabels {
  /** Names the log for a screen reader. */
  aria: string
  /** Marks the reader's own turn. §5.3 keeps the user's paragraph visibly theirs, and a
   *  screen reader gets the same information from this word. */
  you: string
  /** Names the list of files a turn carried. The names themselves are the files' own — a path or
   *  an image's name — so this is what tells a reader what the list *is*. */
  attached: string
  /** The disclosure on the engine's own reasoning channel. */
  thoughtOpen: string
  thoughtClosed: string
  /** The row of controls that floats over the transcript's own bottom edge. */
  controls: AgentTimelineControlLabels
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
import { ChevronDown, ChevronRight, FileText, Image as ImageIcon } from 'lucide-vue-next'
import AgentToolActivity from './AgentToolActivity.vue'
import AgentTimelineControls from './AgentTimelineControls.vue'
import { useAgentScroll } from '../composables/use-agent-scroll'
import { newestReply, newestUserRow } from '../services/agent-timeline-actions'
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

/** The switch's own state, as the control row draws it. A computed rather than the composable's
 *  ref handed straight down: the template reads it as a top-level binding, and the control wants
 *  a boolean prop rather than a ref it would have to unwrap. */
const following = computed(() => scroll.following.value)

/** The newest answer, and whether the reader has said anything: the two things the control row
 *  is drawn for. Both are the view's own rows, read through
 *  `services/agent-timeline-actions.ts` — which row counts as "the answer" is decided there and
 *  not in this template. */
const reply = computed(() => newestReply(props.rows))
const hasUserMessage = computed(() => newestUserRow(props.rows) !== null)

/**
 * The row element for a timeline entry, or null when it is not on screen.
 *
 * Address a row by its own id rather than by index: the rows are keyed by the store's ids and a
 * tool call updating rewrites one row without renumbering the rest, which an index would not
 * survive.
 */
function rowElement(id: number): Element | null {
  return scroller.value?.querySelector(`[data-row="${id}"]`) ?? null
}

/** Take the reader to their own last message. The reader asked, so the move is instant — see
 *  `AgentScroll.toRow`. */
function toUserMessage(): void {
  const row = newestUserRow(props.rows)
  if (row !== null) scroll.toRow(rowElement(row.id))
}

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
    <!-- `tabindex="0"`: the container scrolls, and a scroll container the keyboard cannot
         reach is a transcript a keyboard-only reader cannot read backwards. WebKitGTK — the
         engine this ships on — leaves a plain `div` out of the tab order, and a click on the
         text lands on whatever control the row happens to contain, so before this the only
         keyboard route to the end was the hint and there was no route at all to the rows above
         the fold. Focus here is a plain tab stop: no key is intercepted on it, so keys meant
         for the composer still arrive there, and Tab leaves the way it arrived. -->
    <div
      ref="scroller"
      class="agent-timeline"
      role="log"
      aria-live="off"
      :aria-label="labels.aria"
      tabindex="0"
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
          <!-- What went with this message. The composer's strip is cleared with the draft, so
               this is the only place left that says the model was given a file — and the names
               are the files' own, because a reader looking for the diagram they sent needs to
               see that it is the one that arrived. Not drawn when there is nothing to show: an
               empty frame is a surface with nothing in it. -->
          <ul
            v-if="row.attachments.length > 0"
            class="agent-row-files"
            :aria-label="labels.attached"
            :data-row-files="row.id"
          >
            <li
              v-for="file in row.attachments"
              :key="`${file.kind}:${file.name}`"
              class="agent-row-file"
              :data-kind="file.kind"
            >
              <span
                class="agent-row-file-icon"
                aria-hidden="true"
              >
                <component
                  :is="file.kind === 'image' ? ImageIcon : FileText"
                  :size="11"
                  :stroke-width="1.8"
                />
              </span>
              <span class="agent-row-file-name">{{ file.name }}</span>
            </li>
          </ul>
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
    <AgentTimelineControls
      v-if="rows.length > 0"
      :following="following"
      :pending="scroll.pending.value"
      :reply="reply"
      :has-user-message="hasUserMessage"
      :labels="labels.controls"
      @follow="scroll.setFollowing($event)"
      @resume="scroll.resume()"
      @to-user="toUserMessage()"
      @to-top="scroll.toTop()"
    />
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
/* The tab stop above needs to be visible, or a keyboard reader is moved into a region with no
   sign they are in it. Drawn inset (`-2px`, the app's convention for a control that fills its
   own box): an outside ring on an element that is the full size of its scroll body would be
   clipped by the rail's own overflow, and half a ring is worse than none. `:focus-visible`
   rather than `:focus` keeps the ring off a mouse reader's screen. */
.agent-timeline:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
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
/* The files a turn carried, under the reader's own words. Wraps rather than scrolling: a turn can
   carry several, and the panel is narrow (§5.3 — nothing here may widen it). */
.agent-row-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  /* 6px, not the list's default: this sits inside the reader's own padded paragraph, so the
     separation from the words above is the paragraph's job and only the gap is this list's. */
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.agent-row-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 6px;
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-panel) 60%, transparent);
  color: var(--app-muted);
  font-size: 11px;
}
.agent-row-file-icon {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.agent-row-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>
