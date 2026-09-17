<script lang="ts">
/**
 * The compatibility surface for this section's copy: the vocabulary and the builder that reads the
 * catalogue now live in `agent-skills-labels.ts`, and the two types are re-exported here.
 *
 * The re-export is not decoration. The specifier callers already name is *this file* —
 * `features/agent-settings/index.ts` exports `AgentSkillsLabels` from
 * `./components/AgentSkillsSettings.vue` — and an SFC's named type exports are what such a specifier
 * resolves against. A split keeps the old path working; moving the definition is a change to where
 * the copy lives, while moving the name a caller imports would be a change to the caller.
 */
export type { AgentSkillsLabels, SkillRefusalKind } from './agent-skills-labels'
</script>

<script setup lang="ts">
/**
 * The skills section — §8.2, and the page the row's two behaviour clauses are visible on.
 *
 * The two clauses are 「导入不执行脚本」 and 「禁用真实生效」, and this page's whole part in them is to
 * not be the place they are faked:
 *
 *  - **Import is two steps, and the first one is a read.** {@link SkillPreviewView} names every file
 *    and, separately, the ones the engine may later run as scripts — and says in as many words that
 *    nothing has run. The confirmation is a second, deliberate action; the backend enforces the same
 *    thing independently (`skills.rs` has no process in it at all), so this page's copy is a
 *    description of a property rather than the mechanism that provides it.
 *  - **Replace is a separate button, and it says what it does not lose.** §8.2's 「覆盖必须确认并保留
 *    可恢复副本」. A `name-taken` refusal is rendered as the conflict it is, with a *second* control
 *    that only appears once the first attempt has failed — so replacing is never the default path.
 *  - **A directory this app cannot affect gets no control.** {@link SkillDisableView} has three arms,
 *    and two of them draw text instead of a switch: one names the engine's own variable, the other
 *    states that no such switch exists. §8.2: 「不能仅隐藏 UI 项目而声称已禁用」 — a checkbox that
 *    only hid a row would be exactly that, so there is nothing to hide.
 *  - **A configured directory is not a contributing one.** A scope the engine's rules name can be
 *    one this launch does not read — that is what the app-managed launch's own switch does to
 *    `.claude` and `.agents` — so every row carries the scope's state ({@link SkillEntryView.suppressedBy})
 *    beside what the engine would do with the skill itself. The two answer different questions and
 *    the page asks both: §8.2 wants the 来源目录 and the 实际权限状态, and a row that merged them
 *    would have to drop one.
 *
 * The conflict line is the third thing worth reading. What was observed of the pinned engine is
 * that two skills with one name both load and whichever wins is not settled by anything this host
 * can see — and that is an observation of a version, not a precedence to report, so this page names
 * every other directory and nominates no winner. A page that picked one would be stating a rule the
 * engine has not agreed to, and the user would then fix the copy that may not have been in effect.
 *
 * ## Two absences this page states, and one control it does not draw
 *
 * §5.2's 「不可用选项要说明原因，不显示可点击但无效果的控件」 is why the two are sentences rather than
 * greyed rows, and the reasons are the ones the backend really has:
 *
 *  - **A project's own skills.** The engine reads `.opencode/skills` in the folder a session runs
 *    in. Which project a settings dialog would be managing is not a question this page (or its
 *    backend) can answer — it opens with or without a vault, and it is about an engine profile
 *    rather than about a folder — so `opencode_scopes_without_project` builds the scope list
 *    without that arm, and the sentence says what the missing control would have needed.
 *  - **Folders the engine's own configuration declares.** A `skills.paths` entry is a member of the
 *    engine's configuration document, which this page does not parse (the configuration page shows
 *    that document as text; a second parser would be a second answer about the same file). A skill
 *    reachable only through one is therefore not listed, and the sentence says so rather than
 *    leaving the omission to be discovered.
 *
 * Every directory that *is* listed gets its own heading, its root and — when it holds nothing — its
 * own sentence, because "the engine finds no skills" is a claim about one directory at a time.
 * Zed's skills page draws the same per-scope empty state; here a directory this launch stopped
 * reading says *that* instead of "no skills", which is the flattering-direction claim this whole
 * page exists to avoid. And the import control is drawn only where the readout names a directory
 * this host may write in (`importScope`): a profile reusing the user's own installation has none,
 * and a form whose only possible outcome is a refusal is not a control.
 */
