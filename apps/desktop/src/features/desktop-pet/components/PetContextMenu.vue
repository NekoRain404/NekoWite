<script setup lang="ts">
/**
 * The pet's right-click menu: the way back to the settings, the way to the tasks, and the way to
 * hide it.
 *
 * The mechanism is the one the editor window's `src/ui/ContextMenu.vue` already uses — place, clamp,
 * flip, take focus, restore it, close on Escape or a click outside — and it is written again here
 * rather than imported, because that component imports the application's whole i18n dictionary and
 * §7.1's isolation is asserted by a test that forbids this window from reaching `ui/`
 * (`app/desktop-pet-entry.test.ts`). The placement arithmetic itself is shared as a function
 * (`../services/pet-context-menu`), which is the part with rules in it; what is left here is wiring.
 *
 * It emits and never acts. `open`, the anchor and the capabilities are props, picking an item is an
 * event, and closing is an event — so the menu cannot hide the pet, open a window or answer a
 * permission by itself, and the composition that owns the gateway is the only thing that can
 * (§6.1: the pet window does not drive the runtime). The caller closes it: a component that closed
 * itself would be a component whose `open` prop and whose state disagreed.
 *
 * The items are built here rather than passed in, because their *availability* is the interesting
 * part: an item the host cannot carry out is disabled and says why (§7.2's 不显示可点击但无效果的控件),
 * which is a rule worth having in one place that a test can read.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { placePetMenu, type PetMenuAction } from '../services/pet-context-menu'
import { PET_CONTEXT_MENU_LABELS, type PetContextMenuLabels } from '../services/pet-message-template'

const props = withDefaults(
  defineProps<{
    /** Whether the menu is showing. The caller owns it, here as everywhere else. */
    open?: boolean
    /** The point that was clicked, in window coordinates. */
    anchor?: { x: number; y: number }
    /** What the menu is allowed to offer: what is running decides whether "Show tasks" can act. */
    capabilities?: { taskCount: number }
    /** The menu's wording, field by field. */
    labels?: Partial<PetContextMenuLabels>
  }>(),
  {
    open: false,
    anchor: () => ({ x: 0, y: 0 }),
    capabilities: () => ({ taskCount: 0 }),
    labels: () => ({}),
  },
)

const emit = defineEmits<{ select: [action: PetMenuAction]; close: [] }>()

interface PetMenuItem {
  label: string
  /** False when the host cannot carry the action out right now. */
  enabled: boolean
  /** Why it cannot, shown to the user. Non-null exactly when `enabled` is false. */
  reason: string | null
  action: PetMenuAction
}

const labels = computed<PetContextMenuLabels>(() => ({ ...PET_CONTEXT_MENU_LABELS, ...props.labels }))

const items = computed<PetMenuItem[]>(() => {
  const running = props.capabilities.taskCount > 0
  return [
    {
      label: labels.value.tasks,
      enabled: running,
      reason: running ? null : labels.value.noTasks,
      action: { id: 'tasks' },
    },
    {
      // §5.1: the pet's settings live in the application's settings, and the page it opens on is
      // 常规与交互 — the page whose switch turns the pet off, which is what a user hunting for this
      // menu item is usually after.
      label: labels.value.settings,
      enabled: true,
      reason: null,
      action: { id: 'settings', page: 'general' },
    },
    { label: labels.value.hide, enabled: true, reason: null, action: { id: 'hide' } },
  ]
})

const menuEl = ref<HTMLElement | null>(null)
const placement = ref({ left: 0, top: 0 })
/** Whatever had focus when the menu opened, so closing it can give focus back. */
let restoreTo: HTMLElement | null = null

const menuStyle = computed(() => ({
  position: 'fixed' as const,
  left: `${placement.value.left}px`,
  top: `${placement.value.top}px`,
}))

