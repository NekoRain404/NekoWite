<script lang="ts">
/**
 * One row of a `SelectMenu`. Declared beside the component so a call site and
 * the tests build their lists against the same shape (§13.9).
 */
export interface SelectOption {
  value: string | number
  label: string
  /** Shown and announced, but not selectable: the arrows step over it. */
  disabled?: boolean
}

/** Popup ids must be unique per instance and stable for its whole life. The app
 *  renders no server pass, so a counter is enough — and a call site that passes
 *  `id` gets a readable one instead (`settings-locale-list`). */
let instances = 0
</script>

<script setup lang="ts">
/**
 * A themed stand-in for the native `<select>`.
 *
 * Why it exists: a native select's closed box takes a border, but the popup it
 * opens is drawn by the OS *outside the DOM* — no CSS reaches it. On
 * Linux/WebKitGTK that is a grey system list with the system-blue selection bar
 * in the middle of an otherwise themed app, and it cannot be fixed in place. So
 * the app draws its own listbox.
 *
 * The keyboard model is a select's: focus never leaves the trigger, and
 * `aria-activedescendant` names the row the arrows are on. That is what lets
 * `Tab` fall through to the next field on its own — the popup's rows carry
 * `tabindex="-1"`, so they are not on its path wherever the popup is rendered —
 * and it is the arrangement `ui/CommandPalette.vue` uses for its own list. The
 * popup follows the recipe `ui/ContextMenu.vue` established — same surface,
 * radius, shadow, placement, dismissal and motion rungs. (Not the same code:
 * ContextMenu sits in the frozen `ui/` surface, so its placement and dismissal
 * are ported beside this file, in `use-select-placement.ts`.)
 *
 * **Where the popup goes, and why it does not simply render here.** It is teleported out of the
 * host's subtree: `popupHostOf` (`popup-host.ts`, which seven surfaces ask) is where it lands, and
 * that file is where both halves of the rule are written — the ancestor with a `backdrop-filter`
 * that would become the containing block for these viewport coordinates, and the `<label for>` that
 * 21 of this app's 22 call sites wrap the trigger in, which would hand the popup's own clicks to the
 * label's activation behaviour. The answer is the trigger's nearest `.shell` and never `body`:
 * `body` is outside the one element that carries the user's appearance (`AppShell.vue:271-292`), so
 * a popup there opens light in a dark theme with the system face and the default shadow — measured,
 * and what `e2e/select-popup-scope.spec.ts` pins.
 *
 * `disabled` needs no prop: it falls through to the trigger, a real `<button>`
 * that takes no clicks and is skipped by Tab when disabled.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { modalStack } from '../services/modal-stack'
import { popupHostOf } from './popup-host'
import { useSelectPlacement } from './use-select-placement'

const props = defineProps<{
  /** The chosen value. Picking a row emits the new one. */
  modelValue: string | number
  options: readonly SelectOption[]
  /** Id for the trigger, so an enclosing `<label for>` can name it. */
  id?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number): void
}>()

/** Whether the list is up. The travel itself is the stylesheet's: `<Transition>`
 *  stages the two class sets below, and the global prefers-reduced-motion rule
 *  in `styles/motion.css` is what shortens them for a user who asked for less. */
const open = ref(false)
/** The row `Enter` would take, as an index into `options`. */
const activeIndex = ref(0)

const triggerEl = ref<HTMLButtonElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)

/**
 * Where the popup goes and what keeps it there — the measurement, the follow loop, the listeners
 * that re-place it, and the dismissal a press outside both boxes is. `use-select-placement.ts` says
 * why that is a subject of its own, and what it does *not* own: `open` is read out to it, and a
 * press outside comes back as this component's own `hide()`.
 */
const placement = useSelectPlacement({
  trigger: triggerEl,
  popup: popupEl,
  open,
  close: hide,
})

/**
 * What the popup's `<Teleport>` is aimed at: the trigger's nearest `.shell`, or
 * `body` when the page has none. The rule — and the reason it is a lookup rather
 * than `to=".shell"`, which a `<Teleport>` that matches nothing answers by
 * rendering *nothing* — is `popup-host.ts`'s, because seven surfaces ask it.
 */
const popupHost = ref<Element | string>('body')
onMounted(() => {
  popupHost.value = popupHostOf(triggerEl.value)
})

