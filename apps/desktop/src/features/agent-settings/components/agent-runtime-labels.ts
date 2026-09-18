/**
 * The runtime section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * The sentences are in `src/i18n/namespaces/agent.ts` (`agent.settings.runtime.*`), beside the panel's
 * and the registry page's — a translated build is a catalogue edit rather than a second place to
 * look. What stays here is the *shape* (the keys a caller may replace through the `labels` prop) and
 * the builder that reads the catalogue into it, because a page that reached for `t()` at every use
 * site could not be given a different set of sentences at all.
 *
 * This was the first script block of `AgentRuntimeSettings.vue`, and it is a file of its own for the
 * reason the other sections' copy is: one catalogue key per line, one line per arm — a table that
 * changes when a sentence changes, never when a behaviour does. The page imports
 * {@link runtimeLabels} and re-exports {@link AgentRuntimeLabels}, so nothing that names
 * `AgentRuntimeSettings.vue` has to change.
 *
 * The keys stay **literals**: `i18n.test.ts` reads `t('…')` arguments out of the source to check
 * that every key the source uses has a definition, and it only recognises literals. A key built as a
 * template literal would save a few lines and turn a misspelled suffix into a sentence that renders
 * as the raw key name on screen instead of failing a test — a guard spent for a line count.
 *
 * The facts are *not* in here — a path, an environment variable and the engine's own words are
 * data, and data does not go through a translator.
 *
 * The one shape worth keeping in mind: {@link AgentRuntimeLabels.capabilities} is keyed by the
 * backend's three standings, so a fourth added later is a typecheck failure rather than a row that
 * says nothing.
 */
import { t } from '../../../i18n'

export interface AgentRuntimeLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  facts: {
    agent: string
    source: string
    program: string
    version: string
    versionUnknown: string
    adapter: string
  }
  provenance: Record<'bundled' | 'managed' | 'external', string>
  /**
   * The two states the host can actually report, and the only two in this record.
   *
   * `starting` and `failed` used to be here. Neither is a state any read can be taken in — the
   * instance slot is filled only after a start has returned, and a failed start answers its caller
   * instead of leaving a state behind — so they were copy for two arms nothing could produce.
   */
  process: { label: string; stopped: string; ready: string }
  /**
   * §3.1.4's sentence: 「不把"进程就绪"显示为"模型可用"」.
   *
   * It needs no data at all, which is why it is a sentence here rather than a field on the readout.
   * It used to live under `authorization`, beside a state nothing could answer; the sentence was the
   * true half of that pair all along, and the state was the half that had to go.
   */
  notAModel: string
  protocol: { label: string; version: string; negotiated: string }
  /**
   * What stands in for the protocol line *and* the capability list when there is no handshake.
   *
   * One sentence per id the backend can name, rather than one sentence, because the two send a user
   * to different places: an app that has not started an engine, and an engine running before its
   * first session. The page could not tell them apart on its own — a running engine reads `Running`
   * on the process line in both states — so the host names which one it is and this record is
   * where the naming lands.
   *
   * Spelled out rather than typed as `Record<RuntimeHandshakeAbsent, string>`: that type is declared
   * in `AgentRuntimeSettings.vue`'s setup block, and a `.vue` file's two script blocks are two
   * scopes — this file is a third, and would not see that name either.
   */
  notNegotiated: { 'no-engine': string; 'not-yet': string }
  /**
   * What the engine said about authenticating, reported as what it is.
   *
   * Not an authorization *state*, which no ACP field carries and this host could never be in: it
   * never calls `authenticate`. These are the methods the engine's own handshake advertised, and the
   * note below them says what this app does about them — which is nothing.
   */
  authorization: { label: string; none: string; reportedNotUsed: string }
  /** The engine's own name for itself, from the same handshake. */
  engineReport: { label: string }
  capabilities: {
    title: string
    hint: string
    advertised: string
    notAdvertised: string
    unverified: string
    /**
     * The same three arms as short clauses, for the sentence that names both claims at once.
     *
     * A line that restated the finding's own sentence would be a second copy of the line above it;
     * a clause is enough there because the finding's sentence is already on screen.
     *
     * Keyed by the wire's own ids rather than by the catalogue's key names — the way
     * {@link AgentRuntimeLabels.notNegotiated} is — so the row's arm indexes this record directly
     * and a fourth arm added to the backend fails to typecheck here.
     */
    findingClaim: { advertised: string; 'not-advertised': string; unverified: string }
    /**
     * What this build has on file about the engine version it was measured against.
     *
     * Spelled here rather than typed as `Record<DeclaredCapability, string>` for the reason the
     * record above is: the union is declared in `AgentRuntimeSettings.vue`'s setup block, and a name
     * an SFC's setup block declares is not one this file can see.
     */
    declaredClaim: { advertised: string; 'not-advertised': string; unverified: string }
    /**
     * The sentence for a row where the two claims disagree — the only row that draws the file.
     *
     * A function rather than a template string, because the substitution belongs to the catalogue
     * (`vue-i18n` owns the `{…}` syntax) the same way the profile sentence's does.
     */
    declaredDisagrees: (claims: { declared: string; finding: string }) => string
    /**
     * The sentence for a row the engine reports and this app has no way to act on.
     *
     * Its own sentence rather than a fourth {@link AgentRuntimeLabels.capabilities.findingClaim},
     * because it is about a different subject: the clause beside the standing says what *the
     * engine* did, and this one says what *this app* cannot do about it. A reader who saw them in
     * one vocabulary would take the second for the first, which is the collapse the whole row is
     * shaped to prevent.
     */
    hostNothing: string
    /** What stands in for the list when the backend answered with no rows at all. */
    empty: string
  }
  update: { label: string; hostManaged: string; reportedOnly: string }
}

