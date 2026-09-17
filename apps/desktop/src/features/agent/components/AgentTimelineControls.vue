<script lang="ts">
/**
 * The control row's copy, handed in rather than reached for — see {@link AgentToolLabels} for
 * why, and for what happens when the catalogue grows keys.
 */
export interface AgentTimelineControlLabels {
  /** The way back to the newest row, with the count of arrivals the reader has not seen
   *  rendered beside it. */
  jump: string
  /**
   * The follow switch's accessible name and tooltip while it is OFF: what pressing it will do.
   *
   * A toggle carries the action rather than the state, because `aria-pressed` is what says which
   * state it is in — a label reading "Following" would be the same fact twice, and the tooltip
   * would stop answering the only question a reader has about an unfamiliar control.
   */
  follow: string
  /** The same switch's tooltip while it is ON: the action pressing it will take. */
  followStop: string
  /** Copy the newest answer the engine gave, labelled with which one it is — see
   *  `services/agent-timeline-actions.ts` for why the newest rather than the one under the
   *  pointer. */
  copy: string
  /** The same control while the copy has just landed, so a press that worked is visible. */
  copied: string
  /** A clipboard that refused, in the app's error surface: the reader is about to paste a
   *  stale buffer, and the one thing they must not do is believe they copied the answer. */
  copyFailed: string
  /** Go to the reader's own last message. */
  toUser: string
  /** Go to the beginning of the log. */
  toTop: string
}
</script>

<script setup lang="ts">
/**
 * The transcript's own control row, floating over its bottom edge.
 *
 * **The reader's switch over following**, which the panel had behaviour for and no control
 * (Zed: `render_follow_toggle`, `thread_view.rs:5698`). It is drawn from the composable's own
 * state rather than from a copy of it: `following` is `!suspended`, so the switch can never say
 * one thing while the container does another — a reader who scrolls away mid-stream is what
 * turns it off, and arriving at the end is what turns it back on (§5.2 「回到底部是明确动作」).
 *
 * **The three navigation and copy controls** are row 36's half of Zed's per-message toolbar
 * (`render_thread_controls`, `thread_view.rs:6806`: copy this response, scroll to the user
 * message, scroll to the top). Zed draws them under a message; this panel draws one row for the
 * transcript, so each control acts on the *latest* of the thing it names and says so in its own
 * label — see `services/agent-timeline-actions.ts` for the choice and why it is not silent.
 * Zed hides its scroll-to-top and copy controls at the thread's bottom while a turn is running;
 * ours are drawn whenever they have a target, because neither of them is destructive and a
 * control that disappears mid-turn is a control the reader has to re-find.
 *
 * **It is placed here rather than in the composer's control row**, which is where Zed puts the
 * follow switch, for two reasons that are both about this panel: that row is the engine's own
 * option row (`AgentConfigRow`, drawn from what the session reported) and its width budget is
 * measured at every rail width by `probe-agent-scroll.mjs`'s fit phase, and the transcript's
 * other follow-related affordance — the way back to the end — already lives here. A switch that
 * governs the transcript's scroll belongs beside the control that undoes it.
 *
 * **Turning the switch off never moves the transcript.** That is the whole of what makes it
 * safe: the rule the composable implements is that a reader who has left the end is not moved,
 * and this switch is a way of saying so without scrolling. Turning it on is the reader's own
 * move to the end, and it is instant for the reason §5.2 gives (`resume`): a long eased ride
 * back is a distance they have to wait out.
 *
 * The way back to the end is drawn only while there is something to go back to — not following,
 * and arrivals the reader has not seen. Drawn with nothing to count it would be a control that
 * does nothing on a panel that is already showing the newest row. The copy control is drawn only
 * while there is an answer to copy, and the two navigation controls only while there is
 * somewhere to go: a transcript with no reply, or with no user message, has no target for them,
 * and a control whose press does nothing is worse than an absent one.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { ArrowDown, ArrowUp, Check, Copy, Crosshair, Reply } from 'lucide-vue-next'
import { copyToClipboard } from '../services/agent-clipboard'
import { notifyError } from '../../../services/errors'

const props = defineProps<{
  /** Whether arrivals are followed. The container's own state, not a second opinion. */
  following: boolean
  /** Arrivals since the reader stopped following. Counted by the composable, changes rather
   *  than messages — see `AgentScroll.pending`. */
  pending: number
  /**
   * The newest answer, or null when the engine has not given one.
   *
   * The text is picked by the caller (`services/agent-timeline-actions.ts`) and not here,
   * because "which row is the answer" is a question about the view rather than about this
   * control — and because it is then testable without a browser.
   */
  reply: string | null
  /** Whether the reader has said anything, which is whether there is anywhere for the
   *  go-to-my-last-message control to go. */
  hasUserMessage: boolean
  labels: AgentTimelineControlLabels
}>()

const emit = defineEmits<{
  /** The reader moved the switch. `true` is "follow again", which is also a move to the end. */
  follow: [on: boolean]
  /** The reader asked for the newest row without moving the switch themselves. */
  resume: []
  /** Take the reader to their own last message. */
  toUser: []
  /** Take the reader to the top of the log. */
  toTop: []
}>()

