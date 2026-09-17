<script lang="ts">
/**
 * Which of the four things there are to show. Modelled as one value rather than as a `rows.length`
 * test over a `loaded` flag, because the four are four different sentences: still reading, read
 * and empty, read and unreadable, and rows. A component that inferred them would say "the engine
 * holds no sessions" for a question it never got an answer to.
 */
export type AgentSessionHistoryView = 'loading' | 'rows' | 'empty' | 'unreadable'

/**
 * What the strip under the rows is saying, if anything.
 *
 * Three states of one conversation, and each exists because the alternative is a reader drawing a
 * wrong conclusion: `confirm` is the question the free action has to ask (the engine keeps the
 * session, which is a fact a deletion-shaped gesture would hide), `freed` is the answer to "why is
 * the row still there", and `failed` is the engine's own refusal. The panel owns which one is up;
 * this component only draws it.
 */
export type AgentSessionHistoryFooter =
  | { kind: 'confirm' }
  | { kind: 'freed' }
  | { kind: 'failed'; reason: string }
</script>

<script setup lang="ts">
/**
 * The history menu's list: the sessions the engine holds, the row Enter would take, and the
 * sentence that stands in when there is nothing to show.
 *
 * It draws rows and reports what the user did to one — no store, no gateway, no protocol (§6.1):
 * `view` and `rows` arrive already decided by `AgentPanel`, which is where the gateway and the
 * session are, and nothing here calls anything. The placement comes in as four numbers because
 * the panel measured it against the trigger, which lives in the session bar.
 *
 * **It owns the keyboard, unlike the config picker.** That picker keeps focus on its trigger and
 * hands the arrows to it (`AgentConfigPicker.vue`); here the find box above the rows takes focus
 * on arrival and every key the list needs — the arrows, Home/End, Enter — bubbles to the one
 * handler below, so there is still exactly one place the highlight lives and a reader can type,
 * arrow and commit without leaving the field. Escape is the one key with two meanings, and it is
 * ordered: a query is cleared first, and only an empty box closes the list.
 *
 * The rows follow the app's list vocabulary — one row per session, `role="option"`,
 * `aria-activedescendant` on the listbox — and Enter, a click and a pointer-down-and-release all
 * mean the same thing. The listbox owns options and nothing else, which is why the page sentence
 * and the notices sit outside it and why the free action below is a sibling of the option.
 *
 * What a row may say is deliberately narrow. The title is the engine's or it is absent, and the
 * absence is drawn as a statement about the engine rather than as a name this app invented; the
 * age is the engine's own `updatedAt` read (`services/agent-session-history.ts`); and the two
 * marks beside it are the two facts a reader needs before pressing anything — this is the one
 * already open, and this one was recorded in another folder.
 *
 * **The list can be narrowed without asking the engine anything.** `filterSessionRows` is a
 * service rule over the rows already in hand, so what a query leaves is the engine's own answer
 * with rows removed, never a second list this app composed — and a query that leaves nothing says
 * so in a sentence of its own, rather than by drawing an empty box.
 *
 * **The free action is a second element beside the option, not inside it.** A listbox may only
 * own options, and an interactive child inside one is a control whose role the AT cannot
 * announce; so a row is a wrapper holding the option and, when the engine reports `session-close`
 * *and* the row is not the session on screen, the button that asks to free it. The option stays
 * the whole width of the row, and the button is the only part of it that is not the row.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import {
  describeSessionAge,
  filterSessionRows,
  type AgentSessionHistoryRow,
} from '../services/agent-session-history'
import AgentSessionHistoryHead from './AgentSessionHistoryHead.vue'

const props = withDefaults(
  defineProps<{
    view: AgentSessionHistoryView
    /** The engine's sessions, in the engine's order. Empty for every view but `rows`. */
    rows: readonly AgentSessionHistoryRow[]
    /** Why an `unreadable` list could not be read: the gateway's own sentence. */
    reason: string | null
    /** The engine named a further page, so this list is not the whole history. */
    more: boolean
    /** Whether that page is being read right now. Optional with a default, like the labels
     *  beside it: the state is the caller's, and a caller with no list open is not reading one. */
    moreBusy?: boolean
    /** Why the last attempt at that page failed, in the gateway's own sentence. */
    moreReason?: string | null
    /**
     * Whether the engine reported that it answers `session/close` — the panel's answer, from the
     * engine's own report, exactly as the history control's was.
     *
     * False draws no free button on any row. The action is not offered on a capability this window
     * has not been told about; the row the reader is on is never offered it either (`row.current`),
     * because freeing the session on screen from a list that is about the others is a trap; and a
     * row `row.held` is false for is not offered it, because the host refuses that call before the
     * engine hears about it (the button's own comment has the three together).
     */
    closeable: boolean
    /**
     * Whether the caller can open a *new* session on the runtime this list belongs to — the gate on
     * the one entry here that is not about a row.
     *
     * A gate for the same reason `closeable` is one, and it is the caller's to answer: opening a
     * session is the *rail's* move — the rail is what mounts this panel, and a panel cannot
     * re-point itself at a session it opened — so this list may offer it only when the caller has
     * said it will carry the call out. Absent (or false) draws no entry rather than a button whose
     * press goes nowhere, which is §5.2's rule and the reason this one is optional while the rest
     * are required: the caller that has not wired it yet is a list without that entry, not a broken
     * component.
     */
    openable?: boolean
    /** What the strip under the rows says, if anything. The panel owns it. */
    footer: AgentSessionHistoryFooter | null
    /** The row the footer is about, so the question is attached to what it names. */
    confirming: string | null
    /** The instant the ages are read against — one clock for the whole list. */
    now: number
    /** The list element's id, which the trigger's `aria-controls` names. */
    listId: string
    /** Where the panel put it, in viewport coordinates. */
    left: number
    top: number
    minWidth: number
    /** Which way it had to open, so the arrival comes from the control it belongs to rather than
     *  from the gap on the other side of it. */
    drop: 'down' | 'up'
  }>(),
  { openable: false, moreBusy: false, moreReason: null },
)

