/**
 * The skills section's copy and the vocabulary its refusals are rendered through, both read
 * from `src/i18n/namespaces/agent.ts` (`agent.settings.skills.*`).
 *
 * This was the first half of `AgentSkillsSettings.vue`, and it is a file of its own because it is a
 * different responsibility from the page: one catalogue key per line, one line per arm — a table
 * that changes when a sentence changes, never when a behaviour does. The page imports
 * {@link skillsLabels} and re-exports the two types, so nothing that names
 * `AgentSkillsSettings.vue` has to change.
 *
 * The keys stay **literals**: `i18n.test.ts` reads `t('…')` arguments out of the source to check
 * that every key the source uses has a definition, and it only recognises literals. A key built as
 * a template literal would save a few lines and turn a misspelled suffix into a sentence that
 * renders as the raw key name on screen instead of failing a test — a guard spent for a line count.
 *
 * {@link SkillRefusalKind} is `skills.rs`'s own list, mirrored arm for arm. The `Record` is keyed by
 * it and built from the catalogue, so an arm added to the backend without a sentence here is a
 * missing key rather than a blank line — and the reason each arm has its own sentence is §8.2's
 * subject: "the importer could not finish" leaves a user with nothing to do, while "there is no file
 * at that path" and "the name in the frontmatter is not the folder's" are two different next moves.
 */
import { i18n, t } from '../../../i18n'

export type SkillRefusalKind =
  | 'relative-path'
  | 'store-inside-scope'
  | 'unknown-scope'
  | 'not-managed'
  | 'no-switch'
  | 'outside-scope'
  | 'escapes-scope'
  | 'missing'
  | 'no-manifest'
  | 'symlink'
  | 'not-a-file'
  | 'too-many-files'
  | 'file-too-large'
  | 'skill-too-large'
  | 'no-frontmatter'
  | 'unterminated-frontmatter'
  | 'frontmatter-line'
  | 'name-missing'
  | 'name-shape'
  | 'name-mismatch'
  | 'description-missing'
  | 'description-too-long'
  | 'field-control'
  | 'name-taken'
  | 'store-occupied'
  | 'same-directory'
  | 'scan-too-large'
  | 'io'

export interface AgentSkillsLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  list: {
    empty: string
    scope: string
    directory: string
    noDescription: string
  }
  owner: Record<'managed' | 'engine' | 'foreign', string>
  surface: {
    offered: string
    undescribed: string
    suppressed: string
    unusable: string
    disabled: string
  }
  /** The conflict line. It names every other directory and nominates no winner — see the component. */
  conflict: string
  /** The switch's five sentences. `actionFailed` used to sit here: never supplied (there is no
      such key in the catalogue) and never read (a failed switch renders `import.failed`), so it
      was a required member that nothing could satisfy and nothing wanted. */
  disable: {
    label: string
    enable: string
    disable: string
    noSwitch: string
    engineSwitch: string
    /** The same scope when the launch *has* set the engine's variable — see the component. */
    engineSwitchSet: string
  }
  disabledList: { title: string; hint: string }
  import: {
    title: string
    hint: string
    source: string
    preview: string
    confirm: string
    replace: string
    replaceWarning: string
    done: string
    failed: string
  }
  preview: {
    title: string
    description: string
    files: string
    scripts: string
    noScripts: string
    total: string
    nothingRun: string
  }
  refusal: Record<SkillRefusalKind, string>
}

/**
 * One catalogue sentence, with the slots it carries left as slots.
 *
 * vue-i18n renders an interpolation it was given no value for as the *empty string*, so a sentence
 * like "there is no file at {path} now" would read as finished with a hole in it: `t(key)` alone
 * gives "there is no file at  now". The slot names are therefore taken from the message **as the
 * catalogue writes it** (`tm`, which returns the raw entry rather than the rendered one), handed
 * back to vue-i18n as literal values, and substituted by the page later (`fill`) — a path, a line
 * number and the engine's own message are *data*, and data does not go through a translator.
 *
 * Reading the names out of the catalogue rather than listing them at each call site is the one place
 * this differs from T13a's page. A list would be a second copy of what each sentence contains, and
 * the copy that drifts is the one nobody re-reads after a translation changes — so a sentence whose
 * translation gained a slot would render the hole this helper exists to prevent.
 */
function template(key: string): string {
  const raw: unknown = i18n.global.tm(key)
  const sentence = typeof raw === 'string' ? raw : t(key)
  const values: Record<string, string> = {}
  for (const match of sentence.matchAll(/\{(\w+)\}/g)) values[match[1]] = match[0]
  return Object.keys(values).length === 0 ? sentence : t(key, values)
}

