<script setup lang="ts">
/**
 * The agents section: the one control that reaches the shell, the six pages whose host half this
 * build really has, and the statements for everything in this tree that is still absent.
 *
 * ## What is mounted, and why these six
 *
 * §10.2's T16 row and §8 give an agent settings tree of pages, each delivered as a component that
 * takes its facts from an injected client. Six of those clients can be built against commands this
 * build registers — the registry (`agent_registry_read` / `_add` / `_set_enabled`), the profile
 * (`agent_profile_read` / `_write`), the permission pair (`agent_permission_grants` / `_revoke`),
 * the engine's own configuration (`agent_config_document` / `agent_config_edit`), the ACP catalogue
 * (`agent_catalogue_read`) and the skills page (`agent_skills_read` / `_preview` / `_import` /
 * `_set_enabled`) — so those six pages are mounted here and really read the backend. The clients
 * arrive as a prop from the composition site (`app/agent-settings-composition.ts`), the way the
 * pet's section is handed its connection: this file never builds one, and never decides what a
 * page talks to.
 *
 * Every one of those commands had **no caller anywhere in `src/`** until this file mounted its
 * page. That is this repository's signature failure mode — 建好了但够不到, caught more than eight
 * times — and the thing that ends it is a mount point reached by a real gesture, which for this
 * tree means: the status bar's gear (`AppShell.vue`), the `agents` row in
 * `SettingsNavigation.vue`, and the pages below.
 *
 * ## The pair these pages are about
 *
 * The profile page is about **one engine and one profile**, never "the app's provider" (§8.1:
 * provider credentials, model ids and configuration files are per engine), and the registry page
 * takes the same pair for the engine it plans a session with. The
 * registry readout is the only thing that pairs a profile with an engine, so it is read once here,
 * through {@link defaultEngineIdentity}, and the profile page is mounted only when the pair is
 * known. Nothing is invented to fill the gap: a page handed a guessed profile id would render
 * another engine's record under this engine's heading, which is the one thing §8.1 refuses. The
 * pair is stated on the page, so the two readings below cannot be mistaken for "the app's
 * provider" either.
 *
 * ## The switch, and the statements
 *
 * The rail switch is a real setting with a real effect (the shell reads it; see
 * `stores/settings-agent.ts` for the value, the default and why the default is off), so it is a
 * control whose hint states the consequence a user cannot see from here. Everything else that
 * cannot be done is *said*, with what it would take and no control drawn for it — the rule the
 * registry page and the pet integration page follow. The registry page is mounted with
 * `can-start-session="false"` for the same reason: this dialog has no gateway, so the engine
 * switch it would otherwise draw is a button that emits to nobody.
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '../../../i18n'
import {
  AGENT_SETTINGS_SECTIONS,
  AgentCatalogueBrowser,
  AgentConfigurationSettings,
  AgentPermissionSettings,
  AgentProviderSettings,
  AgentRegistrySettings,
  AgentSkillsSettings,
} from '../../agent-settings'
import { defaultEngineIdentity } from '../../agent-settings/services/agent-registry-policy'
import type { EngineIdentity } from '../../agent-settings/services/agent-registry-policy'
// Named by file rather than through the barrel: the catalogue's prefill is the *component's* own
// vocabulary (`index.ts` exports the sections' components and their label types, and a fifth type
// there would be a name with one caller). The specifier is the component the type belongs to.
import type { CataloguePrefill } from '../../agent-settings/components/AgentCatalogueBrowser.vue'
import type { AgentSettingsClients } from '../../../app/agent-settings-composition'
import { useAgentPanel } from '../composables/use-agent-panel'

const props = defineProps<{
  /** The registry and the profile, chosen at the composition site. */
  clients: AgentSettingsClients
}>()

const { agentPanel, setAgentPanel } = useAgentPanel()

/**
 * The engine and profile the pages below are about, or `null` until the registry has been read.
 *
 * A failure leaves it `null` and is not reported as a second sentence: the registry page is mounted
 * either way and draws the backend's own failure in its own words with a retry, and two readings of
 * one refusal on one page is the kind of duplication that ends up disagreeing with itself.
 */