import { computed, onMounted, ref } from 'vue'

import {
  skillsLabels,
  type AgentSkillsLabels,
  type SkillRefusalKind,
} from './agent-skills-labels'

/** A refusal as the backend sends it: its kind, plus the facts that sentence carries. */
export interface SkillRefusal {
  kind: SkillRefusalKind
  [fact: string]: unknown
}

/** How a directory's contents can be switched off, as `skills.rs` reports it. */
export type SkillDisableView =
  | { kind: 'per-skill' }
  | { kind: 'engine-switch'; variable: string }
  | { kind: 'none' }

/** What the engine will do with a discovered skill. */
export type SkillSurfaceView =
  | { kind: 'offered' }
  | { kind: 'undescribed' }
  | { kind: 'suppressed'; variable: string }
  | { kind: 'unusable'; error: SkillRefusal }
  | { kind: 'disabled' }

export interface SkillEntryView {
  name: string
  description: string | null
  directory: string
  scope: string
  scopeLabel: string
  owner: 'managed' | 'engine' | 'foreign'
  conflicts: string[]
  surface: SkillSurfaceView
  /** The engine's switch that is on for this row's *scope*, or `null` if none is (see the file
      comment: a directory that is configured and one that contributes are two facts). */
  suppressedBy: string | null
  disable: SkillDisableView
}

/** One directory the engine's rules name, as the readout describes it. */
export interface SkillScopeView {
  id: string
  label: string
  root: string
  /** The engine's own switch that stops it reading this directory, or `null` if it reads it. */
  suppressedBy: string | null
}

export interface AgentSkillsReadout {
  /** Every directory the engine's rules name — the page draws one heading per entry. */
  scopes: SkillScopeView[]
  skills: SkillEntryView[]
  disabled: SkillEntryView[]
  /**
   * The scope an import would install into, or `null` when this profile has none.
   *
   * A scope *id* into {@link AgentSkillsReadout.scopes} rather than a path: what the page needs is
   * where the control would write, and where that is is the backend's answer — the same predicate
   * `SkillLibrary::import` refuses on, so a page offering an import the backend would refuse (or
   * omitting one it would accept) cannot be built from this readout.
   */
  importScope: string | null
}

/** What an import would install, read from the folder and written nowhere. */
export interface SkillPreviewView {
  name: string
  description: string
  files: { path: string; bytes: number }[]
  scripts: { path: string; bytes: number }[]
  totalBytes: number
}

/**
 * The backend, chosen at the composition site.
 *
 * Two failure channels, kept apart as they are everywhere else in this tree: a **rejection** is the
 * call not completing and the page says so; a **refusal** is data that comes back and is rendered.
 *
 * The read carries both, and `preview` already did: an arrangement the backend refuses to build a
 * library from (this host's store lying inside a directory the engine scans) is not a broken
 * connection, and answering it as one would leave the page's "could not be read from the backend"
 * standing over a backend that answered with a reason.
 */
export interface AgentSkillsClient {
  read(): Promise<AgentSkillsReadout | SkillRefusal>
  preview(source: string): Promise<SkillPreviewView | SkillRefusal>
  import(source: string, replace: boolean): Promise<SkillRefusal | null>
  setEnabled(name: string, scope: string, enabled: boolean): Promise<SkillRefusal | null>
}

const props = defineProps<{
  client: AgentSkillsClient
  labels?: AgentSkillsLabels
}>()

const labels = computed<AgentSkillsLabels>(() => props.labels ?? skillsLabels())
const readout = ref<AgentSkillsReadout | null>(null)
const readRefusal = ref<SkillRefusal | null>(null)
const state = ref<'loading' | 'ready' | 'refused' | 'unreadable'>('loading')

