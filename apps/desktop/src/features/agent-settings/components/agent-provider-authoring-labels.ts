/**
 * The provider form's copy, read from `src/i18n/namespaces/agent.ts` (`agent.settings.config.provider.*`).
 *
 * A file of its own for the reason `agent-skills-labels.ts` gives: one catalogue key per line, one
 * line per arm — a table that changes when a sentence changes and never when a behaviour does. The
 * keys stay **literals**, because `i18n.test.ts` reads `t('…')` arguments out of the source and only
 * recognises literals; a template-built key would turn a misspelled suffix into raw key text on screen
 * instead of a failing test.
 *
 * It sits beside `agent-config-labels.ts` rather than inside it because it is a different subject one
 * level in: that file's sentences are about the document and the one-member editor over it, and this
 * one's are about a form that writes a *block* out of fields. Three of the sentences below are the
 * ones §5.2 asks for, and each names a different next move rather than a shared failure:
 *
 *  - {@link AgentProviderAuthoringLabels.fetchNeedsKey} — the fetch cannot run without a key, and the
 *    reason is not "a field is empty": with the field empty the command would send the key this app
 *    has stored for its own AI, and the list would be about a credential the engine never uses.
 *  - {@link AgentProviderAuthoringLabels.fetchFailed} — the fetch reaches somebody else's server, so
 *    its failure is theirs and is reported rather than smoothed into a sentence about this page.
 *  - {@link AgentProviderAuthoringLabels.keyBlank} — what saving without a key actually does, stated
 *    before the save rather than discovered at the first request.
 *
 * `{n}` in `fetched` and `{name}`/`{id}`/`{reason}` elsewhere are values, not copy: a count, the
 * derived credential name, the provider id and the backend's own sentence all stay exactly as they
 * are, because they are facts about the user's setup rather than words this app chose.
 */
import { t } from '../../../i18n'

export interface AgentProviderAuthoringLabels {
  title: string
  hint: string
  id: string
  /** The derived credential variable, shown so the user can see where the key will live. */
  idHint: (credentialName: string) => string
  name: string
  nameHint: string
  baseUrl: string
  baseUrlHint: string
  key: string
  keyHint: string
  /** Saving with an empty key field: what the block then says. */
  keyBlank: string
  allowPrivate: string
  allowPrivateHint: string
  fetch: string
  fetching: string
  /** How many ids the endpoint listed. */
  fetched: (count: number) => string
  fetchNeedsKey: string
  fetchFailed: string
  models: string
  modelsEmpty: string
  modelHint: string
  manual: string
  manualAdd: string
  preview: string
  /** The path the block goes to, so the sentence names the member that is about to appear. */
  previewHint: (id: string) => string
  save: string
  /** What a save does to a provider of the same id that is already in the file. */
  replaces: string
  /**
   * The values are arguments rather than concatenated text, and they go through the catalogue's own
   * interpolation: every one of them is a fact about the user's setup (a count, a derived name, the
   * backend's sentence) that must survive translation intact, and a `{placeholder}` a translator can
   * see is a placeholder they can place.
   */
  problem: (reason: string) => string
  credentialFailed: (reason: string) => string
  editFailed: (reason: string) => string
  applied: string
  conflict: string
  conflictCreated: string
}

export function providerAuthoringLabels(): AgentProviderAuthoringLabels {
  return {
    title: t('agent.settings.config.provider.title'),
    hint: t('agent.settings.config.provider.hint'),
    id: t('agent.settings.config.provider.id'),
    idHint: (credentialName) =>
      t('agent.settings.config.provider.idHint', { name: credentialName }),
    name: t('agent.settings.config.provider.name'),
    nameHint: t('agent.settings.config.provider.nameHint'),
    baseUrl: t('agent.settings.config.provider.baseUrl'),
    baseUrlHint: t('agent.settings.config.provider.baseUrlHint'),
    key: t('agent.settings.config.provider.key'),
    keyHint: t('agent.settings.config.provider.keyHint'),
    keyBlank: t('agent.settings.config.provider.keyBlank'),
    allowPrivate: t('agent.settings.config.provider.allowPrivate'),
    allowPrivateHint: t('agent.settings.config.provider.allowPrivateHint'),
    fetch: t('agent.settings.config.provider.fetch'),
    fetching: t('agent.settings.config.provider.fetching'),
    fetched: (count) => t('agent.settings.config.provider.fetched', { n: count }),
    fetchNeedsKey: t('agent.settings.config.provider.fetchNeedsKey'),
    fetchFailed: t('agent.settings.config.provider.fetchFailed'),
    models: t('agent.settings.config.provider.models'),
    modelsEmpty: t('agent.settings.config.provider.modelsEmpty'),
    modelHint: t('agent.settings.config.provider.modelHint'),
    manual: t('agent.settings.config.provider.manual'),
    manualAdd: t('agent.settings.config.provider.manualAdd'),
    preview: t('agent.settings.config.provider.preview'),
    previewHint: (id) => t('agent.settings.config.provider.previewHint', { id }),
    save: t('agent.settings.config.provider.save'),
    replaces: t('agent.settings.config.provider.replaces'),
    problem: (reason) => t('agent.settings.config.provider.problem', { reason }),
    credentialFailed: (reason) =>
      t('agent.settings.config.provider.credentialFailed', { reason }),
    editFailed: (reason) => t('agent.settings.config.provider.editFailed', { reason }),
    applied: t('agent.settings.config.provider.applied'),
    conflict: t('agent.settings.config.provider.conflict'),
    conflictCreated: t('agent.settings.config.provider.conflictCreated'),
  }
}