export function skillsLabels(): AgentSkillsLabels {
  return {
    section: {
      title: t('agent.settings.skills.section.title'),
      hint: t('agent.settings.skills.section.hint'),
    },
    loading: t('agent.settings.skills.loading'),
    unreadable: t('agent.settings.skills.unreadable'),
    retry: t('agent.settings.retry'),
    list: {
      empty: t('agent.settings.skills.list.empty'),
      scope: t('agent.settings.skills.list.scope'),
      directory: t('agent.settings.skills.list.directory'),
      noDescription: t('agent.settings.skills.list.noDescription'),
    },
    owner: {
      managed: t('agent.settings.skills.owner.managed'),
      engine: t('agent.settings.skills.owner.engine'),
      foreign: t('agent.settings.skills.owner.foreign'),
    },
    surface: {
      offered: t('agent.settings.skills.surface.offered'),
      undescribed: t('agent.settings.skills.surface.undescribed'),
      suppressed: template('agent.settings.skills.surface.suppressed'),
      unusable: template('agent.settings.skills.surface.unusable'),
      disabled: t('agent.settings.skills.surface.disabled'),
    },
    conflict: template('agent.settings.skills.conflict'),
    disable: {
      label: t('agent.settings.skills.disable.label'),
      enable: t('agent.settings.skills.disable.enable'),
      disable: t('agent.settings.skills.disable.disable'),
      noSwitch: t('agent.settings.skills.disable.noSwitch'),
      engineSwitch: template('agent.settings.skills.disable.engineSwitch'),
      engineSwitchSet: template('agent.settings.skills.disable.engineSwitchSet'),
    },
    disabledList: {
      title: t('agent.settings.skills.disabledList.title'),
      hint: t('agent.settings.skills.disabledList.hint'),
    },
    import: {
      title: t('agent.settings.skills.import.title'),
      hint: t('agent.settings.skills.import.hint'),
      source: t('agent.settings.skills.import.source'),
      preview: t('agent.settings.skills.import.preview'),
      confirm: t('agent.settings.skills.import.confirm'),
      replace: t('agent.settings.skills.import.replace'),
      replaceWarning: t('agent.settings.skills.import.replaceWarning'),
      done: template('agent.settings.skills.import.done'),
      failed: t('agent.settings.skills.import.failed'),
    },
    preview: {
      title: t('agent.settings.skills.preview.title'),
      description: t('agent.settings.skills.preview.description'),
      files: t('agent.settings.skills.preview.files'),
      scripts: t('agent.settings.skills.preview.scripts'),
      noScripts: t('agent.settings.skills.preview.noScripts'),
      total: t('agent.settings.skills.preview.total'),
      nothingRun: t('agent.settings.skills.preview.nothingRun'),
    },
    refusal: {
      'relative-path': template('agent.settings.skills.refusal.relative-path'),
      'store-inside-scope': template('agent.settings.skills.refusal.store-inside-scope'),
      'unknown-scope': template('agent.settings.skills.refusal.unknown-scope'),
      'not-managed': template('agent.settings.skills.refusal.not-managed'),
      'no-switch': template('agent.settings.skills.refusal.no-switch'),
      'outside-scope': template('agent.settings.skills.refusal.outside-scope'),
      'escapes-scope': template('agent.settings.skills.refusal.escapes-scope'),
      missing: template('agent.settings.skills.refusal.missing'),
      'no-manifest': template('agent.settings.skills.refusal.no-manifest'),
      symlink: template('agent.settings.skills.refusal.symlink'),
      'not-a-file': template('agent.settings.skills.refusal.not-a-file'),
      'too-many-files': template('agent.settings.skills.refusal.too-many-files'),
      'file-too-large': template('agent.settings.skills.refusal.file-too-large'),
      'skill-too-large': template('agent.settings.skills.refusal.skill-too-large'),
      'no-frontmatter': template('agent.settings.skills.refusal.no-frontmatter'),
      'unterminated-frontmatter': template('agent.settings.skills.refusal.unterminated-frontmatter'),
      'frontmatter-line': template('agent.settings.skills.refusal.frontmatter-line'),
      'name-missing': template('agent.settings.skills.refusal.name-missing'),
      'name-shape': template('agent.settings.skills.refusal.name-shape'),
      'name-mismatch': template('agent.settings.skills.refusal.name-mismatch'),
      'description-missing': template('agent.settings.skills.refusal.description-missing'),
      'description-too-long': template('agent.settings.skills.refusal.description-too-long'),
      'field-control': template('agent.settings.skills.refusal.field-control'),
      'name-taken': template('agent.settings.skills.refusal.name-taken'),
      'store-occupied': template('agent.settings.skills.refusal.store-occupied'),
      'same-directory': template('agent.settings.skills.refusal.same-directory'),
      'scan-too-large': template('agent.settings.skills.refusal.scan-too-large'),
      io: template('agent.settings.skills.refusal.io'),
    },
  }
}
