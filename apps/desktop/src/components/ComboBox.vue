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
 *
 * This file is the field half: the input, the narrowing, the keyboard, and
 * where the popup goes. The list — its element, its option ids, its scrolling —
 * is `ComboBoxList.vue`, teleported under the field here.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { modalStack } from '../services/modal-stack'
import ComboBoxList from './ComboBoxList.vue'
import { comboOptionId } from './combo-option-id'
import { popupHostOf } from './popup-host'

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
 *  stages the two class sets the list defines, and the global
 *  prefers-reduced-motion rule in `styles/motion.css` is what shortens them. */
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
/**
 * The placement a list is measured *from* rather than to: enough width to exist, and no ceiling —
 * a box without one is what `measurePlacement` has to read to learn its content's width. `null`
 * and not `Infinity`, because `max-width: Infinitypx` is not a value.
 *
 * **`show()` resets it before every open, and that is not tidiness.** `pos` outlives the popup, so
 * Vue renders the next list with the *last* placement's `min-width` on its first frame, and
 * `measurePlacement` is then read off a box this component sized for a different dialog. Measured
 * on `SelectMenu.vue`, which carries the same recipe: raising its floor above 280 opened the AI
 * provider's list **87px to the left of its control** on the first open after the dialog was
 * widened. The same arithmetic runs here, on the same resizable dialog.
 */
const unplaced = () => ({
  left: 0,
  top: 0,
  minWidth: 180,
  maxWidth: null as number | null,
  drop: 'down' as 'down' | 'up',
})

/** Where the popup was put, and which way it had to open. `drop` is what tells
 *  the stylesheet which edge of the popup touches the field, so its arrival can
 *  come from there — see `place()`. */
const pos = ref(unplaced())

const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<InstanceType<typeof ComboBoxList> | null>(null)

/**
 * What the list's `<Teleport>` is aimed at: the field's nearest `.shell`, or `body` when the page
 * has none.
 *
 * `body` is outside `.shell` — the one element `AppShell.vue:285-292` puts the user's appearance
 * on — so a list rendered there resolved `palettes.css`'s `:root` block instead: measured in a
 * dark `forest` window at `17px` and Source Serif 4, the field's own list drew
 * `color(srgb 0.998431 0.994353 0.982275)` on `--app-elevated: #fffefb` with the light border, the
 * light shadow, `system-ui` on its rows and the `ink` `--app-accent` on the selected one, while
 * the field beside it drew `rgb(232, 243, 226)`. `components/SelectMenu.vue` is the same fix and
 * `components/popup-host.ts` is where the carrier is named once for both.
 *
 * Resolved from the field rather than written as `to=".shell"`, because a `<Teleport>` whose
 * selector matches nothing renders *nothing*: `resolveTarget` returns null and `TeleportImpl`
 * never mounts the slot's nodes, so a static selector would trade a wrong-looking list for an
 * invisible one on any page without a shell. A page that publishes on the document element — the
 * pet window's own page (`features/desktop-pet/services/pet-page-appearance.ts`) — is that page,
 * and `body`, which is what this component used to teleport to, is already inside its scope.
 *
 * The teleport itself stays. `place()` turns the field's `getBoundingClientRect()` — a viewport
 * rectangle — into `left`/`top`, which is only an answer while the containing block is the
 * viewport; and a popup rendered in place would be inside the `<label class="settings-field">`
 * that wraps this field at its one call site (`features/settings/components/AiSettings.vue:83`),
 * whose activation behaviour hands a press on the list's own padding to the input.
 */
const popupHost = ref<Element | string>('body')
onMounted(() => {
  popupHost.value = popupHostOf(inputEl.value)
})

const uid = props.id ?? `combobox-${++instances}`
const listId = `${uid}-list`
const optionId = (index: number): string => comboOptionId(listId, index)

/** Claimed while the list is up. See `show()`. */
let escapeToken: symbol | null = null

const rows = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return props.options
  return props.options.filter((option) => option.toLowerCase().includes(text))
})

/**
 * Put the popup against the field, inside the viewport: below the control, flipped
 * above when that overflows, nudged sideways to fit.
 *
 * Synchronous, and that is what `followField()` needs: the loop below runs once a frame and must
 * not have two placements in flight, so the part that measures and writes is separated from the
 * `nextTick` that waits for the list to exist. The await is real — `listEl` is rendered by the
 * `v-if` `show()` sets, and `measure()` answers null until it is — so it stays in {@link place}.
 */
