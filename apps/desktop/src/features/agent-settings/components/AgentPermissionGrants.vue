<script lang="ts">
/**
 * The grants section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * Split out of `AgentPermissionSettings.vue` for the reason `AiPermissionSettings.vue` gives for
 * its own split: the two answer different questions. That page reports what the engine will *ask*
 * — a ruleset in a document, read with no session running. This one reports what the engine has
 * stopped asking, which lives in the engine's own database and can only be read while an engine is
 * there to read it. One file holding both would also have crossed §13.1's split threshold.
 *
 * The facts are not in here — a tool name, a resource and a project id are the engine's own words,
 * and data does not go through a translator.
 */
import { t } from '../../../i18n'

export interface AgentPermissionGrantLabels {
  title: string
  hint: string
  loading: string
  unreadable: string
  retry: string
  /**
   * The three answers that are not a list, each its own sentence because each is its own claim.
   * `unsupported` and `notRunning` are the two that must never be drawn as an empty list: "this
   * agent cannot be asked" and "there is nothing to ask" are not "you have granted nothing".
   */
  unsupported: string
  notRunning: string
  empty: string
  project: string
  revoke: string
  revoking: string
  /** A removal the engine refused. The list below is the engine's own, unchanged. */
  failed: string
}

export function permissionGrantLabels(): AgentPermissionGrantLabels {
  return {
    title: t('agent.settings.permission.grants.title'),
    hint: t('agent.settings.permission.grants.hint'),
    loading: t('agent.settings.permission.grants.loading'),
    unreadable: t('agent.settings.permission.grants.unreadable'),
    retry: t('agent.settings.retry'),
    unsupported: t('agent.settings.permission.grants.unsupported'),
    notRunning: t('agent.settings.permission.grants.notRunning'),
    empty: t('agent.settings.permission.grants.empty'),
    project: t('agent.settings.permission.grants.project'),
    revoke: t('agent.settings.permission.grants.revoke'),
    revoking: t('agent.settings.permission.grants.revoking'),
    failed: t('agent.settings.permission.grants.failed'),
  }
}
</script>

<script setup lang="ts">
/**
 * The grants a user has actually given, and the one control that takes one back.
 *
 * ## Why this exists at all
 *
 * `Always allow` is not a session answer. The engine writes it into its own database, scoped to
 * the project, and every later evaluation loads it — a later session on the same profile is asked
 * nothing at all (`permission-configured.md` §5, measured). Until this page existed, the user
 * could give that permission and had no way to see it or take it back from inside the app: the
 * prompt said so in words, which is honest but is not a surface.
 *
 * ## What this page is not
 *
 * **It is not a second permission mechanism.** The engine owns the table; this reads it and asks
 * the engine to drop one row, through the engine's own routes. Nothing here decides whether a
 * request is approved, and no copy of the rules is kept here that could disagree with the engine.
 *
 * **It never turns "cannot ask" into "nothing granted".** The readout has three kinds and the
 * template draws all three differently. Selecting the wrong arm would be a page telling a user
 * they have given no lasting permission when the truth is that no one asked the engine — the
 * precise defect this app treats as a defect rather than as an empty state.
 *
 * ## Why there is no confirmation step
 *
 * Revoking is the safe direction: it makes the engine ask *more*, and the cost of a mis-click is
 * one prompt the user answers again. A confirmation dialog here would add a second click to the
 * one action on this page that reduces permission, which is the wrong thing to make harder.
 */
import { computed, onMounted, ref } from 'vue'
import type { AgentPermissionClient, GrantsReadout, SavedGrantView } from '../services/agent-permission-ipc'

const props = defineProps<{
  client: AgentPermissionClient
  labels?: AgentPermissionGrantLabels
}>()

