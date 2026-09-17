<script lang="ts">
/**
 * The ACP catalogue, as a browser: what the public registry publishes, and nothing it does not.
 *
 * Exported for the reason `AgentRegistrySettings.vue` exports its own type: a caller importing this
 * component and wanting the shape of its `labels` prop names this type, so the shape a caller
 * depends on has a name.
 */
export interface CataloguePrefill {
  agentId: string
  displayName: string
  program: string
  args: readonly string[]
}

export type { AgentCatalogueLabels } from './agent-catalogue-labels'
</script>

<script setup lang="ts">
/**
 * The catalogue section: one card per registry entry, drawn from what the backend parsed.
 *
 * **Two rules decide the drawing, and both are negatives.**
 *
 * 1. *Nothing here promises a capability.* A catalogue entry describes a program nobody has run —
 *    an id, a version, a URL — and what an engine can *do* is established by a handshake and a
 *    session negotiation (§3.4's capability row). So no row draws a feature, a slash command or a
 *    configuration control, and every row carries the same sentence saying why: the row shows what
 *    a publisher wrote, and the engine's own answer arrives only after it is started. That is
 *    「不能让按钮看起来可用、点击后才发现不支持」 at the level of what may be rendered at all.
 *
 * 2. *Nothing is offered that cannot be done.* Whether a control exists is
 *    `catalogueAction`'s answer and never a condition written here — one of the four standings
 *    produces a control, and the other three produce a sentence giving their own reason (a download
 *    this app may not make, a machine this app cannot run on, a kind it cannot describe). The
 *    backend's §3.3 gate list is drawn once for the section, so the refusal arrives with its reason
 *    rather than as a button that is merely absent.
 *
 * The one action that does exist hands the entry to the add form above: it prefills a program and
 * an argument *array* (§3.4.3 — the two are never joined into a command line), and the section
 * holds no `add` of its own. Registration stays in one place.
 */
import { computed, onMounted, ref } from 'vue'
import { catalogueAction, untransferableGates, type CatalogueRow, type CatalogueReadout } from '../services/agent-catalogue-policy'
import type { AgentCatalogueClient } from '../services/agent-catalogue-policy'
import { catalogueLabels, type AgentCatalogueLabels } from './agent-catalogue-labels'
import { fillTemplate } from '../services/agent-registry-policy'

const props = withDefaults(
  defineProps<{
    client: AgentCatalogueClient
    labels?: AgentCatalogueLabels
  }>(),
  { labels: undefined },
)

const emit = defineEmits<{ (event: 'use', prefill: { agentId: string; displayName: string; program: string; args: readonly string[] }): void }>()

const labels = computed<AgentCatalogueLabels>(() => props.labels ?? catalogueLabels())
const readout = ref<CatalogueReadout | null>(null)
const loadState = ref<'loading' | 'ready' | 'unreadable'>('loading')
const rows = computed<readonly CatalogueRow[]>(() => readout.value?.rows ?? [])
const used = ref<string | null>(null)

async function load(): Promise<void> {
  loadState.value = 'loading'
  try {
    readout.value = await props.client.readCatalogue()
    loadState.value = 'ready'
  } catch {
    // A rejection is the call not completing — a shape this window could not read. That is a fact
    // about this window and not about the registry, so it is its own state rather than "no agents".
    loadState.value = 'unreadable'
  }
}

onMounted(load)

/** The sentence for a row's standing, with the row's own facts filled into its slots. */
function standingText(row: CatalogueRow): string {
  const copy = labels.value
  const standing = row.standing
  switch (standing.kind) {
    case 'via-package-manager':
      return fillTemplate(copy.standing['via-package-manager'], { manager: standing.manager })
    case 'archive-only':
      return fillTemplate(copy.standing['archive-only'], {
        platform: standing.platform,
        reason: fillTemplate(copy.gates.hint, { checks: untransferableGates(readout.value ?? empty()).join(', ') }),
      })
    case 'unsupported':
      return fillTemplate(copy.standing.unsupported, { published: standing.published.join(', ') })
    case 'unrecognised':
      return fillTemplate(copy.standing.unrecognised, { kinds: standing.kinds.join(', ') })
  }
}

/** The readout an absent one stands in as, so a slot is never filled from nothing. */
function empty(): CatalogueReadout {
  return { registryVersion: '', freshness: 'unavailable', note: null, rows: [], offerable: 0, installGates: [] }
}

/** The freshness line, drawn above the rows so a stale listing is never mistaken for a current one. */
const freshnessText = computed<string | null>(() => {
  const current = readout.value
  if (current === null) return null
  const copy = labels.value
  if (current.freshness === 'current') return copy.freshness.current
  return fillTemplate(copy.freshness[current.freshness], { detail: current.note ?? '' })
})

