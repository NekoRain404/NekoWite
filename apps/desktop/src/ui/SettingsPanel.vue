<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Download,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Type,
  X,
} from 'lucide-vue-next'
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

type SectionId = 'general' | 'appearance' | 'editor' | 'export' | 'ai'

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Type }> = [
  { id: 'general', label: '常规', icon: SlidersHorizontal },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'editor', label: '编辑器', icon: Type },
  { id: 'export', label: '导出', icon: Download },
  { id: 'ai', label: 'AI', icon: Sparkles },
]

const activeSection = ref<SectionId>('general')
const dialogRef = ref<HTMLElement | null>(null)

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

function onOverlayPointerDown(e: PointerEvent): void {
  if (e.target === e.currentTarget) emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  void nextTick(() => dialogRef.value?.focus())
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})

watch(activeSection, () => {
  void nextTick(() => dialogRef.value?.focus())
})

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
  <Teleport to="body">
    <div
      class="settings-overlay"
      role="presentation"
      @pointerdown="onOverlayPointerDown"
    >
      <div
        ref="dialogRef"
        class="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabindex="-1"
      >
        <div class="dialog-header">
          <span class="dialog-title">设置</span>
          <span class="dialog-spacer" />
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
        <div class="dialog-body">
          <aside class="dialog-nav">
            <button
              v-for="s in SECTIONS"
              :key="s.id"
              class="nav-row"
              :class="{ active: activeSection === s.id }"
              @click="activeSection = s.id"
            >
              <component
                :is="s.icon"
                class="nav-row-icon"
                :size="15"
                :stroke-width="1.8"
              />
              <span>{{ s.label }}</span>
            </button>
          </aside>
          <div class="dialog-content">
            <section
              v-if="activeSection === 'general'"
              class="settings-section"
            >
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
              <span class="settings-note">切换知识库会关闭当前所有打开的文档。</span>
            </section>

            <section
              v-else-if="activeSection === 'appearance'"
              class="settings-section"
            >
              <span class="settings-label">主题</span>
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
              <span class="settings-label">强调色</span>
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
            </section>

            <section
              v-else-if="activeSection === 'editor'"
              class="settings-section"
            >
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
            </section>

            <section
              v-else-if="activeSection === 'export'"
              class="settings-section"
            >
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
              <span
                v-if="!hasActiveTab"
                class="settings-note"
              >打开一篇文档后可导出。</span>
            </section>

            <section
              v-else-if="activeSection === 'ai'"
              class="settings-section"
            >
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
            </section>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--app-canvas) 45%, transparent);
  backdrop-filter: blur(2px);
}

.settings-dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  height: min(520px, 100%);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-xl);
  background: color-mix(in srgb, var(--app-elevated) 97%, var(--app-panel));
  box-shadow: var(--app-shadow-dialog);
  color: var(--app-text);
  outline: none;
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  user-select: none;
}
.dialog-title {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.dialog-spacer { flex: 1; }
.settings-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
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
.settings-close:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}

.dialog-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.dialog-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 152px;
  flex: none;
  padding: 10px 8px;
  border-right: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  overflow-y: auto;
  user-select: none;
}
.nav-row {
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: var(--app-radius-lg);
  background: transparent;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.nav-row:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 62%, transparent);
}
.nav-row:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.nav-row.active {
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-elevated));
  color: var(--app-text);
  font-weight: 600;
}
.nav-row.active .nav-row-icon {
  color: var(--app-accent);
}
.nav-row-icon {
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text));
}

.dialog-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-save { align-self: flex-start; }
.vault-row { display: flex; gap: 6px; }
.vault-row .input { flex: 1; min-width: 0; }
.vault-browse { flex: none; }
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.settings-section .settings-label:first-child { margin-top: 0; }
.view-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.view-modes button:disabled { opacity: 0.5; cursor: not-allowed; }
.accent-row { display: flex; gap: 6px; }
</style>
