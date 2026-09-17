<script lang="ts">
import type { Component } from 'vue'

export interface ContextMenuItem {
  id: string
  label?: string
  icon?: Component
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { pagePopupHost } from '../components/popup-host'
import { t } from '../i18n'

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

/**
 * Where the menu is rendered, and it is not `body`.
 *
 * `body` is *outside* `.shell` — the one element `AppShell.vue:285-292` puts the user's appearance
 * on (`data-theme`, `data-color-scheme`, `data-accent`, `data-contrast` and the eight inline
 * `--app-*` properties). So a menu rendered there resolved `palettes.css`'s `:root` block instead:
 * measured in a dark `forest` window at `17px` and Source Serif 4, a right click on a tab drew
 * `color(srgb 0.998431 0.994353 0.982275)` on `--app-elevated: #fffefb` with the light border, the
 * light shadow, `system-ui` on its rows and `--app-accent: #343532`, while the tab under it drew
 * `#243020` in `#e8f3e2` and the shell published `#2e9e8f`. `popupHostOf`'s sibling is what fixes
 * that: the menu is rendered inside the shell and inherits the one declaration set, so nothing
 * about the appearance is repeated here.
 *
 * **Why this one asks the page and not a control.** A menu is placed at a *point* — `props.x` and
 * `props.y` are `clientX`/`clientY` from the press that opened it — so there is no element whose
 * ancestry could be walked, which is the shape `components/SelectMenu.vue` and
 * `components/ComboBox.vue` use. The app's window is entirely inside `.shell` (`height: 100vh`,
 * full width), so the page's answer is the answer for every point on it.
 *
 * **Resolved before the first render, and that is deliberate.** This component's `<Teleport>` is
 * its template root and its content is always mounted (a target that changed on `onMounted` would
 * move the menu's element through the DOM on the frame after it was created). Every host mounts
 * this with `v-if` on the press that opened it (`ui/TabBar.vue:179`, `ui/EditorPane.vue:265`,
 * `ui/AttachmentsPanel.vue:318`, `features/notes/components/NoteListPanel.vue:228`,
 * `features/notes/components/NoteListToolbar.vue:236`,
 * `features/vault/components/FileTreeContextMenu.vue:52`), so the page is already in the state the
 * press was made in when `setup` runs.
 */
const popupHost = ref<Element | string>(pagePopupHost())

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'close'): void
}>()

const menuRef = ref<HTMLElement | null>(null)
const pos = ref({ left: props.x, top: props.y })
const shown = ref(false)
/** True when the viewport clamp pushed the menu above the pointer it opened at.
 *  Read by the stylesheet, which flips the scale origin and the travel with it —
 *  see `place()`. */
const flipped = ref(false)

/**
 * Whatever had focus when the menu opened, so closing it can give focus back.
 *
 * Opening moves focus into the first item (that is what makes the arrow keys
 * and Enter work without a mouse). Without a restore, closing the menu —
 * Escape, a click outside, or picking an item — leaves focus on the item being
 * destroyed, and the browser drops it to `<body>`: the keyboard user's place in
 * the list is gone and the next Tab starts from the top of the app.
 */
let restoreFocusTo: HTMLElement | null = null

