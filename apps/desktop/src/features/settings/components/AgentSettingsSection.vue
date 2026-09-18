<script setup lang="ts">
/**
 * The agents section: the one control that reaches the shell, the seven pages whose host half this
 * build really has, and the statements for everything in this tree that is still absent.
 *
 * ## What is mounted, and why these seven
 *
 * §10.2's T16 row and §8 give an agent settings tree of pages, each delivered as a component that
 * takes its facts from an injected client. Seven of those clients can be built against commands this
 * build registers — the registry (`agent_registry_read` / `_add` / `_set_enabled`), the profile
 * (`agent_profile_read` / `_write`), the permission pair (`agent_permission_grants` / `_revoke`),
 * the engine's own configuration (`agent_config_document` / `agent_config_edit`), the ACP catalogue
 * (`agent_catalogue_read`), the skills page (`agent_skills_read` / `_preview` / `_import` /
 * `_set_enabled`) and the runtime (`agent_runtime_read`) — so those seven pages are mounted here and
 * really read the backend. The clients
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
import { computed, onMounted, ref, watch } from 'vue'
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
import type { EngineIdentity } from '../../agent-settings/services/agent-registry-policy'
// Named by file rather than through the barrel: the catalogue's prefill is the *component's* own
// vocabulary (`index.ts` exports the sections' components and their label types, and a fifth type
// there would be a name with one caller). The specifier is the component the type belongs to.
import type { CataloguePrefill } from '../../agent-settings/components/AgentCatalogueBrowser.vue'
import type { AgentSettingsClients } from '../../../app/agent-settings-composition'
import type { AgentPageId } from '../types'
import { useAgentPanel } from '../composables/use-agent-panel'
import AgentSettingsNavigation from './AgentSettingsNavigation.vue'

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
 * The provider form's client — the model fetch and the credential write — behind the same gate and
 * for the credential client's own reason one step further in: this one *writes a key* into one
 * profile's credential file, and reads a model list for an address typed on that profile's page. A
 * client built for a guessed pair would be a credential put where the user is not looking.
 */
