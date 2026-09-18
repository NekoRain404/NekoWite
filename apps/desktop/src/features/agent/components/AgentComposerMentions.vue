<script setup lang="ts">
/**
 * The `@` list: typing the name of a note into the message, over the field it is being typed into.
 *
 * The rows are the workspace's own notes (`services/vault-files.ts`'s index, which is what the file
 * tree lists), and settling on one puts the file into the turn rather than its name into the text —
 * the same two outcomes `AgentComposer.vue`'s `pickFile` chooses between, for the same reason. The
 * typed word is taken out of the message when it settles, because the file is now a chip and the
 * half-written name is no longer what the reader meant to say; that edit is the composer's, which
 * owns the draft, so what leaves this component is the *path* that was named.
 *
 * **Its own positioning box**, because `AgentReferenceMenu` places itself against the element that
 * owns it and this is not the `+`'s control: it belongs to the field, and it opens upward from the
 * field's top edge. `position: relative` and no size of its own — it must not take a line of the
 * composer's height when it is empty.
 *
 * **Its keys are asked for from outside**, which is the one thing here that is not self-contained:
 * the reader types into the composer's field, so the keydown lands there rather than in this box,
 * and the composer asks this component *first* — before its own meaning of Enter and before the
 * engine's `/` menu — through the exposed `onKeydown`. What that answers with is the composable's
 * own vocabulary (`AgentMentionKeyResult`): this list's key, a key the input method owns, or one
 * that is neither's.
 */
import { computed } from 'vue'
import { FileText } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { useAgentComposerMentions } from '../composables/use-agent-composer-mentions'
import AgentReferenceMenu, { type AgentReferenceRow } from './AgentReferenceMenu.vue'

const props = defineProps<{
  /** The message as the reader has it: the unfinished `@word` is read off its end. A prop and not a
   *  function, because the composer's draft is a model this component never writes. */
  text: string
  /** The workspace whose notes are listed — the session's own, handed down by the panel that holds
   *  it. It arrives rather than being read from the store for the reason `AgentComposer.vue` gives
   *  for its own copy: the store's record is the *focused* session, and the focus can be moved to a
   *  session whose panel is not on screen (`app/pet-task-link.ts`). */
  vault?: string | null
}>()

const emit = defineEmits<{
  /** The reader settled on a file. What becomes of this vault-relative path — a chip, or a path put
   *  into the message — is the composer's answer rather than this list's. */
  pick: [path: string]
}>()

/**
 * The file a mention settled on: the half-typed word comes out of the message, and the file goes
 * into the turn — both of them one layer up, where the draft and the attachments are.
 *
 * One function for both ways in — the row the reader clicked and the Enter the menu took — because
 * the two have to do exactly the same thing, and the second of them is reached from inside the
 * composable below, which was built with this very function as its `select`.
 */
function picked(path: string): void {
  emit('pick', path)
}

const mentions = useAgentComposerMentions({
  vault: () => props.vault ?? null,
  text: () => props.text,
  select: picked,
})

/** The rows the `@` menu draws. Ids are the paths themselves, so the row the reader took and the
 *  file that is attached cannot drift apart. */
const rows = computed((): AgentReferenceRow[] =>
  mentions.matches.value.map((path) => ({ id: path, label: path, icon: FileText })),
)

/** A sentence for each way the `@` menu can have nothing to show. `closed` and `rows` draw the
 *  list itself, so they are not here. */
const notice = computed((): string | null => {
  switch (mentions.view.value) {
    case 'reading':
      return t('agent.panel.composer.attach.mention.reading')
    case 'empty':
      return t('agent.panel.composer.attach.mention.empty')
    case 'no-match':
      return t('agent.panel.composer.attach.mention.noMatch')
    case 'unreadable':
      return t('agent.panel.composer.attach.mention.unreadable')
    default:
      return null
  }
})

/** What a key means here, for the layer that saw it: the keydown arrives on the composer's field
 *  rather than in this box, so the composer asks the list it is drawing. See the header. */
defineExpose({ onKeydown: mentions.onKeydown })
</script>

<template>
  <div class="agent-composer-mentions">
    <!-- The list itself, above the field's top edge and over it. -->
    <Transition name="v">
      <AgentReferenceMenu
        v-if="mentions.view.value !== 'closed'"
        :rows="rows"
        :label="t('agent.panel.composer.attach.mention.list')"
        @select="picked"
        @close="mentions.close"
        @leave="mentions.close"
      />
    </Transition>
    <!-- A list with nothing in it says which nothing it is: still being read, a workspace with
         no notes, a word that matches none, or an index that could not be walked. Drawn in the
         field's own box rather than as an empty menu, because an empty frame is the failure
         this sentence exists to avoid. -->
    <p
      v-if="rows.length === 0 && notice !== null"
      class="agent-composer-mention-notice"
      role="status"
    >
      {{ notice }}
    </p>
  </div>
</template>

<style scoped>
/* The `@` list's positioning box: the anchor `AgentReferenceMenu` places itself against, and the
   place the "nothing to show" sentences are drawn that is not the menu box. `position: relative`
   and no size of its own — it must not take a line of the composer's height when it is empty. */
.agent-composer-mentions {
  position: relative;
}
/* The sentence a state with no rows is said with. It sits below the field's top edge, over the
   field rather than pushing it, so the composer does not change height as the reader types. */
.agent-composer-mention-notice {
  position: absolute;
  top: 4px;
  left: 0;
  z-index: 300;
  margin: 0;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 96%, var(--app-panel));
  box-shadow: var(--app-shadow-menu);
  color: var(--app-muted);
  font-size: 12px;
}
</style>
