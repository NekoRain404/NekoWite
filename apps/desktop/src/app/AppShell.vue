<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FolderOpen, PanelRightClose, PanelRightOpen, Settings } from 'lucide-vue-next'
import TitleBar from '../ui/TitleBar.vue'
import { AppSidebar } from '../features/sidebar'
import { NoteListPanel } from '../features/notes'
import InfoRail, { type RailTab } from '../ui/InfoRail.vue'
import TabBar from '../ui/TabBar.vue'
import StatusBar from '../ui/StatusBar.vue'
import { markArrived, markLeaving } from '../composables/surface-leave'
import AppDialogs from './AppDialogs.vue'
import EditorPane from '../ui/EditorPane.vue'
import LayoutResizeHandle from '../ui/LayoutResizeHandle.vue'
import ViewSwitch from '../view/ViewSwitch.vue'
import Toast from '../components/AppToast.vue'
import type { PendingAiWrite } from '../stores/ai-permission'
import GhostWriter from '../components/GhostWriter.vue'
import CommandPalette from '../ui/CommandPalette.vue'
import {
  NOTELIST_WIDTH_DEFAULT,
  NOTELIST_WIDTH_MAX,
  NOTELIST_WIDTH_MIN,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../stores/appearance-schema'
import { useAppearanceStore } from '../stores/appearance'
import { useSettingsStore } from '../stores/settings'
import type { PluginIntegrityRequest, PluginPermissionRequest } from '../services/plugins'
import { notifyError } from '../services/errors'
import { getLocale, t } from '../i18n'
import { attachAgentRail } from './agent-rail-attachment'
import { failureSentence } from './agent-rail'
import { attachPetHostAppearanceLink } from './pet-host-appearance-link'
import { attachPetSettingsLink } from './pet-settings-link'
import { attachPetTaskLink } from './pet-task-link'
import { taskUnavailableSentence } from './agent-rail-presentation'
import AgentRailBody from './AgentRailBody.vue'
import { createAgentSettingsClients } from './agent-settings-composition'
import type { SettingsOpenTarget } from '../features/settings'

const props = defineProps<{
  sidebarVisible: boolean
  vaultPath: string | null
  railOpen: boolean
  showSettings: boolean
  activeTitle: string
  activeSubtitle: string
  conflict: { tabId: string; path: string } | null
  pluginPermission: PluginPermissionRequest | null
  pluginIntegrity: PluginIntegrityRequest | null
  aiWrite: PendingAiWrite | null
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'open-folder', path: string): void
  (e: 'pick-folder'): void
  (e: 'open-settings'): void
  (e: 'close-settings'): void
  (e: 'close-conflict'): void
  (e: 'reload-conflict-disk', tabId: string): void
  (e: 'keep-local-conflict', tabId: string): void
  (e: 'respond-ai-write', approved: boolean, remember: boolean): void
  (e: 'resolve-permission', allowed: boolean): void
  (e: 'resolve-integrity', reapprove: boolean): void
  (e: 'toggle-rail'): void
  (e: 'toggle-settings'): void
}>()

const appearance = useAppearanceStore()
// Registry management must remain reachable when engine startup fails.
const agentRegistry = createAgentSettingsClients().registry

// The rail is mounted only while it is open, so which panel it shows has to
// outlive it: held here, closing the rail and reopening it puts the user back on
// the panel they were reading instead of resetting to the chat (D1).
const railTab = ref<RailTab>('ai')
const sidebarCompact = ref(false)

const theme = computed<string>(() => {
  void appearance.systemRevision
  return appearance.effectiveTheme()
})
const accent = computed<string>(() => appearance.effectiveAccent())
const colorScheme = computed<string>(() => appearance.colorScheme)
const locale = computed<string>(() => getLocale())
// ---- The agent rail (T16) --------------------------------------------------
//
const settings = useSettingsStore()
const {
  state: agentState,
  composition: agentComposition,
  retry: retryAgentRail,
  resume: resumeAgentSession,
  newSession: newAgentSession,
} = attachAgentRail({
  enabled: () => settings.agentPanel,
  vaultPath: () => props.vaultPath,
  railOpen: () => props.railOpen,
  onStopFailed: (error) =>
    notifyError(t('agent.rail.stopFailed', { reason: failureSentence(error) })),
  onResumeFailed: (error) =>
    notifyError(t('agent.rail.resumeFailed', { reason: failureSentence(error) })),
  // And the same again for a session that never existed: the engine would not open one while it
  // was already serving another, which leaves the reader exactly where they were — so the
  // sentence is the only place the refusal can be read.
  onNewSessionFailed: (error) =>
    notifyError(t('agent.rail.newSessionFailed', { reason: failureSentence(error) })),
})
const agentOn = computed<boolean>(() => settings.agentPanel)

