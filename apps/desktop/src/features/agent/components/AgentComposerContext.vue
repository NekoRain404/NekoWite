<script lang="ts">
/**
 * The `+` control's copy, overridable by whoever wires it up.
 *
 * The defaults come from the catalogue (`src/i18n/namespaces/agent.ts`), the way
 * `AgentCommandMenu`'s do: the keys exist, so a caller that wants other words can pass them and a
 * caller that does not gets the translated ones. It is not threaded through `AgentPanelLabels`
 * because the panel builds that tree in a file this change does not own — the same seam the vault
 * comes through below.
 */
export interface AgentComposerContextLabels {
  /** The button's accessible name and its tooltip: what the control adds to the message. */
  add: string
  /** The `+` when no session is on screen, so there is no folder to read. */
  noFolder: string
  /** Names the list for a screen reader. */
  list: string
  /** A listing is on its way. */
  reading: string
  /** The folder holds nothing to offer. */
  empty: string
  /** The row that walks one level up. */
  up: string
}
</script>

<script setup lang="ts">
/**
 * The composer's `+`: the files of the folder the agent works in, inserted into the message.
 *
 * Zed's composer puts an "Add Context" menu at the left of its bottom row
 * (`zed-main/crates/agent_ui/src/conversation_view/thread_view.rs:5505`'s `render_add_context_button`,
 * menu built at `:5538`), and what a row does there is insert a *mention* into the message text
 * (`thread_view.rs:5578`). This is that control with the one kind of context this app can deliver
 * today: the message is the only channel a turn has (`AgentGateway.prompt(session, text)`), so a
 * chosen file becomes its vault-relative path in the draft and nothing more is claimed — the
 * engine's own tools read it or do not. `services/agent-context-references.ts` owns what a row may
 * name and what a chosen row becomes.
 *
 * Three things it deliberately does not do:
 *
 *  - **It does not offer an attachment.** The host builds one `ContentBlock::Text` per prompt
 *    (`src-tauri/src/agent_runtime/acp_transport/calls.rs`, `EngineConnection::prompt`), whatever
 *    the engine's `promptCapabilities.image` says, so an "attach an image" row would promise a model
 *    something this app cannot send. For the same reason the capability report governs nothing here:
 *    a path in the message is text on every engine, and a row that needed a capability would be
 *    claiming the file itself travels.
 *  - **It does not read the session's own state.** Only the vault, and only to list it: the rows are
 *    the folder's, the draft is the composer's, and no frame, run or permission is touched. The vault
 *    comes from the store's active record because this component cannot be given it any other way —
 *    `AgentPanel.vue` is the one file that could pass `session.identity.vaultId` down and it belongs
 *    to the right-hand group's work; the active record IS the session the composer beside it sends
 *    to, so the folder listed is that session's own rather than whatever the window last opened.
 *  - **It does not stay open across a vault switch.** The vault that was listed is captured before
 *    the await and the answer is dropped when it no longer matches — §7.1's rule that an async gap
 *    may not re-read what is current and serve it under the name of what was asked for.
 *
 * The list itself is `AgentReferenceMenu.vue`; what is here is the button, which folder is being
 * read, and the state that says whether the list is up.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CornerLeftUp, FileText, Folder, FolderOpen, Loader, Plus } from 'lucide-vue-next'
import { fsService } from '../../../platform/gateways/fs'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import { useAgentSessionStore } from '../stores/agent-session'
import {
  referenceText,
  toFolder,
  type AgentFileReference,
  type AgentReferenceFolder,
} from '../services/agent-context-references'
import AgentReferenceMenu, { type AgentReferenceRow } from './AgentReferenceMenu.vue'

const props = defineProps<{
  /** Overrides for the default copy; see {@link AgentComposerContextLabels}. */
  labels?: Partial<AgentComposerContextLabels>
}>()

const emit = defineEmits<{
  /** The reader picked this file. The text is vault-relative and `/`-separated. */
  insert: [path: string]
}>()

const labels = computed((): AgentComposerContextLabels => ({
  add: t('agent.panel.composer.context.add'),
  noFolder: t('agent.panel.composer.context.noFolder'),
  list: t('agent.panel.composer.context.list'),
  reading: t('agent.panel.composer.context.reading'),
  empty: t('agent.panel.composer.context.empty'),
  up: t('agent.panel.composer.context.up'),
  ...props.labels,
}))

/** The folder the session works in, or null while no session is on screen. */
const vaultId = computed(() => useAgentSessionStore().activeRecord?.identity.vaultId ?? null)

/** The control and the list share it: a click inside either is not a dismissal, and a click
 *  anywhere else is. */
const anchor = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
/** Whether the list is up. */
const open = ref(false)
/** Which directory is being listed, vault-relative; `''` is the vault root. */
const directory = ref('')
/** The listing, or null while it is being read. */
const folder = ref<AgentReferenceFolder | null>(null)

/** The menu's own three rows. Prefixed so that an entry's path can never be one of them. */
const UP = '#up'
const READING = '#reading'
const EMPTY = '#empty'

/** The rows' ids: kind and path, so the row that was picked and the reference it names cannot be
 *  confused with each other — and so no file's name can collide with a row of the menu's own. */
function idOf(entry: AgentFileReference): string {
  return `${entry.isDirectory ? 'dir' : 'file'}:${entry.path}`
}