const uid = props.id ?? `select-menu-${++instances}`
const listId = `${uid}-list`
const optionId = (index: number): string => `${listId}-option-${index}`

/** Claimed while the list is up. See `show()`. */
let escapeToken: symbol | null = null

/** The chosen row's text, or the raw value when it names no row — a directory
 *  filter whose directory has since gone still has to say something. */
const selectedLabel = computed(() => {
  const hit = props.options.find((option) => option.value === props.modelValue)
  return hit ? hit.label : String(props.modelValue)
})

/** The rows the arrows may land on — a disabled one is announced, not a destination. */
const enabledIndexes = (): number[] =>
  props.options.flatMap((option, index) => (option.disabled ? [] : [index]))

function show(): void {
  if (open.value) return
  // Not a tidy-up — `forget()` records what happens without it, and it is a placement that outlives
  // the popup rather than a stale style.
  placement.forget()
  open.value = true
  // Only ever opens on a selectable row: a value that is (or has become) a
  // disabled option must not be what Enter would commit.
  const chosen = props.options.findIndex(
    (option) => option.value === props.modelValue && !option.disabled,
  )
  activeIndex.value = chosen >= 0 ? chosen : (enabledIndexes()[0] ?? 0)
  // Escape is arbitrated by the app's modal stack. A dropdown raised inside a
  // dialog is what the user is looking at, so without a claim the dialog's own
  // window-level handler (useModalEscape, capture phase, ahead of this trigger)
  // closes the whole dialog out from under the open list.
  escapeToken = modalStack.claimModal('select-menu')
  placement.start()
}

function hide(): void {
  if (!open.value) return
  open.value = false
  modalStack.releaseModal(escapeToken)
  escapeToken = null
  placement.stop()
}

function commit(index: number): void {
  const option = props.options[index]
  if (!option || option.disabled) return
  emit('update:modelValue', option.value)
  hide()
}

function setActive(index: number): void {
  const option = props.options[index]
  if (option && !option.disabled) activeIndex.value = index
}

/** Step one row, wrapping: the bottom leads back to the top, as a native select does. */
function move(offset: number): void {
  const rows = enabledIndexes()
  if (!rows.length) return
  const at = rows.indexOf(activeIndex.value)
  activeIndex.value = at < 0
    ? rows[offset > 0 ? 0 : rows.length - 1]
    : rows[(at + offset + rows.length) % rows.length]
}

function jump(to: 0 | -1): void {
  const rows = enabledIndexes()
  if (rows.length) activeIndex.value = to === 0 ? rows[0] : rows[rows.length - 1]
}

function onTriggerClick(): void {
  // Pointer only: the key handler cancels the click `Enter` and `Space` would
  // otherwise synthesise, so a press cannot open and instantly close the list.
  if (open.value) hide()
  else show()
}

function onTriggerKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (!open.value) return
    e.preventDefault()
    // The dialog handlers that have not run yet; the modal claim above is what
    // silences the ones that already have.
    e.stopPropagation()
    hide()
    return
  }
  if (e.key === 'Tab') {
    // Left to the browser: the popup is not in its path, so the next stop is
    // whatever follows the trigger — what "close and move on" means.
    hide()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (open.value) move(e.key === 'ArrowDown' ? 1 : -1)
    else show()
    return
  }
  if (e.key === 'Home' || e.key === 'End') {
    if (!open.value) return
    e.preventDefault()
    jump(e.key === 'Home' ? 0 : -1)
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    // preventDefault cancels the click the button would synthesise, which is
    // what keeps `Space` from opening and closing in the same press.
    e.preventDefault()
    if (open.value) commit(activeIndex.value)
    else show()
  }
}