const source = ref('')
const preview = ref<SkillPreviewView | null>(null)
const previewRefusal = ref<SkillRefusal | null>(null)
/** Set when the last import was refused for a taken name: the one path to the replace control. */
const replaceable = ref(false)
const importedName = ref<string | null>(null)
const busy = ref<string | null>(null)
const actionFailed = ref(false)
const rowRefusals = ref<Record<string, SkillRefusal | null>>({})

/** One substitution, for the facts a refusal carries. Facts are data; they do not go through copy. */
function fill(template: string, facts: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => facts[key] ?? whole)
}

function refusalText(refusal: SkillRefusal | null): string {
  if (refusal === null) return ''
  const facts: Record<string, string> = {}
  for (const [key, value] of Object.entries(refusal)) {
    if (key !== 'kind' && (typeof value === 'string' || typeof value === 'number')) {
      facts[key] = String(value)
    }
  }
  return fill(labels.value.refusal[refusal.kind], facts)
}

function surfaceText(entry: SkillEntryView): string {
  const copy = labels.value.surface
  switch (entry.surface.kind) {
    case 'offered':
      return copy.offered
    case 'undescribed':
      return copy.undescribed
    case 'suppressed':
      return fill(copy.suppressed, { variable: entry.surface.variable })
    case 'unusable':
      return fill(copy.unusable, { reason: refusalText(entry.surface.error) })
    case 'disabled':
      return copy.disabled
  }
}

/**
 * Whether this row gets a control at all, and which sentence stands in its place when it does not.
 *
 * Two sentences rather than one, because the scope has two states and the sentence written for the
 * other one is false in each: a launch that sets the engine's variable is *not* reading this
 * directory — the app-managed launch sets it, so that is the ordinary case — and telling a user
 * there that "this launch does not set that variable" would be the flattering-direction claim the
 * whole readout exists to prevent. The switch is read off `suppressedBy`, the scope's own fact,
 * rather than inferred from `surface`: a row whose frontmatter is unusable has a surface that says
 * nothing about whether its directory is read.
 */
function switchNote(entry: SkillEntryView): string {
  if (entry.disable.kind === 'engine-switch') {
    return entry.suppressedBy === null
      ? fill(labels.value.disable.engineSwitch, { variable: entry.disable.variable })
      : fill(labels.value.disable.engineSwitchSet, { variable: entry.suppressedBy })
  }
  return labels.value.disable.noSwitch
}

/**
 * One directory's heading and the rows under it.
 *
 * Grouped here rather than in the backend, because the two questions are different: the backend
 * answers which directories the engine's rules name and what it found in each, and this is the
 * shape a page renders them in. A row whose directory the readout did not name still gets a group
 * — under the label the row itself carries — because a skill the engine reads may not be dropped by
 * a page that failed to look up its heading.
 */
interface ScopeGroup {
  id: string
  label: string
  /** The directory, or `''` when the group was built from a row rather than from the scope list. */
  root: string
  suppressedBy: string | null
  entries: SkillEntryView[]
}

const groups = computed<ScopeGroup[]>(() => {
  const held = readout.value
  if (held === null) return []
  const built: ScopeGroup[] = held.scopes.map((scope) => ({ ...scope, entries: [] }))
  const byId = new Map(built.map((group) => [group.id, group]))
  for (const entry of held.skills) {
    let group = byId.get(entry.scope)
    if (group === undefined) {
      group = {
        id: entry.scope,
        label: entry.scopeLabel,
        root: '',
        suppressedBy: entry.suppressedBy,
        entries: [],
      }
      byId.set(entry.scope, group)
      built.push(group)
    }
    group.entries.push(entry)
  }
  return built
})

/** Where an import would be written, when this profile has a directory this host owns. */
const importTargetRoot = computed<string | null>(() => {
  const held = readout.value
  if (held === null || held.importScope === null) return null
  const found = held.scopes.find((scope) => scope.id === held.importScope)
  return found?.root ?? null
})