const emit = defineEmits<{
  /** The user settled on a session. The panel decides what that means. */
  activate: [sessionId: string]
  /** The user asked to free a session on the engine. The panel asks before it acts. */
  ask: [sessionId: string]
  /** The user asked for a new session. The caller decides what that means and who does it. */
  open: []
  /** The user asked for the page the engine named. The caller holds the cursor and the gateway. */
  more: []
  /** The question in the footer was answered yes. */
  confirm: []
  /** The question in the footer was answered no. */
  cancel: []
  /** Escape: the list is closing. */
  close: []
}>()

const rootEl = ref<HTMLElement | null>(null)
const headEl = ref<InstanceType<typeof AgentSessionHistoryHead> | null>(null)
const confirmEl = ref<HTMLButtonElement | null>(null)
/** The row Enter would take, as an index into {@link visibleRows} — the list on screen, which is
 *  the engine's own minus whatever the query does not match. */
const activeIndex = ref(0)

/** What is in the find box. It narrows the engine's answer here and is sent nowhere. */
const query = ref('')

/** Whether there is a box to draw: one is drawn exactly when there are rows for it to narrow. */
const searchable = computed(() => props.view === 'rows')

/** The rows the list is drawing, in the engine's order — `filterSessionRows`' own rule, applied
 *  to the answer the panel was given. */
const visibleRows = computed(() => filterSessionRows(props.rows, query.value))

/** A search that left nothing: the popup's own sentence, never "the engine holds no sessions". */
const noMatch = computed(() => visibleRows.value.length === 0)

/** The option the arrows are on, as an id — or `undefined` when there is no row to point at, which
 *  is also what tells the find box it has nothing expanded under it. */
const activeOptionId = computed(() =>
  visibleRows.value.length === 0 ? undefined : `${props.listId}-option-${activeIndex.value}`,
)