// A list taller than the popup's cap has to follow the arrows, as the command
// palette's does. The keyboard only ever moved the index; the DOM is ours.
watch(activeIndex, () => {
  void nextTick(() => {
    popupEl.value
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
})

onBeforeUnmount(() => {
  modalStack.releaseModal(escapeToken)
  escapeToken = null
  placement.stop()
})
</script>

<template>
  <button
    :id="id"
    ref="triggerEl"
    class="select-trigger"
    type="button"
    role="combobox"
    :aria-expanded="open"
    :aria-controls="listId"
    :aria-activedescendant="open ? optionId(activeIndex) : undefined"
    @click="onTriggerClick"
    @keydown="onTriggerKeydown"
  >
    <span class="select-value">{{ selectedLabel }}</span>
    <ChevronDown
      class="select-caret"
      :size="14"
      :stroke-width="1.8"
    />
    <Teleport :to="popupHost">
      <Transition name="select-popup">
        <div
          v-if="open"
          :id="listId"
          ref="popupEl"
          class="select-popup"
          :class="{ 'is-above': placement.pos.value.drop === 'up' }"
          :style="{
            left: `${placement.pos.value.left}px`,
            top: `${placement.pos.value.top}px`,
            minWidth: `${placement.pos.value.minWidth}px`,
            // `undefined` and not `null`: Vue removes a style property for either, and only
            // `undefined` is a `StyleValue`.
            maxWidth: placement.pos.value.maxWidth === null
              ? undefined
              : `${placement.pos.value.maxWidth}px`,
          }"
          role="listbox"
        >
          <button
            v-for="(option, index) in options"
            :id="optionId(index)"
            :key="option.value"
            class="select-option"
            :class="{ 'is-active': index === activeIndex, 'is-selected': option.value === modelValue }"
            type="button"
            role="option"
            :aria-selected="option.value === modelValue"
            :aria-disabled="option.disabled || undefined"
            tabindex="-1"
            :data-index="index"
            :data-value="option.value"
            @mousedown.prevent
            @mouseenter="setActive(index)"
            @click="commit(index)"
          >
            <span class="select-option-label">{{ option.label }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </button>
</template>

<style scoped>
/* The closed control is styled by whoever hosts it — `.input`, `.graph-select`,
   `.chat-session-select` — and that is where its focus ring comes from; what is
   set here is only what they cannot know: a flex row of label and caret. */
.select-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  text-align: left;
  cursor: pointer;
}
.select-trigger:disabled { opacity: 0.5; cursor: default; }
.select-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.select-caret {
  flex: none;
  color: var(--app-muted);
  /* An in-place state flip that keeps its footprint: the ladder names this. */
  transition: transform var(--app-motion-fast) var(--app-ease);
}
.select-trigger[aria-expanded="true"] .select-caret {
  transform: rotate(180deg);
}

.select-popup {
  position: fixed;
  /* Above the modal layer (10000) — a dropdown opens from inside the settings
     dialog — and below the toast layer (11000). */
  z-index: 10001;
  /* No `max-width`. It is a measurement rather than a declaration (`use-select-placement.ts`'s
     `floor` and `ceiling`, i.e. `measurePlacement`), and a `280px` used to sit here as a second,
     smaller answer to the same question — see that function for what it cost. `max-height` stays,
     and it is a *different* decision: a list longer than 280px scrolls, which is the number
     `e2e/popup-list-room.spec.ts` reads. */
  max-height: 280px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  /* The edge the trigger is on is the edge it grows out of, and which edge that
     is comes from `placement.pos.value.drop` — the placement the component measured. Set on the
     base rule rather than on the transition classes, which Vue removes a frame
     into the transition, where the origin would snap to the centre mid-flight. */
  transform-origin: top center;
}
.select-popup.is-above {
  transform-origin: bottom center;
}
/* The list is a region arriving in place, so it takes the region rung, and it
   leaves on that rung's exit fraction, accelerating, because by then it has been
   read. A leaving popup is on screen for a moment and must not take the
   dismissing click — hence `pointer-events` below. */
.select-popup-enter-active {
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease);
}
.select-popup-leave-active {
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              transform var(--app-motion-exit) var(--app-ease-exit);
  pointer-events: none;
}
.select-popup-enter-from,
.select-popup-leave-to {
  opacity: 0;
  /* Dropping down: it starts a few pixels *up*, against the trigger it came from,
     and travels down into place. Opening upward the sign flips with the
     placement, so it still emerges from the control rather than from a gap it
     never occupied. There is no `transform: scale` shorthand trick here — the
     travel is the travel token, one sign per placement, both stated once. */
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(var(--app-motion-scale-pop));
}
.select-popup.is-above.select-popup-enter-from,
.select-popup.is-above.select-popup-leave-to {
  transform: translateY(var(--app-motion-travel)) scale(var(--app-motion-scale-pop));
}

.select-option {
  display: flex;
  align-items: center;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.select-option.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.select-option.is-selected { color: var(--app-accent); }
.select-option[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
