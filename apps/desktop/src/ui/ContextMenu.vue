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
import { t } from '../i18n'

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'close'): void
}>()

const menuRef = ref<HTMLElement | null>(null)
const pos = ref({ left: props.x, top: props.y })
const shown = ref(false)

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
  pos.value = {
    left: Math.min(Math.max(pad, props.x), Math.max(pad, window.innerWidth - rect.width - pad)),
    top: Math.min(Math.max(pad, props.y), Math.max(pad, window.innerHeight - rect.height - pad)),
  }
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
  <Teleport to="body">
    <div
      ref="menuRef"
      class="ctx-menu"
      :class="{ 'is-open': shown }"
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
  transform: translateY(4px) scale(0.98);
  /* Closing: the menu was already read, so it leaves on the next rung down and
     accelerates away instead of lingering over the user's next click. */
  transition: opacity var(--app-motion-fast) var(--app-ease-exit),
              transform var(--app-motion-fast) var(--app-ease-exit);
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
.ctx-menu-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
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
