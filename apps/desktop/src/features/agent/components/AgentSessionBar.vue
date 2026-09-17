<script lang="ts">
/**
 * The bar's copy, handed in rather than reached for — see {@link AgentToolLabels} for why, and
 * for what happens when the catalogue grows keys.
 */
import type {
  AgentRunEnding,
  AgentSessionState,
} from '../../../platform/gateways/agent-contracts'

export interface AgentSessionBarLabels {
  /** Shown until the engine names the session. It carries the engine's own name — the caller
   *  fills the slot from the registry's registration (see `AgentRailBody`), so the title says
   *  which engine is running instead of a word this app chose for all of them. */
  untitled: string
  /** One word per session state, keyed by the contract's own states: a state added later
   *  fails to typecheck here rather than rendering as a blank. */
  state: Record<AgentSessionState, string>
  /** How a run ended, per ending the contract can report. `end-turn` is the ordinary ending and
   *  is never shown; the other four say something a reader wants to know — a ceiling was hit, the
   *  engine refused, the run was stopped — and so does an ending whose reason this version does
   *  not know, which is a fact about the engine rather than a failure of the turn. */
  result: Record<AgentRunEnding, string>
  /** The history control's accessible name and tooltip. Optional with a catalogue default, the
   *  direction the newer components beside this one take (`AgentCommandMenu.vue`,
   *  `AgentConfigPicker.vue`): the words for a control are the control's own, and a caller only
   *  overrides them when it has something more specific to say. */
  history?: string
}
</script>

<script setup lang="ts">
/**
 * The session's title bar: what this session is, and what it is doing.
 *
 * Props in, events out. The one control §5.3 puts in this strip beyond the title — history, the
 * action over the session *list* — is here as a trigger and nothing more: pressing it is an
 * event, and the list itself is the panel's, which is where the gateway and the session are.
 * **Whether it is drawn at all is not this component's decision** (`history`): the panel draws it
 * only when the engine's own report says it answers `session/list`, so a bar with no such report
 * has no button rather than a disabled one. The title is shown, not edited: the contract lets the
 * engine name a session (`session-changed`) and offers the host no way to name one back, so a
 * rename control here would be a button that cannot act.
 *
 * The state line is the panel's screen-reader status cue (§5.2 「支持…屏幕阅读器状态提示；
 * 不能每 token 都触发朗读」). It is a `role="status"` region on purpose and it changes when the
 * *run* changes, which is a handful of times per turn — the transcript beside it is
 * `aria-live="off"` for exactly the reason this is not.
 *
 * The status is a word, an icon and a colour in that order of importance: §5.3 asks for text
 * and icon together so that the restrained status colours are never the only signal.
 */
import { computed, ref } from 'vue'
import {
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  History,
  Loader,
  MoreHorizontal,
  ShieldQuestion,
} from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { AgentRunResult, AgentUsage } from '../../../platform/gateways/agent-contracts'
import { turnDurationParts } from '../services/agent-turn-stats'

const props = defineProps<{
  /**
   * The engine's title, or null until one has been stated.
   *
   * The panel is what decides which of the two statements this is — the newest one the session's
   * stream carried (`AgentSessionView.title`, which a `session-changed` frame writes) or the one
   * the reopened session was handed at the load (`AgentSession.title`, read off the engine's own
   * `session/list` row). Both are the engine's words; the fallback underneath is this app's, and
   * it says only that no name has arrived.
   */
  title: string | null
  /** Where the session's state machine is. Null before a session view exists. */
  state: AgentSessionState | null
  /** Why a run did not run to its own end, in the engine's or the runtime's own words. */
  failure: { code: string; message: string } | null
  /** How the last run ended. Its stop reason is shown only when it is not the ordinary one. */
  result: AgentRunResult | null
  /**
   * How long the last turn took, in milliseconds, or null when this window did not watch one
   * end.
   *
   * Measured by the panel rather than read off the wire, because the wire carries no duration —
   * `services/agent-turn-stats.ts` holds that measurement and the reason for it. Null is "not
   * measured": a turn that began before this window was looking has no time to show, and the
   * tokens it reported are drawn beside nothing rather than beside a made-up zero.
   */
  elapsedMs: number | null
  /**
   * Whether to draw the history control — the panel's answer, from the engine's own report.
   *
   * A prop rather than a condition here, because what decides it is a capability this component
   * has no way to ask about: the panel calls `AgentGateway.capabilities` and passes the answer
   * down. False draws no button at all, which is the whole point of asking.
   */
  history: boolean
  /** Whether the list it opens is up, for `aria-expanded` — the state lives in the panel. */
  historyOpen: boolean
  /**
   * Whether to draw the options control — the panel's answer, and the same rule as `history`.
   *
   * The panel draws it only while it has at least one row its caller can carry, so a panel
   * mounted with nothing behind it has no control rather than one that opens an empty box.
   */
  menu: boolean
  /** Whether the menu it opens is up, for `aria-expanded`. */
  menuOpen: boolean
  /**
   * The options control's accessible name — and the menu's as well, because they are one
   * sentence.
   *
   * A prop rather than a member of {@link AgentSessionBarLabels}, which is where the history
   * control's own name lives: the panel owns this menu (its rows are the panel's events), and the
   * name has to be the same string on the control and on the box it opens, so a second place to
   * write it would be a second place for one name to drift.
   */
  menuLabel: string
  labels: AgentSessionBarLabels
}>()

