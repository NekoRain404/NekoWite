<script lang="ts">
/**
 * The change view's copy, handed in rather than reached for.
 *
 * The same arrangement as `AgentPanelLabels`, and for the same reason: this task does not own
 * `src/i18n/namespaces/agent.ts`, so a sentence printed from a catalogue key that does not exist
 * would ship as an English string in a Chinese window. The caller supplies the words, and a
 * missing one is a compile error at the composition site instead of a surprise on screen.
 */
export interface AgentChangesLabels {
  title: string
  /** Nothing has changed yet: said, rather than left as an empty box. */
  empty: string
  close: string
  /**
   * What the row claims about who changed the file — §7.2's three states, each its own sentence
   * because they are three different facts and the user is owed the difference.
   */
  attribution: {
    /** A write-kind tool call of this session named the file. */
    agent: string
    /** The file changed on disk and nothing in this session claims it. */
    external: string
    /** The engine named the path; no tool call and no disk change confirmed it. */
    reported: string
  }
  /** What this window holds for the file, when a tab holds it at all. */
  verdict: {
    followsDisk: string
    unsavedEdits: string
  }
  offer: {
    view: string
    merge: string
    recover: string
  }
  /** Why an action is not on the row. Codes in, sentences out — see `AgentChangeRefusal`. */
  refused: {
    notAgentChange: string
    writeInFlight: string
    unsavedEdits: string
  }
  /** The two texts of a note in conflict, labelled so a merge view cannot show one as the other. */
  unsavedBuffer: string
  diskUnread: string
}
</script>

<script setup lang="ts">
/**
 * The change view: what a run changed, and what may be done about each file.
 *
 * Props in, events out (§10.2): no store, no gateway, no session, no editor. The rows arrive as
 * values that `agent-change-review.ts` already judged, and this file renders them — which is what
 * keeps the decision about *what may be done to a file* in the service that can see the tool call
 * and the buffer, and the decision about *what the user is looking at* here.
 *
 * It is deliberately unable to touch a document. There is no text input, no model write-back and
 * no per-row state: `view`, `merge` and `recover` are events, and whoever mounted this decides
 * what they mean. A component that reloaded the note itself would be a second editor-external-sync
 * with no idea whether the buffer is dirty — the exact way a save path loses the end of a
 * statement.
 *
 * The refusals are shown, not hidden. A row that quietly lacks a button reads as a feature that
 * was not built; a row that says *why* it has none is the one the user can act on (§7.2's
 * 「没有基线时标记不可直接恢复」 — the marking is the requirement).
 */
import { ArrowLeftRight, FileWarning, History, RotateCcw, Trash2, X } from 'lucide-vue-next'
import type { AgentChangeOffer, AgentChangeRow } from '../services/agent-change-review'

// `AgentChangesLabels` needs no import: the plain `<script>` block above is the same module, which
// is how `AgentPanel.vue` declares its own labels type and uses it in its setup block.
const props = defineProps<{
  rows: readonly AgentChangeRow[]
  labels: AgentChangesLabels
}>()

const emit = defineEmits<{
  /** Open the file and its diff. The only offer every row has. */
  (e: 'view', path: string): void
  /** Show the buffer's text and the file's, both of them, and let the user keep their own. */
  (e: 'merge', path: string): void
  /** Ask the host to put this file back to the baseline it recorded before the agent wrote. */
  (e: 'recover', path: string): void
  (e: 'close'): void
}>()

/** The offers drawn as buttons: everything but `view`, which the path itself carries. */
type AgentChangeButton = Exclude<AgentChangeOffer, 'view'>

/** The icon for an offer. Icons carry no meaning on their own here — every button has its word
 *  beside it, so a reader who cannot tell the glyphs apart loses nothing (§5.3). */
const ICONS: Record<AgentChangeButton, typeof RotateCcw> = {
  merge: ArrowLeftRight,
  recover: RotateCcw,
}

/**
 * The actions drawn as buttons beside the path.
 *
 * `view` is not among them: the path *is* the view control (§5.3 「单击进入 diff」), and a second
 * button for the same action would be one action with two names — which a keyboard user meets as
 * two tab stops that do the same thing. The path carries the label instead, so the control reads
 * as "View notes/a.md" to a screen reader rather than as a file name with no verb.
 */
function buttonsFor(row: AgentChangeRow): readonly AgentChangeButton[] {
  return row.offers.filter((offer): offer is AgentChangeButton => offer !== 'view')
}

/** The deletion and move kinds get a marker of their own: §7.2 requires them to be shown
 *  explicitly, and a row that looks like any other edit would hide a file that is gone. */
function isRemoval(row: AgentChangeRow): boolean {
  return row.tool === 'delete' || row.tool === 'move'
}

/** The refusal's sentence. Total over the union, so a new reason is a missing case here. */
function refusalText(row: AgentChangeRow): string | null {
  const refused = row.refused
  if (refused === null) return null
  switch (refused.reason) {
    case 'not-agent-change':
      return props.labels.refused.notAgentChange
    case 'write-in-flight':
      return props.labels.refused.writeInFlight
    case 'unsaved-edits':
      return props.labels.refused.unsavedEdits
  }
}

function offer(row: AgentChangeRow, offer: AgentChangeOffer): void {
  if (offer === 'view') emit('view', row.path)
  else if (offer === 'merge') emit('merge', row.path)
  else emit('recover', row.path)
}
</script>

