<script setup lang="ts">

import { computed, ref, watch } from 'vue'
import { t } from '../../../i18n'
import {
  AGENT_SETTINGS_SECTIONS,
  AgentCatalogueBrowser,
  AgentConfigurationSettings,
  AgentPermissionSettings,
  AgentProviderSettings,
  AgentRegistrySettings,
  AgentRuntimeSettings,
  AgentSkillsSettings,
} from '../../agent-settings'
import { defaultEngineIdentity } from '../../agent-settings/services/agent-registry-policy'
import type { AgentRegistryReadout, EngineIdentity } from '../../agent-settings/services/agent-registry-policy'
// Named by file rather than through the barrel: the catalogue's prefill is the *component's* own
// vocabulary (`index.ts` exports the sections' components and their label types, and a fifth type
// there would be a name with one caller). The specifier is the component the type belongs to.
import type { CataloguePrefill } from '../../agent-settings/components/AgentCatalogueBrowser.vue'
import type { AgentSettingsClients } from '../../../app/agent-settings-composition'
import type { AgentPageId } from '../types'
import { useAgentPanel } from '../composables/use-agent-panel'
import { resetContentScroll } from '../composables/content-scroll'
import AgentSettingsNavigation from './AgentSettingsNavigation.vue'

const props = withDefaults(defineProps<{
  clients: AgentSettingsClients
  showNavigation?: boolean
}>(), { showNavigation: true })
const active = defineModel<AgentPageId>('page', { default: 'runtime' })

const { agentPanel, setAgentPanel } = useAgentPanel()

const identity = ref<EngineIdentity | null>(null)
const verifiedOpenCode = ref(false)

function updateIdentity(readout: AgentRegistryReadout | null): void {
  identity.value = readout === null ? null : defaultEngineIdentity(readout)
  const entry = readout?.entries.find(entry => entry.agentId === identity.value?.agentId)
  verifiedOpenCode.value = entry?.adapterId === 'opencode' && entry.source !== 'external'
}
// A different profile must not retain the previous page's pending reads or editable draft.
const identityKey = computed(() => identity.value === null ? '' : JSON.stringify(identity.value))

const showing = computed(() =>
  identity.value === null
    ? t('agent.settings.agents.profile.unknown')
    : t('agent.settings.agents.profile.showing', {
        agent: identity.value.agentId,
        profile: identity.value.profileId,
      }),
)

const permissionClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.permission(identity.value.agentId, identity.value.profileId),
)

const configClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.config(identity.value.agentId, identity.value.profileId),
)

const skillsClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.skills(identity.value.agentId, identity.value.profileId),
)

const authoringClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.providerAuthoring(identity.value.agentId, identity.value.profileId),
)

const credentialClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.credentials(identity.value.agentId, identity.value.profileId),
)

const cataloguePrefill = ref<CataloguePrefill | null>(null)

function onCatalogueUse(entry: CataloguePrefill): void {
  cataloguePrefill.value = entry
  active.value = landing('registry')
}

const providerPage = computed(() =>
  identity.value === null || credentialClient.value === null
    ? null
    : {
        client: props.clients.provider,
        credentialClient: credentialClient.value,
        agentId: identity.value.agentId,
        profileId: identity.value.profileId,
      },
)
const configurationPage = computed(() =>
  configClient.value === null || authoringClient.value === null
    ? null
    : { client: configClient.value, authoring: authoringClient.value },
)
const skillsPage = computed(() =>
  skillsClient.value === null ? null : { client: skillsClient.value },
)
const permissionPage = computed(() =>
  permissionClient.value === null ? null : { client: permissionClient.value },
)

const mountable = computed<Record<AgentPageId, boolean>>(() => ({
  // No pair and no gate: its subject is the engine this app starts rather than one profile.
  runtime: true,
  // The registry *is* what answers the pair, so it cannot be behind the pair's own gate.
  registry: true,
  // About no profile either: what the public registry publishes.
  catalogue: true,
  provider: providerPage.value !== null,
  configuration: configurationPage.value !== null,
  skills: skillsPage.value !== null,
  permission: permissionPage.value !== null,
}))

const available = computed<AgentPageId[]>(() =>
  AGENT_SETTINGS_SECTIONS.map((section) => section.id)
    .filter((id): id is AgentPageId => Object.hasOwn(mountable.value, id))
    .filter((id) => mountable.value[id]),
)

function landing(id: AgentPageId): AgentPageId {
  if (mountable.value[id] && available.value.includes(id)) return id
  return available.value[0] ?? 'runtime'
}
watch(mountable, () => { active.value = landing(active.value) }, { immediate: true })

const root = ref<HTMLElement | null>(null)
watch(active, () => { resetContentScroll(root.value) })

const SENTENCES: Readonly<Record<string, string>> = {
  commands: t('agent.settings.agents.gaps.commands'),
  mcp: t('agent.settings.agents.gaps.mcp'),
}

const gaps = computed(() => [
  ...AGENT_SETTINGS_SECTIONS.filter((section) => !Object.hasOwn(mountable.value, section.id)).map(
    (section) => SENTENCES[section.id] ?? t('agent.settings.agents.gaps.other'),
  ),
])
</script>

