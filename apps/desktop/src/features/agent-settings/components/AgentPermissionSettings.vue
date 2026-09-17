<script lang="ts">
/**
 * The permission section's copy: the keys a caller may replace, and the catalogue it defaults to.
 *
 * The sentences are in `src/i18n/namespaces/agent.ts` (`agent.settings.permission.*`), beside the panel's
 * and the registry page's — a translated build is a catalogue edit rather than a second place to
 * look. What stays here is the *shape* (the keys a caller may replace through the `labels` prop) and
 * the builder that reads the catalogue into it, because a page that reached for `t()` at every use
 * site could not be given a different set of sentences at all.
 *
 * The facts are *not* in here — a path, an environment variable and the engine's own words are
 * data, and data does not go through a translator.
 *
 * `limits` is keyed by `PermissionLimitId`, and two of its entries are §6.3's own sentences —
 * 「ACP 不是安全沙箱」 and the fact that no sandbox has been built. A blank or softened line there
 * would be a promise this app does not keep, which is why they are drawn as their own rows.
 */
import { t } from '../../../i18n'

export interface AgentPermissionLabels {
  section: { title: string; hint: string }
  loading: string
  unreadable: string
  retry: string
  /**
   * One sentence per state of the consent default (`PermissionState`), because the state is what
   * decides whether the list below is a promise or an absence — a page that drew its rules without
   * saying which profile they apply to would be claiming them for a profile where this host wrote
   * nothing.
   */
  states: { written: string; engineOwn: string; notThisHost: string }
  rules: { title: string; empty: string; tool: string; action: string }
  options: { title: string; hint: string; none: string; noInvention: string }
  origin: { host: string; engine: string; session: string }
  limits: {
    title: string
    notASandbox: string
    noIsolation: string
    staleRequests: string
    noSilentApproval: string
  }
}

export function permissionLabels(): AgentPermissionLabels {
  return {
    section: {
      title: t('agent.settings.permission.section.title'),
      hint: t('agent.settings.permission.section.hint'),
    },
    loading: t('agent.settings.permission.loading'),
    unreadable: t('agent.settings.permission.unreadable'),
    retry: t('agent.settings.retry'),
    states: {
      written: t('agent.settings.permission.states.written'),
      engineOwn: t('agent.settings.permission.states.engineOwn'),
      notThisHost: t('agent.settings.permission.states.notThisHost'),
    },
    rules: {
      title: t('agent.settings.permission.rules.title'),
      empty: t('agent.settings.permission.rules.empty'),
      tool: t('agent.settings.permission.rules.tool'),
      action: t('agent.settings.permission.rules.action'),
    },
    options: {
      title: t('agent.settings.permission.options.title'),
      hint: t('agent.settings.permission.options.hint'),
      none: t('agent.settings.permission.options.none'),
      noInvention: t('agent.settings.permission.options.noInvention'),
    },
    origin: {
      host: t('agent.settings.origin.host'),
      engine: t('agent.settings.origin.engine'),
      session: t('agent.settings.origin.session'),
    },
    limits: {
      title: t('agent.settings.permission.limits.title'),
      notASandbox: t('agent.settings.permission.limits.notASandbox'),
      noIsolation: t('agent.settings.permission.limits.noIsolation'),
      staleRequests: t('agent.settings.permission.limits.staleRequests'),
      noSilentApproval: t('agent.settings.permission.limits.noSilentApproval'),
    },
  }
}

</script>