const emit = defineEmits<{
  /** The user asked for the sessions this engine holds. The panel draws the list. */
  history: []
  /** The options control: open it, or — pressed again, or `Escape` — take it away. */
  menu: []
}>()

const triggerEl = ref<HTMLButtonElement | null>(null)
const menuTriggerEl = ref<HTMLButtonElement | null>(null)

/** The element the panel measures its popup against. Exposed rather than kept here because the
 *  list is the panel's (it is the layer that holds the gateway), and the app's popup recipe
 *  measures from the control it hangs off. */
function triggerElement(): HTMLElement | null {
  return triggerEl.value
}

/** The same, for the options menu, which hangs off a control of its own. */
function menuElement(): HTMLElement | null {
  return menuTriggerEl.value
}

defineExpose({ triggerElement, menuElement })

/**
 * The keys the control answers itself, and only while the focus is still on it.
 *
 * Once the menu is open the focus is inside it and the menu's own handler owns every one of
 * these; the two never see the same key. `Escape` and the arrows are the two that would do the
 * wrong thing unseen: the first would reach the dialog or the editor behind the popup, and the
 * second would scroll the transcript under a menu the reader is aiming at.
 *
 * `Enter` and `Space` are deliberately absent. A button fires its own click for both, and the
 * press is a toggle, so intercepting them here would be the same gesture written twice — once by
 * the browser and once by this handler, in the same event.
 */
function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (!props.menuOpen) return
    event.preventDefault()
    event.stopPropagation()
    emit('menu')
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (props.menuOpen) return
    event.preventDefault()
    emit('menu')
  }
}

/** The catalogue's own name for this control, unless the caller said otherwise. */
const historyLabel = computed(() => props.labels.history ?? t('agent.panel.bar.history'))

const STATE_ICONS: Record<AgentSessionState, typeof Circle> = {
  idle: Circle,
  starting: Loader,
  ready: Circle,
  running: Loader,
  'waiting-permission': ShieldQuestion,
  completed: CircleCheck,
  cancelled: CircleSlash,
  failed: CircleX,
}

/** The states in which something is still happening, and so the ones whose icon turns. */
const SPINNING: readonly AgentSessionState[] = ['starting', 'running']

const stateLabel = computed(() =>
  props.state === null ? '' : props.labels.state[props.state],
)
const stateIcon = computed(() => (props.state === null ? Circle : STATE_ICONS[props.state]))
const spinning = computed(() => props.state !== null && SPINNING.includes(props.state))

/** The second half of the line: why, when there is a why. A failure carries the engine's own
 *  message; an ordinary ending says nothing, and the four that are not ordinary say which one
 *  they were (§5.1: a token ceiling is not a failure and must not read as one).
 *
 *  An ending this version does not know is one of the four that say something, and it carries
 *  the engine's own word in brackets when there is one. That word is the whole of what a reader
 *  — or a bug report — can act on: the sentence says the reason was not recognised, and the word
 *  says which reason it was. */
const detail = computed(() => {
  if (props.failure !== null) return props.failure.message
  const result = props.result
  if (result === null) return null
  const reason = result.stopReason
  if (reason === 'end-turn') return null
  if (reason === 'unrecognised' && result.unrecognisedReason !== undefined) {
    return `${props.labels.result[reason]} (${result.unrecognisedReason})`
  }
  return props.labels.result[reason]
})

/**
 * What the last finished turn spent, as the engine reported it.
 *
 * This has been riding on `lastResult` since `run-finished` was first reduced — `runs.rs` puts the
 * engine's own `usage` object into the payload verbatim and the reducer stores it whole — and the
 * strip simply never read it. It is read, not recomputed: **no number here is derived from
 * another**, because the engine's `totalTokens` is not the sum of its parts (P0 §6.3 measured
 * 1721 + 6 against a reported total of 8895 in one turn).
 */
const usage = computed<AgentUsage | null>(() => props.result?.usage ?? null)

/** The counters in the order the hover text lists them. */
const USAGE_COUNTERS: readonly (keyof AgentUsage)[] = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'thoughtTokens',
  'cachedReadTokens',
  'cachedWriteTokens',
]