/** The element the panel measures to place the list — it is the only layer that can reach it. */
function element(): HTMLElement | null {
  return rootEl.value
}

/** Focus what the reader came for on arrival: the find box when there is one, so the arrows, Enter
 *  and typing all work from the first key, and the list itself when there is nothing to type into. */
function focus(): void {
  if (searchable.value) headEl.value?.focusQuery()
  else rootEl.value?.focus()
}

onMounted(focus)

const notice = computed((): string => {
  switch (props.view) {
    case 'loading':
      return t('agent.panel.history.loading')
    case 'empty':
      return t('agent.panel.history.empty')
    case 'unreadable':
      return t('agent.panel.history.unreadable', { reason: props.reason ?? '' })
    default:
      return ''
  }
})

/** The second line of a row: the engine's own stamp read as an age, then the two marks that say
 *  something pressing the row would not. Absent parts are absent, never blank. */
function metaOf(row: AgentSessionHistoryRow): string[] {
  const parts: string[] = []
  const age = describeSessionAge(row.updatedAt, props.now)
  if (age !== null) parts.push(age)
  if (row.current) parts.push(t('agent.panel.history.current'))
  if (row.elsewhere) parts.push(t('agent.panel.history.elsewhere', { cwd: row.cwd }))
  return parts
}

function move(offset: number): void {
  const count = visibleRows.value.length
  if (count === 0) return
  activeIndex.value = (activeIndex.value + offset + count) % count
}

function jump(to: 0 | -1): void {
  if (visibleRows.value.length === 0) return
  activeIndex.value = to === 0 ? 0 : visibleRows.value.length - 1
}

function commit(index: number): void {
  const row = visibleRows.value[index]
  if (row === undefined) return
  emit('activate', row.sessionId)
}

/** Whether a key is being typed into the find box, which is also where the caret keys belong. */
function inFindBox(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Claimed before the control check below: Escape closes the list from wherever the focus is
    // inside it, including from a button in the footer.
    event.preventDefault()
    // The dialog handlers that have not run yet; the modal claim the panel took is what silences
    // the ones that already have.
    event.stopPropagation()
    // …except while there is something to clear. A reader who has typed a query and presses
    // Escape is asking for the list they had before they typed, and a popup that vanished instead
    // would make the one key they have learned mean "throw my search away *and* close".
    if (query.value !== '') {
      query.value = ''
      return
    }
    emit('close')
    return
  }
  // A `<button>` inside this popup answers its own keys. The rows are not buttons any more (a
  // row's option is a div, so the free action beside it can be one), so anything with that tag
  // is the free button or a footer button — and an Enter meant for it must not be turned into
  // "activate the highlighted row" by the handler below.
  const target = event.target as HTMLElement | null
  if (target !== null && target.tagName === 'BUTTON') return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    // Home inside a box with text in it belongs to the caret, not to the list — the rule the
    // config picker's own filter box established for this app (`AgentConfigOptionsPopup.vue`).
    if (event.key === 'Home' && inFindBox(event.target)) {
      const field = event.target as HTMLInputElement
      if (field.selectionStart !== 0) return
    }
    event.preventDefault()
    jump(event.key === 'Home' ? 0 : -1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    commit(activeIndex.value)
  }
}

// A new query is a new list, so the row Enter would take is the first one it left: without this a
// reader who had arrowed down the whole list would commit whatever now sits at that index — a row
// they never picked.
watch(query, () => {
  activeIndex.value = 0
})

// The list can also move under a query — the panel re-reads the engine's answer after a free — and
// an index past the end would leave Enter with nothing to take.
watch(
  () => visibleRows.value.length,
  (count) => {
    activeIndex.value = Math.max(0, Math.min(activeIndex.value, count - 1))
  },
)

