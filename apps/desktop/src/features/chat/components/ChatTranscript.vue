<script setup lang="ts">
/**
 * The scrolling log of turns, the empty state that stands in for it, and the
 * hint that brings a reader who left the end back to it.
 *
 * It owns the scroll element, which is why it - not the panel - decides what
 * happens to the reader's place in it: the send path asks for `follow` through
 * the panel's template ref, so the element that scrolls and the component that
 * renders it cannot drift apart.
 *
 * **The rows are keyed by the turn's own id, and the id is made with the
 * message** (`nextMessageId`). An index key makes Vue reuse component instances
 * by position, so the row the reader is watching grow is only *coincidentally*
 * the same element: everything below a row that is removed or inserted mid-list
 * shifts up onto the wrong turn, and any per-row state or entrance transition
 * goes with it. A key derived from the content is worse still - it changes on
 * every chunk of a streaming answer, so Vue tears the row down and rebuilds it
 * per token, which is the message flickering while it is being read.
 *
 * **The log is not a live region** (`aria-live="off"`, the same answer
 * `AgentTimeline` gives). A container whose text grows per chunk must not be the
 * thing that speaks: §5.2 asks for 「屏幕阅读器状态提示」 and rules out 「每 token
 * 都触发朗读」, and a region that is announced on every token is unusable during
 * exactly the moment the panel exists for. The completed turn is announced
 * once, elsewhere, by whoever knows the turn finished (`use-chat-send`), which
 * is what the log's own label is for - a reader told an answer is ready needs to
 * be able to find it from the outside.
 */
import { computed, ref } from 'vue'
import { ArrowDown, Sparkles } from 'lucide-vue-next'
import { t } from '../../../i18n'
import ChatMessageRow from './ChatMessageRow.vue'
import { useChatScroll } from '../composables/use-chat-scroll'
import type { PanelMessage } from '../types'

const props = defineProps<{
  messages: PanelMessage[]
  /** A document is open, so a row's insert action can act. */
  canInsert: boolean
}>()

defineEmits<{
  stop: []
  insert: [message: PanelMessage]
  copy: [message: PanelMessage]
}>()

const scrollEl = ref<HTMLElement | null>(null)

const scroll = useChatScroll({
  container: scrollEl,
  // The list's own length, because that is what a message count is. A chunk
  // written into the answer being read reaches the composable through `follow`;
  // this is what says a *turn* arrived.
  messageCount: () => props.messages.length,
})

/**
 * The hint, and the whole rule for when it is on screen: the reader is away from
 * the end and something has arrived below them. `pending` decides only whether
 * it carries a number - the hint appears for content it cannot count (§5.2
 * 「提供新内容提示」, and no number is better than an inflated one).
 */
const hint = computed(() => scroll.suspended.value && scroll.arrived.value)

defineExpose({
  /** Follow the newest turn, unless the reader has left the end. */
  follow: scroll.follow,
  /** Open at the newest turn: a conversation being shown for the first time. */
  jumpToEnd: scroll.jumpToEnd,
})
</script>

<template>
  <div class="chat-transcript">
    <!-- `tabindex="0"`: the container scrolls, and a scroll container the keyboard cannot reach
         is a transcript whose earlier turns are reachable by pointer only. The agent panel's
         transcript is the same surface with the same rule and got the same attribute, but the
         measurement behind it was taken on THAT panel and does not carry over: this is a
         different container, in a different feature, inside a different composer's tab order.
         `use-chat-scroll.ts` already names "a keyboard scroll" as a way back to the end of the
         log; before this attribute there was no key that meant it. `probe-chat-scroll.mjs`
         measures this container in WebKitGTK — the tab walk in, the ring, the keys. -->
    <div
      ref="scrollEl"
      class="chat-scroll"
      role="log"
      aria-live="off"
      :aria-label="t('chat.transcript')"
      tabindex="0"
      @scroll="scroll.onScroll"
    >
      <div
        v-if="!messages.length"
        class="chat-empty"
      >
        <Sparkles
          class="chat-empty-icon"
          :size="20"
          :stroke-width="1.6"
        />
        <p class="chat-empty-title">
          {{ t('chat.emptyTitle') }}
        </p>
        <p class="chat-empty-hint">
          {{ t('chat.emptyMsg') }}
        </p>
        <p class="chat-empty-hint">
          {{ t('chat.emptyImages') }}
        </p>
      </div>

      <ChatMessageRow
        v-for="m in messages"
        :key="m.id"
        :message="m"
        :can-insert="canInsert"
        @stop="$emit('stop')"
        @insert="$emit('insert', m)"
        @copy="$emit('copy', m)"
      />
    </div>

    <!-- The way back for a reader the ruling promised not to drag: a control of
         its own, so returning is the deliberate act 「回到底部是明确动作」 describes
         and not a timer deciding for them. Not a live region, for the reason the
         count would then be announced on every arrival. -->
    <button
      v-if="hint"
      class="chat-jump"
      type="button"
      data-chat-jump
      @click="scroll.jumpToEnd()"
    >
      <ArrowDown
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span v-if="scroll.pending.value > 0">{{ t('chat.newMessages', { count: scroll.pending.value }) }}</span>
      <span v-else>{{ t('chat.newContent') }}</span>
    </button>
  </div>
</template>

<style scoped>
.chat-transcript {
  /* The hint floats over the log rather than living inside it: an absolutely
     positioned child cannot shift the text under the reader when it appears, and
     the log keeps the whole box to scroll in. */
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.chat-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* The tab stop above, made visible. `tabindex` alone would move a keyboard reader into a region
   with no sign they are in it, which is the other half of the same defect. Measured in
   WebKitGTK: the engine's own `outline: auto` is thrown away by the scroll container it would
   have to be drawn on — `.chat-scroll` is the full size of its own scroll body, so a ring outside
   it is drawn over the composer and the session bar — hence INSET, the same choice
   `AgentTimeline`'s container makes for the same reason. `:focus-visible` rather than `:focus`
   keeps it off a mouse reader's screen, and the contrast of `--app-accent` against this panel is
   what the probe reports beside the ring. */
.chat-scroll:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: 1;
  min-height: 160px;
  padding: 16px;
  text-align: center;
  color: var(--app-muted);
}
.chat-empty-icon {
  margin-bottom: 4px;
  color: color-mix(in srgb, var(--app-accent) 60%, var(--app-muted));
}
.chat-empty-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text);
}
.chat-empty-hint {
  margin: 0;
  max-width: 220px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--app-muted);
}
.chat-jump {
  position: absolute;
  bottom: 10px;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-elevated);
  box-shadow: var(--app-shadow-card);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  transform: translateX(-50%);
  cursor: pointer;
  /* Arrival only, and opacity only: it fades in where it lands, so nothing moves
     under the reader and nothing springs. The global reduced-motion sweep
     neutralises the duration (§5.2), which for an opacity keyframe leaves the
     resting look rather than a stuck frame. */
  animation: chat-jump-in var(--app-motion-fade) var(--app-ease);
}
.chat-jump:hover {
  background: color-mix(in srgb, var(--app-elevated) 86%, var(--app-accent-soft));
}
.chat-jump:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
@keyframes chat-jump-in {
  from {
    opacity: 0;
  }
}
</style>
