<script lang="ts">
/**
 * The change view's copy, handed in rather than reached for.
 *
 * The same arrangement as `AgentPanelLabels`, and for the same reason: this component does not own
 * `src/i18n/namespaces/agent.ts`, so a sentence printed from a catalogue key that does not exist
 * would ship as an English string in a Chinese window. The caller supplies the words, and a
 * missing one is a compile error at the composition site instead of a surprise on screen.
 */
export interface AgentChangesLabels {
  title: string
  /** Nothing has changed yet: said, rather than left as an empty box. */
  empty: string
  /** One line for the whole list, counts and all — what the header still reads when collapsed. */
  summary: string
  collapse: string
  expand: string
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
  /** The three answers, in the order the row draws them: look at it, keep it, put it back. */
  offer: {
    view: string
    keep: string
    recover: string
  }
  /** Why an action is not on the row. Codes in, sentences out — see `AgentChangeRefusal`. */
  refused: {
    notAgentChange: string
    writeInFlight: string
    noBaseline: string
    vaultMismatch: string
    unsavedEdits: string
    resultUnstated: string
    changedSince: string
  }
  /** What the user answered, said on the row that is no longer asking. */
  decision: {
    kept: string
    rejected: string
  }
  /** What a rejection did, in the three facts §7.2 keeps apart — the editor's own write. */
  written: {
    saved: string
    saveFailed: string
    unavailable: string
  }
  /**
   * What the host's own recovery did, and why it did not.
   *
   * `recovered` is the file put back, and `recoveredWarning` is drawn under it when the app could
   * not keep the version it replaced — "the file is back, but the previous version is gone" is a
   * fact the reader has to be told. `refused` is keyed by the host's own six codes, one sentence
   * each, for the same reason the review's refusals are: each names a different thing to do.
   */
  recovered: {
    recovered: string
    recoveredWarning: string
    refused: {
      noBaseline: string
      baselineStale: string
      unavailable: string
      changedSinceRecorded: string
      alreadyAtBaseline: string
      writeRefused: string
    }
    /** The call itself did not complete; the host's own sentence says which fact it was. */
    unreachable: string
  }
  /** The two texts of a note in conflict, labelled so a merge view cannot show one as the other. */
  unsavedBuffer: string
  agentVersion: string
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
 * no per-row state: `view`, `keep` and `recover` are events, and whoever mounted this decides
 * what they mean. A component that reloaded the note itself would be a second editor-external-sync
 * with no idea whether the buffer is dirty — the exact way a save path loses the end of a
 * statement.
 *
 * The refusals are shown, not hidden. A row that quietly lacks a button reads as a feature that
 * was not built; a row that says *why* it has none is the one the user can act on (§7.2's
 * 「没有基线时标记不可直接恢复」 — the marking is the requirement).
 *
 * `open` is the host's, not this file's: collapsing the strip is a decision about the surface's
 * place in the window, and a component that kept it locally would lose it the moment the pane
 * remounted.
 */
import { Check, ChevronDown, ChevronRight, FileWarning, History, RotateCcw, Trash2 } from 'lucide-vue-next'
import type { AgentRecoveryRefusalCode } from '../../../platform/gateways/agent-contracts'
import type { AgentChangeOffer, AgentChangeRow } from '../services/agent-change-review'

// `AgentChangesLabels` needs no import: the plain `<script>` block above is the same module, which
// is how `AgentPanel.vue` declares its own labels type and uses it in its setup block.
const props = defineProps<{
  rows: readonly AgentChangeRow[]
  labels: AgentChangesLabels
  /** Whether the rows are drawn or the strip is collapsed to its header. */
  open: boolean
}>()

const emit = defineEmits<{
  /** Open the file in the editor. The only offer every row has. */
  (e: 'view', path: string): void
  /** The change stays, and this is the user's answer about it. Nothing is written. */
  (e: 'keep', path: string): void
  /** Put this file back to the text it held when the request was made. */
  (e: 'recover', path: string): void
  (e: 'toggle'): void
}>()

/** The buttons a row can draw: the service's offers but for `view` (the path carries that one),
 *  plus `keep`, which is not an offer at all — every unanswered row has it, because "this change is
 *  what I want" is an answer the user can always give and nothing has to be true for it to be
 *  available. */
type AgentChangeButton = Exclude<AgentChangeOffer, 'view'> | 'keep'

/** The icon for an offer. Icons carry no meaning on their own here — every button has its word
 *  beside it, so a reader who cannot tell the glyphs apart loses nothing (§5.3). */
const ICONS: Record<AgentChangeButton, typeof RotateCcw> = {
  keep: Check,
  recover: RotateCcw,
}

/**
 * The actions drawn as buttons beside the path, for a row the user has not answered.
 *
 * `view` is not among them: the path *is* the view control (§5.3 「单击进入 diff」), and a second
 * button for the same action would be one action with two names — which a keyboard user meets as
 * two tab stops that do the same thing. The path carries the label instead, so the control reads
 * as "Review notes/a.md" to a screen reader rather than as a file name with no verb.
 *
 * A decided row draws none of them: the question was answered, and the row says what with.
 *
 * The order is the reading order, and it is the safe answer first: `keep` writes nothing and cannot
 * take anything away, so it is the control a keyboard reaches first — the same rule the edit
 * conflict view follows.
 */
function buttonsFor(row: AgentChangeRow): readonly AgentChangeButton[] {
  if (row.decision !== null) return []
  const written = row.offers.filter((offer): offer is 'recover' => offer === 'recover')
  return ['keep', ...written]
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
    case 'no-baseline':
      return props.labels.refused.noBaseline
    case 'vault-mismatch':
      return props.labels.refused.vaultMismatch
    case 'unsaved-edits':
      return props.labels.refused.unsavedEdits
    case 'result-unstated':
      return props.labels.refused.resultUnstated
    case 'changed-since':
      return props.labels.refused.changedSince
  }
}