function use(row: CatalogueRow): void {
  const action = catalogueAction(row)
  if (action.kind !== 'prefill') return
  emit('use', {
    agentId: action.agentId,
    displayName: action.displayName,
    program: action.program,
    args: action.args,
  })
  used.value = action.agentId
}
</script>

<template>
  <section class="settings-section catalogue">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="loadState === 'loading'" class="settings-note" data-test="catalogue-loading">{{ labels.list.loading }}</span>
    <template v-else-if="loadState === 'unreadable'">
      <span class="settings-note is-error" data-test="catalogue-unreadable">{{ labels.list.unreadable }}</span>
      <button type="button" class="registry-button" data-test="catalogue-retry" @click="load">{{ labels.list.retry }}</button>
    </template>

    <template v-else>
      <span v-if="freshnessText" class="settings-note" data-test="catalogue-freshness">{{ freshnessText }}</span>

      <!-- The reason there is no install control, drawn once for the section and only when there
           are rows to explain: the checks a registry entry cannot support. -->
      <p v-if="rows.length > 0" class="settings-note catalogue-gates" data-test="catalogue-gates">
        {{ labels.gates.title }} —
        {{ fillTemplate(labels.gates.hint, { checks: untransferableGates(readout ?? empty()).join(', ') }) }}
      </p>

      <span v-if="rows.length === 0" class="settings-note" data-test="catalogue-empty">{{ labels.list.empty }}</span>

      <ul class="catalogue-rows">
        <li v-for="row in rows" :key="row.id" class="catalogue-row" :data-test="`catalogue-row-${row.id}`">
          <div class="catalogue-head">
            <span class="catalogue-name">{{ row.name }}</span>
            <span class="catalogue-badge">{{ fillTemplate(labels.list.version, { version: row.version }) }}</span>
          </div>
          <span class="settings-note catalogue-description">{{ row.description }}</span>
          <span class="settings-note catalogue-id">ID: {{ row.id }}</span>
          <span v-if="row.authors.length > 0" class="settings-note catalogue-authors">{{ row.authors.join(', ') }}</span>

          <!-- What the entry PUBLISHES, about a process. Never what the engine can do. -->
          <span class="settings-note catalogue-standing">{{ standingText(row) }}</span>
          <!-- Drawn on every row, whatever its standing is: the same sentence the capability report
               answers `unverified` with, said where a user would otherwise expect a feature list. -->
          <span class="settings-note catalogue-unverified" :data-test="`catalogue-unverified-${row.id}`">{{ labels.unverified }}</span>

          <span v-if="row.defects.length > 0" class="settings-note is-warn catalogue-defects" :data-test="`catalogue-defects-${row.id}`">
            {{ labels.defects.title }}: {{ row.defects.join(' ') }}
          </span>

          <span class="catalogue-links">
            <span v-if="row.license" class="settings-note">{{ fillTemplate(labels.license, { license: row.license }) }}</span>
            <a v-if="row.licenseUrl" :href="row.licenseUrl" target="_blank" rel="noreferrer" class="catalogue-link">{{ labels.licenseLink }}</a>
            <a v-if="row.repository" :href="row.repository" target="_blank" rel="noreferrer" class="catalogue-link">{{ labels.repository }}</a>
            <a v-if="row.website" :href="row.website" target="_blank" rel="noreferrer" class="catalogue-link">{{ labels.website }}</a>
          </span>

          <!-- The control exists only where one can run: `catalogueAction` decides, not this
               template. A row with no control draws none at all — never a disabled one, which
               would claim the shape of an action that is merely unavailable. -->
          <button
            v-if="catalogueAction(row).kind === 'prefill'"
            type="button"
            class="registry-button"
            :data-test="`catalogue-use-${row.id}`"
            @click="use(row)"
          >
            {{ labels.action.use }}
          </button>
          <span v-if="used === row.id" class="settings-note" :data-test="`catalogue-used-${row.id}`">
            {{ fillTemplate(labels.action.used, { agentId: row.id }) }}
          </span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
/* The `.settings-*` classes are restated here, as they are in every section that renders them: a
   scoped block belongs to the component that renders the element. */
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.catalogue-rows { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.catalogue-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
}
.catalogue-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.catalogue-name { font-size: 12px; font-weight: 600; color: var(--app-text); }
.catalogue-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--app-border); color: var(--app-muted); white-space: nowrap; }
.catalogue-id, .catalogue-authors { font-family: var(--app-mono-font); }
/* The two sentences that carry the section's whole point, given a left rule so they read as a
   standing fact about the row rather than as another field. */
.catalogue-standing { border-left: 2px solid var(--app-border); padding-left: 8px; color: var(--app-text); }
.catalogue-unverified { border-left: 2px solid var(--app-border); padding-left: 8px; }
.catalogue-gates { margin: 0; }
.catalogue-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.catalogue-link { font-size: 11px; color: var(--app-accent); text-decoration: none; }
.catalogue-link:hover { text-decoration: underline; }
.registry-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
</style>
