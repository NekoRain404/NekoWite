<script setup lang="ts">
import { computed, ref } from 'vue'
import { useViewStore } from '../stores/view'
import type { ViewMode } from '../stores/view'
import { useTabsStore } from '../stores/tabs'
import { useRefsStore } from '../stores/refs'
import { exportHtml, exportToPdf } from '../services/export'
import { exportBaseName } from '../services/exportName'
import { fsService } from '../services/fs'
import { describeExportError, notifyError } from '../services/errors'
import { useSettingsStore } from '../stores/settings'
import { useAppearanceStore } from '../stores/appearance'
import type { Accent } from '../stores/appearance'
import type { ExportRef } from '@nekowite/editor-core'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', path: string): void }>()

const view = useViewStore()
const tabs = useTabsStore()
const refs = useRefsStore()
const settings = useSettingsStore()
const appearance = useAppearanceStore()

const vaultInput = ref(localStorage.getItem('nekowite.vault') ?? '')
const hasActiveTab = computed(() => !!tabs.activeTab?.content)
const showBaseUrl = computed(() => settings.provider === 'local' || settings.provider === 'custom')

const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok', 'local', 'custom']

const ACCENTS: Accent[] = ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate']
const ACCENT_COLORS: Record<Accent, string> = {
  ink: '#343532',
  coral: '#d65f4d',
  blue: '#3f7edb',
  green: '#3e9b73',
  gold: '#b98b09',
  violet: '#8a65d1',
  slate: '#607287',
}

