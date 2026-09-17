<script lang="ts">
/**
 * The copy a tool row needs, handed in rather than reached for.
 *
 * These sentences arrived as a prop while the catalogue had no keys for them, and they stay one:
 * the caller that mounts the panel is the caller that supplies every word it shows, and
 * `AgentRailBody` reads them from `agent.panel.timeline.tool.*`. The newer components beside this
 * one take the other direction — the catalogue's own key, with an optional override — which is
 * what `AgentToolDiff` does for the sentences it owns. Both are supported; neither is a missing
 * sentence waiting to become an English string.
 *
 * `status` is a record over the contract's own statuses, not a free map: a status the engine
 * adds later fails to typecheck here rather than rendering as a blank word.
 */
import type { AgentToolStatus } from '../../../platform/gateways/agent-contracts'
import type { AgentHitRange } from './AgentHighlightedText.vue'

export interface AgentToolLabels {
  /** What to call each state the contract allows, e.g. queued / running / failed. */
  status: Record<AgentToolStatus, string>
  /** The disclosure's tooltip, per state. */
  expand: string
  collapse: string
  /** The two sections of the expanded body. */
  args: string
  output: string
  /** The engine sent no arguments / no output — a different statement from "unreadable",
   *  which is why the contract keeps them apart and why they read differently here. */
  argsAbsent: string
  argsUnreadable: string
  outputAbsent: string
  outputUnreadable: string
}
</script>

<script setup lang="ts">
/**
 * One tool call: name, target and status on a compact line, with the arguments and the output
 * behind a disclosure (§5.3 「工具活动：紧凑的可展开行；名称、目标、状态，展开才看参数和输出」).
 *
 * Props in, events out (§10.2) — no store, no gateway, no session. It renders what the row
 * already holds and reports the one thing it decided: whether it is open. The timeline is
 * what turns that into the anchor correction the reader needs (§5.2), because the height
 * change is real whether or not anyone is told about it.
 *
 * Three choices worth the words:
 *
 *  - **the body is rendered only while open.** That is the "loaded on demand" of §5.1: the
 *    arguments and the output are not in the DOM of a collapsed row, which is what keeps a
 *    transcript of two hundred tool calls cheap. Nothing is fetched, because nothing here can
 *    be — the contract carries the call's input and output in the row itself, so there is no
 *    second read to make.
 *  - **it does not expand itself, not even on failure.** A row that opens on its own moves
 *    everything below it while the reader is somewhere else in the transcript. The failure is
 *    one click away and the status word is on the row, so the error stays reachable without
 *    the transcript moving on its own (§5.1 「长输出折叠并按需加载，仍能查看错误」).
 *  - **status is word and icon together**, never colour alone (§5.3). Colour only shifts the
 *    icon and the word: a reader who cannot tell the two reds apart still reads "Failed".
 *
 * `data-row` is the timeline's own identity for this row, and it is here rather than only on the
 * rows the timeline draws itself: every row of the transcript answers to one name (the store's id
 * for it), and a tool row that answered to none was the one kind a `[data-row]` lookup could not
 * find — including the find bar's own reading of how many rows carry a hit.
 */
import { computed, ref } from 'vue'
import AgentToolDiff from './AgentToolDiff.vue'
import AgentHighlightedText from './AgentHighlightedText.vue'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  FileText,
  Globe,
  Loader,
  Move,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-vue-next'
import type { AgentToolKind } from '../../../platform/gateways/agent-contracts'
import type { AgentToolEntry } from '../services/agent-timeline'

const props = defineProps<{
  /** The row to draw, exactly as the store reduced it. */
  entry: AgentToolEntry
  labels: AgentToolLabels
  /**
   * The find bar's hits, one pair per string this row's header draws — the name it leads with and
   * the target beside it. Absent when no row is marked, which is every row while the bar is shut:
   * the timeline hands out one shared absence so a search that does not touch this row cannot
   * re-render it.
   *
   * Only the header. The body's blocks are drawn inside their own scroll boxes and the change is
   * folded by its own disclosure, so a hit in one of them is not a hit the transcript's scroll can
   * bring the reader to — see `services/agent-conversation-search.ts`, which is where that line is
   * drawn and where it is justified.
   */
  nameHits?: readonly AgentHitRange[]
  nameActive?: number
  targetHits?: readonly AgentHitRange[]
  targetActive?: number
}>()

const emit = defineEmits<{
  /** The disclosure changed the row's height. The timeline holds the reader with it. */
  toggle: [open: boolean]
}>()

/** Category icon, for scanning a transcript: what the call is doing, before reading the
 *  sentence. `other` and `switch_mode` share the wrench because the contract has no icon
 *  vocabulary of its own and inventing a second symbol for "some other tool" would say more
 *  than the engine did. */
const KIND_ICONS: Record<AgentToolKind, typeof Wrench> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: Move,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Wrench,
  other: Wrench,
}

/** Status icon: the half of the pair that is not a word. */
const STATUS_ICONS: Record<AgentToolStatus, typeof Wrench> = {
  pending: Clock,
  in_progress: Loader,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: CircleSlash,
}

const open = ref(false)
const kindIcon = computed(() => KIND_ICONS[props.entry.toolKind])
const statusIcon = computed(() => STATUS_ICONS[props.entry.status])
const statusLabel = computed(() => props.labels.status[props.entry.status])

