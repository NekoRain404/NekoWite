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
import AgentRailBody from './AgentRailBody.vue'
import type { SettingsOpenTarget } from '../features/settings'

// AppShell is the presentational root layout only. It owns no Tauri calls, no
// file-path walking and no business logic. Appearance-driven layout (theme,
// accent, widths, typography) is read from the appearance store; the app-level
// state (vault, pane visibility, active-tab title/subtitle, dialogs) is props,
// and every interaction is an event for the parent (App.vue) to route. The main
// editor region is a default slot so the shell stays composable, with the
// standard TabBar+EditorPane as the fallback.

// Assigned for the one reader in this script: the agent rail watches
// `vaultPath`, because the runtime it manages is per vault. Every other prop is
// read by name in the template, which `<script setup>` exposes without it.
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
  /** A write the AI is waiting to be allowed to perform. */
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

// The rail is mounted only while it is open, so which panel it shows has to
// outlive it: held here, closing the rail and reopening it puts the user back on
// the panel they were reading instead of resetting to the chat (D1).
const railTab = ref<RailTab>('ai')

// The left cluster's toggle does NOT animate the content, deliberately. It used
// to: a compensating translate was written to `.main` on every toggle, because
// the collapsing columns move the content's origin and the layout collapse is
// visible. The cost was the whole editor — the largest subtree in the app —
// carried through a 300ms transform, with two forced synchronous layouts of it
// per toggle to measure and commit the compensation. The user reported what
// that looks like from the outside: 点击左上角的抽屉图标,整个页面都会被改动,
// 而点击右下角的抽屉就不会这样 — jank and flicker on a control whose motion
// should be the panel's alone. The rail is the control that already behaves:
// it fades and translates itself (styles/appShell.css) while the content takes
// the space in the click frame, one reflow, nothing animated. Both toggles now
// do that, so the two halves of the same gesture feel the same.

const theme = computed<string>(() => {
  void appearance.systemRevision
  return appearance.effectiveTheme()
})
const accent = computed<string>(() => appearance.effectiveAccent())
const colorScheme = computed<string>(() => appearance.colorScheme)
const locale = computed<string>(() => getLocale())
// ---- The agent rail (T16) --------------------------------------------------
//
// The right rail has one job and two possible bodies: the chat panel it has
// carried since the chat moved in, and the ACP agent panel (§9's tree) that §12
// stages behind a switch. The shell supplies the two values only it owns — the
// switch (a setting, `stores/settings-agent.ts` owns the value and its default)
// and the folder (`vaultPath`, the vault the app opened) — plus whether the rail
// is on screen; `agent-rail.ts` owns everything that follows from them: when an
// engine is started, torn down or kept running behind a closed panel, and what
// the rail shows while it is none of those. See `attachAgentRail`'s doc for the
// four rules, including why a rollback has to stop the process and not merely
// stop drawing it.
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
  // A `stop` that failed is the one thing on this path the user cannot see from
  // the rail: the state moves on regardless (the window has to be able to say
  // the runtime is gone even when the backend disagreed), so the failure goes
  // to the toast rather than nowhere.
  onStopFailed: (error) =>
    notifyError(t('agent.rail.stopFailed', { reason: failureSentence(error) })),
  // A reopened session the engine would not hand back, and the same reasoning one
  // step further: the rail *keeps* the session that is open — a failed load is not
  // a reason to take a running conversation off the screen — so there is no state
  // for this failure to live in, and the shell is the only layer that can say it.
  onResumeFailed: (error) =>
    notifyError(t('agent.rail.resumeFailed', { reason: failureSentence(error) })),
  // And the same again for a session that never existed: the engine would not open one while it
  // was already serving another, which leaves the reader exactly where they were — so the
  // sentence is the only place the refusal can be read.
  onNewSessionFailed: (error) =>
    notifyError(t('agent.rail.newSessionFailed', { reason: failureSentence(error) })),
})
const agentOn = computed<boolean>(() => settings.agentPanel)

