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
 *
 * **The find bar is this component's**, and it is the one control here that searches rather than
 * scrolls: a reader looking for a line they remember across a long turn has no other way to it.
 * The rule it applies is `services/agent-conversation-search.ts`; what lives here is where the bar
 * sits, where a hit is painted, and what landing on one does to the container. Two of those are
 * rulings rather than choices:
 *
 *  - **landing on a hit is the reader's move and nothing else.** Typing, the arrows and opening
 *    the bar are what may move the container; a rescan is not. The engine streams into the last
 *    row of a live turn, which rebuilds the rows on every frame, and a scan that scrolled on each
 *    of those frames would be the container fighting the hand that owns it — the same failure
 *    §5.2 names for a resize. Zed scrolls when the hit the reader was on is gone
 *    (`thread_search_bar.rs:493-494`); here a lost hit moves the *index* and leaves the container
 *    where the reader put it.
 *  - **the move is one instant write, through the composable's own `toRow`.** No easing, nothing
 *    to interrupt, and the same path the two jump controls already take — so a wheel that arrives
 *    mid-flight is not fought (there is no flight), and everything downstream of a scroll happens
 *    exactly as it does for the reader's own hand: the anchor is re-recorded, and following is
 *    suspended because they are no longer at the end. That suspension is the ruling working, not
 *    a side effect: content arriving while the reader is on a hit must not take them away from it.
 *  - **a hit inside folded reasoning unfolds it.** Reasoning is collapsed by default and it is
 *    searched anyway (the service's header says why); a hit the reader is taken to has to be a hit
 *    they can see, so the row opens on the way in. The open is the reader's own — they asked to go
 *    to the word — and the height change it makes is corrected by the move that follows it rather
 *    than by a `contentChanged`, which is what `contentChanged` is for a reader who is NOT moving.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, FileText, Image as ImageIcon } from 'lucide-vue-next'
import AgentToolActivity from './AgentToolActivity.vue'
import AgentHighlightedText from './AgentHighlightedText.vue'
import AgentTimelineControls from './AgentTimelineControls.vue'
import AgentTimelineSearch from './AgentTimelineSearch.vue'
import { useAgentScroll } from '../composables/use-agent-scroll'
import { newestReply, newestUserRow } from '../services/agent-timeline-actions'
import {
  activeHitIndex,
  findConversationHits,
  hitKey,
  stepHitIndex,
  type AgentHit,
  type AgentHitField,
  type AgentHitRange,
} from '../services/agent-conversation-search'
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

/* ---------------------------------------------------------------------------
 * The find bar
 * ------------------------------------------------------------------------- */

/** Whether the bar is on screen. The transcript's own state: a session switch re-mounts this
 *  component (`AgentPanel.vue` keys it by session), so the search does not outlive its rows. */
const searching = ref(false)
const query = ref('')
/** The hits the current query has, in the order the rows are drawn. */
const hits = ref<readonly AgentHit[]>([])
/** Which of them the reader is on, or -1. */
const active = ref(-1)
const bar = ref<InstanceType<typeof AgentTimelineSearch> | null>(null)

/** The key both the marks and the active one are addressed by: one string of one row. */
function markKey(rowId: number, field: AgentHitField): string {
  return `${rowId}:${field}`
}

/**
 * The ranges every marked string draws, keyed by `rowId:field`.
 *
 * Built once per rescan rather than per render, so a row no hit is in answers with one shared
 * `undefined` frame after frame and is not re-rendered by a search that does not touch it. That
 * matters here more than anywhere else in this component: a live turn rebuilds the row list on
 * every frame, and a search that re-rendered forty tool rows per frame to move one highlight
 * would be paying the panel's whole budget for it.
 */
const marks = computed(() => {
  const byField = new Map<string, AgentHitRange[]>()
  for (const hit of hits.value) {
    const key = markKey(hit.rowId, hit.field)
    const ranges = byField.get(key)
    if (ranges === undefined) byField.set(key, [{ start: hit.start, end: hit.end }])
    else ranges.push({ start: hit.start, end: hit.end })
  }
  return byField
})

/** Where the active hit sits *within its own string*, which is what the marked element is
 *  chosen by — the transcript draws the string, so that is the local index the mark needs. */
const activeMark = computed(() => {
  const hit = hits.value[active.value]
  if (hit === undefined) return null
  const key = markKey(hit.rowId, hit.field)
  let index = 0
  for (let at = 0; at < active.value; at += 1) {
    if (markKey(hits.value[at].rowId, hits.value[at].field) === key) index += 1
  }
  return { key, index }
})

/** The ranges one string of one row draws, or `undefined` — see {@link marks}. */
function hitsFor(rowId: number, field: AgentHitField): readonly AgentHitRange[] | undefined {
  return marks.value.get(markKey(rowId, field))
}

/** Which of that string's ranges the reader is on, or -1 when it is another row's hit. */
function activeFor(rowId: number, field: AgentHitField): number {
  const mark = activeMark.value
  return mark !== null && mark.key === markKey(rowId, field) ? mark.index : -1
}

/**
 * Take the reader to the row the active hit is in — or to the hit itself, which is what this
 * passes to `toRow`: the marked element is the hit's own line, and the container's top edge is
 * where a reader looks after asking for a line.
 */