const identity = ref<EngineIdentity | null>(null)

onMounted(async () => {
  try {
    identity.value = defaultEngineIdentity(await props.clients.registry.read())
  } catch {
    identity.value = null
  }
})

/** The engine the pages are about, for the sentence that says which one they are showing. */
const showing = computed(() =>
  identity.value === null
    ? t('agent.settings.agents.profile.unknown')
    : t('agent.settings.agents.profile.showing', {
        agent: identity.value.agentId,
        profile: identity.value.profileId,
      }),
)

/**
 * The sections this file mounts, by their ids in {@link AGENT_SETTINGS_SECTIONS}.
 *
 * One list, in the feature that declares the tree, and this is the half of it that is reachable:
 * a page is in here when its client can be built against a command this build registers. A literal
 * rather than something derived from the imports, because the id and the component are two
 * different facts (`mounts` names the component; a section's id is what a navigation binds), and
 * the test that reads this file's rendering is what keeps the two in step.
 */
const MOUNTED = new Set([
  'registry',
  'provider',
  'permission',
  'configuration',
  'catalogue',
  'skills',
])

/**
 * The permission page's client, built for the pair the registry answered with.
 *
 * `null` while the registry is unread, which is the same gate the provider page sits behind and
 * for the same reason: the page is about one engine and one profile, and it is not mounted with a
 * guessed pair. A `computed` rather than a call in the template, so the client is one object for
 * as long as the identity is — a page whose client changed identity on every render would reload
 * on every render.
 */
const permissionClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.permission(identity.value.agentId, identity.value.profileId),
)

/**
 * The configuration document's client, behind the same gate and for the same reason.
 *
 * The document lives inside the profile root and its path arrives on that profile's readout, so a
 * page mounted without the pair would have nothing to open — and, worse, a client built for a
 * guessed pair would read one profile's record to decide where to write, which is the §8.1 failure
 * this whole file's `showing` sentence exists to prevent.
 */
const configClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.config(identity.value.agentId, identity.value.profileId),
)

/**
 * The skills page's client, behind the same gate and for its own reason.
 *
 * §8.2's section is about the directories *one profile's* engine reads — the scope list is built
 * from where that profile's `HOME` and `XDG_CONFIG_HOME` point — so a page mounted without the pair
 * would have to be told which profile's directories to describe. Nothing is invented to fill that
 * gap, exactly as the two clients above refuse to be.
 */
const skillsClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.skills(identity.value.agentId, identity.value.profileId),
)

/**
 * The credential write, behind the same gate and for its own reason.
 *
 * What it writes is a key *into one profile's file*, so a client built for a guessed pair would be
 * this app putting a credential where the user is not looking. The provider page is mounted with
 * the same pair in the same breath, and both are built from the registry's answer.
 */
const credentialClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.credentials(identity.value.agentId, identity.value.profileId),
)

/**
 * The entry the catalogue handed to the registry's add form, or `null`.
 *
 * The catalogue's only control is "register this one", and the add form is the registry page's — so
 * the click travels through this file rather than being duplicated inside the catalogue, which
 * holds no `add` of its own. Held here rather than in either page because neither owns the other:
 * one emits, one receives, and the section is the only thing that knows both exist.
 */
const cataloguePrefill = ref<CataloguePrefill | null>(null)

/**
 * One sentence per section that is not mounted, keyed by the list's own ids.
 *
 * Keys are resolved by literal `t()` calls and never built from a variable: a key the source
 * constructs cannot be seen missing from the catalogue by the i18n guard, so a rename would reach
 * the page as an id printed where a sentence belongs. The record has no entry for a mounted
 * section, and the row for an unlisted one falls back to `gaps.other` rather than vanishing.
 */
const SENTENCES: Readonly<Record<string, string>> = {
  runtime: t('agent.settings.agents.gaps.runtime'),
  commands: t('agent.settings.agents.gaps.commands'),
  mcp: t('agent.settings.agents.gaps.mcp'),
}