/**
 * What became of a rejection, in every arm one can end in. `null` for a keep, which writes
 * nothing — and the row says only that it was kept.
 *
 * The arms are total over the union and switch rather than fall through, so a writer added later
 * is a missing case here rather than a row that silently draws nothing.
 */
function rejectionText(row: AgentChangeRow): string | null {
  const rejection = row.decision?.rejection ?? null
  if (rejection === null) return null
  switch (rejection.via) {
    case 'editor':
      if (rejection.written.status === 'saved') return props.labels.written.saved
      if (rejection.written.status === 'save-failed') return props.labels.written.saveFailed
      return props.labels.written.unavailable
    case 'host': {
      const answer = rejection.answered
      if (answer.kind === 'recovered') {
        return answer.warning === null
          ? props.labels.recovered.recovered
          : `${props.labels.recovered.recovered} ${props.labels.recovered.recoveredWarning}`
      }
      return props.labels.recovered.refused[REFUSAL_LABELS[answer.code]]
    }
    case 'unreachable':
      // The host's own sentence, verbatim: the row's lead-in already says what was attempted, and
      // a sentence this file rewrote would be this window describing a failure it did not see.
      return `${props.labels.recovered.unreachable} ${rejection.message}`
  }
}

/**
 * The host's refusal codes as the label keys they are drawn from.
 *
 * A table rather than a chain of `if`s for the reason the labels are a copy tree at all: the six
 * codes are the contract's (`AGENT_RECOVERY_REFUSALS`) and the six sentences are this view's, and
 * a code with no entry is a type error here rather than a blank row.
 */
const REFUSAL_LABELS: Record<AgentRecoveryRefusalCode, keyof AgentChangesLabels['recovered']['refused']> = {
  'no-baseline': 'noBaseline',
  'baseline-stale': 'baselineStale',
  unavailable: 'unavailable',
  'changed-since-recorded': 'changedSinceRecorded',
  'already-at-baseline': 'alreadyAtBaseline',
  'write-refused': 'writeRefused',
}