/** What pressing the switch will do, which is the tooltip a toggle carries while its state is
 *  already on screen as `aria-pressed`. */
const followTitle = computed(() =>
  props.following ? props.labels.followStop : props.labels.follow,
)

/**
 * How long the copy control says "copied" before going back to its own name.
 *
 * Long enough to be read after the press, short enough not to become a second permanent label
 * in a 28px control. It is the app's own fade rung rather than a number invented here, so the
 * notice expires on the same beat as the surfaces around it.
 */
const COPY_NOTICE_MS = 1400

const copied = ref(false)
let notice: ReturnType<typeof setTimeout> | null = null

/**
 * Hand the answer to the clipboard and say what happened.
 *
 * The write goes through `services/agent-clipboard.ts`, which is where the two paths live and
 * which reports rather than throws. A success is shown *on the control* — the icon turns into a
 * check — because a toast for a copy is a notification about something the reader already knows
 * they asked for; a failure is reported to the app's error surface, because there the reader
 * needs a sentence, and the label tree carries it.
 */
async function copy(): Promise<void> {
  const text = props.reply
  if (text === null) return
  if (!(await copyToClipboard(text))) {
    notifyError(props.labels.copyFailed)
    return
  }
  copied.value = true
  if (notice !== null) clearTimeout(notice)
  notice = setTimeout(() => {
    notice = null
    copied.value = false
  }, COPY_NOTICE_MS)
}

onBeforeUnmount(() => {
  if (notice !== null) clearTimeout(notice)
})
</script>

<template>
  <div
    class="agent-timeline-controls"
    data-agent-timeline-controls
  >
    <button
      v-if="!following && pending > 0"
      class="agent-jump"
      type="button"
      data-timeline-control="jump"
      @click="emit('resume')"
    >
      <ArrowDown
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      {{ labels.jump }}
      <span class="agent-jump-count">{{ pending }}</span>
    </button>
    <button
      v-if="hasUserMessage"
      class="agent-control"
      type="button"
      data-timeline-control="to-user"
      :title="labels.toUser"
      :aria-label="labels.toUser"
      @click="emit('toUser')"
    >
      <Reply
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
    <button
      class="agent-control"
      type="button"
      data-timeline-control="to-top"
      :title="labels.toTop"
      :aria-label="labels.toTop"
      @click="emit('toTop')"
    >
      <ArrowUp
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
    <button
      v-if="reply !== null"
      class="agent-control"
      type="button"
      data-timeline-control="copy"
      :data-copy="copied ? 'copied' : null"
      :title="copied ? labels.copied : labels.copy"
      :aria-label="labels.copy"
      @click="copy()"
    >
      <!-- The icon is the whole of the success notice, so it carries the state as its own
           signal: the label keeps saying what the control is, and a reader who is looking at
           the button sees the press land. -->
      <component
        :is="copied ? Check : Copy"
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
    <button
      class="agent-follow"
      type="button"
      data-timeline-control="follow"
      :aria-pressed="following"
      :aria-label="followTitle"
      :title="followTitle"
      @click="emit('follow', !following)"
    >
      <Crosshair
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
/* The row floats over the log rather than living in it: the composable reads the container's
   children as rows, and a control among them would be measured as one. Right-aligned and bottom-
   anchored, so what it covers is the end of the last line and never the column of text. */
.agent-timeline-controls {
  position: absolute;
  right: 10px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}
/* Both controls are one pill each, and quiet until they are pointed at: this is the transcript's
   chrome, and the words are the answer the panel exists to show. */
.agent-jump,
.agent-follow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-elevated);
  box-shadow: var(--app-shadow-card);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  cursor: pointer;
}
.agent-jump {
  padding: 0 10px;
  /* Arrival only, and opacity only: it fades in where it lands. Nothing here moves the log
     under the reader, and the fade rides the app's 140–220ms band with reduced motion
     handled by the global sweep (§5.2). */
  animation: agent-jump-in var(--app-motion-fade) var(--app-ease);
}
.agent-follow,
.agent-control {
  justify-content: center;
  width: 28px;
  padding: 0;
  color: var(--app-muted);
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.agent-follow:hover,
.agent-control:hover {
  color: var(--app-text);
}
/* The press that landed, held for as long as the notice lasts. Drawn as the same tint the
   switch uses for its on state, so the row has one way of saying "this control is doing
   something right now". */
.agent-control[data-copy='copied'] {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
  color: var(--app-accent);
}
/* On, it reads as held — the same treatment the session bar's history control takes while the
   list it belongs to is open. The crosshair is the whole of the on state besides this tint, so
   it is a second signal rather than the only one: `aria-pressed` carries the state for a screen
   reader and the tooltip names the action either way. */
.agent-follow[aria-pressed='true'] {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
  color: var(--app-accent);
}
.agent-jump:hover {
  background: color-mix(in srgb, var(--app-elevated) 86%, var(--app-accent-soft));
}
.agent-jump:focus-visible,
.agent-follow:focus-visible,
.agent-control:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-jump-count {
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
@keyframes agent-jump-in {
  from {
    opacity: 0;
  }
}
</style>
