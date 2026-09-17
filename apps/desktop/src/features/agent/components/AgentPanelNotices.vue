<script setup lang="ts">
/**
 * The three lines the panel says about the record above the transcript.
 *
 * Each is drawn only when it has something true to say, and each says a different thing about the
 * same question — is what is on screen the session's record? A gap is a frame the subscription
 * never saw, and it is the one the reader can act on (the resync). The refused-frame line is the
 * other half of the same question and carries no button. The empty line is not about the record's
 * health at all: it is the transcript's first line, drawn while there is no transcript yet.
 *
 * They live in one component because they are one *region* — the flex column's fixed-height rows
 * between the bar and the transcript — and because their styles are that region's: three
 * sentences' worth of layout that the panel's own stylesheet had no other use for.
 *
 * **The middle line's shape is a decision, not an omission.** It carries no button on purpose: the
 * counter is not cleared by a reload, so a resync here would be a control that leaves its own
 * sentence standing. The sentence says what happened and names the reducer's last reason — it does
 * not say the transcript is incomplete, because it is not always: a re-subscription replays frames
 * the view already has, and their refusal is `duplicate-sequence`
 * (`agent-event-reducer.ts`, `judgeSequence`). A sentence that read "content is missing" would be
 * false for the commonest case, which is the second kind of dishonesty §5.2 forbids.
 *
 * Nothing here decides any of those sentences — `labels` and `dropped` arrive already assembled,
 * because the panel is where the store is read and the catalogue is consulted.
 */
defineProps<{
  /** The gap notice's two sentences. The first is drawn when {@link gap} is true. */
  labels: { gap: string; resync: string }
  /** A hole in the stream: the record on screen is not the session's record. */
  gap: boolean
  /** The refused-frame sentence, already filled, or `null` while there is nothing to say. */
  dropped: string | null
  /** The transcript's first line, drawn only while the transcript is empty. */
  empty: string
  /** Whether the empty line is drawn at all. */
  transcriptEmpty: boolean
}>()

defineEmits<{ resync: [] }>()
</script>

<template>
  <p
    v-if="gap"
    class="agent-panel-notice"
    role="status"
  >
    <span class="agent-panel-notice-text">{{ labels.gap }}</span>
    <button
      class="agent-panel-resync"
      type="button"
      @click="$emit('resync')"
    >
      {{ labels.resync }}
    </button>
  </p>
  <!-- Drawn only above zero (`dropped` is cumulative for the session, so a naught is the ordinary
       state and a badge reading "0" would say nothing). It sits in the flow above the transcript
       like the gap notice, and moving the reader is not a risk it adds: the timeline watches its
       own box and re-anchors the visible row on a container resize (`AgentTimeline.vue`,
       `ResizeObserver` → `contentChanged`). -->
  <p
    v-if="dropped !== null"
    class="agent-panel-notice is-quiet"
    data-agent-dropped
    role="status"
  >
    <span class="agent-panel-notice-text">{{ dropped }}</span>
  </p>
  <!-- The transcript's first line, and only while there is no transcript: directly under the title
       rule, in the panel's own monospace, so an empty session reads as the beginning of a
       conversation rather than as an illustration. It is `aria-live="off"` like the transcript
       beside it — it says nothing that changes per token. -->
  <p
    v-if="transcriptEmpty"
    class="agent-panel-empty"
    data-agent-empty
  >
    {{ empty }}
  </p>
</template>

<style scoped>
.agent-panel-notice {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-warn) 12%, var(--app-panel));
  color: var(--app-text);
  font-size: 12px;
}
.agent-panel-notice-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The refused-frame line. Same row, no warning tint and no button: a frame the transport
   re-sent is not a fault the reader has to act on, and a notice painted in the danger family
   would train them to fear the reload button that produces most of them. */
.agent-panel-notice.is-quiet {
  background: var(--app-elevated);
  color: var(--app-muted);
}
.agent-panel-resync {
  flex: none;
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.agent-panel-resync:hover {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-panel-resync:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
/* The empty transcript's line. Monospace and muted, at the top of the transcript area rather
   than centred in it: it is the first line of a conversation, not an illustration of one, and
   the transcript below keeps the room it will need when the first row arrives. */
.agent-panel-empty {
  flex: none;
  margin: 0;
  padding: 10px 12px 0;
  color: var(--app-muted);
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.5;
  /* One long sentence in a narrow rail may not fit; it wraps rather than disappearing into an
     ellipsis, because every clause of it names something the reader can do. */
  overflow-wrap: anywhere;
}
</style>