// The question takes the focus, because it is the only thing in the popup the reader has to
// answer: a footer that arrived under a list still holding the keyboard would leave its buttons
// reachable only by mouse, and Enter would go on meaning "open the highlighted session".
watch(
  () => props.footer?.kind ?? null,
  (kind) => {
    if (kind !== 'confirm') return
    void nextTick(() => confirmEl.value?.focus())
  },
)

// A list taller than the popup's cap has to follow the arrows: the keyboard only ever moved the
// index, and the scroll is DOM work on an element this component owns.
watch(activeIndex, () => {
  void nextTick(() => {
    rootEl.value
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
})

defineExpose({ element, focus })
</script>

<template>
  <div
    ref="rootEl"
    class="agent-history-popup"
    :class="{ 'is-above': drop === 'up' }"
    :style="{ left: `${left}px`, top: `${top}px`, minWidth: `${minWidth}px` }"
    :data-view="view"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <!-- The box, and the one entry that is not a row. Above the listbox rather than inside it: a
         listbox owns options, and neither of these is one. -->
    <AgentSessionHistoryHead
      v-if="searchable || openable"
      ref="headEl"
      v-model:query="query"
      :searchable="searchable"
      :openable="openable"
      :list-id="listId"
      :active-option-id="activeOptionId"
      @open="emit('open')"
    />
    <div
      v-if="searchable && !noMatch"
      :id="listId"
      class="agent-history-list"
      role="listbox"
      :aria-label="t('agent.panel.history.list')"
      :aria-activedescendant="activeOptionId"
    >
      <div
        v-for="(row, index) in visibleRows"
        :key="row.sessionId"
        class="agent-history-row"
        :class="{
          'is-active': index === activeIndex,
          'is-current': row.current,
          'is-confirming': confirming === row.sessionId,
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
          @mouseenter="activeIndex = index"
          @click="commit(index)"
        >
          <!-- The engine's title, or the sentence saying it sent none. A row is never blank and
               never carries a name this app wrote in the engine's place. -->
          <span class="agent-history-option-title">{{ row.title ?? t('agent.panel.history.untitled') }}</span>
          <span
            v-if="metaOf(row).length > 0"
            class="agent-history-option-meta"
          >
            <span
              v-for="part in metaOf(row)"
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
          @click.stop="emit('ask', row.sessionId)"
        >
          <X
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
    <!-- A search that left nothing, said as the search's own answer. It is a different sentence
         from the engine's "it holds no sessions" on purpose: this app has not asked the engine
         whether such a session exists, and a box that filtered itself empty must not read as a
         statement about the engine's table. -->
    <p
      v-else-if="searchable"
      class="agent-history-notice"
      role="presentation"
      data-history-nomatch
    >
      {{ t('agent.panel.history.search.noMatch') }}
    </p>
    <p
      v-else
      class="agent-history-notice"
      role="presentation"
      :title="view === 'unreadable' ? reason ?? undefined : undefined"
    >
      {{ notice }}
    </p>
    <!-- Outside the listbox, which may only own options, and drawn for a short list whether or not
         a search found anything: an engine that named a further page has not shown the whole
         table, and "no session matches" is only ever true of the page that was sent. A list that
         read as complete would be the one answer worse than a short one.

         A button and not a sentence. The sentence said a page existed and offered no way to it,
         which is this app's own worst shape — a surface claiming something the reader cannot
         reach — so the words are the button's explanation (`title`) and the press is the act.
         `disabled` while the read is in flight, because a second press would ask for the same
         page twice; the label says which page and how far the list has come. -->
    <div
      v-if="searchable && more"
      class="agent-history-more"
      role="presentation"
    >
      <button
        class="agent-history-more-btn"
        type="button"
        data-history-more
        :title="t('agent.panel.history.more')"
        :disabled="moreBusy"
        :aria-busy="moreBusy ? 'true' : undefined"
        @mousedown.prevent
        @click="emit('more')"
      >
        {{ moreBusy ? t('agent.panel.history.moreLoad.loading') : t('agent.panel.history.moreLoad.load') }}
      </button>
      <p
        v-if="moreReason !== null && moreReason !== undefined"
        class="agent-history-more-reason"
        data-history-more-failed
        role="status"
      >
        {{ t('agent.panel.history.moreLoad.failed', { reason: moreReason }) }}
      </p>
    </div>
    <!-- The strip under the rows. `role=presentation` for the reason the notices carry it: this
         is a child of the listbox and not one of its options. -->
    <div
      v-if="footer !== null"
      class="agent-history-footer"
      role="presentation"
      :data-footer="footer.kind"
    >
      <template v-if="footer.kind === 'confirm'">
        <p class="agent-history-footer-sentence">
          {{ t('agent.panel.history.free.confirm') }}
        </p>
        <!-- The sentence that makes this a decision rather than a click: the engine keeps the
             session, so the row the reader is looking at will still be there afterwards. -->
        <p class="agent-history-footer-note">
          {{ t('agent.panel.history.free.note') }}
        </p>
        <div class="agent-history-footer-actions">
          <button
            ref="confirmEl"
            class="agent-history-footer-btn is-primary"
            type="button"
            data-free-confirm
            @click="emit('confirm')"
          >
            {{ t('agent.panel.history.free.confirmAction') }}
          </button>
          <button
            class="agent-history-footer-btn"
            type="button"
            data-free-cancel
            @click="emit('cancel')"
          >
            {{ t('agent.panel.history.free.cancel') }}
          </button>
        </div>
      </template>
      <p
        v-else-if="footer.kind === 'freed'"
        class="agent-history-footer-sentence"
        data-free-done
      >
        {{ t('agent.panel.history.free.done') }}
      </p>
      <p
        v-else
        class="agent-history-footer-sentence"
        data-free-failed
      >
        {{ t('agent.panel.history.free.failed', { reason: footer.reason }) }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.agent-history-popup {
  position: fixed;
  /* Above the modal layer (10000) and below the toast layer (11000), as every popup in this app
     is. */
  z-index: 10001;
  display: flex;
  flex-direction: column;
  max-width: 320px;
  max-height: min(320px, 60vh);
  overflow-y: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  outline: none;
  /* The edge the control is on is the edge the list grows out of, and which edge that is comes
     from `drop` — the placement the panel measured. */
  transform-origin: top center;
}
.agent-history-popup.is-above {
  transform-origin: bottom center;
}
/* The row: the option, and the action beside it. The highlight belongs to the row rather than to
   the option, so the free button is inside the same lit area as the text it acts on. */
.agent-history-row {
  display: flex;
  align-items: center;
  gap: 2px;
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
  color: var(--app-text);
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
   the row's meta line and in its `aria-current`. */
.agent-history-option.is-current .agent-history-option-title {
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
.agent-history-notice {
  margin: 0;
  padding: 14px 8px;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  /* The reason is the backend's own sentence and a narrow popup will wrap it; it must not be
     elided into a title a reader has to hover to find. */
  overflow-wrap: anywhere;
}
.agent-history-more {
  padding: 6px 8px 2px;
  border-top: 1px solid var(--app-border);
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.agent-history-more-btn {
  min-height: 26px;
  width: 100%;
  padding: 0 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-history-more-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-history-more-btn:disabled {
  color: var(--app-muted);
  cursor: default;
}
.agent-history-more-btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-history-more-reason {
  margin: 4px 0 0;
}
/* The strip under the rows: the question before a free, and the engine's answer after one. It is
   inside the listbox rather than a second popup because it is about a row that is on screen, and
   a question that moved away from its subject would be answered against the wrong one. */
.agent-history-footer {
  margin-top: 4px;
  padding: 8px;
  border-top: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-accent-soft) 20%, transparent);
}
.agent-history-footer-sentence {
  margin: 0;
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.agent-history-footer-note {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.agent-history-footer-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.agent-history-footer-btn {
  min-height: 24px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-history-footer-btn.is-primary {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
  color: var(--app-accent);
}
.agent-history-footer-btn:hover {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-history-footer-btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