async function saveAiKey(): Promise<void> {
  try {
    await settings.saveKey()
  } catch (e) {
    notifyError(`保存 AI Key 失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function saveVault(): void {
  const path = vaultInput.value.trim()
  if (!path) return
  localStorage.setItem('nekowite.vault', path)
  emit('saved', path)
}

function setMode(m: ViewMode): void {
  view.setMode(m)
}

function refsMap(): Map<string, ExportRef> {
  const m = new Map<string, ExportRef>()
  for (const r of refs.refs.values()) m.set(r.key, { key: r.key, title: r.title, authors: r.authors, year: r.year })
  return m
}

async function onExportHtml(): Promise<void> {
  const tab = tabs.activeTab
  if (!tab) return
  const savePath = await fsService.saveFileDialog(exportBaseName(tab.path) + '.html', tabs.vault ?? undefined)
  if (!savePath) return
  try {
    await exportHtml(tab.content, tabs.vault ?? '', savePath, { title: exportBaseName(tab.path), refs: refsMap() })
  } catch (e) {
    notifyError(describeExportError(e))
  }
}

function onExportPdf(): void {
  const tab = tabs.activeTab
  if (!tab) return
  exportToPdf(tab.content, { title: exportBaseName(tab.path), refs: refsMap() })
}
</script>

<template>
  <div class="settings-panel">
    <div class="panel-header">
      <span class="panel-title">Settings</span>
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
          class="input"
          type="text"
          placeholder="/path/to/vault"
          @keyup.enter="saveVault"
        >
      </label>
      <button
        class="btn btn-secondary settings-save"
        @click="saveVault"
      >
        Save
      </button>

      <div class="settings-section">
        <span class="settings-label">View mode</span>
        <div class="view-modes">
          <button
            class="switch-option"
            :class="{ 'is-active': view.mode === 'source' }"
            @click="setMode('source')"
          >
            Source
          </button>
          <button
            class="switch-option"
            :class="{ 'is-active': view.mode === 'rendered' }"
            @click="setMode('rendered')"
          >
            Rendered
          </button>
          <button
            class="switch-option"
            :class="{ 'is-active': view.mode === 'split' }"
            @click="setMode('split')"
          >
            Split
          </button>
        </div>
      </div>

      <div class="settings-section">
        <span class="settings-label">外观</span>
        <div class="view-modes">
          <button
            class="switch-option"
            :class="{ 'is-active': appearance.theme === 'light' }"
            @click="appearance.setTheme('light')"
          >
            浅色
          </button>
          <button
            class="switch-option"
            :class="{ 'is-active': appearance.theme === 'dark' }"
            @click="appearance.setTheme('dark')"
          >
            深色
          </button>
          <button
            class="switch-option"
            :class="{ 'is-active': appearance.theme === 'system' }"
            @click="appearance.setTheme('system')"
          >
            跟随系统
          </button>
        </div>
        <div class="accent-row">
          <button
            v-for="a in ACCENTS"
            :key="a"
            class="accent-swatch"
            :class="{ 'is-selected': appearance.accent === a }"
            :style="{ background: ACCENT_COLORS[a] }"
            :title="a as string"
            @click="appearance.setAccent(a)"
          />
        </div>
        <label class="settings-field">
          <span>字号 {{ appearance.bodyFontSize }}px</span>
          <input
            class="input"
            :value="appearance.bodyFontSize"
            type="number"
            min="12"
            max="20"
            @change="appearance.setBodyFontSize(Number(($event.target as HTMLInputElement).value))"
          >
        </label>
        <label class="settings-field">
          <span>行高 {{ appearance.lineHeight }}</span>
          <input
            class="input"
            :value="appearance.lineHeight"
            type="number"
            min="1.2"
            max="2.4"
            step="0.1"
            @change="appearance.setLineHeight(Number(($event.target as HTMLInputElement).value))"
          >
        </label>
      </div>

      <div class="settings-section">
        <span class="settings-label">导出 (当前文档)</span>
        <div class="view-modes">
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!hasActiveTab"
            @click="onExportHtml"
          >
            导出 HTML
          </button>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="!hasActiveTab"
            @click="onExportPdf"
          >
            导出 PDF
          </button>
        </div>
      </div>

      <div class="settings-section ai-settings">
        <span class="settings-label">AI 设置</span>
        <label class="settings-field">
          <span>Provider</span>
          <select
            v-model="settings.provider"
            class="input"
          >
            <option
              v-for="p in AI_PROVIDERS"
              :key="p"
              :value="p"
            >
              {{ p }}
            </option>
          </select>
        </label>
        <label class="settings-field">
          <span>Model</span>
          <input
            v-model="settings.model"
            class="input"
            type="text"
            placeholder="qwen2.5-coder:3b"
          >
        </label>
        <label
          v-if="showBaseUrl"
          class="settings-field"
        >
          <span>Base URL</span>
          <input
            v-model="settings.baseUrl"
            class="input"
            type="text"
            placeholder="http://localhost:1234/v1"
          >
        </label>
        <label class="settings-field">
          <span>API Key</span>
          <input
            v-model="settings.apiKey"
            class="input"
            type="password"
            placeholder="sk-..."
          >
        </label>
        <button
          class="btn btn-secondary settings-save"
          @click="saveAiKey"
        >
          保存 Key
        </button>
        <span class="settings-note">Key 经过加密存储，默认为主密码保护（本机文件级）。</span>
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
  background: var(--app-elevated);
  border-left: 1px solid var(--app-border);
  box-shadow: -4px 0 12px rgb(0 0 0 / 14%);
  color: var(--app-text);
  z-index: 100;
  display: flex;
  flex-direction: column;
}
[data-theme="dark"] .settings-panel {
  box-shadow: -4px 0 16px rgb(0 0 0 / 45%);
}
.settings-close {
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  color: var(--app-muted);
}
.settings-close:hover { color: var(--app-text); }
.settings-body { padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--app-text); }
.settings-note { font-size: 12px; color: var(--app-muted); }
.settings-save { align-self: flex-start; }
.settings-section { display: flex; flex-direction: column; gap: 6px; }
.settings-label { font-size: 13px; font-weight: 500; }
.view-modes { display: flex; gap: 6px; }
.view-modes button:disabled { opacity: 0.5; cursor: not-allowed; }
.accent-row { display: flex; gap: 6px; }
</style>
