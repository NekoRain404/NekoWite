<script setup lang="ts">
/**
 * The change a tool call proposes, drawn line by line.
 *
 * This is the surface a person reads before allowing an edit, so the whole of its design is one
 * question: does it show what the engine actually proposed, and does it say what it does not
 * know? Four answers are load-bearing.
 *
 *  - **Nothing is drawn unless the call reported a `diff` block.** Props in, events out (§10.2),
 *    and the gate is the data's: a `read` call, a shell command, a search — none of them gets an
 *    empty diff frame. A frame with nothing in it is a statement about the engine that the engine
 *    did not make, and §5.1's rule about absence is the same rule here.
 *  - **The diff is recomputed from the block's own two texts.** ACP carries no hunks, so nothing
 *    here takes a summary on trust; `services/agent-tool-diff.ts` holds that decision and the
 *    rows' folding, which is why this file has no logic beyond which folds are open.
 *  - **What the render does not know, it says.** Three cases, each with its own sentence and none
 *    of them absorbed: the engine stated no original text (which is *not* proof of a new file —
 *    see `AgentToolContent`), the comparison stopped at the row cap, and the two texts are the
 *    same document (a diff that draws no row at all would read as "nothing to see" about a call
 *    that is still asking to touch the file).
 *  - **A block this version does not draw is named, not silently swallowed.** The wire's other two
 *    arms — a standard content block and a terminal — arrive as `unrecognised`, and a call whose
 *    only content was one of those would otherwise look exactly like a call that produced nothing.
 *
 * The copy comes from the catalogue directly rather than through a labels prop: these are this
 * component's own sentences about its own subject, which is the arrangement `AgentSessionBar`'s
 * `usage` block already uses, and threading them through `AgentToolLabels` would put them in a
 * type the timeline's tests pin for no gain.
 *
 * No accept/reject control is drawn here, deliberately. The reference client keeps hunk controls
 * out of its transcript for the same reason (`entry_view_state.rs:688`, the hidden hunk
 * renderer): the transcript is a record of what was proposed, and acting on the proposal is a
 * different surface's job — here, the permission prompt beside the composer.
 */
import { computed, ref } from 'vue'
import { ChevronRight, FileDiff } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { DIFF_MAX_LINES } from '../../../services/diff'
import type { AgentToolContent } from '../../../platform/gateways/agent-contracts'
import {
  diffBlocks,
  diffView,
  hasUndrawnContent,
  type AgentDiffFoldRow,
} from '../services/agent-tool-diff'

const props = defineProps<{
  /** The blocks the call reported, exactly as the row holds them. */
  content: readonly AgentToolContent[]
}>()

const blocks = computed(() => diffBlocks(props.content))
const undrawn = computed(() => hasUndrawnContent(props.content))

/** Whether there is anything here at all. The caller still guards its mount, but a component that
 *  answered "yes" to a request it cannot satisfy would be the empty frame this file exists not to
 *  draw. */
const anything = computed(() => blocks.value.length > 0 || undrawn.value)

/**
 * The folds the reader has opened, as `<block index>:<fold key>`.
 *
 * A string rather than a nested map because there are two levels and a flat set keeps the
 * computed below a filter instead of a walk. It is keyed by the fold's position in the
 * comparison, which is stable for as long as the block's texts are — and when they are not, a new
 * update rebuilds the rows and the stale keys can only open a fold that no longer exists, which
 * shows lines rather than hiding them.
 */
const open = ref<readonly string[]>([])

function reveal(block: number, key: number): void {
  open.value = [...open.value, `${block}:${key}`]
}

/** One view per block, each with the folds the reader has opened applied. */
const views = computed(() =>
  blocks.value.map((block, index) => {
    const prefix = `${index}:`
    const unfolded = new Set(
      open.value
        .filter((id) => id.startsWith(prefix))
        .map((id) => Number(id.slice(prefix.length))),
    )
    return diffView(block, unfolded)
  }),
)

