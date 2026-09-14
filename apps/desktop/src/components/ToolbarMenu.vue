<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type Component, type CSSProperties } from 'vue'

/**
 * A toolbar button with a panel under it.
 *
 * Extracted from the word toolbar, where it was written twice — once for the
 * heading levels and once for the AI rewrites — and where the two copies were
 * the reason that file crossed §13.1's hard stop. It is a *mechanism* and not a
 * menu: the items are the caller's, through the default slot, which is handed a
 * `close` because picking an item is what closes it.
 *
 * Two things here are non-obvious and both were measured rather than reasoned:
 *
 * **The panel is `position: fixed`, and it has to be.** The toolbar scrolls
 * horizontally (`overflow-x: auto`), and a non-`visible` `overflow-x` makes
 * `overflow-y` compute to `auto` as well — so the toolbar is a scroll container
 * in *both* axes and an absolutely positioned child is clipped by it. Measured
 * with the H2 dropdown open: the toolbar's scrollport was y 86–128 and the
 * menu's box y 127–324, an overlap of **one pixel**. The button lit up, the
 * 300ms entrance ran, and nothing was ever on screen. (A Playwright click on an
 * option still worked, which is how it stayed invisible: `click()` scrolls its
 * target into view first.) `position: fixed` escapes an ancestor's overflow, so
 * the panel is placed against the viewport from the button that owns it.
 *
 * **The outside-click test covers the wrap, not the panel.** The panel is still
 * a DOM descendant of the wrap — only its painting moved — so `contains()` is
 * the whole test, and a click on an item does not read as "somewhere else".
 */
defineProps<{
  title: string
  /** Rendered at 15px, the size every other toolbar glyph is drawn at. */
  icon: Component
}>()

const open = ref(false)
const wrapEl = ref<HTMLElement | null>(null)
const panelStyle = ref<CSSProperties>({})

function toggle(): void {
  open.value = !open.value
  if (!open.value) return
  const box = wrapEl.value?.getBoundingClientRect()
  if (box) panelStyle.value = { left: `${Math.round(box.left)}px`, top: `${Math.round(box.bottom + 6)}px` }
}

function close(): void {
  open.value = false
}

function onDocPointerDown(e: PointerEvent): void {
  if (!open.value) return
  if (wrapEl.value?.contains(e.target as Node)) return
  close()
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))
</script>

<template>
  <div
    ref="wrapEl"
    class="toolbar-menu-wrap"
  >
    <button
      class="toolbar-btn"
      :title="title"
      :aria-label="title"
      @click="toggle"
    >
      <component
        :is="icon"
        :size="15"
        :stroke-width="1.8"
      />
    </button>
    <Transition name="toolbar-menu">
      <div
        v-if="open"
        class="toolbar-menu"
        :style="panelStyle"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toolbar-menu-wrap {
  position: relative;
  display: inline-flex;
}
.toolbar-menu {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 140px;
  padding: 5px;
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-lg);
  box-shadow: var(--app-shadow-menu);
  /* The panel hangs off the button that owns it and they share a left edge, so
     the corner they touch is where it comes from. Set on the base rule rather
     than on the transition classes: those are removed a frame into the
     transition, and the origin would snap back to the centre while the panel
     was still scaling. */
  transform-origin: top left;
}
/* The rows used to step in one after another, each with its own delay, while the
   menu around them was already fading and scaling in. That is a second animation
   stacked on the first — the same fade twice — and it was the half that could
   not be reversed: a delay belongs to an animation, so a menu closed half-way
   through lost the animations and the rows dropped to full opacity in one frame
   while the menu itself eased back. The menu is the arrival now and the rows
   come with it (see the note in styles/motion.css). */
.toolbar-menu-enter-active {
  /* --app-motion is the rung for a region changing state in place, and a menu
     reveal is the case the ladder names. Two curves, because these are two
     different properties: the movement has a corner to settle into and takes the
     spring, while the fade has nothing above 1 to overshoot and takes the
     state-change bezier. On one curve the opacity reaches full at 42% of the
     timeline and the menu is still visibly growing for the rest of it. */
  transition: opacity var(--app-motion) var(--app-ease),
              transform var(--app-motion) var(--app-ease-surface);
  will-change: opacity, transform;
}
/* Leaving takes the exit fraction of the entrance above — long enough to read
   as a departure rather than a cut, short enough that a menu the user is done
   with is gone — and accelerates away on the exit curve while it goes. */
.toolbar-menu-leave-active {
  transition: opacity var(--app-motion-exit) var(--app-ease-exit),
              transform var(--app-motion-exit) var(--app-ease-exit);
  will-change: opacity, transform;
  /* A menu on its way out still covers the button that closed it and the
     document under it. Measured with the guards off: `pointer-events: auto` and
     `elementFromPoint` answering an element inside the menu, for all 195ms of
     the exit. The select and combobox popups already carry this rule and say
     why — a leaving popup must not take the dismissing click. */
  pointer-events: none;
}
.toolbar-menu-enter-from,
.toolbar-menu-leave-to {
  opacity: 0;
  /* It grows out of the button's corner and covers the few pixels between them.
     Starting *below* the resting position — which this used to do — meant the
     menu rose into place from a gap it never occupied, arriving from nowhere;
     the button is above the menu, so the travel has to be downward. The scale is
     the anchored-popover amplitude: a menu is small furniture and 4% of a
     140px-wide row is most of a glyph's height, which reads as a pop rather than
     as an arrival. */
  transform: translateY(calc(var(--app-motion-travel) * -1)) scale(var(--app-motion-scale-pop));
}
/* `:deep` because the rows belong to the caller: slot content is rendered in
   the *parent's* scope, so a scoped selector here would never match it, and the
   alternative — every caller restating the row — is the duplication this
   component exists to remove. */
.toolbar-menu :deep(.menu-option) {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.toolbar-menu :deep(.menu-option:hover) {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
</style>