const authoringClient = computed(() =>
  identity.value === null
    ? null
    : props.clients.providerAuthoring(identity.value.agentId, identity.value.profileId),
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
 * The catalogue's one control: hand the entry to the registry's add form, and open the page it
 * lands on.
 *
 * The second half is not a convenience. The add form is on the registry page, so a click that only
 * filled it would write into a form the user cannot see — 建好了但够不到 in its exact shape, this
 * repository's signature failure. A control whose whole effect is invisible is worse than no
 * control, so the click also goes where its effect is.
 */
function onCatalogueUse(entry: CataloguePrefill): void {
  cataloguePrefill.value = entry
  active.value = landing('registry')
}

/**
 * Each gated page's whole input, in one object, or `null` while its gate is unmet.
 *
 * This is what keeps the rail's row and the page it opens from becoming two conditions. The row is
 * drawn for a page exactly when its model is not `null` and the page is rendered from the same
 * model, so there is one expression per gate and neither half can drift into offering a row that
 * leads nowhere or a page with no way back to it. It also removes the non-null assertions the
 * bindings would otherwise need: the model is narrowed by the `v-if`, exactly as
 * `DesktopPetSettings.vue` narrows its `context`, rather than the props being asserted non-null
 * where the guard happens to be true today.
 */
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

/**
 * Which of the seven pages are here at all, which is the rail's membership test.
 *
 * Its keys are also what tells the tree which sections are *mounted*: a section of
 * `AGENT_SETTINGS_SECTIONS` whose id is not here is one this build has no client for, and it is
 * stated as a sentence rather than drawn as a row (see {@link gaps}). That used to be a second
 * list — a `MOUNTED` set beside this one — and two lists of one fact is one list too many.
 */
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

/**
 * The rail's rows, in the order the tree declares them.
 *
 * The order comes from {@link AGENT_SETTINGS_SECTIONS} — the barrel says that is what the list is
 * for ("the order a navigation should offer it") and until this rail existed nothing read it for
 * that, which is why the seven pages were stacked in an order of their own. The *membership* comes
 * from {@link mountable}, so a page whose client cannot be built is not offered.
 */
const available = computed<AgentPageId[]>(() =>
  AGENT_SETTINGS_SECTIONS.map((section) => section.id)
    .filter((id): id is AgentPageId => Object.hasOwn(mountable.value, id))
    .filter((id) => mountable.value[id]),
)

/**
 * The page on screen, and the rule for a page that stops being available under it.
 *
 * The registry read resolves *after* the first frame, so the four pages behind the pair arrive a
 * tick into the section's life — and the answer to "where does a request to open a page this build
 * cannot show land" has to be a page that exists, not a blank content area. That is the same rule,
 * and the same fallback, `DesktopPetSettings.vue` follows for the pet's pages; it is repeated here
 * rather than shared because the two containers' page vocabularies have nothing in common but the
 * shape of the question.
 */
const active = ref<AgentPageId>('runtime')
function landing(id: AgentPageId): AgentPageId {
  if (mountable.value[id] && available.value.includes(id)) return id
  return available.value[0] ?? 'runtime'
}
watch(mountable, () => { active.value = landing(active.value) }, { immediate: true })


/**
 * One sentence per section that is not mounted, keyed by the list's own ids.
 *
 * Keys are resolved by literal `t()` calls and never built from a variable: a key the source
 * constructs cannot be seen missing from the catalogue by the i18n guard, so a rename would reach
 * the page as an id printed where a sentence belongs. The record has no entry for a mounted
 * section, and the row for an unlisted one falls back to `gaps.other` rather than vanishing.
 */
const SENTENCES: Readonly<Record<string, string>> = {
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
 * The last row is not a section: the engine switch is about the registry page that *is* mounted.
 * The capability row was here too, and it is gone for the same reason the runtime's sentence is —
 * the join it described as belonging to one running session is what the runtime page now draws.
 */
const gaps = computed(() => [
  ...AGENT_SETTINGS_SECTIONS.filter((section) => !Object.hasOwn(mountable.value, section.id)).map(
    (section) => SENTENCES[section.id] ?? t('agent.settings.agents.gaps.other'),
  ),
  t('agent.settings.agents.gaps.engine'),
])
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

    <!-- The rail, and the reason this section has the shape it does.
         The seven pages used to be stacked in one column: measured in Chromium at the 1280x800
         window this programme's numbers are taken at, that column was 2131px inside a 467px
         viewport — 4.6 screens of scrolling through seven unrelated pages, with nothing on screen
         saying how many there were or which one you were in. The tree's own list
         (`AGENT_SETTINGS_SECTIONS`) declares nine sections "in the order a navigation should offer
         it" and nothing read it for that, which is the shape of a navigation that was specified and
         never built. This is it built.
         A row exists exactly when its page does — `available` is `mountable`'s membership — so
         nothing here leads nowhere, and the sections this build has no client for are still
         *stated* below rather than drawn as rows. -->
    <AgentSettingsNavigation
      :pages="available"
      :active="active"
      @update:active="active = $event"
    />

    <!-- The mounted pages, in one box so that "the controls this page draws itself" is a question
         with an answer: everything inside is a page's own, and the switch above is this file's.
         One page is on screen at a time, and the others are `v-show`-hidden rather than unmounted —
         see this file's header for why that is the load-bearing half of the rail. The order is
         the tree's own, the same list the rail above is built from. -->
    <div
      class="agents-pages"
      data-test="agents-pages"
    >
      <!-- §3.1.4's page, and the one this section mounted last. It takes no pair and sits behind no
           gate, because its subject is not a profile: it reads the engine this app starts — the
           registry's own default, which is the engine a new session uses — and the runtime instance
           the app has running. That is why it is mounted above the identity sentence's consumers
           rather than below them, and why it is the one page here that answers a *live* fact: the
           negotiated protocol version, the engine's own name for itself, the authentication it
           advertises, and the eleven capability rows, all read off the incarnation's handshake. -->
      <AgentRuntimeSettings
        v-show="active === 'runtime'"
        :data-page="'runtime'"
        :client="props.clients.runtime"
      />
      <AgentProviderSettings
        v-if="providerPage"
        v-show="active === 'provider'"
        :data-page="'provider'"
        :client="providerPage.client"
        :credential-client="providerPage.credentialClient"
        :agent-id="providerPage.agentId"
        :profile-id="providerPage.profileId"
      />
      <!-- The engine's own configuration document. Mounted with the pair like the profile page, and
           for the same reason; the page states its own three absences rather than this file
           deciding which of them applies. -->
      <AgentConfigurationSettings
        v-if="configurationPage"
        v-show="active === 'configuration'"
        :data-page="'configuration'"
        :client="configurationPage.client"
        :authoring="configurationPage.authoring"
      />
      <!-- §8.2's page, in the tree's own order (after the configuration document, before the
           permission table). It had no mount point at all before this: `skills.rs` was complete and
           tested, the four commands behind it did not exist, and the section below carried a
           sentence saying so. That sentence is gone — the list of absences is derived, so mounting
           the page is what removed it. -->
      <AgentSkillsSettings
        v-if="skillsPage"
        v-show="active === 'skills'"
        :data-page="'skills'"
        :client="skillsPage.client"
      />
      <!-- The pair is the page's own, so it is built from the registry's answer rather than from
           anything this section decides. The grants half of it reads the running engine, which is
           why the page draws "no agent is running" as a state of its own rather than as a gap. -->
      <AgentPermissionSettings
        v-if="permissionPage"
        v-show="active === 'permission'"
        :data-page="'permission'"
        :client="permissionPage.client"
      />
      <AgentRegistrySettings
        v-show="active === 'registry'"
        :data-page="'registry'"
        :client="props.clients.registry"
        :profile-id="identity?.profileId ?? ''"
        :can-start-session="false"
        :prefill="cataloguePrefill"
      />
      <!-- Last, and about no profile at all: what the public registry publishes. Its one control
           hands an entry to the add form above, which is why it is mounted below the registry page
           rather than beside the profile pages — and why the hand-off *opens* that page: a click
           that filled a form behind a hidden tab would be this repository's signature failure with
           a new costume. -->
      <AgentCatalogueBrowser
        v-show="active === 'catalogue'"
        :data-page="'catalogue'"
        :client="props.clients.catalogue"
        @use="onCatalogueUse"
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
.agents-pages { display: flex; flex-direction: column; }
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
