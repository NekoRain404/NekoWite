/**
 * The registry section's copy, read from `src/i18n/namespaces/agent.ts` (`agent.registry.*`).
 *
 * This was the first half of `AgentRegistrySettings.vue`, and it is a file of its own for the reason
 * the skills page's copy is: it is a different responsibility from the page — one catalogue key per
 * line, one line per arm — and a table that changes when a sentence changes, never when a behaviour
 * does. The page imports {@link registryLabels} and re-exports {@link AgentRegistryLabels}, so
 * nothing that names `AgentRegistrySettings.vue` has to change.
 *
 * The keys stay **literals**: `i18n.test.ts` reads `t('…')` arguments out of the source to check
 * that every key the source uses has a definition, and it only recognises literals. A key built from
 * a variable would save a few lines and turn a misspelled suffix into a sentence that renders as the
 * raw key name on screen instead of failing a test — a guard spent for a line count.
 *
 * Two shapes here are load-bearing rather than decorative. `refusal` is keyed by the backend's own
 * refusal kinds, so an arm added to `agent-registry-policy.ts` without a sentence in the catalogue
 * is a typecheck failure rather than a row that says nothing. `program` is absent from it on
 * purpose: a program problem is one of the five `programState` sentences, shared with the state line
 * every row already draws — one answer per state, not two that could drift apart.
 */
import { t } from '../../../i18n'
import type { InstallSource, ProgramState, RegistryRefusalKind, UpdatePolicy } from '../services/agent-registry-policy'

export type RefusalTextKey = Exclude<RegistryRefusalKind, 'program'>

export interface AgentRegistryLabels {
  section: { title: string; hint: string }
  list: { loading: string; unreadable: string; retry: string; empty: string; adapter: string; version: string; versionUnknown: string }
  provenance: Record<InstallSource, string>
  /** What being registered does and does not mean, per provenance. Drawn on every row, whatever
   *  its state is and whatever an add just did — the row's markup says where. */
  standing: Record<InstallSource, string>
  update: Record<UpdatePolicy, string>
  programState: Record<ProgramState, string>
  control: { enable: string; disable: string }
  fields: { agentId: string; displayName: string; program: string; args: string; argsHint: string; adapter: string }
  add: { title: string; submit: string; added: string }
  action: { failed: string }
  /** The owner slot of a `profile-unbound` refusal when the backend names none. */
  ownerUnknown: string
  refusal: Record<RefusalTextKey, string>
  engine: { title: string; current: string; none: string; choose: string; creates: string; keeps: string; start: string; elsewhere: string }
}

/**
 * One catalogue message, with the slots it carries kept as slots.
 *
 * vue-i18n renders an interpolation it was given no value for as the *empty string*, so a sentence
 * like "there is no file at {path} now" would read as finished with a hole in it. The slot names are
 * therefore passed back to it as literal values, and the page fills them later (`fillTemplate` in
 * `agent-registry-policy.ts`, where the substitution is tested) — deliberately: a path, an
 * argument's index and an engine's own message are *data*, and data does not go through a
 * translator.
 */
function template(key: string, ...slots: string[]): string {
  const values: Record<string, string> = {}
  for (const slot of slots) values[slot] = `{${slot}}`
  return t(key, values)
}

/** The catalogue, read into the labels tree. */
export function registryLabels(): AgentRegistryLabels {
  return {
    section: { title: t('agent.registry.section.title'), hint: t('agent.registry.section.hint') },
    list: {
      loading: t('agent.registry.list.loading'), unreadable: t('agent.registry.list.unreadable'),
      retry: t('agent.registry.list.retry'), empty: t('agent.registry.list.empty'), adapter: t('agent.registry.list.adapter'),
      version: template('agent.registry.list.version', 'version'), versionUnknown: t('agent.registry.list.versionUnknown'),
    },
    provenance: { bundled: t('agent.registry.provenance.bundled'), managed: t('agent.registry.provenance.managed'), external: t('agent.registry.provenance.external') },
    standing: { bundled: t('agent.registry.standing.bundled'), managed: t('agent.registry.standing.managed'), external: t('agent.registry.standing.external') },
    update: { 'host-managed': t('agent.registry.update.hostManaged'), 'reported-only': t('agent.registry.update.reportedOnly') },
    programState: {
      launchable: template('agent.registry.programState.launchable', 'path'),
      'not-absolute': template('agent.registry.programState.notAbsolute', 'path'),
      missing: template('agent.registry.programState.missing', 'path'),
      'not-a-file': template('agent.registry.programState.notAFile', 'path'),
      'not-executable': template('agent.registry.programState.notExecutable', 'path'),
    },
    control: { enable: t('agent.registry.control.enable'), disable: t('agent.registry.control.disable') },
    fields: {
      agentId: t('agent.registry.fields.agentId'), displayName: t('agent.registry.fields.displayName'),
      program: t('agent.registry.fields.program'), args: t('agent.registry.fields.args'),
      argsHint: t('agent.registry.fields.argsHint'), adapter: t('agent.registry.fields.adapter'),
    },
    add: { title: t('agent.registry.add.title'), submit: t('agent.registry.add.submit'), added: template('agent.registry.add.added', 'agentId') },
    action: { failed: t('agent.registry.action.failed') },
    ownerUnknown: t('agent.registry.ownerUnknown'),
    refusal: {
      id: template('agent.registry.refusal.id', 'value'), argument: template('agent.registry.refusal.argument', 'index'),
      environment: template('agent.registry.refusal.environment', 'name'), disabled: template('agent.registry.refusal.disabled', 'agentId'),
      'unknown-adapter': template('agent.registry.refusal.unknownAdapter', 'adapterId'), 'duplicate-agent': template('agent.registry.refusal.duplicateAgent', 'agentId'),
      'unknown-agent': template('agent.registry.refusal.unknownAgent', 'agentId'), 'profile-unbound': template('agent.registry.refusal.profileUnbound', 'profileId', 'owner'),
      'already-running': template('agent.registry.refusal.alreadyRunning', 'agentId'), 'instance-running': template('agent.registry.refusal.instanceRunning', 'agentId'),
      'is-default': template('agent.registry.refusal.isDefault', 'agentId'), 'launch-failed': template('agent.registry.refusal.launchFailed', 'code', 'message'),
    },
    engine: {
      title: t('agent.registry.engine.title'), none: t('agent.registry.engine.none'),
      choose: t('agent.registry.engine.choose'), current: template('agent.registry.engine.current', 'engine'),
      creates: template('agent.registry.engine.creates', 'engine'), keeps: template('agent.registry.engine.keeps', 'engine'),
      start: template('agent.registry.engine.start', 'engine'), elsewhere: t('agent.registry.engine.elsewhere'),
    },
  }
}
