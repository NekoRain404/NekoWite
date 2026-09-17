/**
 * The catalogue section's copy, read from `src/i18n/namespaces/agent.ts` (`agent.catalogue.*`).
 *
 * A file of its own for the reason `agent-registry-labels.ts` is: one catalogue key per line, one
 * line per arm, and a table that changes when a sentence changes rather than when a behaviour does.
 *
 * The keys stay **literals** — `i18n.test.ts` reads `t('…')` arguments out of the source to check
 * that every key the source uses has a definition, and it only recognises literals. A key built
 * from a variable would turn a misspelled suffix into a sentence that renders as the raw key name.
 *
 * Every standing and every freshness value has a sentence, and the record types below make a missing
 * one a typecheck failure rather than a row that says nothing — the same guard
 * `AgentRegistryLabels.provenance` uses one file over.
 */
import { t } from '../../../i18n'
import type { CatalogueFreshness, CatalogueStanding } from '../services/agent-catalogue-policy'

/** The standing kinds, as a record rather than a union, so a new arm must be given a sentence. */
export type StandingKind = CatalogueStanding['kind']

export interface AgentCatalogueLabels {
  section: { title: string; hint: string }
  list: { loading: string; unreadable: string; retry: string; empty: string; version: string }
  freshness: Record<CatalogueFreshness, string>
  standing: Record<StandingKind, string>
  /** What the registry never says, whatever a row's standing is. */
  unverified: string
  gates: { title: string; hint: string }
  action: { use: string; used: string }
  defects: { title: string }
  license: string
  licenseLink: string
  repository: string
  website: string
}

/**
 * One catalogue message, with the slots it carries kept as slots.
 *
 * vue-i18n renders an interpolation it was given no value for as the *empty string*, so a sentence
 * like "published for {published} only" would read as finished with a hole in it. The slot names go
 * back to it as literal values and the page fills them later — the same rule
 * `agent-registry-labels.ts` follows, and for the same reason: a platform name, a package manager
 * and a command are *data*, and data does not go through a translator.
 */
function template(key: string, ...slots: string[]): string {
  const values: Record<string, string> = {}
  for (const slot of slots) values[slot] = `{${slot}}`
  return t(key, values)
}

/** The catalogue copy, read into the labels tree. */
export function catalogueLabels(): AgentCatalogueLabels {
  return {
    section: {
      title: t('agent.catalogue.section.title'),
      hint: t('agent.catalogue.section.hint'),
    },
    list: {
      loading: t('agent.catalogue.list.loading'),
      unreadable: t('agent.catalogue.list.unreadable'),
      retry: t('agent.catalogue.list.retry'),
      empty: t('agent.catalogue.list.empty'),
      version: template('agent.catalogue.list.version', 'version'),
    },
    freshness: {
      current: t('agent.catalogue.freshness.current'),
      stale: template('agent.catalogue.freshness.stale', 'detail'),
      unavailable: template('agent.catalogue.freshness.unavailable', 'detail'),
    },
    standing: {
      'via-package-manager': template('agent.catalogue.standing.viaManager', 'manager'),
      'archive-only': template('agent.catalogue.standing.archiveOnly', 'platform', 'reason'),
      unsupported: template('agent.catalogue.standing.unsupported', 'published'),
      unrecognised: template('agent.catalogue.standing.unrecognised', 'kinds'),
    },
    unverified: t('agent.catalogue.unverified'),
    gates: {
      title: t('agent.catalogue.gates.title'),
      hint: template('agent.catalogue.gates.hint', 'checks'),
    },
    action: {
      use: t('agent.catalogue.action.use'),
      used: template('agent.catalogue.action.used', 'agentId'),
    },
    defects: { title: t('agent.catalogue.defects.title') },
    license: template('agent.catalogue.license', 'license'),
    licenseLink: t('agent.catalogue.licenseLink'),
    repository: t('agent.catalogue.repository'),
    website: t('agent.catalogue.website'),
  }
}