/**
 * The statements about what is not connected, derived from the tree's own list.
 *
 * Derived, and not a hand-kept list of absences: a sentence about a missing thing has a shelf life
 * of about one commit, and the version of this page that says "no section is reachable" while two
 * of them are mounted is worse than one that says nothing. Deriving the rows means a page whose
 * client lands drops out of here by being named in {@link MOUNTED} — the same edit that mounts it.
 *
 * The last two rows are not sections: the capability join is a fact about what *any* page can say,
 * and the engine switch is about the registry page that *is* mounted.
 */
const gaps = [
  ...AGENT_SETTINGS_SECTIONS.filter((section) => !MOUNTED.has(section.id)).map(
    (section) => SENTENCES[section.id] ?? t('agent.settings.agents.gaps.other'),
  ),
  t('agent.settings.agents.gaps.capabilities'),
  t('agent.settings.agents.gaps.engine'),
]
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('agent.settings.agents.section.title') }}</span>
    <p class="settings-note">
      {{ t('agent.settings.agents.section.hint') }}
    </p>
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

    <!-- The one engine/profile pair this page is about. Stated, because the pages below are about
         one record each and a user reading two of them should not have to guess which. -->
    <p
      class="settings-note"
      data-test="agents-profile"
    >
      {{ showing }}
    </p>

    <!-- The mounted pages, in one box so that "the controls this page draws itself" is a question
         with an answer: everything inside is a page's own, and the switch above is this file's. -->
    <div
      class="agents-pages"
      data-test="agents-pages"
    >
      <AgentRegistrySettings
        :client="props.clients.registry"
        :profile-id="identity?.profileId ?? ''"
        :can-start-session="false"
        :prefill="cataloguePrefill"
      />
      <AgentProviderSettings
        v-if="identity && credentialClient"
        :client="props.clients.provider"
        :credential-client="credentialClient"
        :agent-id="identity.agentId"
        :profile-id="identity.profileId"
      />
      <!-- The engine's own configuration document. Mounted with the pair like the profile page, and
           for the same reason; the page states its own three absences rather than this file
           deciding which of them applies. -->
      <AgentConfigurationSettings
        v-if="configClient"
        :client="configClient"
      />
      <!-- §8.2's page, in the tree's own order (after the configuration document, before the
           permission table). It had no mount point at all before this: `skills.rs` was complete and
           tested, the four commands behind it did not exist, and the section below carried a
           sentence saying so. That sentence is gone — the list of absences is derived, so mounting
           the page is what removed it. -->
      <AgentSkillsSettings
        v-if="skillsClient"
        :client="skillsClient"
      />
      <!-- The pair is the page's own, so it is built from the registry's answer rather than from
           anything this section decides. The grants half of it reads the running engine, which is
           why the page draws "no agent is running" as a state of its own rather than as a gap. -->
      <AgentPermissionSettings
        v-if="permissionClient"
        :client="permissionClient"
      />
      <!-- Last, and about no profile at all: what the public registry publishes. Its one control
           hands an entry to the add form above, which is why it is mounted below the registry page
           rather than beside the profile pages. -->
      <AgentCatalogueBrowser
        :client="props.clients.catalogue"
        @use="cataloguePrefill = $event"
      />
    </div>

    <span class="settings-label">{{ t('agent.settings.agents.gaps.title') }}</span>
    <p class="settings-note">
      {{ t('agent.settings.agents.gaps.intro') }}
    </p>
    <!-- Text, not disabled controls: `.agent-gap` is a list item and there is no
         `input`, `button` or `role="switch"` anywhere below. The absence is the
         acceptance — a control that only fails reads as a feature that is broken
         rather than as one that was never built. -->
    <ul class="agent-gaps">
      <li
        v-for="(gap, index) in gaps"
        :key="index"
        class="agent-gap"
      >
        {{ gap }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-label`, `.settings-toggle`, `.settings-field`
   and `.checkbox` are restated here, as every section in this dialog restates
   them: a scoped block belongs to the component that renders the element. */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
/* A divider before each page, so the mounted pages and this file's own sentences read as the two
   different things they are — the box is one element and draws nothing else. */
.agents-pages { display: flex; flex-direction: column; }
.agents-pages > :deep(.settings-section) { padding-top: 10px; border-top: 1px solid var(--app-border); }
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