const agentForEditor = computed(() => {
  const live = agentState.value
  return live.kind === 'live' ? live.session : null
})

// ---- The pet's settings deep link (§5.1's 设置定位) --------------------------
//
const { target: petSettingsTarget } = attachPetSettingsLink({
  open: () => props.showSettings,
  onOpen: () => {
    agentSettingsTarget.value = null
    emit('open-settings')
  },
})

const agentSettingsTarget = ref<SettingsOpenTarget | null>(null)

function openAgentSettings(page?: 'registry' | 'catalogue'): void {
  petSettingsTarget.value = null
  agentSettingsTarget.value = { section: 'agents', ...(page ? { agentPage: page } : {}) }
  emit('open-settings')
}

// ---- The pet follows this window's appearance (§1's 「保留现有主题、强调色」) --------------
//
attachPetHostAppearanceLink({
  appearance: () => ({
    // Each window resolves system theme itself, so pass the preference.
    theme: appearance.theme,
    colorScheme: colorScheme.value,
    accent: accent.value,
    highContrast: appearance.highContrast,
    bodyFontSize: appearance.bodyFontSize,
  }),
})

// Deep links expire with the dialog they opened.
watch(
  () => props.showSettings,
  (open) => {
    if (!open) agentSettingsTarget.value = null
  },
)

const settingsTarget = computed<SettingsOpenTarget | null>(
  () => agentSettingsTarget.value ?? petSettingsTarget.value,
)

// ---- The pet's click on a task (§6.2's 点击返回任务) -------------------------
//
attachPetTaskLink({
  railOpen: () => props.railOpen,
  onOpenRail: () => {
    railTab.value = 'ai'
    if (!props.railOpen) emit('toggle-rail')
  },
  // The rail's own state, not the store's: the session on screen is the one the rail's `live` arm
  // names, and there is no second answer to that question (`stores/agent-session.ts`).
  session: () => {
    const live = agentState.value
    return live.kind === 'live' ? live.session : null
  },
  // The rail's `resume`, through the attached handle: a session this runtime already serves comes
  // back from the handle the window holds — the run in it untouched — and one it does not is
  // loaded. Refusals are the rail's to report (`onResumeFailed`, wired above).
  onShow: (sessionId) => void resumeAgentSession(sessionId),
  // And the click this window cannot serve: refused out loud rather than answered with a session
  // nobody asked for. No engine is started for it, and the rail is not opened — see the doc above.
  onUnavailable: (key) => notifyError(taskUnavailableSentence(agentState.value, key)),
})

const shellStyle = computed<Record<string, string>>(() => ({
  '--app-sidebar-width': `${sidebarCompact.value ? 56 : appearance.sidebarWidth}px`,
  '--app-rail-width': `${appearance.railWidth}px`,
  '--app-notelist-width': `${appearance.notelistWidth}px`,
  '--app-body-size': `${appearance.bodyFontSize}px`,
  '--app-line-height': String(appearance.lineHeight),
  '--app-font': appearance.uiFontFamily(),
  '--app-mono-font': appearance.monoFontFamily(),
  '--app-editor-font': appearance.editorFontFamily(),
}))
</script>

