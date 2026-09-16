<script lang="ts">
/**
 * The MCP section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * The sentences are in `src/i18n/namespaces/agent.ts` (`agent.settings.mcp.*`), beside the panel's
 * and the registry page's — a translated build is a catalogue edit rather than a second place to
 * look. What stays here is the *shape* (the keys a caller may replace through the `labels` prop) and
 * the builder that reads the catalogue into it, because a page that reached for `t()` at every use
 * site could not be given a different set of sentences at all.
 *
 * The facts are *not* in here — a path, an environment variable and the engine's own words are
 * data, and data does not go through a translator.
 *
 * `trust` is the one sentence on this page that is doing security work rather than describing a
 * value, so its translation carries the same three clauses as the English rather than a summary.
 */
import { t } from '../../../i18n'

export interface AgentMcpLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  list: { empty: string; name: string; transport: string; state: string; on: string; off: string; command: string }
  transport: Record<'local' | 'http' | 'sse', string>
  origin: { host: string; engine: string; session: string }
  credentials: { label: string; none: string; namesOnly: string }
  diagnostic: { label: string; none: string }
  capabilities: { title: string; hint: string; advertised: string; notAdvertised: string }
  /** Drawn on every local server, whatever its state is. §4.2's `mcp` row. */
  trust: string
  /** What this page does not do. */
  doesNotStart: string
}

export function mcpLabels(): AgentMcpLabels {
  return {
    section: {
      title: t('agent.settings.mcp.section.title'),
      hint: t('agent.settings.mcp.section.hint'),
    },
    loading: t('agent.settings.mcp.loading'),
    unreadable: t('agent.settings.mcp.unreadable'),
    retry: t('agent.settings.retry'),
    list: {
      empty: t('agent.settings.mcp.list.empty'),
      name: t('agent.settings.mcp.list.name'),
      transport: t('agent.settings.mcp.list.transport'),
      state: t('agent.settings.mcp.list.state'),
      on: t('agent.settings.mcp.list.on'),
      off: t('agent.settings.mcp.list.off'),
      command: t('agent.settings.mcp.list.command'),
    },
    transport: {
      local: t('agent.settings.mcp.transport.local'),
      http: t('agent.settings.mcp.transport.http'),
      sse: t('agent.settings.mcp.transport.sse'),
    },
    origin: {
      host: t('agent.settings.origin.host'),
      engine: t('agent.settings.origin.engine'),
      session: t('agent.settings.origin.session'),
    },
    credentials: {
      label: t('agent.settings.mcp.credentials.label'),
      none: t('agent.settings.mcp.credentials.none'),
      namesOnly: t('agent.settings.mcp.credentials.namesOnly'),
    },
    diagnostic: {
      label: t('agent.settings.mcp.diagnostic.label'),
      none: t('agent.settings.mcp.diagnostic.none'),
    },
    capabilities: {
      title: t('agent.settings.mcp.capabilities.title'),
      hint: t('agent.settings.mcp.capabilities.hint'),
      advertised: t('agent.settings.mcp.capabilities.advertised'),
      notAdvertised: t('agent.settings.mcp.capabilities.notAdvertised'),
    },
    trust: t('agent.settings.mcp.trust'),
    doesNotStart: t('agent.settings.mcp.doesNotStart'),
  }
}

</script>

<script setup lang="ts">
/**
 * The MCP section — §4.2's `mcp` row: 「MCP 列表、配置、认证、诊断」 and 「启动本地 MCP 等于执行程序，需
 * 单独信任」.
 *
 * The acceptance clause is 「MCP 来源明确」, and the two things it takes to meet it are both structural:
 *
 *  - **Every server carries an origin**, and the three arms are the three real answers — this app
 *    wrote it, the engine found it under rules this app does not own, or it was handed to a session
 *    (§4.2's `session` row: a server can be passed per session, which is why it is not always in a
 *    file). §8.1's warning applies here as much as to the model: a list that showed only what this
 *    app configured would be describing a world with nothing else in it.
 *  - **Every local server carries the trust sentence**, drawn unconditionally — not only when
 *    something is wrong, and not only until the server has been added. Registering a program is not
 *    a verdict on it (§3.4.4: 「校验文件存在和可执行只能证明可启动，不能证明程序安全」), and "starting
 *    a local MCP equals executing a program" is the fact that sentence exists to keep in front of
 *    the user.
 *
 * There is no control on this page, and that is a decision rather than an omission: servers are
 * started by the engine when it opens a session, so a switch here would be a switch over something
 * this app does not own. §8.2's rule for the same situation — 「不能仅隐藏 UI 项目而声称已禁用」 —
 * applies to a control that does nothing just as much as to a disable that does not disable.
 *
 * Credentials are names. {@link McpServerView.credentials} holds key and header names, and there is
 * no field on this page a value could travel in: §8.1's 「密钥不进入消息、日志或 localStorage」 is a
 * property of the shape rather than a rule somebody remembers.
 */
import { computed, onMounted, ref } from 'vue'
import type { SettingOrigin } from '../index'

export type McpTransport = 'local' | 'http' | 'sse'

