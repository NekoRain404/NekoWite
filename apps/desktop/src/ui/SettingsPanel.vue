<script setup lang="ts">
import { ref } from 'vue'
import { useViewStore } from '../stores/view'
import type { ViewMode } from '../stores/view'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', path: string): void }>()

const view = useViewStore()

const vaultInput = ref(localStorage.getItem('nekowite.vault') ?? '')

function saveVault(): void {
  const path = vaultInput.value.trim()
  if (!path) return
  localStorage.setItem('nekowite.vault', path)
  emit('saved', path)
}

function setMode(m: ViewMode): void {
  view.setMode(m)
}
</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <span class="settings-title">Settings</span>
      <button
        class="settings-close"
        title="Close"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <div class="settings-body">
      <label class="settings-field">
        <span>Vault path</span>
        <input
          v-model="vaultInput"
          type="text"
          placeholder="/path/to/vault"
          @keyup.enter="saveVault"
        >
      </label>
      <button
        class="settings-save"
        @click="saveVault"
      >
        Save
      </button>

      <div class="settings-section">
        <span class="settings-label">View mode</span>
        <div class="view-modes">
          <button
            :class="{ active: view.mode === 'source' }"
            @click="setMode('source')"
          >
            Source
          </button>
          <button
            :class="{ active: view.mode === 'rendered' }"
            @click="setMode('rendered')"
          >
            Rendered
          </button>
          <button
            :class="{ active: view.mode === 'split' }"
            @click="setMode('split')"
          >
            Split
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 300px;
  background: #fafafa;
  border-left: 1px solid #e0e0e0;
  box-shadow: -4px 0 12px rgba(0, 0, 0, 0.08);
  z-index: 100;
  display: flex;
  flex-direction: column;
}
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid #e0e0e0;
}
.settings-title { font-weight: 600; }
.settings-close {
  border: none;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
  color: #999;
}
.settings-close:hover { color: #333; }
.settings-body { padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.settings-field input {
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
}
.settings-save {
  padding: 6px 12px;
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  align-self: flex-start;
}
.settings-save:hover { background: #f0f0f0; }
.settings-section { display: flex; flex-direction: column; gap: 6px; }
.settings-label { font-size: 13px; font-weight: 500; }
.view-modes { display: flex; gap: 6px; }
.view-modes button {
  padding: 5px 10px;
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.view-modes button.active { background: #4a90d9; color: #fff; border-color: #4a90d9; }
</style>