/**
 * A token count as this strip can show it: `9.2k`, not `9189`.
 *
 * The rule is Zed's (`agent_ui.rs:550`, `humanize_token_count`), for the range a turn's counts fall
 * in: exact below a thousand, one decimal in the thousands, whole thousands above ten thousand,
 * and one decimal in the millions. Nothing is lost by rounding — the exact numbers are the hover
 * text below.
 */
function humanized(count: number): string {
  if (count < 1_000) return String(count)
  const thousands = count / 1_000
  if (thousands < 10) return `${oneDecimal(thousands)}k`
  if (thousands < 1_000) return `${Math.round(thousands)}k`
  return `${oneDecimal(count / 1_000_000)}M`
}

/** One decimal, and no trailing `.0`: `9.2k`, and `9k` rather than `9.0k`. */
function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toString().replace(/\.0$/, '')
}

/**
 * One counter's line in the hover text — written out per field rather than composed from the
 * name, because the i18n guard resolves keys from the source text and a key built from a variable
 * is invisible to it. A `switch` over the contract's own field names is also what makes a seventh
 * counter a typecheck failure here rather than a number that quietly stops being listed.
 */
function counterLine(counter: keyof AgentUsage, count: number): string {
  switch (counter) {
    case 'inputTokens':
      return t('agent.panel.bar.usage.detail.input', { n: count })
    case 'outputTokens':
      return t('agent.panel.bar.usage.detail.output', { n: count })
    case 'totalTokens':
      return t('agent.panel.bar.usage.detail.total', { n: count })
    case 'thoughtTokens':
      return t('agent.panel.bar.usage.detail.thought', { n: count })
    case 'cachedReadTokens':
      return t('agent.panel.bar.usage.detail.cachedRead', { n: count })
    case 'cachedWriteTokens':
      return t('agent.panel.bar.usage.detail.cachedWrite', { n: count })
  }
}

/**
 * What the strip's own line says: the engine's total when it sent one, and otherwise the two
 * counters it sent instead. **Never their sum** — see {@link usage}. An engine that reported
 * neither total nor input/output gets no line rather than an empty one (§5.1: an unknown cost
 * stays unknown, and a `0` would read as a free turn).
 */
const usageParts = computed<readonly string[]>(() => {
  const held = usage.value
  if (held === null) return []
  if (held.totalTokens !== undefined) {
    return [t('agent.panel.bar.usage.total', { n: humanized(held.totalTokens) })]
  }
  const parts: string[] = []
  if (held.inputTokens !== undefined) {
    parts.push(t('agent.panel.bar.usage.input', { n: humanized(held.inputTokens) }))
  }
  if (held.outputTokens !== undefined) {
    parts.push(t('agent.panel.bar.usage.output', { n: humanized(held.outputTokens) }))
  }
  return parts
})

/** Every counter the engine reported, named and exact. `\n` is what a `title` renders as lines.
 *  Null when the engine reported nothing to itemise, which also keeps an empty `title` off the
 *  element. */
const usageDetail = computed<string | null>(() => {
  const held = usage.value
  if (held === null) return null
  const lines: string[] = []
  for (const counter of USAGE_COUNTERS) {
    const count = held[counter]
    if (count !== undefined) lines.push(counterLine(counter, count))
  }
  return lines.length === 0 ? null : lines.join('\n')
})

/**
 * The elapsed half of the turn's stats, in the same strip as the token half and drawn only when
 * this window measured it.
 *
 * The three arms are Zed's (`duration_alt_display`, `crates/util/src/time.rs:3-15`): hours and
 * minutes and seconds, each drawn only when it is above zero, so a short turn is `12s` and a
 * long one is `1h 2m 3s`. The words are the catalogue's, written out per arm rather than built
 * from the numbers — the i18n guard resolves keys from the source text, and a key assembled from
 * a variable is invisible to it.
 */
const elapsedLabel = computed<string | null>(() => {
  const ms = props.elapsedMs
  if (ms === null) return null
  const { hours, minutes, seconds } = turnDurationParts(ms)
  if (hours > 0) return t('agent.panel.bar.elapsed.hours', { h: hours, m: minutes, s: seconds })
  if (minutes > 0) return t('agent.panel.bar.elapsed.minutes', { m: minutes, s: seconds })
  return t('agent.panel.bar.elapsed.seconds', { s: seconds })
})
</script>

