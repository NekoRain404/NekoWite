/**
 * The configuration document's copy, read from `src/i18n/namespaces/agent.ts`
 * (`agent.settings.config.*`).
 *
 * A file of its own for the reason `agent-skills-labels.ts` gives: one catalogue key per line, one
 * line per arm — a table that changes when a sentence changes, never when a behaviour does. The keys
 * stay **literals**, because `i18n.test.ts` reads `t('…')` arguments out of the source and only
 * recognises literals; a template-built key would turn a misspelled suffix into raw key text on
 * screen instead of a failing test.
 *
 * ## Why the states have sentences of their own
 *
 * §5.2's 「不可用选项要说明原因」, and the reason is that they lead a user to different next moves:
 *
 *  - {@link AgentConfigLabels.none} — this profile reads the user's own installation. There is a
 *    configuration; it is that installation's file and this app does not open it. The next move is
 *    to edit that file where it lives, or to switch the profile to app-managed.
 *  - {@link AgentConfigLabels.creates} — the document is not on disk. The form below is drawn, and
 *    this sentence is what says so and what saving it will do: it creates the engine's file, with
 *    the member the user names as its whole content. The sentence is not decoration — a save that
 *    created a file the user thought was only being changed is the surprise §5.2 is about.
 *  - {@link AgentConfigLabels.readOnly} — the file is there and this host may not write it. The next
 *    move is the same as the first arm's.
 *
 * A page that drew one sentence for all three, or a form greyed out, would be telling the user to
 * wait in the two cases where waiting is not the answer.
 */
import { t } from '../../../i18n'

export interface AgentConfigLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  /** The profile whose engine configuration belongs to the user's own installation. */
  none: string
  /** The document is not on disk, and saving a member is what creates it. */
  creates: string
  /** There is a document and this host may not write it. */
  readOnly: string
  document: {
    title: string
    /** The absolute path the backend resolved. Shown so a user can open the file themselves. */
    path: string
    exists: string
    absent: string
    text: string
    textHint: string
  }
  edit: {
    title: string
    hint: string
    member: string
    memberHint: string
    value: string
    valueHint: string
    save: string
    /** The member field is blank, so there is no member to set. */
    noMember: string
    /** What is in the value field is not a JSON value. */
    invalidValue: string
    applied: string
    /** The document is not the one this page read: reloaded, and the edit was not written. */
    conflict: string
    /** The document was not there and something else created it first: same rule, other sentence. */
    conflictCreated: string
    /** The call did not complete. The page's own sentence; the refusal's text is the backend's. */
    failed: string
  }
}

export function configLabels(): AgentConfigLabels {
  return {
    section: {
      title: t('agent.settings.config.section.title'),
      hint: t('agent.settings.config.section.hint'),
    },
    loading: t('agent.settings.config.loading'),
    unreadable: t('agent.settings.config.unreadable'),
    retry: t('agent.settings.retry'),
    none: t('agent.settings.config.none'),
    creates: t('agent.settings.config.creates'),
    readOnly: t('agent.settings.config.readOnly'),
    document: {
      title: t('agent.settings.config.document.title'),
      path: t('agent.settings.config.document.path'),
      exists: t('agent.settings.config.document.exists'),
      absent: t('agent.settings.config.document.absent'),
      text: t('agent.settings.config.document.text'),
      textHint: t('agent.settings.config.document.textHint'),
    },
    edit: {
      title: t('agent.settings.config.edit.title'),
      hint: t('agent.settings.config.edit.hint'),
      member: t('agent.settings.config.edit.member'),
      memberHint: t('agent.settings.config.edit.memberHint'),
      value: t('agent.settings.config.edit.value'),
      valueHint: t('agent.settings.config.edit.valueHint'),
      save: t('agent.settings.config.edit.save'),
      noMember: t('agent.settings.config.edit.noMember'),
      invalidValue: t('agent.settings.config.edit.invalidValue'),
      applied: t('agent.settings.config.edit.applied'),
      conflict: t('agent.settings.config.edit.conflict'),
      conflictCreated: t('agent.settings.config.edit.conflictCreated'),
      failed: t('agent.settings.config.edit.failed'),
    },
  }
}