/** The items a keyboard can land on. A disabled item is skipped, not focused. */
function pickable(): HTMLButtonElement[] {
  const el = menuEl.value
  if (!el) return []
  return [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
}

async function place(): Promise<void> {
  await nextTick()
  const el = menuEl.value
  if (!el) return
  const box = el.getBoundingClientRect()
  placement.value = placePetMenu({
    anchor: props.anchor,
    size: { width: box.width, height: box.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  })
}

function restoreFocus(): void {
  const target = restoreTo
  restoreTo = null
  target?.focus()
}

function onOutside(event: PointerEvent): void {
  if (menuEl.value && !menuEl.value.contains(event.target as Node)) emit('close')
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

/** A viewport that moved takes the menu away: it is pinned to a point that is no longer there. */
function onViewportChange(): void {
  emit('close')
}

function onMenuKeydown(event: KeyboardEvent): void {
  const rows = pickable()
  if (rows.length === 0) return
  const current = rows.indexOf(document.activeElement as HTMLButtonElement)

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = current < 0 ? 0 : (current + step + rows.length) % rows.length
    rows[next]?.focus()
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    rows[0]?.focus()
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    rows[rows.length - 1]?.focus()
  }
}

function choose(item: PetMenuItem): void {
  // The handlers on a disabled button do not run, so this is the belt to the `disabled` braces: a
  // click that arrived anyway must not turn into an action the host cannot carry out.
  if (!item.enabled) return
  emit('select', item.action)
}

function watchViewport(watching: boolean): void {
  if (watching) {
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('keydown', onGlobalKeydown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
  } else {
    document.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('keydown', onGlobalKeydown)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreTo = (document.activeElement as HTMLElement | null) ?? null
      watchViewport(true)
      await place()
      // The first item the user can actually pick: opening on a disabled one would leave the arrow
      // keys with nowhere to start.
      pickable()[0]?.focus()
      return
    }
    watchViewport(false)
    restoreFocus()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  // §10.2: teardown is the destruction path — no listener outlives the menu, and a menu that
  // unmounted while open gives the focus back rather than dropping it on `<body>`.
  watchViewport(false)
  restoreFocus()
})
</script>

<template>
  <div
    v-if="open"
    ref="menuEl"
    class="pet-menu"
    role="menu"
    :aria-label="labels.menu"
    :style="menuStyle"
    @keydown="onMenuKeydown"
  >
    <button
      v-for="item in items"
      :key="item.action.id"
      type="button"
      role="menuitem"
      class="pet-menu__item"
      :disabled="!item.enabled"
      :title="item.reason ?? undefined"
      @click="choose(item)"
    >
      <span class="pet-menu__label">{{ item.label }}</span>
      <span
        v-if="item.reason"
        class="pet-menu__reason"
      >{{ item.reason }}</span>
    </button>
  </div>
</template>

<style scoped>
.pet-menu {
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 150px;
  /* The menu is the one surface that may be wider than the bubble: its items are short and its
     user is aiming at a row. It still wraps rather than widening the window. */
  max-width: calc(100vw - 16px);
  box-sizing: border-box;
  padding: 4px;
  border: 1px solid var(--app-border, rgb(255 255 255 / 18%));
  border-radius: var(--app-radius, 10px);
  background: var(--app-panel, rgb(28 28 32 / 96%));
  box-shadow: var(--app-shadow-menu, 0 6px 20px rgb(0 0 0 / 45%));
  color: var(--app-text, #fff);
  font-family: var(--app-font, system-ui, sans-serif);
  font-size: var(--app-body-size, 12px);
  user-select: none;
}

.pet-menu__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--app-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.pet-menu__item:hover:not(:disabled),
.pet-menu__item:focus-visible {
  background: var(--app-accent-soft, rgb(255 255 255 / 10%));
}

.pet-menu__item:disabled {
  color: var(--app-muted, rgb(255 255 255 / 55%));
  cursor: default;
}

.pet-menu__reason {
  color: var(--app-muted, rgb(255 255 255 / 55%));
  font-size: 11px;
}
</style>
