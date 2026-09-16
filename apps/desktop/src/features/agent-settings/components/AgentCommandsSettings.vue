<script lang="ts">
/**
 * The commands section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * The sentences are in `src/i18n/namespaces/agent.ts` (`agent.settings.commands.*`), beside the panel's
 * and the registry page's — a translated build is a catalogue edit rather than a second place to
 * look. What stays here is the *shape* (the keys a caller may replace through the `labels` prop) and
 * the builder that reads the catalogue into it, because a page that reached for `t()` at every use
 * site could not be given a different set of sentences at all.
 *
 * The facts are *not* in here — a path, an environment variable and the engine's own words are
 * data, and data does not go through a translator.
 *
 * {@link AgentCommandsLabels.limits} is keyed by `CommandLimitId`, so a limitation the backend
 * reports without a sentence here fails to typecheck rather than rendering as a blank line — which
 * matters more here than elsewhere, because the thing a blank line would hide is a limitation.
 */
import { t } from '../../../i18n'

export interface AgentCommandsLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  session: { title: string; none: string; session: string; published: string; description: string }
  sources: { title: string; hint: string; empty: string; commands: string }
  app: { title: string; hint: string }
  origin: { host: string; engine: string; session: string }
  limits: { title: string; undoRedo: string; unpublished: string; parameters: string; unnamed: string }
}

export function commandsLabels(): AgentCommandsLabels {
  return {
    section: {
      title: t('agent.settings.commands.section.title'),
      hint: t('agent.settings.commands.section.hint'),
    },
    loading: t('agent.settings.commands.loading'),
    unreadable: t('agent.settings.commands.unreadable'),
    retry: t('agent.settings.retry'),
    session: {
      title: t('agent.settings.commands.session.title'),
      none: t('agent.settings.commands.session.none'),
      session: t('agent.settings.commands.session.session'),
      published: t('agent.settings.commands.session.published'),
      description: t('agent.settings.commands.session.description'),
    },
    sources: {
      title: t('agent.settings.commands.sources.title'),
      hint: t('agent.settings.commands.sources.hint'),
      empty: t('agent.settings.commands.sources.empty'),
      commands: t('agent.settings.commands.sources.commands'),
    },
    app: {
      title: t('agent.settings.commands.app.title'),
      hint: t('agent.settings.commands.app.hint'),
    },
    origin: {
      host: t('agent.settings.origin.host'),
      engine: t('agent.settings.origin.engine'),
      session: t('agent.settings.origin.session'),
    },
    limits: {
      title: t('agent.settings.commands.limits.title'),
      undoRedo: t('agent.settings.commands.limits.undoRedo'),
      unpublished: t('agent.settings.commands.limits.unpublished'),
      parameters: t('agent.settings.commands.limits.parameters'),
      unnamed: t('agent.settings.commands.limits.unnamed'),
    },
  }
}

</script>

<script setup lang="ts">
/**
 * The commands section — §4.1 and the `agent` / commands half of §4.2.
 *
 * The acceptance clause is 「命令来源明确」, and "clear" here means something specific: the three
 * places commands can come from are drawn as three groups, because they behave differently and a
 * user acts on them differently.
 *
 *  - **Session commands** were published by the engine for the session in front of them, so they are
 *    true of *that* session and stop being true when it changes (§4.1: 「命令范围绑定当前运行时和会话」).
 *    The list is a snapshot, and the page says so rather than implying it is a property of the app.
 *  - **File commands** live in directories the engine reads. This app did not write them and does not
 *    interpret them: §4.1's 「自定义 OpenCode 命令仍由 OpenCode 发现和执行，不在 NekoWite 重新实现模板解释
 *   器」. So the page names the directories and shows what the engine found, and there is no "run"
 *    control anywhere on it.
 *  - **This app's own commands** are listed to say where they are *not*: §4.1 keeps them out of the
 *    engine's `/` namespace, so a name cannot collide with the engine's.
 *
 * The limitations are a list the backend selects from, rather than sentences it sends. That is the
 * same shape as the runtime page's capability rows, and for the same reason: §3.4.6 requires a
 * specific limitation to be shown where one exists, and 「遵循 ACP」 must not be advertised as feature
 * parity — so `/undo` and `/redo` are named as unsupported rather than left to be discovered.
 */
import { computed, onMounted, ref } from 'vue'
import type { SettingOrigin } from '../index'

/** A limitation the backend reports for the engine it has measured. */
export type CommandLimitId = 'undo-redo' | 'unpublished' | 'parameters' | 'unnamed'

export interface CommandView {
  name: string
  description: string
  /** The engine's optional text prompt for the command's arguments, shown verbatim. */
  hint: string | null
}

/** One directory or document the engine reads commands from. */
export interface CommandSourceView {
  origin: SettingOrigin
  commands: CommandView[]
}

