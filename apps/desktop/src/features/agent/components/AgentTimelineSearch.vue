<script setup lang="ts">
/**
 * The transcript's find bar: the field, the count, the two arrows and the way out.
 *
 * It is Zed's own bar (`conversation_view/thread_search_bar.rs`): a single-line query field with
 * the match counter beside it, previous/next with wrap-around, and a close control — the field
 * placeholder is Zed's sentence about this thread, addressed to this conversation. The bar is a
 * *bar* rather than an overlay for the reason Zed puts it above the conversation: it takes its own
 * height, and it has to, because the transcript below it scrolls hits to its own top edge and an
 * overlaid bar would cover the very hit it just found.
 *
 * **It decides nothing.** The query is a prop with an `update:query` event, the count arrives
 * worked out, and the bar's own two sentences are the only thing it knows. Which rows match, how
 * many hits there are and which one the reader is on belong to
 * `services/agent-conversation-search.ts` and to the timeline that draws the rows; this file is
 * the keyboard and the geometry those answers are read from.
 *
 * **The three states are three different things on screen**, and the whole point of the middle
 * one being a sentence: no query at all (nothing to say), a query with hits (a count, `3/5`), and
 * a query that matched nothing (its own words). A count that read `0/0` would be a number the
 * reader has to translate, and one that read `0` beside a field they just typed in is the kind of
 * answer that leaves them wondering whether the search ran at all.
 *
 * **The keys are the ones a bar has**, and they are Zed's bindings
 * (`assets/keymaps/default-linux.json`, the `AcpThreadSearchBar` context): Escape, Enter for the
 * next hit, Shift+Enter for the previous. Escape gives up the *query* before it gives up the bar,
 * which is the rule this app's other find box keeps
 * (`AgentSessionHistoryMenu.vue`: "a query is cleared first, and only an empty box closes the
 * list") — and the one thing a reader must never lose to a habitual keypress is what they typed.
 *
 * The copy is read from the catalogue here rather than handed in through `AgentTimelineLabels`,
 * which is the direction this feature's newer components take (`AgentToolDiff.vue`,
 * `AgentCommandMenu.vue`). The label tree is assembled one level up in the rail body, and the
 * sentences below are this component's own business: nothing about them is a caller's choice.
 */
import { computed, nextTick, ref } from 'vue'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps<{
  /** What is in the box. Owned by the timeline, which is where the rows it searches live. */
  query: string
  /**
   * Which hit the reader is on, zero-based, or `-1` when there is none.
   *
   * An index rather than a hit: the bar counts and steps, and it is the timeline that knows which
   * row and which range that index names — and that is the half that scrolls.
   */
  index: number
  /** How many hits the query has. `0` with a non-empty query is the no-match state. */
  total: number
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  /** The reader asked for the next hit. Wraps at the end, in the caller. */
  next: []
  /** The same, backwards. */
  prev: []
  /** The reader is done with the bar. */
  close: []
}>()

const field = ref<HTMLInputElement | null>(null)

/** Both answers are about a query that exists: an empty box is not a search that found nothing. */
const hasQuery = computed(() => props.query.trim() !== '')
const hasHits = computed(() => props.total > 0)
/** Zed's own state: a query in the box that the thread has no answer for. */
const noMatch = computed(() => hasQuery.value && !hasHits.value)

/** The count as the reader reads it — and as the label explains it, since "3/5" is two numbers. */
const countLabel = computed(() =>
  t('agent.panel.timeline.search.count', { index: props.index + 1, total: props.total }),
)
const countText = computed(() => `${props.index + 1}/${props.total}`)

/** What every key does, in one place: the bar's keyboard is the whole of its interaction. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    // Two statements rather than one with a computed event name: `defineEmits`' overloads are
    // typed per event, and a union handed to one call is a union nothing can check.
    if (event.shiftKey) emit('prev')
    else emit('next')
    return
  }
  if (event.key !== 'Escape') return
  event.preventDefault()
  // Cancelable on purpose: Escape is also how a popup closes and how the panel's own surfaces
  // back out, and a press that emptied this box must not also take the rail away underneath it.
  if (props.query !== '') emit('update:query', '')
  else emit('close')
}

/** Hand the whole query back. The engine's rows are not this box's to forget — only its own. */
function clear(): void {
  emit('update:query', '')
  void nextTick(() => field.value?.focus())
}