const labels = computed<AgentPermissionGrantLabels>(
  () => props.labels ?? permissionGrantLabels(),
)
const readout = ref<GrantsReadout | null>(null)
const state = ref<'loading' | 'ready' | 'unreadable'>('loading')
/** The grant being removed right now, so the button that was pressed is the one that says so. */
const busy = ref<string | null>(null)
/** A removal the engine refused, in the backend's own words. The list below is unchanged. */
const failure = ref<string | null>(null)

async function load(): Promise<void> {
  state.value = 'loading'
  try {
    readout.value = await props.client.grants()
    state.value = 'ready'
  } catch {
    state.value = 'unreadable'
  }
}

async function revoke(grant: SavedGrantView): Promise<void> {
  busy.value = grant.id
  failure.value = null
  try {
    // The answer *replaces* the list rather than dropping the row here: it is the engine's own
    // list after the removal, and a page that struck the row out itself would be showing its
    // belief about a removal whose only evidence is the engine's next answer.
    readout.value = await props.client.revoke(grant.id)
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = null
  }
}

onMounted(load)
</script>

<template>
  <div
    class="permission-group"
    data-test="permission-grants"
  >
    <span class="settings-label">{{ labels.title }}</span>
    <span class="settings-note">{{ labels.hint }}</span>

    <span
      v-if="state === 'loading'"
      class="settings-note"
      data-test="grants-loading"
    >
      {{ labels.loading }}
    </span>
    <template v-else-if="state === 'unreadable'">
      <span
        class="settings-note is-error"
        data-test="grants-unreadable"
      >{{ labels.unreadable }}</span>
      <button
        type="button"
        class="permission-button"
        data-test="grants-retry"
        @click="load"
      >
        {{ labels.retry }}
      </button>
    </template>

    <template v-else-if="readout">
      <!-- The agent cannot be asked at all. Drawn as its own statement, never as an empty list. -->
      <span
        v-if="readout.kind === 'unsupported'"
        class="settings-note is-warn"
        data-test="grants-unsupported"
      >
        {{ labels.unsupported }}
      </span>

      <!-- No engine is running: nothing to read, and a retry for when one is. -->
      <template v-else-if="readout.kind === 'not-running'">
        <span
          class="settings-note"
          data-test="grants-not-running"
        >{{ labels.notRunning }}</span>
        <button
          type="button"
          class="permission-button"
          data-test="grants-retry"
          @click="load"
        >
          {{ labels.retry }}
        </button>
      </template>

      <!-- The engine answered, and this is what it holds. An empty list here is its own claim. -->
      <template v-else>
        <span
          v-if="readout.grants.length === 0"
          class="settings-note"
          data-test="grants-empty"
        >
          {{ labels.empty }}
        </span>
        <ul
          v-else
          class="permission-rows"
          data-test="grants-list"
        >
          <li
            v-for="grant in readout.grants"
            :key="grant.id"
            class="permission-row"
            :data-test="`grant-${grant.id}`"
          >
            <div class="permission-head">
              <code class="permission-name">{{ grant.action }}</code>
              <span class="permission-badge">{{ grant.resource }}</span>
            </div>
            <span class="settings-note permission-origin">
              {{ labels.project }}: <code class="permission-name">{{ grant.projectId }}</code>
            </span>
            <button
              type="button"
              class="permission-button"
              :disabled="busy !== null"
              :data-test="`grant-revoke-${grant.id}`"
              @click="revoke(grant)"
            >
              {{ busy === grant.id ? labels.revoking : labels.revoke }}
            </button>
          </li>
        </ul>
        <span
          v-if="failure"
          class="settings-note is-error"
          data-test="grants-failure"
        >
          {{ labels.failed }} {{ failure }}
        </span>
      </template>
    </template>
  </div>
</template>

<style scoped>
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.permission-group { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.permission-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.permission-row { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.permission-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.permission-name { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-text); overflow-wrap: anywhere; }
.permission-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--app-border); color: var(--app-muted); white-space: nowrap; }
.permission-origin { overflow-wrap: anywhere; }
.permission-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.permission-button:disabled { opacity: 0.6; cursor: default; }
</style>