/** The character that carries a row's meaning when the colour cannot (§5.3): a diff drawn in two
 *  shades of grey is a diff nobody can read. The word beside it is the header's stat. */
const SIGNS: Record<'add' | 'del' | 'same', string> = { add: '+', del: '−', same: ' ' }

function foldTitle(row: AgentDiffFoldRow): string {
  return t('agent.panel.timeline.tool.diff.reveal', { n: row.count })
}
</script>

<template>
  <section
    v-if="anything"
    class="agent-diff"
    data-agent-diff
  >
    <h4
      v-if="blocks.length > 0"
      class="agent-diff-label"
    >
      {{ t('agent.panel.timeline.tool.diff.label') }}
    </h4>
    <!-- One card per block: an edit may propose several files at once, and they are separate
         changes rather than one list. Keyed by index because the engine's own order is the
         identity a block has — the schema carries no id for one. -->
    <article
      v-for="(view, index) in views"
      :key="index"
      class="agent-diff-block"
      :data-path="view.path"
      :data-identical="view.identical ? 'true' : 'false'"
    >
      <header class="agent-diff-head">
        <FileDiff
          class="agent-diff-icon"
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        <!-- The engine's own path, and nothing when it sent none: a surface that wrote a
             heading for a blank would be naming the file the engine did not. -->
        <span
          v-if="view.path !== ''"
          class="agent-diff-path"
          :title="view.path"
        >{{ view.path }}</span>
        <!-- The counts, and only when there is one to show. `+0 −0` is not drawn: over a pair the
             comparison found equal it would be noise, and over a pair whose difference is past the
             row cap it would be a claim the note below contradicts. -->
        <span
          v-if="view.added + view.removed > 0"
          class="agent-diff-stat"
        >
          <span class="agent-diff-added">{{ t('agent.panel.timeline.tool.diff.added', { n: view.added }) }}</span>
          <span class="agent-diff-removed">{{ t('agent.panel.timeline.tool.diff.removed', { n: view.removed }) }}</span>
        </span>
      </header>
      <!-- The absence, in the engine's own terms rather than as a conclusion. `oldText: null`
           means the engine stated no original text; the schema *glosses* that as a new file, and
           the field's default-on-error deserialization means an unreadable original arrives the
           same way, so this sentence claims only what was received. -->
      <p
        v-if="!view.statedOldText"
        class="agent-diff-note"
        data-agent-diff-no-original
      >
        {{ t('agent.panel.timeline.tool.diff.noOriginal') }}
      </p>
      <!-- The row cap, stated rather than absorbed: the rows below are a prefix of the change,
           and a reader who is about to allow an edit must know that the rest is not here. The two
           sentences are separate because they are two different facts — "the change may be past
           these lines" and "the change is past these lines", the second of which the rows
           themselves cannot show, since they hold no changed line at all. -->
      <p
        v-if="view.beyond"
        class="agent-diff-note"
        data-agent-diff-beyond
      >
        {{ t('agent.panel.timeline.tool.diff.beyond', { n: DIFF_MAX_LINES }) }}
      </p>
      <p
        v-else-if="view.partial"
        class="agent-diff-note"
        data-agent-diff-partial
      >
        {{ t('agent.panel.timeline.tool.diff.partial', { n: DIFF_MAX_LINES }) }}
      </p>
      <!-- Same text on both sides. Drawn as a sentence and not as an empty list: the block is
           still a proposal to touch the file, and "no rows" would read as nothing to see. -->
      <p
        v-if="view.identical"
        class="agent-diff-same"
        data-agent-diff-identical
      >
        {{ t('agent.panel.timeline.tool.diff.identical') }}
      </p>
      <div
        v-else
        class="agent-diff-rows"
      >
        <template
          v-for="(row, at) in view.rows"
          :key="at"
        >
          <!-- A fold is a control, not a decoration: the count is on its face and pressing it
               shows exactly those lines. Nothing is dropped without saying how much. -->
          <button
            v-if="row.kind === 'fold'"
            class="agent-diff-fold"
            type="button"
            :title="foldTitle(row)"
            @click="reveal(index, row.key)"
          >
            <ChevronRight
              :size="12"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ t('agent.panel.timeline.tool.diff.folded', { n: row.count }) }}
          </button>
          <div
            v-else
            class="agent-diff-line"
            :data-type="row.type"
          >
            <span
              class="agent-diff-gutter"
              aria-hidden="true"
            >{{ row.oldLine ?? '' }}</span>
            <span
              class="agent-diff-gutter"
              aria-hidden="true"
            >{{ row.newLine ?? '' }}</span>
            <span
              class="agent-diff-sign"
              aria-hidden="true"
            >{{ SIGNS[row.type] }}</span>
            <code class="agent-diff-text">{{ row.text || ' ' }}</code>
          </div>
        </template>
      </div>
    </article>
    <!-- The sibling arms of the wire's union. One line, and it exists so that a call whose whole
         content was a block this version does not draw is not drawn identically to a call that
         produced nothing. -->
    <p
      v-if="undrawn"
      class="agent-diff-note agent-diff-undrawn"
      data-agent-diff-undrawn
    >
      {{ t('agent.panel.timeline.tool.diff.undrawn') }}
    </p>
  </section>