<script setup lang="ts">
/**
 * The permission section — §6.3, and §8.1's `permission` half.
 *
 * The acceptance clause is 「禁用真实生效」's neighbour, and it is the same rule read the other way:
 * a permission UI that displays a control the runtime does not honour is worse than one with no
 * control at all. So there are no controls here, and the page says why in three places:
 *
 *  - **The options belong to the engine.** §6.3: 「授权 UI 使用引擎提供的选项与 option ID，不能自行发明
 *    『永久允许』」. The engine's own P0 measurement is that it *does* offer one (`allow_always`, option
 *    id `always`) — so this app neither hides it nor invents it, and the page states that whatever is
 *    on offer came with the request.
 *  - **The settings belong to the engine.** What the engine asks about lives in its own configuration
 *    document, which §3.4.5 leaves to a verified adapter; this page reports where those settings come
 *    from instead of offering an editor for a format this task does not own.
 *  - **Nothing here is a sandbox.** §6.3's closing paragraph is the sentence this page exists to keep
 *    in front of a user: 「ACP 不是安全沙箱」, and 「此能力未完成前，UI 不能展示"已完全隔离"」. Both are
 *    drawn as limitations rather than as a footnote, because the failure mode they prevent — a user
 *    believing a workspace restriction is enforcement — is silent.
 */
import { computed, onMounted, ref } from 'vue'
import AgentPermissionGrants from './AgentPermissionGrants.vue'
import type { SettingOrigin } from '../index'
import type { PermissionState } from '../services/agent-settings-policy'
import type {
  AgentPermissionClient,
  PermissionLimitId,
  PermissionReadout,
} from '../services/agent-permission-ipc'

/**
 * The port and its readout are declared by their *implementation* now, and imported rather than
 * repeated.
 *
 * They were declared in this file while nothing implemented them — a page describing a backend that
 * did not exist. One does now (`services/agent-permission-ipc.ts`, over the profile the session
 * path also writes through), and a second copy of the same types here would be a second place for
 * the two to disagree — the disagreement being a page rendering a state the client never sends.
 * `<script setup>` cannot re-export them, so the port's name lives in `services/`; nothing outside
 * this page imported the old ones.
 */
const props = defineProps<{
  client: AgentPermissionClient
  labels?: AgentPermissionLabels
}>()

/**
 * The sentence for the state, which is what says whether the rows below are in force.
 *
 * Exhaustive on purpose: a fourth arm added to `PermissionState` fails to compile here, so a page
 * cannot end up rendering an empty explanation for a state somebody just introduced.
 */
function stateText(state: PermissionState): string {
  const copy = labels.value.states
  if (state === 'written') return copy.written
  if (state === 'engine-own') return copy.engineOwn
  return copy.notThisHost
}

const labels = computed<AgentPermissionLabels>(() => props.labels ?? permissionLabels())
const readout = ref<PermissionReadout | null>(null)
const state = ref<'loading' | 'ready' | 'unreadable'>('loading')

/**
 * The rules readout, and only while it is the read this page holds.
 *
 * `state` decides rather than `readout` alone, because a retry that fails leaves the last
 * successful answer in the ref while this half goes back to `unreadable` — rows drawn from that
 * value would be this page showing rules it can no longer say are current, which is the one thing
 * the states below exist to avoid.
 *
 * It is a `computed` because the gate is asked in two places. The grants block sits between the two
 * parts of the rules half — under the rules they are an answer to, which is where this page wants
 * it — so that half is drawn in two branches rather than one. The repetition is the point: one
 * branch would put the grants block back inside *this* read's success path, which is the defect
 * `AgentPermissionGrants.vue`'s own module comment names ("the two answer different questions") and
 * the reason a failed profile read must not take the revoke control off the page. See
 * `AgentPermissionSettings.test.ts`.
 */
const profileRead = computed<PermissionReadout | null>(() =>
  state.value === 'ready' ? readout.value : null,
)

function originText(origin: SettingOrigin): string {
  const copy = labels.value.origin
  if (origin.kind === 'host') {
    return origin.variable === null ? `${copy.host}: ${origin.path}` : `${copy.host}: ${origin.variable} = ${origin.path}`
  }
  if (origin.kind === 'engine') return `${copy.engine}: ${origin.what}`
  return `${copy.session}: ${origin.what}`
}

