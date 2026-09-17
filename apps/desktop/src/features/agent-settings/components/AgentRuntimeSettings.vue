<script lang="ts">
/**
 * The runtime section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * The sentences are in `src/i18n/namespaces/agent.ts` (`agent.settings.runtime.*`), beside the panel's
 * and the registry page's — a translated build is a catalogue edit rather than a second place to
 * look. What stays here is the *shape* (the keys a caller may replace through the `labels` prop) and
 * the builder that reads the catalogue into it, because a page that reached for `t()` at every use
 * site could not be given a different set of sentences at all.
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
   * Spelled out rather than typed as `Record<RuntimeHandshakeAbsent, string>`: that type is
   * declared in the setup block below, and a `.vue` file's two script blocks are two scopes — the
   * reference would be a name this block cannot see.
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
    },
    update: {
      label: t('agent.settings.runtime.update.label'),
      hostManaged: t('agent.settings.runtime.update.hostManaged'),
      reportedOnly: t('agent.settings.runtime.update.reportedOnly'),
    },
  }
}

</script>

<script setup lang="ts">
/**
 * The runtime section — §3.1.4, and §3.4.6's list of limitations.
 *
 * ## What this page is allowed to draw, and where that changed
 *
 * §3.1.4 asks for 「当前版本、来源、实际路径、协议状态、更新状态」 and forbids the one substitution that reads
 * as a lie — 「不把"进程就绪"显示为"模型可用"」. The first version of this page declared eleven fields and
 * six of them had an answer; the other five were drawn empty, and every one of those was a field
 * asserting a fact the backend had never stated. Two of them were worse than empty: `protocol` drew
 * `{version: null, negotiated: false}` — 「Not negotiated in this runtime」 — while the rail beside the
 * dialog could be running a negotiated session, and `authorization` offered three arms, none of
 * which any ACP field carries.
 *
 * So the shape follows the answer, the way the composer's config row follows what a session
 * reports: **the registry's facts are always drawn, the handshake's facts are drawn when there is a
 * handshake, and when there is not, the backend's own sentence says why.** That is §3.2's
 * 「页面应被告知」 taken literally — this page composes no reason of its own, including the reason
 * there is nothing to show.
 *
 * ## The two lines that carry the design
 *
 *  - **A running process is not an available model.** {@link AgentRuntimeLabels.notAModel} is drawn
 *    whenever the process is up, and it needs no data at all: it is the sentence §3.1.4 asks for.
 *    The engine's own P0 report is the finding from the other side — a session opens with no
 *    credentials, and the failure only arrives at the first prompt. Which is also why no
 *    "authorization state" is drawn here: nothing in this app can be in one.
 *  - **Unverified is not "unsupported".** {@link CapabilityStanding} has three arms because
 *    `adapters::Capability` has three, and T3a's comment is the reason: the third state exists so
 *    that "we have not measured this engine" cannot be mistaken for either of the other two. A page
 *    that folded `unverified` into `not-advertised` would tell a user an engine cannot do something
 *    nobody has established.
 *
 * ## What this page does not do
 *
 * There is nothing to press. Every fact arrives from the backend and none of it is this page's to
 * change: starting and stopping the runtime is the panel's, and replacing a version is T14's. The
 * one list that is *about* actions — the engine's advertised authentication methods — is drawn as
 * the engine's own report with the sentence saying this app does not act on it, because a page in
 * this tree may not draw a control whose press does nothing (§7.2), and a list of ways to log in on
 * a page that cannot log in is that defect in a quieter form.
 */
import { computed, onMounted, ref } from 'vue'

/** What one measured capability's line says. The three arms are the backend's, not a summary. */
export type CapabilityStanding = 'advertised' | 'not-advertised' | 'unverified'

/** One feature and what has been measured about it. */
export interface RuntimeCapabilityRow {
  /** The backend's own name for the feature. Data, shown as written. */
  feature: string
  standing: CapabilityStanding
  /** The engine's or the runtime's own words, when there are any. */
  detail: string | null
}

/**
 * One authentication method the engine advertised.
 *
 * Data, rendered as written. `id` is what the protocol calls it — the value `authenticate` would
 * take — and `name` is what the engine calls it for a reader; both are the engine's, and this app
 * has no call that would use either.
 */
export interface RuntimeAuthMethod {
  id: string
  name: string
}

/**
 * Which of the two states this host is in when nothing has been negotiated.
 *
 * Two ids, and the page renders one sentence per id from its own catalogue — the same split
 * `RegistryRefusal` makes between the backend's `kind` and the sentence a user reads. What the
 * *host* owns is the classification: these are two states of its own lifecycle, and the page could
 * not tell them apart if it tried, because a running engine before its first session reads `ready`
 * exactly like one that has negotiated.
 */