export interface AgentCommandsReadout {
  /** What the engine published for the session in front of the user, or `null` before it does. */
  session: { sessionId: string; commands: CommandView[] } | null
  sources: CommandSourceView[]
  appCommands: CommandView[]
  limits: CommandLimitId[]
}

/** The backend, chosen at the composition site. */
export interface AgentCommandsClient {
  read(): Promise<AgentCommandsReadout>
}

const props = defineProps<{
  client: AgentCommandsClient
  labels?: AgentCommandsLabels
}>()

const labels = computed<AgentCommandsLabels>(() => props.labels ?? commandsLabels())
const readout = ref<AgentCommandsReadout | null>(null)
const state = ref<'loading' | 'ready' | 'unreadable'>('loading')

function originText(origin: SettingOrigin): string {
  const copy = labels.value.origin
  if (origin.kind === 'host') {
    return origin.variable === null ? `${copy.host}: ${origin.path}` : `${copy.host}: ${origin.variable} = ${origin.path}`
  }
  if (origin.kind === 'engine') return `${copy.engine}: ${origin.what}`
  return `${copy.session}: ${origin.what}`
}

function limitText(limit: CommandLimitId): string {
  const copy = labels.value.limits
  switch (limit) {
    case 'undo-redo':
      return copy.undoRedo
    case 'unpublished':
      return copy.unpublished
    case 'parameters':
      return copy.parameters
    case 'unnamed':
      return copy.unnamed
  }
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
  <section class="settings-section commands">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="state === 'loading'" class="settings-note" data-test="commands-loading">
      {{ labels.loading }}
    </span>
    <template v-else-if="state === 'unreadable'">
      <span class="settings-note is-error" data-test="commands-unreadable">{{ labels.unreadable }}</span>
      <button type="button" class="commands-button" data-test="commands-retry" @click="load">
        {{ labels.retry }}
      </button>
    </template>

    <template v-else-if="readout">
      <div class="commands-group">
        <span class="settings-label">{{ labels.session.title }}</span>
        <span v-if="readout.session === null" class="settings-note" data-test="commands-session-none">
          {{ labels.session.none }}
        </span>
        <template v-else>
          <span class="settings-note" data-test="commands-session-id">
            {{ labels.session.session }}: <code class="commands-name">{{ readout.session.sessionId }}</code>
            — {{ labels.session.published }}
          </span>
          <ul class="commands-rows">
            <li
              v-for="command in readout.session.commands"
              :key="command.name"
              class="commands-row"
              :data-test="`command-session-${command.name}`"
            >
              <code class="commands-name">{{ command.name }}</code>
              <span class="settings-note">{{ command.description || labels.session.description }}</span>
              <span v-if="command.hint" class="settings-note commands-hint">{{ command.hint }}</span>
            </li>
          </ul>
        </template>
      </div>

      <div class="commands-group">
        <span class="settings-label">{{ labels.sources.title }}</span>
        <span class="settings-note">{{ labels.sources.hint }}</span>
        <span v-if="readout.sources.length === 0" class="settings-note" data-test="commands-sources-empty">
          {{ labels.sources.empty }}
        </span>
        <ul v-else class="commands-rows">
          <li
            v-for="(source, index) in readout.sources"
            :key="index"
            class="commands-row"
            :data-origin="source.origin.kind"
            :data-test="`command-source-${index}`"
          >
            <span class="settings-note commands-origin">{{ originText(source.origin) }}</span>
            <span class="settings-note">{{ labels.sources.commands }}: {{ source.commands.length }}</span>
            <ul class="commands-rows">
              <li v-for="command in source.commands" :key="command.name" class="settings-note commands-name">
                {{ command.name }}
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <div class="commands-group">
        <span class="settings-label">{{ labels.app.title }}</span>
        <span class="settings-note">{{ labels.app.hint }}</span>
        <ul class="commands-rows">
          <li v-for="command in readout.appCommands" :key="command.name" class="commands-row">
            <span class="commands-name">{{ command.name }}</span>
            <span class="settings-note">{{ command.description }}</span>
          </li>
        </ul>
      </div>

      <div v-if="readout.limits.length > 0" class="commands-group">
        <span class="settings-label">{{ labels.limits.title }}</span>
        <ul class="commands-rows">
          <li
            v-for="limit in readout.limits"
            :key="limit"
            class="settings-note is-warn commands-limit"
            :data-test="`command-limit-${limit}`"
          >
            {{ limitText(limit) }}
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
.commands-group { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.commands-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.commands-row { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.commands-name { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-text); overflow-wrap: anywhere; }
.commands-origin { color: var(--app-text); }
.commands-hint { font-style: italic; }
.commands-limit { list-style: none; }
.commands-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
</style>