function measurePlacement(): void {
  const anchor = inputEl.value?.getBoundingClientRect()
  // Measured by the list, placed by the field: it is the field that can measure
  // its own anchor, and the list that holds the box to place against it.
  const box = listEl.value?.measure()
  if (!anchor || !box) return
  const pad = 8
  // The room the window gives a list — the window less the same pad it keeps from either edge — and
  // the field's own width, clamped into it. Those two are the whole of the popup's width rule:
  // never narrower than the field it belongs to, never wider than the window it is in. The
  // stylesheet declares neither, and the two that used to be there were both 280px — a
  // `Math.min(anchor.width, 280)` on this floor and a `max-width: 280px` on the list's own rule
  // (`ComboBoxList.vue`) — measured by `e2e/combo-popup-width.spec.ts` at 1280x800, where the
  // model field is 455px and the list opened at **280px inside it**, and stayed 280 while the user
  // dragged the dialog wider (the field went 455 -> 535). The floor's own inner 180 is for a field
  // *smaller* than a list can usefully be.
  const ceiling = Math.max(180, window.innerWidth - pad * 2)
  const floor = Math.min(Math.max(180, anchor.width), ceiling)
  // The box, not the rect: the rect is measured through the enter transition. And the clamp below
  // is against the width the popup will *have* — its content's, once the floor and the ceiling
  // have had their say — because the content's alone is the number that crosses the right edge.
  const width = Math.min(Math.max(box.width, floor), ceiling)
  const height = box.height
  const below = anchor.bottom + 4
  const above = anchor.top - height - 4
  // Which way it opened, carried through to the stylesheet: near the bottom of
  // the window the list flips above the field, and its arrival has to flip with
  // it. A list that sat above its field while rising into place from below would
  // arrive from a gap it never occupied. See SelectMenu.place, which this ports.
  const dropsDown = below + height <= window.innerHeight - pad || above < pad
  pos.value = {
    left: Math.min(Math.max(pad, anchor.left), Math.max(pad, window.innerWidth - width - pad)),
    top: dropsDown
      ? Math.min(below, Math.max(pad, window.innerHeight - height - pad))
      : above,
    minWidth: floor,
    maxWidth: ceiling,
    drop: dropsDown ? 'down' : 'up',
  }
}

async function place(): Promise<void> {
  await nextTick()
  measurePlacement()
}

/**
 * The field, followed while it moves.
 *
 * It is here because the anchor can move *without* any of the three things this component watches
 * — the window resizing, anything scrolling, its own boxes changing size — and the measurement is
 * what says so. The settings pages arrive through a `scale`/`translate` transition
 * (`SettingsPanel.vue:347-355`: `--app-motion-slow` on the surface spring), so a press that lands
 * while the AI page is still on its way in is placed against a field that goes on moving for the
 * length of the spring. Measured in Chromium, at 1280x720, with the press made in the same frame
 * the page swap starts: the list settled **20.719px below and 6.688px right** of the field it is
 * supposed to hang 4px off (and the stale number the report carried, 19.59px, is the same defect
 * at their window and their body size).
 *
 * **The instrument the report suggested would not have found it.** A `ResizeObserver` on the field
 * fires nothing for this: `scale` and `translate` are transforms, so the field's box never changes
 * size — measured, over the 17px that field travelled the observer reported not one callback. What
 * *is* observable is the rectangle itself, so one is read per frame — and the loop stops as soon
 * as two frames agree, which is the whole of the cost: three reads for an open with nothing
 * moving, and nothing at all once the field has arrived. The stop is a comparison of the rectangle
 * rather than a timeout, so no duration of the design system is repeated here; a spring's last
 * hundredth of a pixel keeps the loop alive for exactly as long as it takes, and the placement it
 * wrote is the one the field has come to rest at.
 *
 * Re-armed by {@link watchMotion} as well, and that half is not a refinement: the case the spec's
 * own flow measures is a press made *before* the page swap's spring has begun to move, where the
 * field's rectangle is still for the two frames the loop allows and the loop has stopped by the
 * time the transition starts — measured, that flow settled 16.5px out with the open alone arming
 * it. A movement that starts later announces itself (`transitionrun`, `animationstart`), so the
 * loop is re-armed from there rather than kept alive by a timer that would have to guess how long
 * an engine takes to begin.
 */