async function reveal(): Promise<void> {
  const hit = hits.value[active.value]
  if (hit === undefined) return
  const row = props.rows.find((candidate) => candidate.id === hit.rowId)
  if (row !== undefined && row.kind === 'thought' && !isThoughtOpen(row.id)) {
    // Folded reasoning: the hit is inside text that is not drawn yet, and the reader asked to be
    // taken to it. Unfolding is the only way there — and it is not `toggleThought`, because that
    // also announces a height change for a reader who is staying put, and this reader is leaving.
    openThoughts.value = [...openThoughts.value, row.id]
  }
  // One tick, always: the marks are painted by the flush this rescan caused, and querying the DOM
  // before it would look for an element the browser has not built yet.
  await nextTick()
  scroll.toRow(scroller.value?.querySelector('[data-agent-hit="active"]') ?? null)
}

/**
 * Re-run the query over the rows, and say whether the reader's hit survived.
 *
 * `move` is the reader's own act — a keystroke, an arrow, the bar opening — and it is the only
 * thing that may move the container. A rescan caused by content arriving passes `false` and never
 * moves, whatever the hits do.
 */
function rescan(move: boolean): void {
  const previous = hits.value[active.value]
  hits.value = findConversationHits(props.rows, query.value)
  const resolved = activeHitIndex(hits.value, previous === undefined ? null : hitKey(previous))
  active.value = resolved.index
  if (move && !resolved.preserved) void reveal()
}

/** Step to the next (`+1`) or previous (`-1`) hit, wrapping — and go to it. */
function go(delta: number): void {
  active.value = stepHitIndex(active.value, hits.value.length, delta)
  void reveal()
}

/**
 * Open the bar.
 *
 * `contentChanged` is announced *before* the bar's row is added, because the transcript below it
 * loses that height in the same flush and the composable's anchor is measured from the DOM as it
 * was (§5.2 「高度变化保持可见内容锚点」). The reader is not searching yet, so this is the one
 * moment the change must not move them.
 */
function openSearch(): void {
  searching.value = true
  scroll.contentChanged()
  void nextTick(() => bar.value?.focus())
}

/**
 * Close it, and take the marks with it.
 *
 * The query goes rather than being kept for next time: every mark on the transcript is drawn from
 * it, and a bar that is gone while its hits still glow would be highlighting the reader has no
 * control left to explain. Focus goes to the log, which is where they were reading.
 */
function closeSearch(): void {
  searching.value = false
  query.value = ''
  scroll.contentChanged()
  scroller.value?.focus()
}

/** The control row's own press: the bar is a toggle, so the same control gives the height back. */
function toggleSearch(): void {
  if (searching.value) closeSearch()
  else openSearch()
}

// The two things that make the hits stale. A query the reader typed is their own act and lands on
// its first hit; content arriving is not, and must leave the container alone — the rule this
// component's header states in full.
watch(query, () => rescan(true))
watch(
  () => props.rows,
  () => {
    if (searching.value) rescan(false)
  },
)

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
    <!-- The bar is a row of its own above the log rather than an overlay on it, which is Zed's
         arrangement and the only one that works here: a hit is scrolled to the container's own top
         edge, so a bar floating over the log would cover the line it just found. It takes its
         height out of the log once, in the click frame, which is the shape `appShell.css` allows
         for the rail itself ("The layout collapses in the frame the user acts"). -->
    <AgentTimelineSearch
      v-if="searching && rows.length > 0"
      ref="bar"
      :query="query"
      :index="active"
      :total="hits.length"
      @update:query="query = $event"
      @next="go(1)"
      @prev="go(-1)"
      @close="closeSearch()"
    />
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
          <span class="agent-row-text"><AgentHighlightedText
            :text="row.text"
            :hits="hitsFor(row.id, 'text')"
            :active="activeFor(row.id, 'text')"
          /></span>
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
              v-for="(file, index) in row.attachments"
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
              <span class="agent-row-file-name"><AgentHighlightedText
                :text="file.name"
                :hits="hitsFor(row.id, `attach:${index}`)"
                :active="activeFor(row.id, `attach:${index}`)"
              /></span>
            </li>
          </ul>
        </p>
        <p
          v-else-if="row.kind === 'text'"
          class="agent-row agent-row-reply"
          :data-row="row.id"
        >
          <AgentHighlightedText
            :text="row.text"
            :hits="hitsFor(row.id, 'text')"
            :active="activeFor(row.id, 'text')"
          />
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
            <AgentHighlightedText
              :text="row.text"
              :hits="hitsFor(row.id, 'text')"
              :active="activeFor(row.id, 'text')"
            />
          </p>
        </div>
        <AgentToolActivity
          v-else
          :entry="row"
          :labels="labels.tool"
          :name-hits="hitsFor(row.id, 'name')"
          :name-active="activeFor(row.id, 'name')"
          :target-hits="hitsFor(row.id, 'target')"
          :target-active="activeFor(row.id, 'target')"
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
      :searching="searching"
      :labels="labels.controls"
      @follow="scroll.setFollowing($event)"
      @resume="scroll.resume()"
      @to-user="toUserMessage()"
      @to-top="scroll.toTop()"
      @search="toggleSearch()"
    />
  </div>
</template>

<style scoped>
.agent-timeline-wrap {
  /* The find bar and the log are a column, and the hint floats over the log rather than living in
     it: the composable reads the container's children as rows, and a control among them would be
     measured as one. */
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.agent-timeline {
  flex: 1;
  min-width: 0;
  /* A column's flex child does not shrink below its content without this, and a transcript that
     refused to shrink would push the composer off the rail instead of scrolling. */
  min-height: 0;
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