export function runtimeLabels(): AgentRuntimeLabels {
  return {
    section: {
      title: t('agent.settings.runtime.section.title'),
      hint: t('agent.settings.runtime.section.hint'),
    },
    loading: t('agent.settings.runtime.loading'),
    unreadable: t('agent.settings.runtime.unreadable'),
    retry: t('agent.settings.retry'),
    facts: {
      agent: t('agent.settings.runtime.facts.agent'),
      source: t('agent.settings.runtime.facts.source'),
      program: t('agent.settings.runtime.facts.program'),
      version: t('agent.settings.runtime.facts.version'),
      versionUnknown: t('agent.settings.runtime.facts.versionUnknown'),
      adapter: t('agent.settings.runtime.facts.adapter'),
    },
    provenance: {
      bundled: t('agent.settings.runtime.provenance.bundled'),
      managed: t('agent.settings.runtime.provenance.managed'),
      external: t('agent.settings.runtime.provenance.external'),
    },
    process: {
      label: t('agent.settings.runtime.process.label'),
      stopped: t('agent.settings.runtime.process.stopped'),
      ready: t('agent.settings.runtime.process.ready'),
    },
    notAModel: t('agent.settings.runtime.notAModel'),
    protocol: {
      label: t('agent.settings.runtime.protocol.label'),
      version: t('agent.settings.runtime.protocol.version'),
      negotiated: t('agent.settings.runtime.protocol.negotiated'),
    },
    notNegotiated: {
      'no-engine': t('agent.settings.runtime.notNegotiated.noEngine'),
      'not-yet': t('agent.settings.runtime.notNegotiated.notYet'),
    },
    authorization: {
      label: t('agent.settings.runtime.authorization.label'),
      none: t('agent.settings.runtime.authorization.none'),
      reportedNotUsed: t('agent.settings.runtime.authorization.reportedNotUsed'),
    },
    engineReport: {
      label: t('agent.settings.runtime.engineReport.label'),
    },
    capabilities: {
      title: t('agent.settings.runtime.capabilities.title'),
      hint: t('agent.settings.runtime.capabilities.hint'),
      advertised: t('agent.settings.runtime.capabilities.advertised'),
      notAdvertised: t('agent.settings.runtime.capabilities.notAdvertised'),
      unverified: t('agent.settings.runtime.capabilities.unverified'),
      findingClaim: {
        advertised: t('agent.settings.runtime.capabilities.finding.advertised'),
        'not-advertised': t('agent.settings.runtime.capabilities.finding.notAdvertised'),
        unverified: t('agent.settings.runtime.capabilities.finding.unverified'),
      },
      declaredClaim: {
        advertised: t('agent.settings.runtime.capabilities.declared.advertised'),
        'not-advertised': t('agent.settings.runtime.capabilities.declared.notAdvertised'),
        unverified: t('agent.settings.runtime.capabilities.declared.unverified'),
      },
      declaredDisagrees: (claims) =>
        t('agent.settings.runtime.capabilities.declared.disagrees', claims),
      hostNothing: t('agent.settings.runtime.capabilities.hostNothing'),
      empty: t('agent.settings.runtime.capabilities.empty'),
    },
    update: {
      label: t('agent.settings.runtime.update.label'),
      hostManaged: t('agent.settings.runtime.update.hostManaged'),
      reportedOnly: t('agent.settings.runtime.update.reportedOnly'),
    },
  }
}