let follow = 0
/** The rectangle as the last frame read it, and how many frames in a row have agreed. */
let watched = ''
let still = 0

/** The field's placement-relevant geometry, as a string to compare frame against frame. Only the
 *  numbers `measurePlacement` reads: a rect that differs in a field nothing is placed from would
 *  keep the loop alive for a change no reader can see. */
function rectKey(): string {
  const rect = inputEl.value?.getBoundingClientRect()
  return rect === undefined ? '' : `${rect.top}:${rect.left}:${rect.width}:${rect.height}`
}

function stopFollowing(): void {
  if (follow !== 0) cancelAnimationFrame(follow)
  follow = 0
  watched = ''
  still = 0
}

function followField(): void {
  if (follow !== 0) return
  watched = rectKey()
  still = 0
  const step = (): void => {
    follow = 0
    // The list may have closed inside the frame (Escape, a commit, a press outside), and a
    // frame spent placing a popup that is gone is a write to the *next* one's position.
    if (!open.value) return
    const now = rectKey()
    if (now !== watched) {
      watched = now
      still = 0
      measurePlacement()
    } else {
      // Two agreeing frames, not one: a spring has a frame of near-zero movement at its peak, and
      // a loop that stopped there would leave the list at the wrong end of the overshoot.
      still += 1
      if (still >= 2) return
    }
    follow = requestAnimationFrame(step)
  }
  follow = requestAnimationFrame(step)
}

/**
 * A movement starting under an open list, taken from the DOM rather than waited for.
 *
 * `transitionrun` and `animationstart` bubble, so one listener on the document hears every arrival
 * in it, and the filter is what keeps that from being a re-place per hover colour: only a target
 * that is the field itself or a box *above* it can move the field. `transitionrun` rather than
 * `transitionstart`: it fires when the transition is created, before any delay, which is the
 * earliest moment the movement is a fact.
 */
function onMotionStart(event: Event): void {
  if (!open.value) return
  const target = event.target
  const field = inputEl.value
  if (!(target instanceof Element) || field === null) return
  if (target !== field && !target.contains(field)) return
  followField()
}

function watchMotion(watching: boolean): void {
  if (watching) {
    document.addEventListener('transitionrun', onMotionStart)
    document.addEventListener('animationstart', onMotionStart)
  } else {
    document.removeEventListener('transitionrun', onMotionStart)
    document.removeEventListener('animationstart', onMotionStart)
  }
}

function onPointerDown(e: PointerEvent): void {
  const target = e.target as Node
  // The input is not "outside": its own click handler owns the open, and
  // dismissing here as well would close and immediately reopen the list.
  if (inputEl.value?.contains(target)) return
  // Nor is the list: its rows are the popup, and a click on one is a commit,
  // not a dismissal.
  if (listEl.value?.contains(target)) return
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
  // Forgotten before the open, so the arithmetic below is idempotent: see `unplaced`.
  pos.value = unplaced()
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
  watchMotion(true)
  void place()
  // And the field is followed from here, because a movement that began before the press is one no
  // event of ours will announce — see `followField()`.
  followField()
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
  watchMotion(false)
  stopFollowing()
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
// palette's does. The keyboard only ever moved the index; the scroll is DOM
// work on an element the list owns.
watch(activeIndex, () => {
  void nextTick(() => listEl.value?.scrollActiveIntoView(activeIndex.value))
})

onBeforeUnmount(() => {
  modalStack.releaseModal(escapeToken)
  escapeToken = null
  watchViewport(false)
  watchMotion(false)
  stopFollowing()
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
    <Teleport :to="popupHost">
      <Transition name="combo-popup">
        <ComboBoxList
          v-if="open"
          ref="listEl"
          :list-id="listId"
          :rows="rows"
          :active-index="activeIndex"
          :model-value="modelValue"
          :list-label="listLabel"
          :left="pos.left"
          :top="pos.top"
          :min-width="pos.minWidth"
          :max-width="pos.maxWidth"
          :drop="pos.drop"
          @activate="commit"
          @highlight="setActive"
        />
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
</style>