export type RuntimeHandshakeAbsent = 'no-engine' | 'not-yet'

/**
 * What the handshake said, or why there is none — the backend's union, arm for arm.
 *
 * A tagged union rather than an optional group, so "nothing has been negotiated" cannot be
 * confused with "the fields were missing": the second is a shape this window refuses to read, and
 * the first is a state with a reason attached.
 */
export type RuntimeHandshakeState =
  | {
      status: 'read'
      /** The version the engine answered `initialize` with. */
      protocolVersion: number
      /** `agentInfo.name`, when the engine sent one. Optional on the wire. */
      agentName: string | null
      agentVersion: string | null
      authMethods: RuntimeAuthMethod[]
    }
  | { status: 'not-read'; reason: RuntimeHandshakeAbsent }

/**
 * The runtime as the settings page reads it.
 *
 * Every member here is one the backend answered with, and the ones nothing can answer are **absent**
 * rather than present-and-empty. The old readout declared four of those and drew them all: an
 * `authorization` state (no ACP field carries one, and this host never calls `authenticate`), a
 * `protocol` group that was `null` until a session existed (the handshake is per incarnation and
 * nothing read it), two process arms no read can be taken in, and an "update available" flag
 * (`update.rs` owns the gate a candidate must pass and not the network question of which release to
 * ask about). Each is now either answered here or said in the backend's own words — see
 * `commands/agent_runtime.rs` for the four decisions.
 */
export interface AgentRuntimeReadout {
  agentId: string
  displayName: string
  source: 'bundled' | 'managed' | 'external'
  /** The absolute path the process was or would be started from. */
  program: string
  /** What the program reported about itself. `null` until something asked it. */
  reportedVersion: string | null
  adapterId: string
  /** `stopped` or `ready` — the two this host can report. */
  process: 'stopped' | 'ready'
  /** Who may replace the program, from its provenance. Not "an update exists". */
  updatePolicy: 'host-managed' | 'reported-only'
  handshake: RuntimeHandshakeState
  /** One row per feature, or empty when `handshake` is `not-read` — which says why. */
  capabilities: RuntimeCapabilityRow[]
}

/** The backend, chosen at the composition site. */
export interface AgentRuntimeClient {
  read(): Promise<AgentRuntimeReadout>
}

const props = defineProps<{
  client: AgentRuntimeClient
  labels?: AgentRuntimeLabels
}>()

const labels = computed<AgentRuntimeLabels>(() => props.labels ?? runtimeLabels())

/**
 * One capability's sentence. A function rather than an inline ternary in the template, so the three
 * arms are three arms here and a fourth standing added to the backend fails to typecheck at
 * {@link CapabilityStanding} rather than falling into whichever branch happened to be last.
 */
function standingText(standing: CapabilityStanding): string {
  switch (standing) {
    case 'advertised':
      return labels.value.capabilities.advertised
    case 'not-advertised':
      return labels.value.capabilities.notAdvertised
    case 'unverified':
      return labels.value.capabilities.unverified
  }
}

const readout = ref<AgentRuntimeReadout | null>(null)
const state = ref<'loading' | 'ready' | 'unreadable'>('loading')

async function load(): Promise<void> {
  state.value = 'loading'
  try {
    readout.value = await props.client.read()
    state.value = 'ready'
  } catch {
    // A rejection is the call not completing, which is a different thing from a runtime that is
    // not up — that one arrives as data. Saying "not running" here would be a claim about the
    // engine made from a failed read of it.
    state.value = 'unreadable'
  }
}

onMounted(load)
</script>

