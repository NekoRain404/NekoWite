<script lang="ts">
/** Popup ids must be unique per instance and stable for its whole life. The app
 *  renders no server pass, so a counter is enough — and a call site that passes
 *  `id` gets a readable one instead (`settings-ai-model-list`). */
let instances = 0
</script>

<script setup lang="ts">
/**
 * An editable combobox: a text input with the list drawn by the app under it.
 *
 * Why it exists: it replaces an `<input list="…">` plus a native `<datalist>`,
 * whose popup is drawn by the engine *outside the DOM* — no CSS reaches it, and
 * WebKitGTK draws one poorly enough that a refresh which had in fact fetched
 * the models showed the user nothing. The same class of control as the native
 * `<select>`s `SelectMenu` replaced, and the same remedy.
 *
 * What makes it a combobox rather than a picker: the list is only ever as good
 * as the provider's `/models` endpoint, and people paste ids it does not list.
 * So the typed text is the value. Every keystroke is emitted, `Enter` takes a
 * row only while the list is up, and a query that matches nothing leaves the
 * field exactly as it was — a control that could only commit a listed value
 * would be a worse bug than the one this fixes.
 *
 * The keyboard and ARIA model is the one `SelectMenu` uses and
 * `ui/CommandPalette.vue` established before it: focus never leaves the input,
 * `aria-activedescendant` names the row the arrows are on, and the rows are not
 * tabbable, so `Tab` falls through to the next field on its own. The popup
 * follows the recipe `ui/ContextMenu.vue` established — same surface, radius,
 * shadow, placement, dismissal and motion rungs. Ported rather than shared,
 * because those two files sit in the frozen `ui/` surface.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { modalStack } from '../services/modal-stack'

// `class`, `placeholder`, `title` and any listener are the closed control's
// look and behaviour, and the closed control is the input — not the wrapper
// that exists only to hold the teleported list beside it.
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** The value in the field. Never constrained by `options`. */
  modelValue: string
  /** The suggestions. Empty means an ordinary text input. */
  options: readonly string[]
  /** Id for the input, so an enclosing `<label for>` can name it. */
  id?: string
  /** Accessible name for the list, since a listbox of bare strings has none. */
  listLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

/** Whether the list is up. The travel itself is the stylesheet's: `<Transition>`
 *  stages the two class sets below, and the global prefers-reduced-motion rule
 *  in `styles/motion.css` is what shortens them. */
const open = ref(false)
/** The text typed since the list opened, and the only thing the list narrows
 *  on. It starts empty even when the field already holds a model, so opening
 *  the field always shows the whole list: filtering on the field's own value
 *  would hide every model a refresh just fetched whenever one was already
 *  configured, which is the report this component answers. Once the user types,
 *  the narrowing is the search they asked for. */
const query = ref('')
/** The row `Enter` would take, as an index into `rows`. */
const activeIndex = ref(0)
const pos = ref({ left: 0, top: 0, minWidth: 180 })

const inputEl = ref<HTMLInputElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)

const uid = props.id ?? `combobox-${++instances}`
const listId = `${uid}-list`
const optionId = (index: number): string => `${listId}-option-${index}`

/** Claimed while the list is up. See `show()`. */
let escapeToken: symbol | null = null

const rows = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return props.options
  return props.options.filter((option) => option.toLowerCase().includes(text))
})

/** Put the popup against the field, inside the viewport: below the control,
 *  flipped above when that overflows, nudged sideways to fit. */
async function place(): Promise<void> {
  await nextTick()
  const anchor = inputEl.value?.getBoundingClientRect()
  const popup = popupEl.value
  if (!anchor || !popup) return
  const pad = 8
  // The box, not the rect: the rect is measured through the enter transition.
  // And the wider of the two: the floor below widens the popup, so clamping
  // against the old width would let it cross the right edge.
  const floor = Math.max(180, Math.min(anchor.width, 280))
  const width = Math.max(popup.offsetWidth, floor)
  const height = popup.offsetHeight
  const below = anchor.bottom + 4
  const above = anchor.top - height - 4
  pos.value = {
    left: Math.min(Math.max(pad, anchor.left), Math.max(pad, window.innerWidth - width - pad)),
    top: below + height <= window.innerHeight - pad || above < pad
      ? Math.min(below, Math.max(pad, window.innerHeight - height - pad))
      : above,
    // Never narrower than the field it belongs to, never wider than a menu.
    minWidth: floor,
  }
}

function onPointerDown(e: PointerEvent): void {
  const target = e.target as Node
  // The input is not "outside": its own click handler owns the open, and
  // dismissing here as well would close and immediately reopen the list.
  if (inputEl.value?.contains(target)) return
  if (popupEl.value?.contains(target)) return
  hide()
}

function onViewportChange(): void {
  // Repositioned rather than dismissed, as a dropdown anchored to a control
  // still on screen should be: closing it because a pane scrolled under it
  // would lose the list the user was reading.
  if (open.value) void place()
}

function watchViewport(watching: boolean): void {
  // Written out rather than dispatched through `document[watching ? 'add' :
  // 'remove'](...)`: the computed method defeats overload resolution, and
  // `onPointerDown` takes a `PointerEvent`, which is not assignable to the
  // generic `EventListener` its sibling handlers satisfy.
  if (watching) {
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
  }
}