/** The decision's own word, for the row that is no longer asking. */
function decisionText(row: AgentChangeRow): string | null {
  const decision = row.decision
  if (decision === null) return null
  return decision.decision === 'kept' ? props.labels.decision.kept : props.labels.decision.rejected
}

/** The path's own control carries `view`; every drawn button carries one of the three answers. */
type AgentChangeChoice = AgentChangeOffer | AgentChangeButton

function offer(row: AgentChangeRow, choice: AgentChangeChoice): void {
  if (choice === 'view') emit('view', row.path)
  else if (choice === 'keep') emit('keep', row.path)
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
      <!-- The counts, and they are the whole of what a reader needs to decide whether to open the
           list: how much this run touched, and how much of it is still unanswered. Drawn only when
           there is something to count — beside the empty sentence below it would be four zeros. -->
      <p
        v-if="rows.length > 0"
        class="agent-changes-summary"
        data-changes-summary
      >
        {{ labels.summary }}
      </p>
      <button
        type="button"
        class="btn btn-ghost btn-sm agent-changes-toggle"
        :data-action="open ? 'collapse' : 'expand'"
        :aria-expanded="open"
        @click="emit('toggle')"
      >
        <component
          :is="open ? ChevronDown : ChevronRight"
          :size="14"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ open ? labels.collapse : labels.expand }}
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
      v-else-if="open"
      class="agent-changes-list"
    >
      <li
        v-for="row in rows"
        :key="row.path"
        class="agent-changes-row"
        :data-path="row.path"
        :data-attribution="row.attribution"
        :data-verdict="row.verdict.kind"
        :data-decision="row.decision?.decision ?? 'none'"
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
             buffer's is shown because it is the one that cannot be recovered from disk, and the
             file's is the one the call said it left — which is the only place it is drawn, since
             otherwise the file's text is what the editor already has on screen. -->
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
          <div
            class="agent-changes-text-block"
            data-unsaved-buffer
          >
            <p class="agent-changes-text-label">
              {{ labels.unsavedBuffer }}
            </p>
            <pre
              class="agent-changes-text"
              tabindex="0"
            >{{ row.verdict.bufferText }}</pre>
          </div>
          <div
            v-if="row.result !== null"
            class="agent-changes-text-block"
            data-agent-version
          >
            <p class="agent-changes-text-label">
              {{ labels.agentVersion }}
            </p>
            <pre
              class="agent-changes-text"
              tabindex="0"
            >{{ row.result }}</pre>
          </div>
          <!-- Null is "the file was not read", and it is said in words: an empty block would
               show the user an empty file the agent had in fact changed. -->
          <p
            v-else
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

        <!-- The answer, on the row that is no longer asking. A rejection carries what the write
             did, and the three arms are said apart: the note and the file, the note alone, and
             nothing at all. -->
        <template v-if="row.decision !== null">
          <p class="agent-changes-decision">
            {{ decisionText(row) }}
          </p>
          <p
            v-if="rejectionText(row) !== null"
            class="agent-changes-outcome"
            data-decision-outcome
            role="status"
          >
            {{ rejectionText(row) }}
          </p>
        </template>

        <div
          v-else
          class="agent-changes-actions"
        >
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
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.agent-changes-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.agent-changes-summary {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}
.agent-changes-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
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
.agent-changes-buffer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.agent-changes-buffer-claim {
  display: flex;
  gap: 4px;
  align-items: center;
  margin: 0;
  color: var(--app-warn);
  font-size: 12px;
}
.agent-changes-text-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.agent-changes-text-label {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
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
/* The tab stop above, made visible. Measured in WebKitGTK, the engine's own `outline: auto` on
   this element paints one five-pixel bar down its left edge and nothing along the other three —
   a fragment rather than an indicator. Same rule as the permission prompt's arguments and the
   agent transcript's container; INSET because the element is the full size of its scroll body. */
.agent-changes-text:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
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
.agent-changes-decision {
  margin: 0;
  color: var(--app-text);
  font-size: 12px;
  font-weight: 600;
}
.agent-changes-outcome {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.35;
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
