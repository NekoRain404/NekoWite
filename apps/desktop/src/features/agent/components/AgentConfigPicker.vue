<script lang="ts">
/**
 * The picker's copy, overridable by whoever wires it up — the same arrangement
 * {@link AgentCommandMenuLabels} uses, and for the same reason: the defaults come from the
 * catalogue, and a caller that wants different words can say so.
 */
export interface AgentConfigPickerLabels {
  /** Names the popup list for a screen reader, with the option's own name in it. */
  list: string
  /** The filter box's placeholder, drawn only for a long choice list. */
  filter: string
  /** There are choices, but none match what is being typed. */
  noMatch: string
  /** What the engine said the option is set to, when it named no value at all. */
  unknown: string
}
</script>

<script setup lang="ts">
/**
 * One `select` config option: the trigger the row draws, and the list it opens.
 *
 * The structure is Zed's `ConfigOptionSelector` — a muted trigger carrying the *current value's
 * own name* and a caret (`zed-main/crates/agent_ui/src/config_options.rs:382` `current_value_name`,
 * `:407` `render_trigger_button`), opening a list whose rows are the engine's values in the
 * engine's order (`:619` `ConfigOptionPickerEntry`). The pixels are this application's: the
 * app's own popup recipe, which `components/SelectMenu.vue` established and
 * `composables/use-detached-popup.ts` holds — teleported, `position: fixed`, placed against the
 * trigger, dismissed on an outside press, Escape claimed through the modal stack, and the motion
 * rungs of `styles/motion.css`.
 *
 * Two things it deliberately does not do. It does not decide what the option *is*: the control
 * arrives already built by `services/agent-config-options.ts`, with the engine's own values and
 * names in the engine's own order. And it does not write the value anywhere: choosing one is an
 * event, and the value on the trigger stays whatever the engine last reported until a
 * `config-changed` frame (or the next mount) says otherwise.
 *
 * The list itself is `AgentConfigOptionsPopup.vue` — the part about rows and keys — and the
 * placement and dismissal are the composable's; what is left here is the control.
 */
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { useDetachedPopup } from '../composables/use-detached-popup'
import type { AgentConfigSelectControl } from '../services/agent-config-options'
import AgentConfigOptionsPopup from './AgentConfigOptionsPopup.vue'

const props = defineProps<{
  /** The option to draw, with the engine's choices and its current value. */
  control: AgentConfigSelectControl
  /** Its value is being set right now: the trigger takes no second press (Zed's
   *  `setting_value`, `config_options.rs:443`). */
  busy: boolean
  /**
   * Why this control cannot be used at all, or null when it can.
   *
   * Never a temporary state: it is the row's answer to "this value has no shape this app's
   * transport can send" (`services/agent-config-options.ts`), so a control carrying it is drawn
   * plainly unavailable rather than looking usable and failing on the press.
   */
  unavailable: string | null
  /** The reason the last attempt to set this value did not take, or null. The trigger keeps
   *  showing the engine's current value either way — a set that did not happen leaves it true. */
  failure: string | null
  /** Overrides for the default copy; see {@link AgentConfigPickerLabels}. */
  labels?: Partial<AgentConfigPickerLabels>
}>()

const emit = defineEmits<{
  /** The user settled on one of the engine's values. */
  select: [value: string]
}>()

const copy = computed((): AgentConfigPickerLabels => ({
  list: t('agent.panel.composer.config.picker.list'),
  filter: t('agent.panel.composer.config.picker.filter'),
  noMatch: t('agent.panel.composer.config.picker.noMatch'),
  unknown: t('agent.panel.composer.config.picker.unknown'),
  ...props.labels,
}))

/**
 * The option's own name, and this app's word for an option that arrives without one.
 *
 * The empty case is a floor rather than the rule: an engine names its options and the reader
 * keeps the name it sent (`tauri-agent/session.ts`). What is shown *in* the control is always the
 * engine's — the current value's own name — and this only names the control itself, in its
 * tooltip and to a screen reader, the way `Send` names the send button.
 */
const optionName = computed(() =>
  props.control.name === '' ? t('agent.panel.composer.config.model') : props.control.name,
)

/** What the closed trigger reads. The engine's name for the value it says is current; the raw
 *  value when it named no choice for it, because that value is still its own report; and the
 *  catalogue's word when the engine reported no current value at all. */
const valueLabel = computed(() =>
  props.control.currentName === '' ? copy.value.unknown : props.control.currentName,
)

/** What hovering and a screen reader hear: the option's own name and description, then why this
 *  control is not usable, then why the last attempt failed. */
const explained = computed(() =>
  [optionName.value, props.control.description, props.unavailable, props.failure]
    .filter((part): part is string => part !== undefined && part !== null && part !== '')
    .join('\n'),
)

const closed = computed(() => props.busy || props.unavailable !== null)

/** The row `Enter` would take, as an index into `matches`; and what is in the filter box. */
const activeIndex = ref(0)
const query = ref('')
const triggerEl = ref<HTMLButtonElement | null>(null)
const popupRef = ref<InstanceType<typeof AgentConfigOptionsPopup> | null>(null)

/** Where the list goes, when it closes, and who owns Escape while it is up. */
const popup = useDetachedPopup({
  floor: 160,
  claim: 'agent-config-picker',
  trigger: triggerEl,
  popup: () => popupRef.value?.element() ?? null,
})

/** The engine's choices narrowed by what is being typed, in the engine's order. A filter rather
 *  than a search: nothing here ranks or reorders the engine's list. */
const matches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle === '') return props.control.choices
  return props.control.choices.filter(
    (choice) =>
      choice.name.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle),
  )
})

const listId = `agent-config-list-${props.control.key}`