/** The row's target: what it touches. The title is the engine's sentence about the call, so
 *  the file paths beside it are the part a reader scans for. */
const target = computed(() => props.entry.paths.join(', '))
const script = computed(() => props.entry.name ?? props.entry.title)
const title = computed(() =>
  [props.entry.title, target.value].filter((part) => part !== '').join(' — '),
)

/** The arguments, or null when there are none to show — and the sentence that stands in when
 *  there are none, which the contract distinguishes: "the engine sent nothing" and "the
 *  engine sent something this app could not read" are different statements about the call. */
const args = computed(() => (props.entry.input.state === 'text' ? props.entry.input.json : null))
const argsNote = computed(() =>
  props.entry.input.state === 'unreadable' ? props.labels.argsUnreadable : props.labels.argsAbsent,
)
const output = computed(() =>
  props.entry.output.state === 'text' ? props.entry.output.json : null,
)
const outputNote = computed(() =>
  props.entry.output.state === 'unreadable'
    ? props.labels.outputUnreadable
    : props.labels.outputAbsent,
)

function toggle(): void {
  open.value = !open.value
  emit('toggle', open.value)
}
</script>

<template>
  <div
    class="agent-tool"
    :data-row="entry.id"
    :data-status="entry.status"
    :data-kind="entry.toolKind"
    :data-call="entry.toolCallId"
    :data-open="open ? 'true' : 'false'"
  >
    <button
      class="agent-tool-head"
      type="button"
      :title="open ? labels.collapse : labels.expand"
      :aria-expanded="open"
      @click="toggle"
    >
      <component
        :is="kindIcon"
        class="agent-tool-kind"
        :size="13"
        :stroke-width="1.8"
      />
      <span class="agent-tool-name"><AgentHighlightedText
        :text="script"
        :hits="nameHits"
        :active="nameActive ?? -1"
      /></span>
      <span
        v-if="target"
        class="agent-tool-target"
        :title="title"
      ><AgentHighlightedText
        :text="target"
        :hits="targetHits"
        :active="targetActive ?? -1"
      /></span>
      <span class="agent-tool-status">
        <component
          :is="statusIcon"
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ statusLabel }}
      </span>
      <component
        :is="open ? ChevronDown : ChevronRight"
        class="agent-tool-chevron"
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
    <div
      v-if="open"
      class="agent-tool-body"
    >
      <!-- First, and above the arguments, because it is the thing the row is about: where the
           engine proposes a change, the change is what the reader came for and the arguments are
           the working. It draws nothing at all for a call that reported no `diff` block, which is
           every call of every other kind. -->
      <AgentToolDiff :content="entry.content" />
      <section class="agent-tool-section">
        <h4 class="agent-tool-label">
          {{ labels.args }}
        </h4>
        <pre
          v-if="args !== null"
          class="agent-tool-pre"
        >{{ args }}</pre>
        <p
          v-else
          class="agent-tool-note"
        >
          {{ argsNote }}
        </p>
      </section>
      <section class="agent-tool-section">
        <h4 class="agent-tool-label">
          {{ labels.output }}
        </h4>
        <pre
          v-if="output !== null"
          class="agent-tool-pre"
        >{{ output }}</pre>
        <p
          v-else
          class="agent-tool-note"
        >
          {{ outputNote }}
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.agent-tool {
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}
.agent-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  /* §5.3's tool row: 28–32px, and the whole row is the hit area rather than the 13px icon. */
  min-height: 28px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-tool-head:hover {
  background: color-mix(in srgb, var(--app-elevated) 80%, transparent);
}
.agent-tool-head:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
}
.agent-tool-kind {
  flex: none;
  color: var(--app-muted);
}
.agent-tool-name {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tool-target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--app-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tool-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  color: var(--app-muted);
}
/* Colour is the second signal, never the only one: the word beside each icon says the same
   thing. Only the two states that carry a decision shift hue at all — a call still running
   reads as ordinary text, which is what keeps a transcript of twenty calls quiet. */
.agent-tool[data-status='failed'] .agent-tool-status {
  color: var(--app-danger);
}
.agent-tool[data-status='completed'] .agent-tool-status {
  color: var(--app-success);
}
.agent-tool[data-status='in_progress'] .agent-tool-status {
  color: var(--app-text);
}
/* The one animation in this file, and it is on a 13px icon: a running call has to look
   running. It rides the app's own spin token, so the global reduced-motion sweep turns it
   off with everything else (§5.2). */
.agent-tool[data-status='in_progress'] .agent-tool-status svg {
  animation: agent-tool-spin var(--app-motion-spin) linear infinite;
}
@keyframes agent-tool-spin {
  to {
    transform: rotate(360deg);
  }
}
.agent-tool-chevron {
  flex: none;
  color: var(--app-muted);
}
.agent-tool-body {
  padding: 2px 8px 8px;
  border-top: 1px solid var(--app-border);
}
.agent-tool-section + .agent-tool-section {
  margin-top: 8px;
}
.agent-tool-label {
  margin: 6px 0 4px;
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.agent-tool-pre {
  /* Bounded in both directions: the panel is 400px wide and a tool can return a minified
     line of any length, so the block scrolls instead of widening the panel (§5.3). */
  max-height: 260px;
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--app-radius-xs);
  background: var(--app-canvas);
  color: var(--app-text);
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.5;
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.agent-tool-note {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}
</style>
