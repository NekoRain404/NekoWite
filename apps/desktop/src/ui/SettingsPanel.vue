<script setup lang="ts">
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
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

async function saveVault(): Promise<void> {
  const path = vaultInput.value.trim()
  if (!path) return
  localStorage.setItem('nekowite.vault', path)
  emit('saved', path)
}

async function browseVault(): Promise<void> {
  try {
    const picked = await fsService.openFolderDialog()
    if (!picked) return
    vaultInput.value = picked
    await saveVault()
  } catch (e) {
    notifyError(`选择文件夹失败：${e instanceof Error ? e.message : String(e)}`)
  }
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
      <span class="panel-title">设置</span>
      <button
        class="settings-close"
        title="关闭"
        @click="emit('close')"
      >
        <X
          :size="15"
          :stroke-width="1.8"
        />
      </button>
    </div>
    <div class="settings-body">
      <div class="settings-section">
        <span class="settings-label">知识库</span>
        <div class="vault-row">
          <input
            v-model="vaultInput"
            class="input"
            type="text"
            placeholder="/path/to/vault"
            @keyup.enter="saveVault"
          >
          <button
            class="btn btn-secondary btn-sm vault-browse"
            title="浏览…"
            @click="browseVault"
          >
            浏览…
          </button>
        </div>
        <button
          class="btn btn-secondary settings-save"
          @click="saveVault"
        >
          保存并切换
        </button>
      </div>

      <div class="settings-section">
        <span class="settings-label">视图</span>
        <div class="view-modes">
          <button
            class="switch-option"
            :class="{ 'is-active': view.mode === 'source' }"
            @click="setMode('source')"
          >
            源码
          </button>
          <button
            class="switch-option"
            :class="{ 'is-active': view.mode === 'rendered' }"
            @click="setMode('rendered')"
          >
            渲染
          </button>
          <button
            class="switch-option"
            :class="{ 'is-active': view.mode === 'split' }"
            @click="setMode('split')"
          >
            对照
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
            @change="appearance.setBodyFontSize(Math.min(20, Math.max(12, Number(($event.target as HTMLInputElement).value) || 15)))"
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
            @change="appearance.setLineHeight(Math.min(2.4, Math.max(1.2, Number(($event.target as HTMLInputElement).value) || 1.8)))"
          >
        </label>
      </div>

      <div class="settings-section">
        <span class="settings-label">导出（当前文档）</span>
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

      <div class="settings-section">
        <span class="settings-label">保存</span>
        <label class="settings-field">
          <span>自动保存间隔</span>
          <select
            v-model="settings.autosaveInterval"
            class="input"
          >
            <option :value="'off'">
              关闭
            </option>
            <option :value="5000">
              5秒
            </option>
            <option :value="15000">
              15秒
            </option>
            <option :value="30000">
              30秒
            </option>
            <option :value="60000">
              60秒
            </option>
          </select>
        </label>
        <label class="settings-field">
          <span>历史版本上限</span>
          <input
            class="input"
            :value="settings.maxHistory"
            type="number"
            min="1"
            max="100"
            @change="settings.maxHistory = Math.min(100, Math.max(1, Math.round(Number(($event.target as HTMLInputElement).value) || 10)))"
          >
        </label>
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
        <span class="settings-note">Key 经加密存储，由主密码保护（本机文件级）。</span>
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
  width: 320px;
  background: var(--app-elevated);
  border-left: 1px solid var(--app-border);
  border-radius: 0;
  box-shadow: var(--app-shadow-dialog);
  color: var(--app-text);
  z-index: 100;
  display: flex;
  flex-direction: column;
}
.settings-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  color: var(--app-muted);
  border-radius: var(--app-radius-sm);
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.settings-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
}
.settings-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-save { align-self: flex-start; }
.vault-row { display: flex; gap: 6px; }
.vault-row .input { flex: 1; min-width: 0; }
.vault-browse { flex: none; }
.settings-section { display: flex; flex-direction: column; gap: 8px; padding-bottom: 14px; border-bottom: 1px solid color-mix(in srgb, var(--app-border) 50%, transparent); }
.settings-section:last-child { border-bottom: none; padding-bottom: 0; }
.settings-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.view-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.view-modes button:disabled { opacity: 0.5; cursor: not-allowed; }
.accent-row { display: flex; gap: 6px; }
</style>
