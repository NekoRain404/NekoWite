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
  process: { label: string; stopped: string; starting: string; ready: string; failed: string }
  /** §3.1.4's pair. Kept beside the process state precisely so the two cannot be read as one. */
  authorization: {
    label: string
    unknown: string
    required: string
    configured: string
    /** Drawn whenever the process is up, whatever the authorization state is. */
    notAModel: string
  }
  protocol: { label: string; version: string; none: string; negotiated: string; notNegotiated: string }
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
      starting: t('agent.settings.runtime.process.starting'),
      ready: t('agent.settings.runtime.process.ready'),
      failed: t('agent.settings.runtime.process.failed'),
    },
    authorization: {
      label: t('agent.settings.runtime.authorization.label'),
      unknown: t('agent.settings.runtime.authorization.unknown'),
      required: t('agent.settings.runtime.authorization.required'),
      configured: t('agent.settings.runtime.authorization.configured'),
      notAModel: t('agent.settings.runtime.authorization.notAModel'),
    },
    protocol: {
      label: t('agent.settings.runtime.protocol.label'),
      version: t('agent.settings.runtime.protocol.version'),
      none: t('agent.settings.runtime.protocol.none'),
      negotiated: t('agent.settings.runtime.protocol.negotiated'),
      notNegotiated: t('agent.settings.runtime.protocol.notNegotiated'),
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
 * Two lines carry the whole design, and each exists because the version of this page without it
 * would be a lie of a specific kind:
 *
 *  - **A running process is not an available model.** §3.1.4: 「设置显示当前版本、来源、实际路径、协议
 *    状态、更新状态，不把"进程就绪"显示为"模型可用"」. So the process state and the authorization state
 *    are two lines, and the second one says what it is not. The engine's own P0 report has the same
 *    finding from the other side: a session opens with no credentials at all, and the failure only
 *    arrives at the first prompt.
 *  - **Unverified is not "unsupported".** {@link CapabilityStanding} has three arms because
 *    `adapters::Capability` has three, and T3a's comment is the reason: the third state exists so
 *    that "we have not measured this engine" cannot be mistaken for either of the other two. A page
 *    that folded `unverified` into `not-advertised` would tell a user an engine cannot do something
 *    nobody has established.
 *
 * There is nothing to press on this page. Every fact arrives from the backend and none of it is this
 * page's to change: starting and stopping the runtime is the panel's, and replacing a version is
 * T14's. A control here would be a control over something this page does not own.
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

/** The runtime as the settings page reads it. */
export interface AgentRuntimeReadout {
  agentId: string
  displayName: string
  source: 'bundled' | 'managed' | 'external'
  /** The absolute path the process was or would be started from. */
  program: string
  /** What the program reported about itself. `null` until something asked it. */
  version: string | null
  adapterId: string
  process: 'stopped' | 'starting' | 'ready' | 'failed'
  /** §3.1.4's second state, reported separately from {@link process} on purpose. */
  authorization: 'unknown' | 'required' | 'configured'
  protocol: { version: number | null; negotiated: boolean }
  capabilities: RuntimeCapabilityRow[]
  update: { policy: 'host-managed' | 'reported-only' }
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
        {{ readout.version ?? labels.facts.versionUnknown }}
      </dd>
      <dt>{{ labels.facts.adapter }}</dt>
      <dd data-test="runtime-adapter">{{ readout.adapterId }}</dd>
    </dl>

    <template v-if="state === 'ready' && readout">
      <span class="settings-note" data-test="runtime-process">
        {{ labels.process.label }}: {{ labels.process[readout.process] }}
      </span>
      <span class="settings-note" data-test="runtime-authorization">
        {{ labels.authorization.label }}: {{ labels.authorization[readout.authorization] }}
      </span>
      <!-- Drawn whenever the process is up: the sentence exists to stop the line above it being
           read as "a model will answer". -->
      <span
        v-if="readout.process === 'ready'"
        class="settings-note is-warn"
        data-test="runtime-not-a-model"
      >
        {{ labels.authorization.notAModel }}
      </span>
      <span class="settings-note" data-test="runtime-protocol">
        {{ labels.protocol.label }}:
        {{ readout.protocol.negotiated ? labels.protocol.negotiated : labels.protocol.notNegotiated }}
        <template v-if="readout.protocol.version !== null">
          — {{ labels.protocol.version }} {{ readout.protocol.version }}
        </template>
      </span>

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

      <span class="settings-note" data-test="runtime-update">
        {{ readout.update.policy === 'host-managed' ? labels.update.hostManaged : labels.update.reportedOnly }}
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
.runtime-capabilities { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.runtime-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.runtime-row { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.runtime-feature { font-size: 12px; color: var(--app-text); }
.runtime-detail { overflow-wrap: anywhere; }
.runtime-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
</style>