/** Put the reader in the box. The timeline calls this the moment the bar opens. */
function focus(): void {
  field.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div
    class="agent-search"
    role="search"
    data-agent-search
  >
    <div class="agent-search-row">
      <!-- The box, with its own two controls inside it: what is in the field and what clears it
           are the same fact, and a clear button anywhere else would be a control about a field
           that is somewhere over there. -->
      <div class="agent-search-box">
        <Search
          class="agent-search-icon"
          :size="12"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        <input
          ref="field"
          class="agent-search-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :value="query"
          :aria-label="t('agent.panel.timeline.search.label')"
          :placeholder="t('agent.panel.timeline.search.placeholder')"
          data-conversation-search
          @input="emit('update:query', ($event.target as HTMLInputElement).value)"
          @keydown="onKeydown"
        >
        <span
          v-if="hasHits"
          class="agent-search-count"
          data-search-count
          :aria-label="countLabel"
        >{{ countText }}</span>
        <button
          v-if="query !== ''"
          class="agent-search-clear"
          type="button"
          :title="t('agent.panel.timeline.search.clear')"
          :aria-label="t('agent.panel.timeline.search.clear')"
          data-search-clear
          @mousedown.prevent
          @click="clear"
        >
          <X
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
          />
        </button>
      </div>
      <!-- The two arrows are drawn while there is a query and disabled while there is nothing to
           walk: a control that vanishes mid-typing is one the reader has to re-find, and a control
           that is there and refuses is the §5.2 shape a disabled state is for. -->
      <button
        v-if="hasQuery"
        class="agent-search-step"
        type="button"
        :title="t('agent.panel.timeline.search.previous')"
        :aria-label="t('agent.panel.timeline.search.previous')"
        :disabled="!hasHits"
        data-search-step="prev"
        @mousedown.prevent
        @click="emit('prev')"
      >
        <ChevronUp
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
      </button>
      <button
        v-if="hasQuery"
        class="agent-search-step"
        type="button"
        :title="t('agent.panel.timeline.search.next')"
        :aria-label="t('agent.panel.timeline.search.next')"
        :disabled="!hasHits"
        data-search-step="next"
        @mousedown.prevent
        @click="emit('next')"
      >
        <ChevronDown
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
      </button>
      <button
        class="agent-search-close"
        type="button"
        :title="t('agent.panel.timeline.search.close')"
        :aria-label="t('agent.panel.timeline.search.close')"
        data-search-close
        @mousedown.prevent
        @click="emit('close')"
      >
        <X
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
      </button>
    </div>
    <!-- The one sentence the bar has to say about the reader's own query, on a line of its own
         because that is what a sentence needs: the row above is the machinery, and this is the
         answer to what they typed. Zed's bar keeps its own message row in the same place
         (`thread_search_bar.rs:809-812`). -->
    <p
      v-if="noMatch"
      class="agent-search-none"
      data-search-none
    >
      {{ t('agent.panel.timeline.search.noMatch') }}
    </p>
  </div>
</template>

<style scoped>
.agent-search {
  flex: none;
  padding: 6px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  background: var(--app-panel);
  font-family: var(--app-font);
}
.agent-search-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.agent-search-box {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 5px;
  /* The rail is 220px at its narrowest and the field takes what is left after three buttons: a
     field that could not shrink would push the close control off the edge instead. */
  min-width: 0;
  padding: 0 6px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-canvas);
}
.agent-search-box:focus-within {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
.agent-search-icon {
  flex: none;
  color: var(--app-muted);
}
.agent-search-input {
  flex: 1;
  min-width: 0;
  padding: 5px 0;
  border: 0;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  /* The box is the ring: a second outline inside it would draw two rectangles. */
  outline: none;
}
.agent-search-input::placeholder {
  color: var(--app-muted);
}
/* Tabular figures so the count does not shuffle the field's width as the reader walks the hits. */
.agent-search-count {
  flex: none;
  color: var(--app-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.agent-search-clear,
.agent-search-step,
.agent-search-close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-search-step,
.agent-search-close {
  border: 1px solid var(--app-border);
  background: var(--app-canvas);
}
.agent-search-clear:hover,
.agent-search-step:hover:not(:disabled),
.agent-search-close:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  color: var(--app-text);
}
/* Disabled is a state, not an absence: the arrows stay where they were so the row does not
   reflow the moment the count reaches zero. Dimmed with opacity rather than by fading
   `--app-muted` into transparency, which is the shape the composer's own send button uses for
   the same reason (`AgentComposer.vue`: a value mixed out of muted drops below AA, so the rule
   is that muted is used whole). */
.agent-search-step:disabled {
  color: var(--app-muted);
  opacity: 0.55;
  cursor: default;
}
.agent-search-clear:focus-visible,
.agent-search-step:focus-visible,
.agent-search-close:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
.agent-search-none {
  margin: 5px 2px 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.4;
}
</style>