function limitText(limit: PermissionLimitId): string {
  const copy = labels.value.limits
  switch (limit) {
    case 'not-a-sandbox':
      return copy.notASandbox
    case 'no-isolation':
      return copy.noIsolation
    case 'stale-requests':
      return copy.staleRequests
    case 'no-silent-approval':
      return copy.noSilentApproval
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
  <section class="settings-section permission">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <!-- The rules half: what the engine will *ask*, read from the profile's own document. Its own
         read, its failure, its retry — and nothing else on this page is inside them. -->
    <span v-if="state === 'loading'" class="settings-note" data-test="permission-loading">
      {{ labels.loading }}
    </span>
    <template v-else-if="state === 'unreadable'">
      <span class="settings-note is-error" data-test="permission-unreadable">{{ labels.unreadable }}</span>
      <button type="button" class="permission-button" data-test="permission-retry" @click="load">
        {{ labels.retry }}
      </button>
    </template>

    <template v-else-if="profileRead">
      <!-- What this app did about permissions for this profile, above the list it explains: the
           state is what turns "these are the rules" into "these are the rules in force", and the
           two states where they are not in force are the ones a user most needs said out loud. -->
      <p
        class="settings-note"
        data-test="permission-state"
        :data-state="profileRead.state"
      >
        {{ stateText(profileRead.state) }}
      </p>

      <div class="permission-group">
        <span class="settings-label">{{ labels.rules.title }}</span>
        <span v-if="profileRead.rules.length === 0" class="settings-note" data-test="permission-no-rules">
          {{ labels.rules.empty }}
        </span>
        <ul v-else class="permission-rows">
          <li
            v-for="rule in profileRead.rules"
            :key="rule.tool"
            class="permission-row"
            :data-test="`permission-rule-${rule.tool}`"
          >
            <div class="permission-head">
              <code class="permission-name">{{ rule.tool }}</code>
              <span class="permission-badge">{{ rule.action }}</span>
            </div>
            <span class="settings-note permission-origin" :data-origin="rule.origin.kind">
              {{ originText(rule.origin) }}
            </span>
          </li>
        </ul>
      </div>
    </template>

    <!-- The grants the user actually gave, directly under the rules they are an answer to:
         "what the engine will ask" and "what you have already answered for good" are the two
         halves of the same question, and this is the half that can be taken back.

         It is drawn **outside** the branch above, on its own authority — its own read, its own
         failure, its own retry, all inside `AgentPermissionGrants.vue`. The two halves answer
         different questions (that component's own module comment), so neither may be gated by the
         other's read: an unreadable profile document is exactly when a user needs to see, and be
         able to take back, what the engine wrote down after they answered "always". Gating this
         block on the profile read is what hid the only lasting-permission control this app has. -->
    <AgentPermissionGrants :client="props.client" />

    <!-- The rest of the rules half, in a branch of its own rather than a shared one — the gate is
         repeated, not widened, so the grants block above cannot end up inside it again. -->
    <template v-if="profileRead">
      <div class="permission-group">
        <span class="settings-label">{{ labels.options.title }}</span>
        <span class="settings-note">{{ labels.options.hint }}</span>
        <span v-if="profileRead.optionKinds.length === 0" class="settings-note" data-test="permission-no-options">
          {{ labels.options.none }}
        </span>
        <ul v-else class="permission-rows" data-test="permission-options">
          <li v-for="kind in profileRead.optionKinds" :key="kind" class="settings-note permission-name">
            {{ kind }}
          </li>
        </ul>
        <span class="settings-note is-warn" data-test="permission-no-invention">
          {{ labels.options.noInvention }}
        </span>
      </div>

      <div class="permission-group">
        <span class="settings-label">{{ labels.limits.title }}</span>
        <ul class="permission-rows">
          <li
            v-for="limit in profileRead.limits"
            :key="limit"
            class="settings-note is-warn permission-limit"
            :data-test="`permission-limit-${limit}`"
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
.permission-group { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.permission-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.permission-row { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.permission-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.permission-name { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-text); overflow-wrap: anywhere; }
.permission-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--app-border); color: var(--app-muted); white-space: nowrap; }
.permission-origin { overflow-wrap: anywhere; }
.permission-limit { list-style: none; }
.permission-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
</style>