// What the editor pane needs to host the agent's proposals for the note that is open, handed down
// because the shell is the only layer that holds both halves: the runtime on screen (`agentState`)
// and the column the note is in. The identity is the session's own — an `AgentSession` IS an
// `AgentIdentity` — and the insertion source is the composition, which is where
// `connectSvgInsertion` lives. Both are null while no runtime is up, and the surface draws nothing
// rather than a control that could not act.
const agentForEditor = computed(() => {
  const live = agentState.value
  return live.kind === 'live' ? live.session : null
})

// ---- The pet's settings deep link (§5.1's 设置定位) --------------------------
//
// The pet window's right-click asks the host to raise this window on a page; the host checks the
// page against its own list and emits it, and the shell is where the request lands — what the
// dialog opens on is a value the shell hands down, and the other thing that has to change is the
// boolean that shows it, which the shell already asks for with the same `open-settings` event the
// sidebar's gear emits. The listener, its lifetime and how long one request is remembered are
// `pet-settings-link.ts`'s, for the reason that file gives: the shell supplies the two values it
// alone has and nothing else.
//
// It is one of **two** producers of that landing place. The other is the agent panel's own
// options menu, a few lines below, and it is a click in this window rather than a request from
// another one — which is the whole of row 43: until it existed, the only way into the agents
// tree was to know that the settings dialog had one.
const { target: petSettingsTarget } = attachPetSettingsLink({
  open: () => props.showSettings,
  onOpen: () => {
    // The newest request wins, and it is written here rather than left to the `??` below: the
    // pet's right-click *can* arrive while the dialog is open (its own watcher exists for that
    // case), and a landing place that outlived its request would answer it with the section
    // nobody just asked for. The reverse cannot happen — the panel is behind the dialog's overlay
    // while the dialog is up — which is why this is the only direction that needs writing down.
    agentSettingsTarget.value = null
    emit('open-settings')
  },
})

/**
 * Where the dialog was asked to open by the agent panel's options menu, or `null`.
 *
 * The panel does not name the section: `agents` is a fact about where this app keeps the agent
 * pages, so it is written once, here, beside the shell's other use of that vocabulary. The panel
 * emits `open-settings` and means "the agent settings" — this is the layer that knows what that
 * is called in the navigation.
 */
const agentSettingsTarget = ref<SettingsOpenTarget | null>(null)

/**
 * Open the agents tree, from the panel that feels the misconfiguration (§8.1).
 *
 * Two writes and an emit, in that order: the target has to be in place before the dialog mounts,
 * because the panel reads its landing place once, in `setup`. `App.vue` owns `showSettings` and
 * flips it on the event below.
 */
function openAgentSettings(): void {
  petSettingsTarget.value = null
  agentSettingsTarget.value = { section: 'agents' }
  emit('open-settings')
}

// ---- The pet follows this window's appearance (§1's 「保留现有主题、强调色」) --------------
//
// The pet's windows are pages of their own and may not read this window's store (§7.1), so the
// appearance this shell draws with is *published*: the four attributes and the body size are the
// same four and the same one the root below carries, read from the same getters, so the pet cannot
// be told about an appearance this window is not showing. `pet-host-appearance-link.ts` owns when
// that happens; the shell supplies the getters only it has.
attachPetHostAppearanceLink({
  appearance: () => ({
    // The *setting* and not `theme.value`: `system` is resolved by each page against its own engine
    // — the same engine, in the same process — so a pet window keeps following a desktop theme flip
    // on a machine whose app is following it too. The accent is the resolved one, because resolving
    // *that* needs the OS read only the backend has (`stores/appearance.ts`'s `effectiveAccent`).
    theme: appearance.theme,
    colorScheme: colorScheme.value,
    accent: accent.value,
    highContrast: appearance.highContrast,
    bodyFontSize: appearance.bodyFontSize,
  }),
})

// One request is remembered for as long as the dialog it opened. Without this, the toolbar's
// gear and the panel's row would keep opening on the section the *last* request named, because
// the panel reads its landing place on every mount — the same rule the pet's link states for its
// own ref, and the reason the two are cleared in the same breath as they are set.
watch(
  () => props.showSettings,
  (open) => {
    if (!open) agentSettingsTarget.value = null
  },
)