function show(): void {
  if (open.value) return
  // Nothing to offer: with no suggestions the field is an ordinary text input,
  // and an empty popup over the fields below it is worse than no popup.
  const list = rows.value
  if (!list.length) return
  open.value = true
  // Only ever opens on a row: the one the field already holds, else the top.
  const chosen = list.indexOf(props.modelValue)
  activeIndex.value = chosen >= 0 ? chosen : 0
  // Escape is arbitrated by the app's modal stack. A dropdown raised inside a
  // dialog is what the user is looking at, so without a claim the dialog's own
  // window-level handler (useModalEscape, capture phase, ahead of this input)
  // closes the whole dialog out from under the open list.
  escapeToken = modalStack.claimModal('combobox')
  watchViewport(true)
  void place()
}

function hide(): void {
  // Cleared either way: a query typed while nothing was open must not be what
  // the next open filters on.
  query.value = ''
  if (!open.value) return
  open.value = false
  activeIndex.value = 0
  modalStack.releaseModal(escapeToken)
  escapeToken = null
  watchViewport(false)
}

function commit(index: number): void {
  const option = rows.value[index]
  if (option === undefined) return
  emit('update:modelValue', option)
  hide()
  // The commit is a value change, not a move: the caret stays in the field, so
  // the user can keep editing what they just took from the list.
  inputEl.value?.focus()
}

function setActive(index: number): void {
  activeIndex.value = index
}

/** Step one row, wrapping: the bottom leads back to the top, as a list does. */
function move(offset: number): void {
  const len = rows.value.length
  if (!len) return
  activeIndex.value = (activeIndex.value + offset + len) % len
}

function onInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  // The value first and unconditionally: what the user typed is the model, and
  // the list is a suggestion about it, never a gate in front of it.
  emit('update:modelValue', value)
  query.value = value
  activeIndex.value = 0
  if (rows.value.length) show()
  else hide()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (!open.value) return
    e.preventDefault()
    // The dialog handlers that have not run yet; the modal claim above is what
    // silences the ones that already have.
    e.stopPropagation()
    // Closes only: what the user typed is theirs to keep, and is often the
    // whole reason they were typing.
    hide()
    return
  }
  if (e.key === 'Tab') {
    // Left to the browser: the popup is not in its path, so the next stop is
    // whatever follows this field — what "close and move on" means.
    hide()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (open.value) move(e.key === 'ArrowDown' ? 1 : -1)
    else show()
    // Claimed only when there is a list to move through: with no suggestions
    // the field is an ordinary text input and keeps its ordinary keys.
    if (open.value) e.preventDefault()
    // Home, End and the left/right pair are deliberately not handled at all:
    // in an editable field they move the caret, and a combobox that stole them
    // could not be typed into.
    return
  }
  if (e.key === 'Enter') {
    // Only while the list is up. With it closed there is no highlighted row to
    // commit and Enter belongs to whatever encloses the field.
    if (!open.value) return
    e.preventDefault()
    commit(activeIndex.value)
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
  watchViewport(false)
})
</script>

<template>
  <div class="combobox">
    <input
      :id="uid"
      ref="inputEl"
      v-bind="$attrs"
      class="combo-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open ? optionId(activeIndex) : undefined"
      :value="modelValue"
      @input="onInput"
      @click="show"
      @keydown="onKeydown"
    >
    <Teleport to="body">
      <Transition name="combo-popup">
        <div
          v-if="open"
          :id="listId"
          ref="popupEl"
          class="combo-popup"
          :style="{ left: `${pos.left}px`, top: `${pos.top}px`, minWidth: `${pos.minWidth}px` }"
          role="listbox"
          :aria-label="listLabel"
        >
          <button
            v-for="(option, index) in rows"
            :id="optionId(index)"
            :key="option"
            class="combo-option"
            :class="{ 'is-active': index === activeIndex, 'is-selected': option === modelValue }"
            type="button"
            role="option"
            :aria-selected="option === modelValue"
            tabindex="-1"
            :data-index="index"
            :data-value="option"
            @mousedown.prevent
            @mouseenter="setActive(index)"
            @click="commit(index)"
          >
            <span class="combo-option-label">{{ option }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* The wrapper exists to hold the teleported list beside an input that keeps the
   host's own class and would otherwise be the component's only root — and so
   must be a flex box: an inline-block input in a block wrapper hangs from a
   text baseline and the row it sits in would grow by the descender. */
.combobox {
  display: flex;
  min-width: 0;
}
.combo-input {
  flex: 1;
  min-width: 0;
}

.combo-popup {
  position: fixed;
  /* Above the modal layer (10000) — a dropdown opens from inside the settings
     dialog — and below the toast layer (11000). */
  z-index: 10001;
  max-width: 280px;
  max-height: 280px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
}
/* The list is a region arriving in place, so it takes the region rung, and it
   leaves on the next rung down, accelerating, because by then it has been read.
   A leaving popup is on screen for a frame and must not take the dismissing
   click. */
.combo-popup-enter-active {
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease);
}
.combo-popup-leave-active {
  transition: opacity var(--app-motion-fast) var(--app-ease-exit),
              transform var(--app-motion-fast) var(--app-ease-exit);
  pointer-events: none;
}
.combo-popup-enter-from,
.combo-popup-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.98);
}

.combo-option {
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
.combo-option.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.combo-option.is-selected { color: var(--app-accent); }
.combo-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
