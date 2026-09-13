import { computed, type ComputedRef, type WritableComputedRef } from 'vue'
import type { AiAuditEvent, AiAuditOutcome } from '../../../services/aiAudit'
import type { AiWriteKind, AiWriteSource } from '../../../services/aiPermissions'
import { AI_WRITE_POLICIES, describePolicy } from '../../../services/aiPermissions'
import type { AiWritePolicy } from '../../../services/aiPermissions'
import { useAiPermissionStore } from '../../../stores/aiPermission'

export interface AiPermissionSettingsModel {
  enabled: WritableComputedRef<boolean>
  policy: WritableComputedRef<AiWritePolicy>
  writePolicies: { value: AiWritePolicy; labelKey: string }[]
  /** The newest entries first, capped at the number of rows the panel shows. */
  recentAiAudit: ComputedRef<AiAuditEvent[]>
  auditSummary: ComputedRef<Record<AiAuditOutcome, number>>
  /** The session's grants, as the set itself: the template reads its size and
   *  joins it, and a copy would only be a second thing to keep in step. */
  sessionGrants: ComputedRef<ReadonlySet<string>>
  revokeGrants: () => void
  forgetAudit: () => void
  clockTime: (at: number) => string
}

/** How many entries the panel shows. The log keeps more than this (see
 *  services/aiAudit); the panel is a window onto it, not the whole file. */
const AUDIT_ROWS = 8

/** Literal i18n keys per audit field. A table, not concatenation: the i18n
 *  parity test scans the source for real key literals, so a dynamically built
 *  key is a key nobody checks. */
export const AUDIT_OUTCOME_KEYS: Record<AiAuditOutcome, string> = {
  asked: 'aiperm.audit.outcome.asked',
  allowed: 'aiperm.audit.outcome.allowed',
  denied: 'aiperm.audit.outcome.denied',
  blocked: 'aiperm.audit.outcome.blocked',
  granted: 'aiperm.audit.outcome.granted',
}
export const AUDIT_SOURCE_KEYS: Record<AiWriteSource, string> = {
  ghost: 'aiperm.audit.source.ghost',
  chat: 'aiperm.audit.source.chat',
  edit: 'aiperm.audit.source.edit',
  dialog: 'aiperm.audit.source.dialog',
  plugin: 'aiperm.audit.source.plugin',
}
export const AUDIT_KIND_KEYS: Record<AiWriteKind, string> = {
  insert: 'aiperm.audit.kind.insert',
  'replace-selection': 'aiperm.audit.kind.replace-selection',
  'replace-document': 'aiperm.audit.kind.replace-document',
}

/**
 * The AI write permission and its audit trail: what the app may let a model
 * change, and the record of what it actually did.
 *
 * The wording of the policies comes from `describePolicy` in the permission
 * service, so this maps values to keys and the text stays in i18n.
 */
export function useAiPermissionSettings(): AiPermissionSettingsModel {
  const aiPermission = useAiPermissionStore()

  /**
   * The AI write policies, in the order they are offered. `describePolicy` in the
   * permission service owns the key mapping, so the wording only lives in i18n.
   */
  const writePolicies: { value: AiWritePolicy; labelKey: string }[] = AI_WRITE_POLICIES.map(
    (value) => ({ value, labelKey: describePolicy(value) }),
  )

  /** The newest entries first: the question this list answers is "what just
   *  happened", so the most recent line has to be the one at the top. */
  const recentAiAudit = computed(() => [...aiPermission.auditLog].reverse().slice(0, AUDIT_ROWS))

  /** Wall-clock time only: these rows are all from today in practice, and a date
   *  on every line would crowd out the part that matters. */
  function clockTime(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return {
    enabled: computed({
      get: () => aiPermission.enabled,
      set: (on) => { aiPermission.setEnabled(on) },
    }),
    policy: computed({
      get: () => aiPermission.policy,
      set: (p) => { aiPermission.setPolicy(p) },
    }),
    writePolicies,
    recentAiAudit,
    auditSummary: computed(() => aiPermission.auditSummary),
    sessionGrants: computed(() => aiPermission.sessionGrants),
    revokeGrants: () => aiPermission.forgetGrants(),
    forgetAudit: () => aiPermission.forgetAudit(),
    clockTime,
  }
}