async function load(): Promise<void> {
  state.value = 'loading'
  readRefusal.value = null
  try {
    const answer = await props.client.read()
    // A refusal is the backend answering: it says the arrangement itself is one this host will not
    // run under, and the sentence for that kind is already in the copy tree. Drawing the retry
    // here would offer a control that cannot change the arrangement.
    if ('kind' in answer) {
      readRefusal.value = answer
      state.value = 'refused'
      return
    }
    readout.value = answer
    state.value = 'ready'
  } catch {
    // "The engine finds no skills" is a claim about the engine; a failed read is a claim about the
    // connection. Telling them apart is the difference between two next moves for the user.
    state.value = 'unreadable'
  }
}

function resetImport(): void {
  preview.value = null
  previewRefusal.value = null
  replaceable.value = false
  importedName.value = null
  busy.value = null
}

async function readSource(): Promise<void> {
  resetImport()
  actionFailed.value = false
  busy.value = 'preview'
  try {
    const answer = await props.client.preview(source.value.trim())
    if ('kind' in answer) {
      previewRefusal.value = answer
      return
    }
    preview.value = answer
  } catch {
    actionFailed.value = true
  } finally {
    busy.value = null
  }
}

async function runImport(replace: boolean): Promise<void> {
  actionFailed.value = false
  busy.value = 'import'
  try {
    const refusal = await props.client.import(source.value.trim(), replace)
    if (refusal !== null) {
      // A taken name is the one refusal with a second step behind it, and the control for that step
      // only exists once this has happened.
      replaceable.value = refusal.kind === 'name-taken'
      previewRefusal.value = refusal
      return
    }
  } catch {
    actionFailed.value = true
    return
  } finally {
    busy.value = null
  }
  importedName.value = preview.value?.name ?? null
  preview.value = null
  previewRefusal.value = null
  replaceable.value = false
  await load()
}

async function toggle(entry: SkillEntryView, enabled: boolean): Promise<void> {
  rowRefusals.value = { ...rowRefusals.value, [entry.name]: null }
  actionFailed.value = false
  busy.value = entry.name
  try {
    const refusal = await props.client.setEnabled(entry.name, entry.scope, enabled)
    if (refusal !== null) {
      rowRefusals.value = { ...rowRefusals.value, [entry.name]: refusal }
      return
    }
  } catch {
    actionFailed.value = true
    return
  } finally {
    busy.value = null
  }
  // Re-read rather than patched locally: what has to be true is that the backend's next scan does
  // not find it, and a row this page updated by hand would say so whether or not that is so.
  await load()
}

onMounted(load)
</script>