</template>

<style scoped>
.agent-diff {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.agent-diff-label {
  margin: 6px 0 0;
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.agent-diff-block {
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-xs);
  background: var(--app-canvas);
  overflow: hidden;
}
.agent-diff-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--app-border);
  color: var(--app-muted);
  font-size: 12px;
}
.agent-diff-icon {
  flex: none;
}
.agent-diff-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--app-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-diff-stat {
  display: inline-flex;
  flex: none;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
/* The counts are the colour's only job, and the `+`/`−` on every row says the same thing (§5.3:
   never colour alone). */
.agent-diff-added {
  color: var(--app-success);
}
.agent-diff-removed {
  color: var(--app-danger);
}
.agent-diff-note,
.agent-diff-same {
  margin: 0;
  padding: 6px 8px;
  color: var(--app-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.agent-diff-note {
  border-bottom: 1px solid var(--app-border);
}
.agent-diff-rows {
  /* Bounded in both directions, like the tool body's own pre: the panel is 400px wide and a
     whole-file rewrite is thousands of rows, so the block scrolls rather than pushing the
     transcript's own scrollback to an unusable length. */
  max-height: 360px;
  padding: 4px 0;
  overflow: auto;
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.5;
}
.agent-diff-line {
  display: flex;
  align-items: baseline;
  padding: 0 8px 0 4px;
}
.agent-diff-line[data-type='add'] {
  background: color-mix(in srgb, var(--app-success) 12%, transparent);
}
.agent-diff-line[data-type='del'] {
  background: color-mix(in srgb, var(--app-danger) 12%, transparent);
}
.agent-diff-gutter {
  flex: none;
  width: 3ch;
  padding-right: 4px;
  color: var(--app-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.agent-diff-sign {
  flex: none;
  width: 2ch;
  color: var(--app-muted);
  text-align: center;
  user-select: none;
}
.agent-diff-line[data-type='add'] .agent-diff-sign {
  color: var(--app-success);
}
.agent-diff-line[data-type='del'] .agent-diff-sign {
  color: var(--app-danger);
}
.agent-diff-text {
  flex: 1;
  min-width: 0;
  color: var(--app-text);
  /* A minified line is any length. It wraps in the column rather than widening the panel, which
     is the same rule the tool body's own pre follows. */
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.agent-diff-fold {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  /* A control in the panel's own hit-area rung, and the panel's own font rather than the mono
     one: this row is a sentence about the file, not a line of it. */
  min-height: 26px;
  padding: 2px 8px;
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  background: color-mix(in srgb, var(--app-elevated) 60%, transparent);
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.agent-diff-fold:hover {
  color: var(--app-text);
}
.agent-diff-fold:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
}
.agent-diff-undrawn {
  border: none;
}
</style>