<template>
  <section
    class="agent-changes"
    data-agent-changes
    :aria-label="labels.title"
  >
    <header class="agent-changes-head">
      <h2 class="agent-changes-title">
        {{ labels.title }}
      </h2>
      <button
        type="button"
        class="btn btn-ghost btn-sm agent-changes-close"
        data-action="close"
        @click="emit('close')"
      >
        <X
          :size="14"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ labels.close }}
      </button>
    </header>

    <!-- Nothing changed yet. A blank panel would be indistinguishable from one that failed to
         load, and the two are not the same fact. -->
    <p
      v-if="rows.length === 0"
      class="agent-changes-empty"
      data-changes-empty
    >
      {{ labels.empty }}
    </p>

    <ul
      v-else
      class="agent-changes-list"
    >
      <li
        v-for="row in rows"
        :key="row.path"
        class="agent-changes-row"
        :data-path="row.path"
        :data-attribution="row.attribution"
        :data-verdict="row.verdict.kind"
      >
        <div class="agent-changes-row-head">
          <!-- Clicking the path is the diff: §5.3's list, one click per file — and the only view
               control on the row, so the action and its name cannot be counted twice. -->
          <button
            type="button"
            class="agent-changes-path"
            data-action="view"
            :aria-label="`${labels.offer.view} ${row.path}`"
            @click="offer(row, 'view')"
          >
            {{ row.path }}
          </button>
          <span
            v-if="isRemoval(row)"
            class="agent-changes-removal"
            data-removal
          >
            <Trash2
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ row.tool }}
          </span>
        </div>

        <!-- The attribution is a word, never only a colour. "The agent changed this" and
             "something else did" are the two answers this panel exists to keep apart. -->
        <p class="agent-changes-claim">
          {{ labels.attribution[row.attribution] }}
        </p>

        <!-- A tab holds the file and its buffer is ahead of it: both texts are named. The
             buffer's is shown because it is the one that cannot be recovered from disk. -->
        <div
          v-if="row.verdict.kind === 'unsaved-edits'"
          class="agent-changes-buffer"
        >
          <p class="agent-changes-buffer-claim">
            <FileWarning
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ labels.verdict.unsavedEdits }}
          </p>
          <pre
            class="agent-changes-text"
            tabindex="0"
            :aria-label="labels.unsavedBuffer"
          >{{ row.verdict.bufferText }}</pre>
          <!-- Null is "the file was not read", and it is said in words: an empty block would
               show the user an empty file the agent had in fact changed. -->
          <p
            v-if="row.verdict.diskText === null"
            class="agent-changes-text-none"
            data-disk-unread
          >
            {{ labels.diskUnread }}
          </p>
        </div>
        <p
          v-else-if="row.verdict.kind === 'follows-disk'"
          class="agent-changes-follows"
        >
          {{ labels.verdict.followsDisk }}
        </p>

        <div class="agent-changes-actions">
          <button
            v-for="button in buttonsFor(row)"
            :key="button"
            type="button"
            class="btn btn-sm"
            :class="button === 'recover' ? 'btn-secondary' : 'btn-ghost'"
            :data-action="button"
            :data-path="row.path"
            @click="offer(row, button)"
          >
            <component
              :is="ICONS[button]"
              :size="14"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ labels.offer[button] }}
          </button>
          <!-- Why the missing one is missing. Without it the row reads as an unfinished
               feature rather than as a decision the user can still change. -->
          <span
            v-if="refusalText(row) !== null"
            class="agent-changes-refused"
            data-refused
            :data-refusal="row.refused?.reason"
          >
            <History
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ refusalText(row) }}
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.agent-changes {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  color: var(--app-text);
  font-size: 13px;
}
.agent-changes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.agent-changes-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.agent-changes-close {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.agent-changes-empty {
  margin: 0;
  color: var(--app-muted);
}
.agent-changes-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.agent-changes-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}
.agent-changes-row[data-verdict='unsaved-edits'] {
  /* The one state that is the user's own text at risk, so it is the one that gets the border. */
  border-color: color-mix(in srgb, var(--app-warn) 55%, var(--app-border));
}
.agent-changes-row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.agent-changes-path {
  min-width: 0;
  padding: 0;
  color: var(--app-text);
  font-family: var(--app-mono-font);
  font-size: 12px;
  text-align: left;
  /* A path has no spaces to break at. */
  overflow-wrap: anywhere;
  background: none;
  border: none;
  cursor: pointer;
}
.agent-changes-path:hover {
  color: var(--app-accent);
}
.agent-changes-removal {
  display: inline-flex;
  flex: none;
  gap: 3px;
  align-items: center;
  color: var(--app-warn);
  font-size: 11px;
}
.agent-changes-claim {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}
.agent-changes-buffer-claim {
  display: flex;
  gap: 4px;
  align-items: center;
  margin: 0;
  color: var(--app-warn);
  font-size: 12px;
}
.agent-changes-text {
  margin: 0;
  padding: 6px 8px;
  max-height: 160px;
  overflow: auto;
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--app-panel) 55%, var(--app-canvas));
  border-radius: var(--app-radius-sm);
}
.agent-changes-text-none {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}
.agent-changes-follows {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}
.agent-changes-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.agent-changes-actions .btn {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.agent-changes-refused {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  min-width: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.3;
}
</style>
