<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-vue-next'

const props = defineProps<{
  sidebarVisible: boolean
  title: string
  subtitle: string
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
}>()

const inTauri = typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
const maximized = ref(false)
let unlistenResized: (() => void) | null = null

async function refreshMaximized(): Promise<void> {
  if (!inTauri) return
  try {
    maximized.value = await getCurrentWindow().isMaximized()
  } catch {
    maximized.value = false
  }
}

function minimize(): void {
  if (!inTauri) return
  void getCurrentWindow().minimize().catch(() => undefined)
}

function toggleMaximize(): void {
  if (!inTauri) return
  void getCurrentWindow().toggleMaximize().catch(() => undefined)
}

function close(): void {
  if (!inTauri) return
  void getCurrentWindow().close().catch(() => undefined)
}

function onDoubleClick(): void {
  // Memoir-style: double-click anywhere on the title bar toggles maximize.
  toggleMaximize()
}

onMounted(async () => {
  if (!inTauri) return
  await refreshMaximized()
  try {
    unlistenResized = await getCurrentWindow().onResized(() => {
      void refreshMaximized()
    })
  } catch {
    unlistenResized = null
  }
})

onBeforeUnmount(() => {
  unlistenResized?.()
  unlistenResized = null
})
</script>

<template>
  <header
    class="titlebar"
    data-tauri-drag-region
    @dblclick.self="onDoubleClick"
  >
    <div class="tb-left">
      <button
        class="tb-btn"
        :title="props.sidebarVisible ? '收起侧栏' : '展开侧栏'"
        @click="emit('toggle-sidebar')"
      >
        <PanelLeftClose
          v-if="props.sidebarVisible"
          :size="16"
          :stroke-width="1.8"
        />
        <PanelLeftOpen
          v-else
          :size="16"
          :stroke-width="1.8"
        />
      </button>
      <span class="tb-app">NekoWite</span>
    </div>

    <div
      class="tb-center"
      data-tauri-drag-region
    >
      <span
        class="tb-title"
        :title="props.title"
      >{{ props.title }}</span>
      <span
        v-if="props.subtitle"
        class="tb-subtitle"
        :title="props.subtitle"
      >{{ props.subtitle }}</span>
    </div>

    <div class="tb-right">
      <button
        v-if="inTauri"
        class="tb-window-btn"
        title="最小化"
        @click="minimize"
      >
        <Minus
          :size="16"
          :stroke-width="1.8"
        />
      </button>
      <button
        v-if="inTauri"
        class="tb-window-btn"
        :title="maximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <Copy
          v-if="maximized"
          :size="14"
          :stroke-width="1.8"
        />
        <Square
          v-else
          :size="14"
          :stroke-width="1.8"
        />
      </button>
      <button
        v-if="inTauri"
        class="tb-window-btn tb-window-close"
        title="关闭"
        @click="close"
      >
        <X
          :size="16"
          :stroke-width="1.8"
        />
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: var(--app-titlebar-height);
  flex: none;
  padding: 0 10px 0 12px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-elevated) 68%, var(--app-canvas));
  user-select: none;
}
.tb-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tb-btn:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}

.tb-app {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--app-muted);
  white-space: nowrap;
}

.tb-center {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
  justify-content: center;
}
.tb-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--app-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40vw;
}
.tb-subtitle {
  font-size: 10px;
  color: var(--app-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tb-right {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.tb-window-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tb-window-btn:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}
.tb-window-btn:active {
  background: color-mix(in srgb, var(--app-elevated) 40%, transparent);
}
.tb-window-close:hover {
  background: color-mix(in srgb, var(--app-danger) 18%, transparent);
  color: var(--app-danger);
}
</style>
