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
 * are ported below.)
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

/** What a popup is placed *from* rather than to: enough width to exist, and no ceiling — a box
 *  without one is what {@link measurePlacement} has to read to learn its content's width. `null`
 *  and not `Infinity`, because `max-width: Infinitypx` is not a value. */
const unplaced = () => ({
  left: 0,
  top: 0,
  minWidth: 180,
  maxWidth: null as number | null,
  drop: 'down' as 'down' | 'up',
})

/** Whether the list is up. The travel itself is the stylesheet's: `<Transition>`
 *  stages the two class sets below, and the global prefers-reduced-motion rule
 *  in `styles/motion.css` is what shortens them for a user who asked for less. */
const open = ref(false)
/** The row `Enter` would take, as an index into `options`. */
const activeIndex = ref(0)
/** Where the popup was put, and which way it had to open. `drop` is not
 *  geometry the component uses — it is what tells the stylesheet which edge of
 *  the popup is the one touching the trigger, so the arrival can come from there
 *  and the scale can grow out of it.
 *
 *  `minWidth`/`maxWidth` are the popup's own bounds, *measured* rather than declared — see
 *  {@link measurePlacement} for the two numbers and for why the stylesheet holds neither. */
const pos = ref(unplaced())

const triggerEl = ref<HTMLButtonElement | null>(null)
const popupEl = ref<HTMLElement | null>(null)

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

/**
 * Put the popup against its trigger, inside the viewport: below the control,
 * flipped above when that overflows, nudged sideways to fit.
 *
 * Synchronous, and that is what {@link followTrigger} needs — one loop, one placement in flight —
 * so the measuring half is separated from the `nextTick` that waits for the popup to exist, which
 * {@link place} keeps.
 */
