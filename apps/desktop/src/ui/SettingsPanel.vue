<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Download,
  Palette,
  RefreshCw,
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
import type { Accent, EditorFontId, MonoFontId, UiFontId } from '../stores/appearance'
import { getLocale, setLocale, t } from '../i18n'
import type { ExportRef } from '@nekowite/editor-core'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', path: string): void }>()

const view = useViewStore()
const tabs = useTabsStore()
const refs = useRefsStore()
const settings = useSettingsStore()
const appearance = useAppearanceStore()

type SectionId = 'general' | 'appearance' | 'editor' | 'export' | 'ai'

const SECTIONS = computed<Array<{ id: SectionId; label: string; icon: typeof Type }>>(() => [
  { id: 'general', label: t('settings.section.general'), icon: SlidersHorizontal },
  { id: 'appearance', label: t('settings.section.appearance'), icon: Palette },
  { id: 'editor', label: t('settings.section.editor'), icon: Type },
  { id: 'export', label: t('settings.section.export'), icon: Download },
  { id: 'ai', label: t('settings.section.ai'), icon: Sparkles },
])

const activeSection = ref<SectionId>('general')
const dialogRef = ref<HTMLElement | null>(null)

const vaultInput = ref(localStorage.getItem('nekowite.vault') ?? '')
const hasActiveTab = computed(() => !!tabs.activeTab?.content)
const showBaseUrl = computed(() => settings.provider === 'local' || settings.provider === 'custom')

const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok', 'local', 'custom']

const modelLoading = ref(false)
const modelOptions = computed(() => {
  const list = settings.modelsCache
  const current = settings.model
  if (!current || list.includes(current)) return list
  return [current, ...list]
})