function show(): void {
  if (closed.value) return
  query.value = ''
  // The row the list opens on is the value the engine says is current (Zed's own starting index,
  // `config_options.rs:657`), and the first row when that value is not among the choices.
  const chosen = props.control.choices.findIndex((choice) => choice.value === props.control.current)
  activeIndex.value = chosen >= 0 ? chosen : 0
  void popup.show().then(() => {
    // A list that must be typed into should not need a second press before it can be.
    if (props.control.filterable) popupRef.value?.focusFilter()
  })
}

function hide(): void {
  popup.hide()
  // The trigger takes focus back: a list dismissed with Escape or a click outside must not leave
  // the keyboard nowhere, and the control the reader just used is where they were.
  triggerEl.value?.focus()
}

function commit(index: number): void {
  const choice = matches.value[index]
  if (choice === undefined) return
  emit('select', choice.value)
  hide()
}

/** Step one row, wrapping — the app's own select does this (`components/SelectMenu.vue`), and a
 *  reader who has learnt it there should not learn a second model here. */
function move(offset: number): void {
  const count = matches.value.length
  if (count === 0) return
  activeIndex.value = (activeIndex.value + offset + count) % count
}

// A narrowing list is a different list: the highlight belongs on its first row, not on whatever
// index it happened to hold while the choices were longer.
function onQuery(value: string): void {
  query.value = value
  activeIndex.value = 0
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (!popup.open.value) return
    event.preventDefault()
    // The dialog handlers that have not run yet; the modal claim is what silences the ones that
    // already have.
    event.stopPropagation()
    hide()
    return
  }
  if (event.key === 'Tab') {
    // Left to the browser: the popup is not in its path, so the next stop is whatever follows
    // the trigger — what "close and move on" means.
    hide()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (popup.open.value) move(event.key === 'ArrowDown' ? 1 : -1)
    else show()
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    if (!popup.open.value) return
    event.preventDefault()
    activeIndex.value = event.key === 'Home' ? 0 : Math.max(0, matches.value.length - 1)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    // preventDefault cancels the click the button would synthesise, which is what keeps `Space`
    // from opening and closing in the same press.
    event.preventDefault()
    if (popup.open.value) commit(activeIndex.value)
    else show()
  }
}
</script>

<template>
  <button
    ref="triggerEl"
    class="agent-config-trigger"
    type="button"
    role="combobox"
    :aria-expanded="popup.open.value"
    :aria-controls="listId"
    :aria-activedescendant="popup.open.value ? `${listId}-option-${activeIndex}` : undefined"
    :aria-disabled="unavailable !== null || undefined"
    :disabled="closed"
    :title="explained"
    :aria-label="`${optionName}: ${valueLabel}`"
    :data-option="control.key"
    :data-failed="failure !== null || undefined"
    @click="popup.open.value ? hide() : show()"
    @keydown="onTriggerKeydown"
  >
    <span class="agent-config-value">{{ valueLabel }}</span>
    <ChevronDown
      class="agent-config-caret"
      :size="12"
      :stroke-width="1.8"
      aria-hidden="true"
    />
    <Teleport to="body">
      <Transition name="agent-config-popup">
        <AgentConfigOptionsPopup
          v-if="popup.open.value"
          ref="popupRef"
          :rows="matches"
          :active-index="activeIndex"
          :current="control.current"
          :query="query"
          :filterable="control.filterable"
          :list-id="listId"
          :labels="{
            list: `${optionName} — ${copy.list}`,
            filter: copy.filter,
            noMatch: copy.noMatch,
          }"
          :left="popup.placement.value.left"
          :top="popup.placement.value.top"
          :min-width="popup.placement.value.minWidth"
          :drop="popup.placement.value.drop"
          @update:query="onQuery"
          @activate="commit"
          @highlight="activeIndex = $event"
          @move="move"
          @jump="activeIndex = $event === 0 ? 0 : Math.max(0, matches.length - 1)"
          @commit="commit(activeIndex)"
          @close="hide"
        />
      </Transition>
    </Teleport>
  </button>
</template>

<style scoped>
/* The trigger is one chip in the composer's control row: the height and border of the send
   button beside it, and the muted colouring Zed gives a config trigger rather than the row's own
   text weight. */
.agent-config-trigger {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-config-trigger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
  color: var(--app-text);
}
.agent-config-trigger:disabled {
  cursor: default;
  opacity: 0.55;
}
.agent-config-trigger[data-failed] {
  /* A set that did not take: the value shown is still the engine's, and the mark says the press
     did not land. The sentence itself is in the title and announced by the row beside it. */
  border-color: color-mix(in srgb, var(--app-danger) 60%, var(--app-border));
  color: var(--app-danger);
}
.agent-config-trigger:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-config-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-config-caret {
  flex: none;
  transition: transform var(--app-motion-fast) var(--app-ease);
}
.agent-config-trigger[aria-expanded="true"] .agent-config-caret {
  transform: rotate(180deg);
}

/* How the list arrives, which is the picker's business because the picker measured where it
   went: the region rung in, its exit fraction out, because by then it has been read. A leaving
   list is on screen for a moment and must not take the dismissing click — hence `pointer-events`
   below. It reaches the popup's element because Vue gives a child component's root the parent's
   scope id as well as its own. */
.agent-config-popup-enter-active {
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease);
}
.agent-config-popup-leave-active {
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              transform var(--app-motion-exit) var(--app-ease-exit);
  pointer-events: none;
}
.agent-config-popup-enter-from,
.agent-config-popup-leave-to {
  opacity: 0;
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(var(--app-motion-scale-pop));
}
.agent-config-popup.is-above.agent-config-popup-enter-from,
.agent-config-popup.is-above.agent-config-popup-leave-to {
  transform: translateY(var(--app-motion-travel)) scale(var(--app-motion-scale-pop));
}
</style>
