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
 * hands the arrows to it (`AgentConfigPicker.vue`); here the list takes focus on arrival, so it
 * is the only handler and there is no second place the highlight could live. The rows follow the
 * app's list vocabulary — one row per session, `role="option"`, `aria-activedescendant` on the
 * listbox — and Enter, a click and a pointer-down-and-release all mean the same thing.
 *
 * What a row may say is deliberately narrow. The title is the engine's or it is absent, and the
 * absence is drawn as a statement about the engine rather than as a name this app invented; the
 * age is the engine's own `updatedAt` read (`services/agent-session-history.ts`); and the two
 * marks beside it are the two facts a reader needs before pressing anything — this is the one
 * already open, and this one was recorded in another folder.
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
  type AgentSessionHistoryRow,
} from '../services/agent-session-history'

const props = defineProps<{
  view: AgentSessionHistoryView
  /** The engine's sessions, in the engine's order. Empty for every view but `rows`. */
  rows: readonly AgentSessionHistoryRow[]
  /** Why an `unreadable` list could not be read: the gateway's own sentence. */
  reason: string | null
  /** The engine named a further page, so this list is not the whole history. */
  more: boolean
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
}>()

const emit = defineEmits<{
  /** The user settled on a session. The panel decides what that means. */
  activate: [sessionId: string]
  /** The user asked to free a session on the engine. The panel asks before it acts. */
  ask: [sessionId: string]
  /** The question in the footer was answered yes. */
  confirm: []
  /** The question in the footer was answered no. */
  cancel: []
  /** Escape: the list is closing. */
  close: []
}>()

const rootEl = ref<HTMLElement | null>(null)
const confirmEl = ref<HTMLButtonElement | null>(null)
/** The row Enter would take, as an index into `rows`. */
const activeIndex = ref(0)

/** The element the panel measures to place the list — it is the only layer that can reach it. */
function element(): HTMLElement | null {
  return rootEl.value
}

/** Focus the list on arrival: the arrows are its own from the moment it is up, and a reader who
 *  opened it with the keyboard should not have to press Tab to reach what they opened. */
function focus(): void {
  rootEl.value?.focus()
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
  const count = props.rows.length
  if (count === 0) return
  activeIndex.value = (activeIndex.value + offset + count) % count
}

function jump(to: 0 | -1): void {
  if (props.rows.length === 0) return
  activeIndex.value = to === 0 ? 0 : props.rows.length - 1
}

function commit(index: number): void {
  const row = props.rows[index]
  if (row === undefined) return
  emit('activate', row.sessionId)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Claimed before the control check below: Escape closes the list from wherever the focus is
    // inside it, including from a button in the footer.
    event.preventDefault()
    // The dialog handlers that have not run yet; the modal claim the panel took is what silences
    // the ones that already have.
    event.stopPropagation()
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
    event.preventDefault()
    jump(event.key === 'Home' ? 0 : -1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    commit(activeIndex.value)
  }
}

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
    :id="listId"
    ref="rootEl"
    class="agent-history-popup"
    :class="{ 'is-above': drop === 'up' }"
    :style="{ left: `${left}px`, top: `${top}px`, minWidth: `${minWidth}px` }"
    role="listbox"
    :aria-label="t('agent.panel.history.list')"
    :aria-activedescendant="view === 'rows' ? `${listId}-option-${activeIndex}` : undefined"
    :data-view="view"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <template v-if="view === 'rows'">
      <div
        v-for="(row, index) in rows"
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
      <!-- role=presentation: a listbox may only own options. An engine that named a further page
           has not shown the whole table, and a list that read as complete would be the one answer
           worse than a short one. -->
      <p
        v-if="more"
        class="agent-history-more"
        role="presentation"
        data-history-more
      >
        {{ t('agent.panel.history.more') }}
      </p>
    </template>
    <p
      v-else
      class="agent-history-notice"
      role="presentation"
      :title="view === 'unreadable' ? reason ?? undefined : undefined"
    >
      {{ notice }}
    </p>
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
  margin: 0;
  padding: 6px 8px 2px;
  border-top: 1px solid var(--app-border);
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
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