async function refreshModels(): Promise<void> {
  if (modelLoading.value) return
  modelLoading.value = true
  try {
    await settings.listModels()
  } catch (e) {
    notifyError(`获取模型失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    modelLoading.value = false
  }
}

// Each provider has its own endpoint and credentials, so refetch (and clear the
// stale cache) whenever the provider changes.
watch(
  () => settings.provider,
  () => {
    settings.clearModelsCache()
    void refreshModels()
  },
)

const ACCENTS: Accent[] = ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate', 'teal', 'lime', 'rose', 'amber']
const ACCENT_COLORS: Record<Accent, string> = {
  ink: '#343532',
  coral: '#d65f4d',
  blue: '#3f7edb',
  green: '#3e9b73',
  gold: '#b98b09',
  violet: '#8a65d1',
  slate: '#607287',
  teal: '#2e9e8f',
  lime: '#7aa816',
  rose: '#e05c76',
  amber: '#d98c1f',
}

const UI_FONT_OPTIONS: UiFontId[] = ['system', 'inter', 'serif', 'rounded']
const EDITOR_FONT_OPTIONS: EditorFontId[] = ['system', 'serif', 'sans', 'reading']
const MONO_FONT_OPTIONS: MonoFontId[] = ['mono', 'cascadia', 'jetbrains']

function onLocaleChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  setLocale(v === 'en' ? 'en' : 'zh')
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
    notifyError(t('settings.general.saveKeyFailed', { msg: e instanceof Error ? e.message : String(e) }))
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
    notifyError(t('settings.general.vaultBrowseFailed', { msg: e instanceof Error ? e.message : String(e) }))
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
        :aria-label="t('settings.dialogTitle')"
        tabindex="-1"
      >
        <div class="dialog-header">
          <span class="dialog-title">{{ t('settings.dialogTitle') }}</span>
          <span class="dialog-spacer" />
          <button
            class="settings-close"
            :title="t('common.close')"
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
              <span class="settings-label">{{ t('settings.general.vault') }}</span>
              <div class="vault-row">
                <input
                  v-model="vaultInput"
                  class="input"
                  type="text"
                  :placeholder="t('settings.general.vaultPlaceholder')"
                  @keyup.enter="saveVault"
                >
                <button
                  class="btn btn-secondary btn-sm vault-browse"
                  :title="t('common.browse')"
                  @click="browseVault"
                >
                  {{ t('common.browse') }}
                </button>
              </div>
              <button
                class="btn btn-secondary settings-save"
                @click="saveVault"
              >
                {{ t('common.saveAndSwitch') }}
              </button>
              <span class="settings-note">{{ t('settings.general.vaultNote') }}</span>

              <span class="settings-label">{{ t('settings.general.language') }}</span>
              <label class="settings-field">
                <select
                  class="input"
                  :value="getLocale()"
                  @change="onLocaleChange"
                >
                  <option value="zh">{{ t('settings.general.languageZh') }}</option>
                  <option value="en">{{ t('settings.general.languageEn') }}</option>
                </select>
              </label>
            </section>

            <section
              v-else-if="activeSection === 'appearance'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.appearance.theme') }}</span>
              <div class="view-modes">
                <button
                  class="switch-option"
                  :class="{ 'is-active': appearance.theme === 'light' }"
                  @click="appearance.setTheme('light')"
                >
                  {{ t('settings.appearance.themeLight') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': appearance.theme === 'dark' }"
                  @click="appearance.setTheme('dark')"
                >
                  {{ t('settings.appearance.themeDark') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': appearance.theme === 'system' }"
                  @click="appearance.setTheme('system')"
                >
                  {{ t('settings.appearance.themeSystem') }}
                </button>
              </div>
              <span class="settings-label">{{ t('settings.appearance.accent') }}</span>
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
              <span class="settings-label">{{ t('settings.appearance.font') }}</span>
              <label class="settings-field">
                <span>{{ t('settings.appearance.uiFont') }}</span>
                <select
                  class="input"
                  :value="appearance.uiFont"
                  @change="appearance.setUiFont(($event.target as HTMLSelectElement).value as UiFontId)"
                >
                  <option
                    v-for="f in UI_FONT_OPTIONS"
                    :key="f"
                    :value="f"
                  >
                    {{ t(`font.${f}`) }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.editorFont') }}</span>
                <select
                  class="input"
                  :value="appearance.editorFont"
                  @change="appearance.setEditorFont(($event.target as HTMLSelectElement).value as EditorFontId)"
                >
                  <option
                    v-for="f in EDITOR_FONT_OPTIONS"
                    :key="f"
                    :value="f"
                  >
                    {{ t(`font.${f}`) }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.monoFont') }}</span>
                <select
                  class="input"
                  :value="appearance.monoFont"
                  @change="appearance.setMonoFont(($event.target as HTMLSelectElement).value as MonoFontId)"
                >
                  <option
                    v-for="f in MONO_FONT_OPTIONS"
                    :key="f"
                    :value="f"
                  >
                    {{ t(`font.${f}`) }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.fontSize', { size: appearance.bodyFontSize }) }}</span>
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
                <span>{{ t('settings.appearance.lineHeight', { lh: appearance.lineHeight }) }}</span>
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
              <span class="settings-label">{{ t('settings.editor.behavior') }}</span>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.focusMode') }}</span>
                <input
                  :checked="appearance.focusMode"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setFocusMode(($event.target as HTMLInputElement).checked)"
                >
              </label>
            </section>

            <section
              v-else-if="activeSection === 'editor'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.editor.view') }}</span>
              <div class="view-modes">
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.mode === 'source' }"
                  @click="setMode('source')"
                >
                  {{ t('settings.editor.viewSource') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.mode === 'rendered' }"
                  @click="setMode('rendered')"
                >
                  {{ t('settings.editor.viewRendered') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.mode === 'split' }"
                  @click="setMode('split')"
                >
                  {{ t('settings.editor.viewSplit') }}
                </button>
              </div>
              <span class="settings-label">{{ t('settings.editor.save') }}</span>
              <label class="settings-field">
                <span>{{ t('settings.editor.autosaveInterval') }}</span>
                <select
                  v-model="settings.autosaveInterval"
                  class="input"
                >
                  <option :value="'off'">
                    {{ t('settings.editor.autosaveOff') }}
                  </option>
                  <option :value="5000">
                    {{ t('settings.editor.autosave5s') }}
                  </option>
                  <option :value="15000">
                    {{ t('settings.editor.autosave15s') }}
                  </option>
                  <option :value="30000">
                    {{ t('settings.editor.autosave30s') }}
                  </option>
                  <option :value="60000">
                    {{ t('settings.editor.autosave60s') }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.editor.maxHistory') }}</span>
                <input
                  class="input"
                  :value="settings.maxHistory"
                  type="number"
                  min="1"
                  max="100"
                  @change="settings.maxHistory = Math.min(100, Math.max(1, Math.round(Number(($event.target as HTMLInputElement).value) || 10)))"
                >
              </label>
              <span class="settings-label">{{ t('settings.editor.behavior') }}</span>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.spellCheck') }}</span>
                <input
                  :checked="appearance.spellCheckEnabled"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setSpellCheckEnabled(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.softWrap') }}</span>
                <input
                  :checked="appearance.softWrap"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setSoftWrap(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.lineNumbers') }}</span>
                <input
                  :checked="appearance.lineNumbers"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setLineNumbers(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field">
                <span>{{ t('settings.editor.wordGoal', { goal: appearance.wordGoal }) }}</span>
                <input
                  class="input"
                  :value="appearance.wordGoal"
                  type="number"
                  min="0"
                  max="100000"
                  step="100"
                  @change="appearance.setWordGoal(Number(($event.target as HTMLInputElement).value) || 0)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.autosaveOnBlur') }}</span>
                <input
                  :checked="appearance.autosaveOnBlur"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setAutosaveOnBlur(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.statusBarWords') }}</span>
                <input
                  :checked="appearance.statusBarWords"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setStatusBarWords(($event.target as HTMLInputElement).checked)"
                >
              </label>
            </section>

            <section
              v-else-if="activeSection === 'export'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.export.current') }}</span>
              <div class="view-modes">
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="!hasActiveTab"
                  @click="onExportHtml"
                >
                  {{ t('settings.export.html') }}
                </button>
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="!hasActiveTab"
                  @click="onExportPdf"
                >
                  {{ t('settings.export.pdf') }}
                </button>
              </div>
              <span
                v-if="!hasActiveTab"
                class="settings-note"
              >{{ t('settings.export.none') }}</span>
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
                <div class="model-row">
                  <input
                    v-model="settings.model"
                    class="input"
                    type="text"
                    list="model-list"
                    placeholder="qwen2.5-coder:3b"
                  >
                  <datalist id="model-list">
                    <option
                      v-for="m in modelOptions"
                      :key="m"
                      :value="m"
                    >
                      {{ m }}
                    </option>
                  </datalist>
                  <button
                    class="btn btn-secondary btn-sm model-refresh"
                    :disabled="modelLoading"
                    title="刷新模型列表"
                    @click="refreshModels"
                  >
                    <RefreshCw
                      :size="13"
                      :stroke-width="1.8"
                      class="model-refresh-icon"
                      :class="{ spin: modelLoading }"
                    />
                    <span>刷新</span>
                  </button>
                </div>
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
              <label class="settings-field settings-toggle">
                <span>{{ t('aiSettings.systemPrompt') }}</span>
                <input
                  v-model="settings.systemPromptOn"
                  type="checkbox"
                  class="checkbox"
                >
              </label>
              <label
                v-if="settings.systemPromptOn"
                class="settings-field"
              >
                <span>{{ t('aiSettings.systemPromptHint') }}</span>
                <textarea
                  v-model="settings.systemPrompt"
                  class="input textarea"
                  rows="3"
                  :placeholder="t('aiSettings.systemPromptPlaceholder')"
                />
              </label>
              <label class="settings-field">
                <span>{{ t('aiSettings.temperature') }}</span>
                <input
                  class="input"
                  :value="settings.temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  @change="settings.temperature = Math.min(2, Math.max(0, Number(($event.target as HTMLInputElement).value) || 0.7))"
                >
              </label>
              <label class="settings-field">
                <span>{{ t('aiSettings.maxTokens') }}</span>
                <input
                  class="input"
                  :value="settings.maxTokens"
                  type="number"
                  min="128"
                  max="8192"
                  step="64"
                  @change="settings.maxTokens = Math.min(8192, Math.max(128, Math.round(Number(($event.target as HTMLInputElement).value) || 256)))"
                >
              </label>
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
.model-row { display: flex; gap: 6px; }
.model-row .input { flex: 1; min-width: 0; }
.model-refresh { flex: none; padding: 0 10px; }
.model-refresh:disabled { cursor: default; opacity: 0.6; }
.model-refresh-icon.spin {
  animation: model-spin 0.9s linear infinite;
}
@keyframes model-spin {
  to { transform: rotate(360deg); }
}
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.settings-section .settings-label:first-child { margin-top: 0; }
.settings-toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.settings-toggle > span { color: var(--app-text); font-size: 12px; }
.checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--app-accent);
  cursor: pointer;
}
.textarea {
  resize: vertical;
  min-height: 64px;
  font-family: var(--app-font);
  line-height: 1.5;
}
.view-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.view-modes button:disabled { opacity: 0.5; cursor: not-allowed; }
.accent-row { display: flex; gap: 6px; }
</style>