<template>
  <section
    ref="root"
    class="settings-section"
  >
    <div class="agents-intro">
      <span class="settings-label">{{ t('agent.settings.agents.section.title') }}</span>
      <p class="settings-note">
        {{ t('agent.settings.agents.section.hint') }}
      </p>
    </div>
    <div class="agents-control">
      <label class="settings-field settings-toggle">
        <span>{{ t('agent.settings.agents.panel.label') }}</span>
        <input
          :checked="agentPanel"
          data-agent-panel-switch
          type="checkbox"
          class="checkbox"
          @change="setAgentPanel(($event.target as HTMLInputElement).checked)"
        >
      </label>
      <p class="settings-note">
        {{ t('agent.settings.agents.panel.hint') }}
      </p>
    </div>

    <AgentSettingsNavigation
      v-if="showNavigation"
      :pages="available"
      :active="active"
      @update:active="active = $event"
    />

    <p
      class="agents-profile settings-note"
      data-test="agents-profile"
    >
      {{ showing }}
    </p>

    <div
      class="agents-pages"
      data-test="agents-pages"
    >
      <AgentRuntimeSettings
        v-show="active === 'runtime'"
        :data-page="'runtime'"
        :client="props.clients.runtime"
      />
      <AgentProviderSettings
        v-if="providerPage"
        :key="`provider:${identityKey}`"
        v-show="active === 'provider'"
        :data-page="'provider'"
        :client="providerPage.client"
        :credential-client="providerPage.credentialClient"
        :agent-id="providerPage.agentId"
        :profile-id="providerPage.profileId"
      />

      <AgentConfigurationSettings
        v-if="configurationPage"
        :key="`configuration:${identityKey}`"
        v-show="active === 'configuration'"
        :data-page="'configuration'"
        :client="configurationPage.client"
        :authoring="configurationPage.authoring"
      />

      <AgentSkillsSettings
        v-if="skillsPage"
        :key="`skills:${identityKey}`"
        v-show="active === 'skills'"
        :data-page="'skills'"
        :client="skillsPage.client"
      />

      <AgentPermissionSettings
        v-if="permissionPage"
        :key="`permission:${identityKey}`"
        v-show="active === 'permission'"
        :data-page="'permission'"
        :client="permissionPage.client"
        :config-client="configClient ?? undefined"
        :verified-open-code="verifiedOpenCode"
      />
      <AgentRegistrySettings
        v-show="active === 'registry'"
        :data-page="'registry'"
        :client="props.clients.registry"
        :profile-id="identity?.profileId ?? ''"
        :can-start-session="false"
        :prefill="cataloguePrefill"
        @readout-changed="updateIdentity"
      />

      <AgentCatalogueBrowser
        v-show="active === 'catalogue'"
        :data-page="'catalogue'"
        :client="props.clients.catalogue"
        @use="onCatalogueUse"
      />
    </div>

    <div
      v-if="gaps.length"
      class="agents-gaps"
    >
      <span class="settings-label">{{ t('agent.settings.agents.gaps.title') }}</span>
      <p class="settings-note">
        {{ t('agent.settings.agents.gaps.intro') }}
      </p>

      <ul class="agent-gaps">
        <li
          v-for="(gap, index) in gaps"
          :key="index"
          class="agent-gap"
        >
          {{ gap }}
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-label`, `.settings-toggle`, `.settings-field`
   and `.checkbox` are restated here, as every section in this dialog restates
   them: a scoped block belongs to the component that renders the element. */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-section .settings-label:first-child { margin-top: 0; }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.settings-toggle > span { color: var(--app-text); font-size: 12px; }
.checkbox {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--app-accent);
  cursor: pointer;
}
.settings-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted);
}
.agents-intro {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
}
.agents-intro .settings-label,
.agents-gaps .settings-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--app-text);
}
.agents-control {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
  border-radius: var(--app-radius-md);
  background: color-mix(in srgb, var(--app-panel) 38%, transparent);
}
.agents-profile {
  margin: -2px 2px 0;
  font-size: 10px;
}
.agents-gaps {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 64%, transparent);
}
/* The box the seven pages live in.
   It carries no divider rules of its own any more, and that is the consequence of one page being
   on screen at a time rather than a tidy-up: the old rule drew a line *before every page* because
   seven of them were stacked in one scroll and the lines were what told them apart. The rail above
   delimits the page now, and a rule that tried to draw only above the drawn page would have to ask
   which sibling is `display: none` — a question with no selector a reader could trust. Six of the
   seven pages here are `v-show`-hidden in any frame.

   **No swap transition, on purpose.** `<Transition>` takes one child, and the reason the pages are
   `v-show`-hidden rather than unmounted is that unmounting them loses each page's draft and breaks
   the catalogue's hand-off to the registry's add form (the page watches `prefill`, not on mount).
   So there is nothing here to cross-fade, and §7.3's 正文稳定 is served by the absence: the click is
   the user's own, the page is already in the DOM, and nothing moves the text for a curve nobody
   asked for. The level above — the dialog's own section swap — carries the arrival vocabulary. */
.agents-pages {
  display: flex;
  flex-direction: column;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
}
.agent-gaps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 16px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted);
}
.agent-gap::marker { color: var(--app-accent); }
</style>