export interface McpServerView {
  name: string
  origin: SettingOrigin
  transport: McpTransport
  enabled: boolean
  /** For a local server, the program and its arguments — as an array, never joined (§3.4.3). */
  command: string[] | null
  /** Environment variable and header *names*. There is nowhere here for a value. */
  credentials: string[]
  /** The engine's own last word about this server, when it has one. */
  diagnostic: string | null
}

export interface AgentMcpReadout {
  servers: McpServerView[]
  /** What the handshake advertised for this engine version, measured rather than assumed. */
  transports: { transport: McpTransport; advertised: boolean }[]
}

/** The backend, chosen at the composition site. */
export interface AgentMcpClient {
  read(): Promise<AgentMcpReadout>
}

const props = defineProps<{
  client: AgentMcpClient
  labels?: AgentMcpLabels
}>()

const labels = computed<AgentMcpLabels>(() => props.labels ?? mcpLabels())
const readout = ref<AgentMcpReadout | null>(null)
const state = ref<'loading' | 'ready' | 'unreadable'>('loading')

function originText(origin: SettingOrigin): string {
  const copy = labels.value.origin
  if (origin.kind === 'host') {
    return origin.variable === null ? `${copy.host}: ${origin.path}` : `${copy.host}: ${origin.variable} = ${origin.path}`
  }
  if (origin.kind === 'engine') return `${copy.engine}: ${origin.what}`
  return `${copy.session}: ${origin.what}`
}

async function load(): Promise<void> {
  state.value = 'loading'
  try {
    readout.value = await props.client.read()
    state.value = 'ready'
  } catch {
    state.value = 'unreadable'
  }
}

onMounted(load)
</script>

<template>
  <section class="settings-section mcp">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="state === 'loading'" class="settings-note" data-test="mcp-loading">{{ labels.loading }}</span>
    <template v-else-if="state === 'unreadable'">
      <span class="settings-note is-error" data-test="mcp-unreadable">{{ labels.unreadable }}</span>
      <button type="button" class="mcp-button" data-test="mcp-retry" @click="load">{{ labels.retry }}</button>
    </template>

    <template v-else-if="readout">
      <span class="settings-note" data-test="mcp-does-not-start">{{ labels.doesNotStart }}</span>

      <span v-if="readout.servers.length === 0" class="settings-note" data-test="mcp-empty">
        {{ labels.list.empty }}
      </span>
      <ul class="mcp-rows">
        <li
          v-for="server in readout.servers"
          :key="server.name"
          class="mcp-row"
          :data-transport="server.transport"
          :data-test="`mcp-row-${server.name}`"
        >
          <div class="mcp-head">
            <span class="mcp-name">{{ server.name }}</span>
            <span class="mcp-badge">{{ labels.transport[server.transport] }}</span>
          </div>
          <span class="settings-note mcp-origin" :data-origin="server.origin.kind">
            {{ originText(server.origin) }}
          </span>
          <span class="settings-note">
            {{ labels.list.state }}: {{ server.enabled ? labels.list.on : labels.list.off }}
          </span>
          <!-- An array, one element per line: a command with a space inside one of its arguments
               must not be drawn as a command line (§3.4.3). -->
          <span v-if="server.command" class="mcp-command">
            {{ labels.list.command }}:
            <code v-for="(argument, index) in server.command" :key="index">{{ argument }}</code>
          </span>
          <span class="settings-note">
            {{ labels.credentials.label }}:
            {{ server.credentials.length === 0 ? labels.credentials.none : server.credentials.join(', ') }}
            ({{ labels.credentials.namesOnly }})
          </span>
          <span class="settings-note">
            {{ labels.diagnostic.label }}: {{ server.diagnostic ?? labels.diagnostic.none }}
          </span>
          <!-- Unconditional, on every local server. See the component comment. -->
          <span
            v-if="server.transport === 'local'"
            class="settings-note is-warn mcp-trust"
            data-test="mcp-trust"
          >
            {{ labels.trust }}
          </span>
        </li>
      </ul>

      <div class="mcp-capabilities">
        <span class="settings-label">{{ labels.capabilities.title }}</span>
        <span class="settings-note">{{ labels.capabilities.hint }}</span>
        <ul class="mcp-rows">
          <li
            v-for="entry in readout.transports"
            :key="entry.transport"
            class="settings-note"
            :class="{ 'is-warn': !entry.advertised }"
            :data-test="`mcp-transport-${entry.transport}`"
          >
            {{ labels.transport[entry.transport] }}:
            {{ entry.advertised ? labels.capabilities.advertised : labels.capabilities.notAdvertised }}
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.mcp-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.mcp-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.mcp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.mcp-name { font-size: 12px; font-weight: 600; color: var(--app-text); }
.mcp-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--app-border); color: var(--app-muted); white-space: nowrap; }
.mcp-origin { color: var(--app-text); overflow-wrap: anywhere; }
.mcp-command { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; color: var(--app-muted); }
.mcp-command code { font-family: var(--app-mono-font); font-size: 11px; padding: 1px 5px; border-radius: var(--app-radius-sm); background: var(--app-panel); color: var(--app-text); }
.mcp-capabilities { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.mcp-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
</style>