<template>
  <header class="agent-bar">
    <h2
      class="agent-bar-title"
      :title="title ?? labels.untitled"
    >
      {{ title ?? labels.untitled }}
    </h2>
    <!-- §5.3's one control beyond the title, and only when the engine said it answers the call
         behind it. `aria-haspopup` and `aria-expanded` carry the state; the list's own element is
         the panel's (it is teleported to the body), so this control does not name it. -->
    <button
      v-if="history"
      ref="triggerEl"
      class="agent-bar-history"
      type="button"
      data-agent-history
      aria-haspopup="listbox"
      :aria-expanded="historyOpen"
      :title="historyLabel"
      :aria-label="historyLabel"
      @click="emit('history')"
    >
      <History
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
    <!-- The panel's options control, beside the history one and drawn on the same rule: the panel
         decides (it is what owns the rows and the events they produce), so a panel with nothing
         to offer draws no control rather than one that opens an empty box. It carries the whole
         of the keyboard that opens a menu — a press, `Enter`/`Space` through the button's own
         click, an arrow, and `Escape` to take it away — because the focus leaves here the moment
         the menu is up. -->
    <button
      v-if="menu"
      ref="menuTriggerEl"
      class="agent-bar-menu"
      type="button"
      data-agent-menu
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :title="menuLabel"
      :aria-label="menuLabel"
      @click="emit('menu')"
      @keydown="onMenuKeydown"
    >
      <MoreHorizontal
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
    <!-- What the last finished turn cost and took, in the engine's own numbers and this
         window's own stopwatch (rows 5b and 37). They sit *before* the state line rather than
         inside it: the state word is the one thing in this strip that must draw the eye, so it
         keeps the end of the row, and the live region keeps the cadence it was written for
         rather than announcing a count as well. Each half is drawn only when it was actually
         reported or measured — `usage: null` is an engine that reported nothing, and
         `elapsedMs: null` is a turn this window did not watch, and §5.1's rule is that an unknown
         stays unknown rather than becoming a zero. -->
    <p
      v-if="elapsedLabel !== null"
      class="agent-bar-clock"
      data-agent-clock
    >
      {{ elapsedLabel }}
    </p>
    <p
      v-if="usageParts.length > 0"
      class="agent-bar-usage"
      data-agent-usage
      :title="usageDetail ?? undefined"
    >
      {{ usageParts.join(' · ') }}
    </p>
    <p
      class="agent-bar-state"
      role="status"
      aria-live="polite"
      :data-state="state ?? 'none'"
    >
      <component
        :is="stateIcon"
        class="agent-bar-state-icon"
        :class="{ 'is-spinning': spinning }"
        :size="12"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="agent-bar-state-word">{{ stateLabel }}</span>
      <span
        v-if="detail"
        class="agent-bar-detail"
        :title="detail"
      >
        {{ detail }}
      </span>
    </p>
  </header>
</template>

<style scoped>
.agent-bar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  /* §5.3's title bar: 36–40px, one rung, no second navigation row. */
  min-height: 38px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-border);
  flex: none;
}
.agent-bar-title {
  flex: 1;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The strip is baseline-aligned for the title and the state word; a control has no baseline to
   sit on, so it centres itself in the row instead. Quiet by default — this is a title bar, and
   the one thing here that must draw the eye is the state it is reporting. */
.agent-bar-history {
  display: inline-flex;
  align-self: center;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-bar-history:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  color: var(--app-text);
}
/* Open, it reads as held: the list below belongs to this control. */
.agent-bar-history[aria-expanded='true'] {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
  color: var(--app-accent);
}
.agent-bar-history:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
/* The options control, restating the history one's box rather than sharing a class: the two are
   different controls in different positions, and a shared name would make the next change to one
   of them a change to both. */
.agent-bar-menu {
  display: inline-flex;
  align-self: center;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-bar-menu:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  color: var(--app-text);
}
.agent-bar-menu[aria-expanded='true'] {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
  color: var(--app-accent);
}
.agent-bar-menu:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-bar-state {
  display: inline-flex;
  flex: none;
  max-width: 55%;
  align-items: center;
  gap: 4px;
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  white-space: nowrap;
}
/* The last turn's numbers: quieter than the state word beside them and never elided — the title
   gives way first, because a number cut in half is worse than no number. Tabular figures so the
   strip does not jitter as the counters change width between turns. The clock is the same rung:
   it is the second half of one fact (what the last turn cost, and what it took), so it is drawn
   with the same weight rather than as a heading of its own. */
.agent-bar-usage,
.agent-bar-clock {
  flex: none;
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.agent-bar-state-icon {
  flex: none;
}
.agent-bar-state-icon.is-spinning {
  animation: agent-bar-spin var(--app-motion-spin) linear infinite;
}
@keyframes agent-bar-spin {
  to {
    transform: rotate(360deg);
  }
}
.agent-bar-state-word {
  flex: none;
}
.agent-bar-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The two states worth a colour, and only as the second signal: the word beside each one
   already says the same thing. */
.agent-bar-state[data-state='failed'] {
  color: var(--app-danger);
}
.agent-bar-state[data-state='waiting-permission'] {
  color: var(--app-warn);
}
</style>