function measurePlacement(): void {
  const trigger = triggerEl.value
  const popup = popupEl.value
  if (!trigger || !popup) return
  const pad = 8
  const anchor = trigger.getBoundingClientRect()
  // The room the window gives a list — the window less the same pad it keeps from either edge — and
  // the control's own width, clamped into it. Those two are the whole of the popup's width rule:
  // never narrower than the control it belongs to, never wider than the window it is in. The
  // stylesheet declares neither, and the one that used to be there (`max-width: 280px`) was not a
  // ceiling but a second, smaller width — measured in Chromium at 1280x800 through
  // `e2e/select-popup-width.spec.ts`, every select in the settings dialog opened its list at
  // **280px inside a 526px control**, with the labels it exists to show ellipsised at the same
  // character the closed control had already ellipsised them at, and it stayed 280 while the user
  // dragged the dialog wider (the control went 526 -> 606). The floor's own inner 180 is for a
  // control *smaller* than a list can usefully be.
  const ceiling = Math.max(180, window.innerWidth - pad * 2)
  const floor = Math.min(Math.max(180, anchor.width), ceiling)
  // The box, not the rect: the rect is measured through the enter transition. And the clamp below
  // is against the width the popup will *have* — its content's, once the floor and the ceiling have
  // had their say — because the content's alone is the number that crosses the right edge.
  const width = Math.min(Math.max(popup.offsetWidth, floor), ceiling)
  const height = popup.offsetHeight
  const below = anchor.bottom + 4
  const above = anchor.top - height - 4
  // Which way it opened, decided once and carried through to the stylesheet: the
  // popup tells the user where it came from with the pixels it travels, and near
  // the bottom of the window that direction is *up*. A popup that flipped to sit
  // above its trigger while still rising into place from below would be
  // arriving from a gap it does not occupy — the same defect the heading menu
  // and the context menu were both moved off.
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
 * The trigger, followed while it moves — `ComboBox.vue`'s shape, where it was measured first, and
 * the same blind spot this file and `use-detached-popup.ts` both had.
 *
 * The trigger can move *without* either of the two things this component watched — the window
 * resizing, anything scrolling — and a `ResizeObserver` cannot see it either, because `scale` and
 * `translate` leave every number of a box unchanged. The settings pages arrive through exactly that
 * spring (`SettingsPanel.vue`'s page swap), so a press landing while the page is still on its way
 * in is placed against a trigger that goes on moving. `e2e/select-popup-scope.spec.ts` is where
 * that was measured and where the numbers live.
 *
 * So the rectangle is read once a frame, and the loop stops as soon as two frames agree — three
 * reads for an open with nothing moving, and nothing once the trigger has arrived. The stop is the
 * rectangle rather than a timeout, so no duration of the design system is repeated here; two
 * agreeing frames rather than one, because a spring has a frame of near-zero movement at its peak.
 *
 * Re-armed by {@link watchMotion}, and that half is not a refinement: a press made *before* the
 * spring has begun leaves the rectangle still for the two frames this loop allows, so the loop has
 * stopped by the time the movement starts. A movement beginning later announces itself, and the
 * loop is re-armed from there rather than kept alive by a timer guessing an engine's delay.
 */
let follow = 0
/** The rectangle as the last frame read it, and how many frames in a row have agreed. */
let watched = ''
let still = 0

/** The trigger's placement-relevant geometry as a string: only the numbers {@link measurePlacement}
 *  reads, so a change in a field nothing is placed from cannot keep the loop alive. */
function rectKey(): string {
  const rect = triggerEl.value?.getBoundingClientRect()
  return rect === undefined ? '' : `${rect.top}:${rect.left}:${rect.width}:${rect.height}`
}

function stopFollowing(): void {
  if (follow !== 0) cancelAnimationFrame(follow)
  follow = 0
  watched = ''
  still = 0
}

function followTrigger(): void {
  if (follow !== 0) return
  watched = rectKey()
  still = 0
  const step = (): void => {
    follow = 0
    // The list may have closed inside the frame (Escape, a commit, a press outside), and a frame
    // spent placing a popup that is gone is a write to the *next* one's position.
    if (!open.value) return
    const now = rectKey()
    if (now !== watched) {
      watched = now
      still = 0
      measurePlacement()
    } else {
      // Two agreeing frames, not one: a spring has a frame of near-zero movement at its peak, and a
      // loop that stopped there would leave the list at the wrong end of the overshoot.
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
 * that is the trigger itself or a box *above* it can move the trigger. `transitionrun` rather than
 * `transitionstart`: it fires when the transition is created, before any delay.
 */
function onMotionStart(event: Event): void {
  if (!open.value) return
  const target = event.target
  const trigger = triggerEl.value
  if (!(target instanceof Element) || trigger === null) return
  if (target !== trigger && !target.contains(trigger)) return
  followTrigger()
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
  // The trigger is not "outside": its own click handler owns the toggle, and
  // dismissing here as well would close and immediately reopen the list.
  if (triggerEl.value?.contains(target)) return
  if (popupEl.value?.contains(target)) return
  hide()
}

function onViewportChange(): void {
  // Repositioned rather than dismissed, unlike ContextMenu: that one is anchored
  // to a point the user clicked and scrolling means it has moved on, while a
  // select belongs to a control still on screen — closing it as a pane scrolled
  // under it would lose the list the user was reading.
  if (open.value) void place()
}

function watchViewport(watching: boolean): void {
  // Written out rather than dispatched through `document[watching ? 'add' :
  // 'remove'](...)`: the computed method defeats overload resolution, and
  // `onPointerDown` takes a `PointerEvent`, which is not assignable to the
  // generic `EventListener` its sibling handlers satisfy. Explicit branches
  // typecheck without a cast and say the same thing.
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
  // The placement is forgotten before the list is drawn again, and that is not a tidy-up: `pos`
  // outlives the popup, Vue renders the next one with the *last* `min-width` on its first frame,
  // and the first `measurePlacement` is usually the only one (the follow loop re-places a *moving*
  // trigger, and a list opened at rest has none). So the loop used to read a box the component had
  // sized for a previous, different trigger — invisible while the stylesheet pinned the width at
  // 280px, and a visible misplacement the moment the floor followed the control: measured through
  // `e2e/settings-resize.spec.ts`, the AI provider's list opened **87px to the left of its
  // control**, a `min-width: 908px` from a wider dialog entering the left clamp. Forgetting it
  // makes the placement idempotent, which is the property that was missing.
  pos.value = unplaced()
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
  watchViewport(true)
  watchMotion(true)
  void place()
  // And the trigger is followed from here, because a movement that began before the press is one no
  // event of ours will announce — see `followTrigger()`.
  followTrigger()
}

function hide(): void {
  if (!open.value) return
  open.value = false
  modalStack.releaseModal(escapeToken)
  escapeToken = null
  watchViewport(false)
  watchMotion(false)
  stopFollowing()
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
  watchViewport(false)
  watchMotion(false)
  stopFollowing()
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
          :class="{ 'is-above': pos.drop === 'up' }"
          :style="{
            left: `${pos.left}px`,
            top: `${pos.top}px`,
            minWidth: `${pos.minWidth}px`,
            // `undefined` and not `null`: Vue removes a style property for either, and only
            // `undefined` is a `StyleValue`.
            maxWidth: pos.maxWidth === null ? undefined : `${pos.maxWidth}px`,
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
  /* No `max-width`. It is a measurement rather than a declaration (`measurePlacement`'s `floor` and
     `ceiling`), and a `280px` used to sit here as a second, smaller answer to the same question —
     see that function for what it cost. `max-height` stays, and it is a *different* decision: a
     list longer than 280px scrolls, which is the number `e2e/popup-list-room.spec.ts` reads. */
  max-height: 280px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  /* The edge the trigger is on is the edge it grows out of, and which edge that
     is comes from `pos.drop` — the placement the component measured. Set on the
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