<template>
  <section class="settings-section runtime">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="state === 'loading'" class="settings-note" data-test="runtime-loading">
      {{ labels.loading }}
    </span>
    <template v-else-if="state === 'unreadable'">
      <span class="settings-note is-error" data-test="runtime-unreadable">{{ labels.unreadable }}</span>
      <button type="button" class="runtime-button" data-test="runtime-retry" @click="load">
        {{ labels.retry }}
      </button>
    </template>

    <dl v-else-if="readout" class="runtime-facts">
      <dt>{{ labels.facts.agent }}</dt>
      <dd data-test="runtime-agent">
        {{ readout.displayName || readout.agentId }} <code>{{ readout.agentId }}</code>
      </dd>
      <dt>{{ labels.facts.source }}</dt>
      <dd data-test="runtime-source">{{ labels.provenance[readout.source] }}</dd>
      <dt>{{ labels.facts.program }}</dt>
      <dd class="runtime-path" data-test="runtime-program">{{ readout.program }}</dd>
      <dt>{{ labels.facts.version }}</dt>
      <dd data-test="runtime-version">
        {{ readout.reportedVersion ?? labels.facts.versionUnknown }}
      </dd>
      <dt>{{ labels.facts.adapter }}</dt>
      <dd data-test="runtime-adapter">{{ readout.adapterId }}</dd>
    </dl>

    <template v-if="state === 'ready' && readout">
      <span class="settings-note" data-test="runtime-process">
        {{ labels.process.label }}: {{ labels.process[readout.process] }}
      </span>
      <!-- Drawn whenever the process is up, and it needs no data: the sentence exists to stop the
           line above it being read as "a model will answer". §3.1.4's own clause. -->
      <span
        v-if="readout.process === 'ready'"
        class="settings-note is-warn"
        data-test="runtime-not-a-model"
      >
        {{ labels.notAModel }}
      </span>

      <!-- The handshake's half, drawn only when there is a handshake to draw. The `v-else` is the
           whole point of the rebuild: one sentence from the backend stands in for the protocol
           line *and* the capability list, because the two are read off the same negotiation, and a
           page that drew either of them empty would be stating a fact nothing established. -->
      <template v-if="readout.handshake.status === 'read'">
        <span class="settings-note" data-test="runtime-protocol">
          {{ labels.protocol.label }}: {{ labels.protocol.negotiated }} — {{ labels.protocol.version }}
          {{ readout.handshake.protocolVersion }}
        </span>

        <!-- The engine's own words about itself, when it sent any. ACP makes `agentInfo` optional,
             so its absence is not a gap to explain — it is simply nothing to draw. -->
        <span
          v-if="readout.handshake.agentName !== null"
          class="settings-note"
          data-test="runtime-engine-report"
        >
          {{ labels.engineReport.label }}: {{ readout.handshake.agentName }}
          {{ readout.handshake.agentVersion ?? '' }}
        </span>

        <!-- The engine's advertised authentication methods: reported, never offered. The note below
             the list is not a caveat — it is what keeps a list of ways to log in from reading as a
             login this app can perform. -->
        <div class="runtime-authorization">
          <span class="settings-label">{{ labels.authorization.label }}</span>
          <ul
            v-if="readout.handshake.authMethods.length > 0"
            class="runtime-rows"
            data-test="runtime-auth-methods"
          >
            <li
              v-for="method in readout.handshake.authMethods"
              :key="method.id"
              class="runtime-row"
            >
              <span class="runtime-feature">{{ method.name }}</span>
              <span class="settings-note runtime-detail"><code>{{ method.id }}</code></span>
            </li>
          </ul>
          <span v-else class="settings-note" data-test="runtime-auth-none">
            {{ labels.authorization.none }}
          </span>
          <span class="settings-note" data-test="runtime-auth-not-acted-on">
            {{ labels.authorization.reportedNotUsed }}
          </span>
        </div>

        <div class="runtime-capabilities">
          <span class="settings-label">{{ labels.capabilities.title }}</span>
          <span class="settings-note">{{ labels.capabilities.hint }}</span>
          <ul class="runtime-rows">
            <li
              v-for="row in readout.capabilities"
              :key="row.feature"
              class="runtime-row"
              :data-test="`runtime-capability-${row.feature}`"
            >
              <span class="runtime-feature">{{ row.feature }}</span>
              <span
                class="settings-note"
                :class="{ 'is-warn': row.standing !== 'advertised' }"
                :data-standing="row.standing"
              >
                {{ standingText(row.standing) }}
              </span>
              <span v-if="row.detail" class="settings-note runtime-detail">{{ row.detail }}</span>
            </li>
          </ul>
        </div>
      </template>
      <span v-else class="settings-note" data-test="runtime-not-negotiated">
        {{ labels.notNegotiated[readout.handshake.reason] }}
      </span>

      <span class="settings-note" data-test="runtime-update">
        {{ readout.updatePolicy === 'host-managed' ? labels.update.hostManaged : labels.update.reportedOnly }}
      </span>
    </template>
  </section>
</template>

<style scoped>
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.runtime-facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; font-size: 12px; }
.runtime-facts dt { color: var(--app-muted); font-size: 11px; }
.runtime-facts dd { margin: 0; color: var(--app-text); }
.runtime-facts code { font-family: var(--app-mono-font); font-size: 11px; }
.runtime-path { font-family: var(--app-mono-font); font-size: 11px; overflow-wrap: anywhere; }
.runtime-authorization, .runtime-capabilities { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.runtime-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.runtime-row { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.runtime-feature { font-size: 12px; color: var(--app-text); }
.runtime-detail { overflow-wrap: anywhere; }
.runtime-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
</style>
