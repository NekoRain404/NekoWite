/**
 * The provider section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * The sentences are in `src/i18n/namespaces/agent.ts` (`agent.settings.provider.*`), beside the panel's
 * and the registry page's — a translated build is a catalogue edit rather than a second place to
 * look. What stays here is the *shape* (the keys a caller may replace through the `labels` prop) and
 * the builder that reads the catalogue into it, because a page that reached for `t()` at every use
 * site could not be given a different set of sentences at all.
 *
 * The facts are *not* in here — a path, an environment variable and the engine's own words are
 * data, and data does not go through a translator.
 *
 * {@link AgentProviderLabels.changes} is keyed by `ModeChange`, so a change added to the policy
 * without a sentence here is a missing key rather than a line that goes blank.
 */
import { t } from '../../../i18n'
import type { DiscoverySurface, ModeChange } from '../services/agent-settings-policy'

export interface AgentProviderLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  identity: { agent: string; profile: string }
  /** Shown when the readout is not the pair this page believes it is showing. */
  mismatch: string
  mode: { label: string; appManaged: string; userConfig: string; readOnly: string }
  fields: { provider: string; modelId: string; empty: string }
  action: { save: string; applied: string; failed: string; unsaved: string }
  switchPlan: { title: string; movesNothing: string }
  changes: Record<ModeChange, string>
  sources: {
    title: string
    hint: string
    injected: string
    engineDiscovery: string
    /** One sentence per merge the engine makes and this app does not set, keyed by the backend's
        own surface id — so a merge the backend adds without copy here is a missing key. */
    discovery: Record<DiscoverySurface, string>
  }
  credentials: {
    title: string
    hint: string
    none: string
    hostFile: string
    notEncrypted: string
    placeholder: string
    /** The write form's own sentences — `AgentCredentialSettings.vue`'s `labels` prop. */
    form: {
      editHint: string
      save: string
      saved: string
      failed: string
    }
  }
}
export function providerLabels(): AgentProviderLabels {
  return {
    section: {
      title: t('agent.settings.provider.section.title'),
      hint: t('agent.settings.provider.section.hint'),
    },
    loading: t('agent.settings.provider.loading'),
    unreadable: t('agent.settings.provider.unreadable'),
    retry: t('agent.settings.retry'),
    identity: {
      agent: t('agent.settings.provider.identity.agent'),
      profile: t('agent.settings.provider.identity.profile'),
    },
    mismatch: t('agent.settings.provider.mismatch'),
    mode: {
      label: t('agent.settings.provider.mode.label'),
      appManaged: t('agent.settings.provider.mode.appManaged'),
      userConfig: t('agent.settings.provider.mode.userConfig'),
      readOnly: t('agent.settings.provider.mode.readOnly'),
    },
    fields: {
      provider: t('agent.settings.provider.fields.provider'),
      modelId: t('agent.settings.provider.fields.modelId'),
      empty: t('agent.settings.provider.fields.empty'),
    },
    action: {
      save: t('agent.settings.provider.action.save'),
      applied: t('agent.settings.provider.action.applied'),
      failed: t('agent.settings.provider.action.failed'),
      unsaved: t('agent.settings.provider.action.unsaved'),
    },
    switchPlan: {
      title: t('agent.settings.provider.switchPlan.title'),
      movesNothing: t('agent.settings.provider.switchPlan.movesNothing'),
    },
    changes: {
      'roots-are-injected': t('agent.settings.provider.changes.roots-are-injected'),
      'roots-are-the-users': t('agent.settings.provider.changes.roots-are-the-users'),
      'host-starts-writing': t('agent.settings.provider.changes.host-starts-writing'),
      'host-stops-writing': t('agent.settings.provider.changes.host-stops-writing'),
      'credentials-move-to-the-engine': t('agent.settings.provider.changes.credentials-move-to-the-engine'),
    },
    sources: {
      title: t('agent.settings.provider.sources.title'),
      hint: t('agent.settings.provider.sources.hint'),
      injected: t('agent.settings.provider.sources.injected'),
      engineDiscovery: t('agent.settings.provider.sources.engineDiscovery'),
      // Literal keys, one per arm: `i18n.test.ts` reads `t('…')` out of the source, and a key built
      // from a variable would render as the raw key rather than fail a test.
      discovery: {
        reused: t('agent.settings.provider.sources.discovery.reused'),
        project: t('agent.settings.provider.sources.discovery.project'),
        managed: t('agent.settings.provider.sources.discovery.managed'),
      },
    },
    credentials: {
      title: t('agent.settings.provider.credentials.title'),
      hint: t('agent.settings.provider.credentials.hint'),
      none: t('agent.settings.provider.credentials.none'),
      hostFile: t('agent.settings.provider.credentials.hostFile'),
      notEncrypted: t('agent.settings.provider.credentials.notEncrypted'),
      placeholder: t('agent.settings.provider.credentials.placeholder'),
      form: {
        editHint: t('agent.settings.provider.credentials.form.editHint'),
        save: t('agent.settings.provider.credentials.form.save'),
        saved: t('agent.settings.provider.credentials.form.saved'),
        failed: t('agent.settings.provider.credentials.form.failed'),
      },
    },
  }
}
