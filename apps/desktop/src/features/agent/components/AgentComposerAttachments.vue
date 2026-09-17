<script lang="ts">
/**
 * The chip strip's copy, overridable by whoever wires it up — the same seam `AgentComposerContext`
 * gives its own labels, and for the same reason: the defaults come from the catalogue, so a caller
 * that wants other words can pass them and a caller that does not gets the translated ones.
 */
export interface AgentComposerAttachmentLabels {
  /** Names the strip for a screen reader. */
  strip: string
  /** The accessible name of one chip: the attachment, and what it is doing there. */
  label: string
  /** The remove control's tooltip and accessible name, with the attachment's own name in it. */
  remove: string
}
</script>

<script setup lang="ts">
/**
 * What the message is carrying, one chip each.
 *
 * Zed folds a mention into the message text as a *crease*
 * (`zed-main/crates/agent_ui/src/message_editor.rs:2073-2111` `build_chunks_from_creases`, drawn by
 * `ui/mention_crease.rs`) — a range of the buffer hidden behind a removable token. This app's
 * message is a `<textarea>`, which holds no ranges and no creases, so *that* shape is not
 * available here. The shape that is available says the same thing in one place a textarea cannot
 * reach: a strip of its own above the field.
 *
 * **A chip is not text and must not look like one.** What it names is not in the message and cannot
 * be edited out of it — it is a second thing the turn carries, and the remove control is the only
 * way to be rid of it. That is the difference the strip exists to draw: a path typed into the
 * message is a path, and a chip is a file that travels.
 *
 * **Nothing is drawn when nothing is attached.** The strip is rendered on `v-if` by its parent
 * rather than drawing an empty frame with a heading, which would be the "surface with nothing to
 * show" this project forbids: a reader who has attached nothing has no state to be told about.
 */
import { computed } from 'vue'
import { FileText, Image as ImageIcon, X } from 'lucide-vue-next'
import {
  promptAttachmentLabel,
  type AgentPromptAttachment,
} from '../../../platform/gateways/agent-contracts'
import { t } from '../../../i18n'
import { attachmentKey } from '../services/agent-composer-attachments'

const props = defineProps<{
  /** What the turn will carry, in the order the reader attached it. */
  attachments: readonly AgentPromptAttachment[]
  /** Overrides for the default copy; see {@link AgentComposerAttachmentLabels}. */
  labels?: Partial<AgentComposerAttachmentLabels>
}>()

const emit = defineEmits<{
  /** The reader took one off. The key is the attachment's own, from `attachmentKey`. */
  remove: [key: string]
}>()

const copy = computed((): AgentComposerAttachmentLabels => ({
  strip: t('agent.panel.composer.attach.strip'),
  label: t('agent.panel.composer.attach.label'),
  remove: t('agent.panel.composer.attach.remove'),
  ...props.labels,
}))

/** One row's facts, derived once so the template reads the same values the events are built from:
 *  the key a removal is addressed by, the label a person reads, and which icon belongs to it. */
const rows = computed(() =>
  props.attachments.map((attachment) => ({
    key: attachmentKey(attachment),
    label: promptAttachmentLabel(attachment),
    icon: attachment.kind === 'image' ? ImageIcon : FileText,
  })),
)
</script>

<template>
  <ul
    class="agent-composer-attachments"
    :aria-label="copy.strip"
    data-test="composer-attachments"
  >
    <li
      v-for="row in rows"
      :key="row.key"
      class="agent-composer-attachment"
      :data-kind="row.key.split(':')[0]"
    >
      <span
        class="agent-composer-attachment-icon"
        aria-hidden="true"
      >
        <component
          :is="row.icon"
          :size="12"
          :stroke-width="1.8"
        />
      </span>
      <span
        class="agent-composer-attachment-label"
        :title="row.label"
      >{{ row.label }}</span>
      <button
        class="agent-composer-attachment-remove"
        type="button"
        :title="copy.remove.replace('{name}', row.label)"
        :aria-label="copy.remove.replace('{name}', row.label)"
        data-action="detach"
        @click="emit('remove', row.key)"
      >
        <X
          :size="11"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>
    </li>
  </ul>
</template>

<style scoped>
/* §5.3's hit-area rule reaches this row too, and it is the reason a chip is taller than its own
   text: the remove control inside it has to be pressable, and a target smaller than the mark it
   shows is the failure that rule names. */
.agent-composer-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
}
.agent-composer-attachment {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  height: 24px;
  padding: 0 2px 0 6px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-size: 11px;
}
/* An image and a file are different promises — one's bytes travel, the other's text does — and the
   mark is the cheapest place to say which, before the reader has to open a tooltip. */
.agent-composer-attachment[data-kind='image'] .agent-composer-attachment-icon {
  color: var(--app-accent);
}
.agent-composer-attachment-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--app-muted);
}
.agent-composer-attachment-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-composer-attachment-remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-composer-attachment-remove:hover {
  background: color-mix(in srgb, var(--app-elevated) 70%, var(--app-accent-soft));
  color: var(--app-text);
}
.agent-composer-attachment-remove:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -1px;
}
</style>