const rows = computed((): AgentReferenceRow[] => {
  const held = folder.value
  if (held === null) {
    return [{ id: READING, label: labels.value.reading, icon: Loader, disabled: true }]
  }
  const list: AgentReferenceRow[] = []
  if (held.parent !== null) {
    list.push({ id: UP, label: labels.value.up, icon: CornerLeftUp })
  }
  for (const entry of held.entries) {
    list.push({
      id: idOf(entry),
      label: entry.name,
      icon: entry.isDirectory ? Folder : FileText,
    })
  }
  // Said out loud rather than left as a list with only "up" in it: an empty folder and a folder
  // whose rows failed to arrive would otherwise look the same.
  if (held.entries.length === 0) {
    list.push({ id: EMPTY, label: labels.value.empty, icon: FolderOpen, disabled: true })
  }
  return list
})

async function load(dir: string): Promise<void> {
  const vault = vaultId.value
  // No session, no folder to read. The button is disabled in this state as well; this is the same
  // refusal at the call, so a store change between the render and the click cannot open a list
  // that would show nothing.
  if (vault === null) return
  directory.value = dir
  folder.value = null
  try {
    const entries = await fsService.list(vault, dir)
    // The answer belongs to the folder that was asked about, in the vault that asked. A vault
    // switch, a walk into another directory, or a closed list each make it stale.
    if (vault !== vaultId.value || directory.value !== dir || !open.value) return
    folder.value = toFolder(dir, entries, vault)
  } catch (error) {
    if (vault !== vaultId.value || directory.value !== dir || !open.value) return
    dismiss(true)
    // A refusal is shown with the backend's own words (§7.2), not summarised into a sentence
    // that would leave the reader guessing what failed.
    const detail = error instanceof Error ? error.message : String(error)
    notifyError(t('agent.panel.composer.context.unreadable', { detail }))
  }
}

/**
 * Close the list.
 *
 * `restoreFocus` is the difference between the two ways out, and it is `ui/ContextMenu.vue`'s rule
 * rather than this component's invention: a **keyboard** dismissal puts focus back on the control
 * the reader opened (they have nowhere else to be, and the row they were on is about to stop
 * existing), while a click somewhere else leaves focus to the click. Choosing a row does not come
 * through here at all — the composer takes focus into the message, which is where the next word
 * goes.
 */
function dismiss(restoreFocus = false): void {
  open.value = false
  folder.value = null
  if (restoreFocus) trigger.value?.focus()
}

function toggle(): void {
  if (open.value) {
    dismiss(true)
    return
  }
  open.value = true
  // At the root every time: the control adds a file, and reopening it in whatever directory the
  // last visit ended in made the second click look like a different button.
  void load('')
}

/** A pointer anywhere but the control and its list. Captured, so a click stopped by something
 *  inside the panel still counts as "outside the menu". */
function onPointerDown(event: PointerEvent): void {
  if (!open.value) return
  if (anchor.value?.contains(event.target as Node)) return
  dismiss()
}

// Registered for the component's whole life rather than while the list is up: the listener is what
// closes it, so a list that opened between the two would be a list nothing can dismiss.
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
})

function onSelect(id: string): void {
  const held = folder.value
  if (held === null) return
  if (id === UP) {
    if (held.parent === null) return
    void load(held.parent)
    return
  }
  const entry = held.entries.find((row) => idOf(row) === id)
  if (entry === undefined) return
  const text = referenceText(entry)
  // A folder in the list is walked into, never inserted: `referenceText` answers null for one and
  // this is the branch that follows it. The list stays up, because the reader asked to see what is
  // inside rather than to put the control away.
  if (text === null) {
    void load(entry.path)
    return
  }
  open.value = false
  folder.value = null
  emit('insert', text)
}
</script>

<template>
  <span
    ref="anchor"
    class="agent-context-anchor"
  >
    <button
      ref="trigger"
      class="agent-context-add"
      type="button"
      :title="vaultId === null ? labels.noFolder : labels.add"
      :aria-label="labels.add"
      aria-haspopup="menu"
      :aria-expanded="open"
      :disabled="vaultId === null"
      data-action="context"
      @click="toggle"
    >
      <Plus
        :size="14"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>
    <Transition name="v">
      <AgentReferenceMenu
        v-if="open"
        :rows="rows"
        :label="labels.list"
        @select="onSelect"
        @close="dismiss(true)"
        @leave="dismiss()"
      />
    </Transition>
  </span>
</template>

<style scoped>
.agent-context-anchor {
  position: relative;
  display: inline-flex;
  flex: none;
  /* The row it sits in distributes its children with `space-between`, and a third child turned that
     into "the hint floats in the middle": this asks for the free space instead, which is what keeps
     the hint beside the control it describes. On this element rather than on the row, because the
     row is shared with the right-hand end of the bar. */
  margin-right: auto;
}
/* The composer's own action button, by value: `AgentComposer.vue` scopes its rule to itself and a
   scoped style cannot be shared across two components. Both read the same tokens — border, radius,
   elevation, the fast motion rung — so the three controls in this row stay one control's width and
   one control's look, and a token change moves all of them. */
.agent-context-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* §5.3's minimum hit area, matching the send and stop buttons beside it. */
  width: 28px;
  height: 28px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-context-add:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-context-add:disabled {
  border-color: color-mix(in srgb, var(--app-border) 55%, transparent);
  background: transparent;
  color: var(--app-muted);
  cursor: default;
  opacity: 0.55;
}
.agent-context-add:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