<template>
  <section class="settings-section skills">
    <span class="settings-label">{{ labels.section.title }}</span>
    <span class="settings-note">{{ labels.section.hint }}</span>

    <span v-if="state === 'loading'" class="settings-note" data-test="skills-loading">
      {{ labels.loading }}
    </span>
    <!-- The refusal arm: the backend answered, and what it said is about the arrangement rather
         than about the connection. No retry below it — see `load`. -->
    <template v-else-if="state === 'refused'">
      <span class="settings-note is-error" data-test="skills-refused">
        {{ refusalText(readRefusal) }}
      </span>
    </template>
    <template v-else-if="state === 'unreadable'">
      <span class="settings-note is-error" data-test="skills-unreadable">{{ labels.unreadable }}</span>
      <button type="button" class="skills-button" data-test="skills-retry" @click="load">
        {{ labels.retry }}
      </button>
    </template>

    <template v-else-if="readout">
      <span v-if="groups.length === 0" class="settings-note" data-test="skills-empty">
        {{ labels.list.empty }}
      </span>
      <!-- One heading per directory the engine's rules name, with that directory's own sentence
           when it holds nothing. A directory this launch stopped reading says that, rather than
           "no skills", which would be a claim about contents nobody looked at. -->
      <div
        v-for="group in groups"
        :key="group.id"
        class="skills-scope"
        :data-test="`skill-scope-${group.id}`"
      >
        <span class="skills-scope-label">{{ group.label }}</span>
        <span v-if="group.root" class="settings-note skills-path">{{ group.root }}</span>
        <span
          v-if="group.entries.length === 0 && group.suppressedBy"
          class="settings-note"
          :data-test="`skill-scope-unread-${group.id}`"
        >
          {{ fill(labels.surface.suppressed, { variable: group.suppressedBy }) }}
        </span>
        <span
          v-else-if="group.entries.length === 0"
          class="settings-note"
          :data-test="`skill-scope-empty-${group.id}`"
        >
          {{ labels.list.emptyScope }}
        </span>
        <ul class="skills-rows">
          <li v-for="entry in group.entries" :key="`${entry.scope}/${entry.directory}`" class="skills-row" :data-test="`skill-row-${entry.name}`">
            <div class="skills-head">
              <span class="skills-name">{{ entry.name }}</span>
              <span class="skills-badge">{{ labels.owner[entry.owner] }}</span>
            </div>
            <span class="settings-note skills-description">
              {{ entry.description ?? labels.list.noDescription }}
            </span>
            <span class="settings-note">
              {{ labels.list.scope }}: {{ entry.scopeLabel }} — {{ labels.list.directory }}:
              <code class="skills-path">{{ entry.directory }}</code>
            </span>
            <span v-if="entry.conflicts.length > 0" class="settings-note is-warn skills-conflict" data-test="skill-conflict">
              {{ fill(labels.conflict, { directories: entry.conflicts.join(', ') }) }}
            </span>
            <span class="settings-note skills-surface" :data-surface="entry.surface.kind">
              {{ surfaceText(entry) }}
            </span>
            <span v-if="rowRefusals[entry.name]" class="settings-note is-error" data-test="skill-refusal">
              {{ refusalText(rowRefusals[entry.name]) }}
            </span>
            <!-- A control only where it can change what the engine reads. The other two arms draw
                 the reason instead, so there is nothing on screen that claims a disable it cannot
                 perform (§8.2). -->
            <div v-if="entry.disable.kind === 'per-skill'" class="skills-toggle">
              <span class="settings-note">{{ labels.disable.label }}</span>
              <button
                type="button"
                class="skills-button"
                :disabled="busy === entry.name"
                :data-test="`skill-disable-${entry.name}`"
                @click="toggle(entry, false)"
              >
                {{ labels.disable.disable }}
              </button>
            </div>
            <span v-else class="settings-note skills-no-switch" data-test="skill-no-switch">
              {{ switchNote(entry) }}
            </span>
          </li>
        </ul>
      </div>

      <!-- The two directories this page does not manage, stated with their real reasons rather
           than drawn greyed out (§5.2). Nothing below is a control. -->
      <div class="skills-unmanaged" data-test="skills-unmanaged">
        <span class="settings-label">{{ labels.unmanaged.title }}</span>
        <span class="settings-note" data-test="skills-project-scope">{{ labels.unmanaged.project }}</span>
        <span class="settings-note" data-test="skills-declared-scope">{{ labels.unmanaged.declared }}</span>
      </div>

      <div v-if="readout.disabled.length > 0" class="skills-disabled">
        <span class="settings-label">{{ labels.disabledList.title }}</span>
        <span class="settings-note">{{ labels.disabledList.hint }}</span>
        <ul class="skills-rows">
          <li v-for="entry in readout.disabled" :key="entry.directory" class="skills-row" :data-test="`skill-off-${entry.name}`">
            <span class="skills-name">{{ entry.name }}</span>
            <span class="settings-note skills-surface" data-surface="disabled">{{ surfaceText(entry) }}</span>
            <button
              type="button"
              class="skills-button"
              :disabled="busy === entry.name"
              :data-test="`skill-enable-${entry.name}`"
              @click="toggle(entry, true)"
            >
              {{ labels.disable.enable }}
            </button>
          </li>
        </ul>
      </div>

      <!-- The form only where there is a directory this host may write in. A profile reusing the
           user's own installation has none, and the sentence says what such a profile would need
           rather than drawing a control whose only possible answer is a refusal. -->
      <!-- The form only where there is a directory this host may write in. A profile reusing the
           user's own installation has none, and the sentence says what such a profile would need
           rather than drawing a control whose only possible answer is a refusal. -->
      <span
        v-if="!readout.importScope"
        class="settings-note skills-no-import"
        data-test="skills-no-import"
      >
        {{ labels.import.noTarget }}
      </span>
      <form v-else class="skills-import" @submit.prevent="readSource">
        <span class="settings-label">{{ labels.import.title }}</span>
        <span class="settings-note">{{ labels.import.hint }}</span>
        <span v-if="importTargetRoot" class="settings-note">
          {{ labels.import.target }}: <code class="skills-path">{{ importTargetRoot }}</code>
        </span>
        <label class="skills-field">
          <span>{{ labels.import.source }}</span>
          <input v-model="source" class="skills-input" data-test="skills-source">
        </label>
        <div class="skills-actions">
          <button type="submit" class="skills-button" data-test="skills-preview" :disabled="busy === 'preview'">
            {{ labels.import.preview }}
          </button>
          <span v-if="importedName" class="settings-note skills-ok" data-test="skills-imported">
            {{ fill(labels.import.done, { name: importedName }) }}
          </span>
          <span v-if="actionFailed" class="settings-note is-error" data-test="skills-action-failed">
            {{ labels.import.failed }}
          </span>
        </div>
      </form>

      <div v-if="previewRefusal" class="skills-actions">
        <span class="settings-note is-error" data-test="skills-preview-refusal">
          {{ refusalText(previewRefusal) }}
        </span>
        <template v-if="replaceable">
          <span class="settings-note is-warn" data-test="skills-replace-warning">
            {{ labels.import.replaceWarning }}
          </span>
          <button
            type="button"
            class="skills-button"
            :disabled="busy === 'import'"
            data-test="skills-replace"
            @click="runImport(true)"
          >
            {{ labels.import.replace }}
          </button>
        </template>
      </div>

      <div v-if="preview" class="skills-preview" data-test="skills-preview">
        <span class="settings-label">{{ labels.preview.title }}</span>
        <span class="settings-note skills-name">{{ preview.name }}</span>
        <span class="settings-note">
          {{ labels.preview.description }}: {{ preview.description || labels.list.noDescription }}
        </span>
        <span class="settings-note">{{ labels.preview.files }}:</span>
        <ul class="skills-files">
          <li v-for="file in preview.files" :key="file.path" class="settings-note skills-path">
            {{ file.path }} ({{ file.bytes }})
          </li>
        </ul>
        <span class="settings-note">{{ labels.preview.scripts }}:</span>
        <ul v-if="preview.scripts.length > 0" class="skills-files" data-test="skills-scripts">
          <li v-for="file in preview.scripts" :key="file.path" class="settings-note skills-path">
            {{ file.path }} ({{ file.bytes }})
          </li>
        </ul>
        <span v-else class="settings-note" data-test="skills-no-scripts">{{ labels.preview.noScripts }}</span>
        <span class="settings-note">{{ labels.preview.total }}: {{ preview.totalBytes }}</span>
        <!-- The sentence the acceptance is about, said where the files are listed. -->
        <span class="settings-note is-warn" data-test="skills-nothing-run">{{ labels.preview.nothingRun }}</span>
        <button
          type="button"
          class="skills-button"
          :disabled="busy === 'import'"
          data-test="skills-confirm"
          @click="runImport(false)"
        >
          {{ labels.import.confirm }}
        </button>
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
.skills-rows { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.skills-scope, .skills-unmanaged { display: flex; flex-direction: column; gap: 4px; }
.skills-scope-label { font-size: 12px; font-weight: 600; color: var(--app-text); }
.skills-unmanaged { padding-top: 8px; border-top: 1px solid var(--app-border); }
.skills-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); }
.skills-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.skills-name { font-size: 12px; font-weight: 600; color: var(--app-text); }
.skills-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--app-border); color: var(--app-muted); white-space: nowrap; }
.skills-path { font-family: var(--app-mono-font); overflow-wrap: anywhere; }
.skills-description { color: var(--app-text); }
.skills-toggle { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.skills-disabled, .skills-import, .skills-preview { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.skills-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.skills-field > span:first-child { color: var(--app-muted); font-size: 11px; }
.skills-input { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); color: var(--app-text); font-family: var(--app-mono-font); }
.skills-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.skills-files { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0 0 0 14px; list-style: none; }
.skills-ok { color: var(--app-accent); }
.skills-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.skills-button:disabled { opacity: 0.5; cursor: default; }
</style>