/**
 * What the dialog is told to open on.
 *
 * At most one of the two is ever set — each producer clears the other as it writes — so this is
 * a join of two mutually exclusive facts rather than a precedence rule.
 */
const settingsTarget = computed<SettingsOpenTarget | null>(
  () => agentSettingsTarget.value ?? petSettingsTarget.value,
)

// ---- The pet's click on a task (§6.2's 点击返回任务) -------------------------
//
// The other half of the same flow: the pet's row calls `desktop_pet_open_task`, the host raises
// this window and emits D1's key, and the link asks for the rail and for the session it names —
// which may be collapsed, since the flow this exists for is 收起面板 → 完成提醒 → 返回. The
// listener, the rule about which sessions a click may address and the release are
// `pet-task-link.ts`'s; the shell supplies the three readings only it has — whether the rail is
// open, which session the rail is showing, and the rail's own way between sessions — plus the
// panel it wants shown.
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
})

const shellStyle = computed<Record<string, string>>(() => ({
  '--app-sidebar-width': `${appearance.sidebarWidth}px`,
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
      <!-- Having a vault open and having the sidebar shown are two different
           things, and only the first builds the columns: sharing one `v-if` once
           meant collapsing the sidebar unmounted it and the note list, losing
           the list's scroll and the open groups. Mounted once per vault, the
           toggle only hides them — and the `<Transition>` is what gives it an
           *exit*, because `v-show` alone writes `display: none` in the frame the
           state flips. What the leave does with the layout is in `appShell.css`. -->
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
            @open-folder="(p: string) => emit('open-folder', p)"
            @open-settings="emit('open-settings')"
          />
        </Transition>
        <LayoutResizeHandle
          v-if="sidebarVisible"
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
        <!-- `v-if`, not `v-show`, and the difference is a cost worth naming: the
             rail holds a chat session and a file-watch subscription, so keeping
             it alive for the app's whole life is not what a fade is worth. The
             `<Transition>` gives it an exit without that — the element stays in
             the tree for its own leave, then is destroyed. -->
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
            <!-- Filled only while the agent panel is switched on, and that is
                 what makes the rollback exact: with the slot absent, the rail
                 renders the chat panel it has always rendered, through the same
                 element, the same store and the same subscription. `.agent-*`
                 selectors in the tests are the panel's own. -->
            <template
              v-if="agentOn"
              #body
            >
              <AgentRailBody
                :state="agentState"
                :vault-open="vaultPath !== null"
                @retry="retryAgentRail()"
                @resume="resumeAgentSession($event)"
                @new-session="newAgentSession()"
                @open-settings="openAgentSettings()"
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
    <!-- The shell's own modals, and the only place their exit is declared; see
         the component for why they moved out of this template together. -->
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
    <!-- Last, and the position is load-bearing. `ui/CommandPalette.vue` stopped teleporting its
         overlay to `body` (the reason is in that file: an `inset: 0` box's containing block is the
         box it fills, and `.shell` *is* the window), so it is now a sibling of the dialog above
         rather than an element appended after the whole application. The palette's `z-index:
         10000` and the settings overlay's are the same number — the palette is meant to be raised
         *over* a dialog — so the tie is broken by document order, and this is where it has to be
         written: after `AppDialogs`, which is the order the teleport used to produce for free
         (a `<Teleport>` appends to its target). `Toast` keeps its own 11000 and stays on top of
         both wherever it sits. -->
    <CommandPalette />
  </div>
</template>

<!-- The shell's chrome, beside it for the reason `appShell.css` states: these rules are global, and
     the two files are the two halves of one move that took the shell's line budget back from its
     stylesheets. Markup and assembly are what this file keeps; the boxes they are laid out in are
     in the two files below, in that order, which is the order they were in when the chrome was
     still inline. -->
<style src="./appShell-chrome.css"></style>

<style src="./appShell.css"></style>