function menuItems(): HTMLButtonElement[] {
  const el = menuRef.value
  if (!el) return []
  return [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
}

async function place(): Promise<void> {
  await nextTick()
  const el = menuRef.value
  const pad = 8
  if (!el) {
    pos.value = { left: props.x, top: props.y }
    shown.value = true
    return
  }
  const rect = el.getBoundingClientRect()
  const left = Math.min(Math.max(pad, props.x), Math.max(pad, window.innerWidth - rect.width - pad))
  const top = Math.min(Math.max(pad, props.y), Math.max(pad, window.innerHeight - rect.height - pad))
  pos.value = { left, top }
  // Near the bottom of the window the clamp pushes the menu up past the pointer
  // it was opened at, and once it has gone far enough that the pointer is below
  // the menu's own middle, that is a flip: the corner they share is now the
  // menu's bottom edge rather than its top, so the scale has to grow out of that
  // edge and the travel has to run upward into place. Left at "down", the menu
  // would sit above the pointer while still rising from below it — arriving from
  // the gap underneath, which is where nothing happened.
  //
  // The test is the midpoint and not `top !== props.y`: a couple of pixels of
  // clamp at the very bottom of a tall window is not a flip, and treating it as
  // one put the origin on the wrong edge for the common case.
  flipped.value = top + rect.height / 2 < props.y
  const first = shown.value ? null : menuItems()[0]
  shown.value = true
  first?.focus()
}

function onPointerDown(e: PointerEvent): void {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) emit('close')
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function onViewportChange(): void {
  emit('close')
}

function onMenuKeydown(e: KeyboardEvent): void {
  const list = menuItems()
  if (!list.length) return
  const current = list.indexOf(document.activeElement as HTMLButtonElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const offset = e.key === 'ArrowDown' ? 1 : -1
    const next = current < 0 ? 0 : (current + offset + list.length) % list.length
    list[next]?.focus()
    return
  }
  if (e.key === 'Home') {
    e.preventDefault()
    list[0]?.focus()
    return
  }
  if (e.key === 'End') {
    e.preventDefault()
    list[list.length - 1]?.focus()
  }
}

function pick(item: ContextMenuItem): void {
  if (item.disabled) return
  emit('select', item.id)
  emit('close')
}

watch(
  () => [props.x, props.y] as const,
  () => {
    void place()
  },
)

onMounted(() => {
  // Captured BEFORE `place()` focuses the first item, and synchronously: the
  // element under the pointer is still the user's place in the list.
  const active = document.activeElement
  restoreFocusTo = active instanceof HTMLElement ? active : null
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  void place()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  const target = restoreFocusTo
  restoreFocusTo = null
  // Only when the menu still holds focus. Picking "rename" or "delete" moves
  // focus out of it (an inline input, a dialog) before the menu is torn down,
  // and restoring unconditionally would pull focus straight back out of the
  // field the user is now typing in. A closed element cannot take focus back.
  if (!target || !target.isConnected) return
  if (!menuRef.value?.contains(document.activeElement)) return
  target.focus()
})
</script>

<template>
  <Teleport :to="popupHost">
    <div
      ref="menuRef"
      class="ctx-menu"
      :class="{ 'is-open': shown, 'is-flipped': flipped }"
      role="menu"
      :aria-label="t('contextMenu.aria')"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      @contextmenu.prevent
      @keydown="onMenuKeydown"
    >
      <template
        v-for="item in items"
        :key="item.id"
      >
        <!-- A separator is an optional LEADING divider, not a branch. An item
             that sets `separator: true` AND still carries its own label
             (FileTree's rename, TabBar's close-others) renders BOTH: the
             divider up front, then the item itself. A pure separator item
             (`{ id, separator: true }`, AttachmentsPanel) renders just the
             divider — the v-if/v-else pair used to swallow such an item's
             button entirely. -->
        <div
          v-if="item.separator"
          class="ctx-menu-separator"
          role="separator"
        />
        <button
          v-if="!item.separator || Boolean(item.label)"
          class="ctx-menu-item"
          :class="{ 'is-danger': item.danger }"
          role="menuitem"
          type="button"
          tabindex="-1"
          :disabled="item.disabled"
          @click="pick(item)"
        >
          <span class="ctx-menu-icon">
            <component
              :is="item.icon"
              v-if="item.icon"
              :size="14"
              :stroke-width="1.8"
            />
          </span>
          <span class="ctx-menu-label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 300;
  min-width: 180px;
  max-width: 280px;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  opacity: 0;
  /* It grows out of the click. The menu is placed at the pointer, so the corner
     they share is where it came from, and the travel is *down* into place — the
     road back to the pointer is up. Starting below the resting position, which
     is what this did, made the menu rise out of a gap it had never occupied,
     and scaling about its own centre made it inflate in place rather than
     emerge; the heading popup in WordToolbar was moved off that same geometry
     for the same reason. The distance is the travel token, as it is there. */
  transform-origin: top left;
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(var(--app-motion-scale-pop));
  /* Closing: the menu was already read, so it leaves on the exit fraction of its
     own entrance and accelerates away instead of lingering over the user's next
     click. (In practice the hosts mount this with `v-if`, so the element is
     destroyed on close and neither curve runs — the rule is here for a host that
     ever keeps it mounted, and the mismatch is recorded in the report.) */
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              transform var(--app-motion-exit) var(--app-ease-exit);
}
/* Clamped up near the bottom edge: the pointer is now *below* the menu, so the
   shared corner is the bottom one and the road back to the anchor runs down.
   Both halves flip together — an origin that flipped while the travel did not
   would grow out of the bottom edge while still sliding down from above it. */
.ctx-menu.is-flipped {
  transform-origin: bottom left;
  transform: translateY(var(--app-motion-travel)) scale(var(--app-motion-scale-pop));
}
.ctx-menu.is-open {
  opacity: 1;
  transform: none;
  /* Opening: a whole region arriving, so it takes the region step. The rule on
     the target state is the one the browser uses, which is what lets enter and
     exit differ without a Vue <Transition>. */
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease);
}
/* ---- The exit, which every host used to cut ------------------------------
   The rules above declare the exit and it has never run: every host mounts this
   with `v-if` on a nullable state, so the element was destroyed in the frame the
   user acted and the menu entered over 300ms and vanished in one. `<Transition
   name="ctx">` at the host keeps the node mounted for this rule.
   Both selectors carry `.ctx-menu`, and that is not tidiness — it is the whole
   trap. The component drives its own state with `.ctx-menu.is-open`, which is
   *two* classes: a bare `.ctx-leave-active` loses to it on specificity, so the
   leaver kept the arriving curve and `opacity: 1` for the whole of its life.
   Measured before the fix: 20 frames at `opacity 1` with `pointer-events: none`
   and then out of the document. Measured after: 1 → 0.986 → 0.897 → 0.750 →
   0.563 → 0.344 → 0.095, `none` throughout — the same walk the panels make. */
.ctx-menu.ctx-leave-active {
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              transform var(--app-motion-exit) var(--app-ease-exit);
  pointer-events: none;
}
.ctx-menu.ctx-leave-to {
  opacity: 0;
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(var(--app-motion-scale-pop));
}
.ctx-menu-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--app-radius-sm);
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
.ctx-menu-item:hover,
.ctx-menu-item:focus-visible {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
  outline: none;
}
.ctx-menu-item.is-danger {
  color: var(--app-danger);
}
.ctx-menu-item.is-danger:hover,
.ctx-menu-item.is-danger:focus-visible {
  background: color-mix(in srgb, var(--app-danger) 12%, var(--app-elevated));
}
.ctx-menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}
.ctx-menu-icon {
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
  color: currentColor;
}
.ctx-menu-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-menu-separator {
  height: 1px;
  margin: 4px 6px;
  background: color-mix(in srgb, var(--app-border) 88%, transparent);
}
</style>