<template>
  <div
    class="shell"
    :style="shellStyle"
    :data-theme="theme"
    :data-color-scheme="colorScheme"
    :data-accent="accent"
    :data-contrast="appearance.highContrast ? 'high' : 'normal'"
    :data-locale="locale"
  >
    <TitleBar
      :sidebar-visible="sidebarVisible"
      :title="activeTitle"
      :subtitle="activeSubtitle"
      @toggle-sidebar="emit('toggle-sidebar')"
    />

    <div class="shell-body">
      <template v-if="vaultPath">
        <Transition
          name="col"
          @leave="markLeaving"
          @enter="markArrived"
        >
          <AppSidebar
            v-show="sidebarVisible"
            class="layout-col"
            :vault="vaultPath"
            :compact="sidebarCompact"
            @open-folder="(p: string) => emit('open-folder', p)"
            @open-settings="emit('open-settings')"
            @toggle-compact="sidebarCompact = !sidebarCompact"
          />
        </Transition>
        <LayoutResizeHandle
          v-if="sidebarVisible && !sidebarCompact"
          :label="t('layout.resizeSidebar')"
          :min="SIDEBAR_WIDTH_MIN"
          :max="SIDEBAR_WIDTH_MAX"
          :value="appearance.sidebarWidth"
          :default-value="SIDEBAR_WIDTH_DEFAULT"
          @change="appearance.setSidebarWidth"
        />
        <Transition
          name="col"
          @leave="markLeaving"
          @enter="markArrived"
        >
          <NoteListPanel
            v-show="sidebarVisible"
            class="note-list-col layout-col"
          />
        </Transition>
        <LayoutResizeHandle
          v-if="sidebarVisible"
          :label="t('layout.resizeNotelist')"
          :min="NOTELIST_WIDTH_MIN"
          :max="NOTELIST_WIDTH_MAX"
          :value="appearance.notelistWidth"
          :default-value="NOTELIST_WIDTH_DEFAULT"
          @change="appearance.setNotelistWidth"
        />
      </template>
      <div
        v-else
        class="onboard"
      >
        <div class="onboard-card">
          <div class="onboard-icon">
            <FolderOpen
              :size="26"
              :stroke-width="1.5"
            />
          </div>
          <p class="onboard-title">
            {{ t('app.welcome') }}
          </p>
          <p class="onboard-hint">
            {{ t('app.welcomeHint') }}
          </p>
          <button
            class="btn btn-primary"
            @click="emit('pick-folder')"
          >
            {{ t('app.openFolder') }}
          </button>
        </div>
      </div>

      <section class="main">
        <div class="main-content">
          <slot>
            <TabBar />
            <EditorPane
              :agent-identity="agentForEditor"
              :agent-insertions="agentComposition"
            />
          </slot>
        </div>
        <LayoutResizeHandle
          v-if="railOpen"
          side="end"
          :label="t('layout.resizeRail')"
          :min="RAIL_WIDTH_MIN"
          :max="RAIL_WIDTH_MAX"
          :value="appearance.railWidth"
          :default-value="RAIL_WIDTH_DEFAULT"
          @change="appearance.setRailWidth"
        />

        <Transition
          name="rail"
          @leave="markLeaving"
          @enter="markArrived"
        >
          <InfoRail
            v-if="railOpen"
            v-model:tab="railTab"
            @close="emit('toggle-rail')"
          >
            <template
              v-if="agentOn"
              #body
            >
              <AgentRailBody
                :state="agentState"
                :registry="agentComposition?.registry ?? agentRegistry"
                :vault-open="vaultPath !== null"
                @retry="retryAgentRail()"
                @resume="resumeAgentSession($event)"
                @new-session="newAgentSession($event)"
                @open-settings="openAgentSettings($event)"
                @use-chat="settings.agentPanel = false"
              />
            </template>
          </InfoRail>
        </Transition>
      </section>
    </div>

    <StatusBar>
      <template #actions>
        <ViewSwitch />
        <button
          class="status-btn"
          :class="{ 'is-active': railOpen }"
          :title="railOpen ? t('rail.collapse') : t('rail.expand')"
          @click="emit('toggle-rail')"
        >
          <PanelRightClose
            v-if="railOpen"
            :size="14"
            :stroke-width="1.8"
          />
          <PanelRightOpen
            v-else
            :size="14"
            :stroke-width="1.8"
          />
        </button>
        <button
          class="status-btn"
          :title="t('common.settings')"
          @click="emit('toggle-settings')"
        >
          <Settings
            :size="14"
            :stroke-width="1.8"
          />
        </button>
      </template>
    </StatusBar>
    <GhostWriter />
    <Toast />

    <AppDialogs
      :show-settings="showSettings"
      :settings-target="settingsTarget"
      :conflict="conflict"
      :plugin-permission="pluginPermission"
      :plugin-integrity="pluginIntegrity"
      :ai-write="aiWrite"
      @close-settings="emit('close-settings')"
      @open-folder="(p: string) => emit('open-folder', p)"
      @close-conflict="emit('close-conflict')"
      @reload-conflict-disk="(tabId: string) => emit('reload-conflict-disk', tabId)"
      @keep-local-conflict="(tabId: string) => emit('keep-local-conflict', tabId)"
      @respond-ai-write="(approved: boolean, remember: boolean) => emit('respond-ai-write', approved, remember)"
      @resolve-permission="(allowed: boolean) => emit('resolve-permission', allowed)"
      @resolve-integrity="(reapprove: boolean) => emit('resolve-integrity', reapprove)"
    />

    <CommandPalette />
  </div>
</template>

<style src="./appShell-chrome.css"></style>

<style src="./appShell.css"></style>
