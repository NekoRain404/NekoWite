/**
 * The one piece of observable AI state: whether a completion is in its
 * reasoning phase.
 *
 * Its own module because neither request lifecycle owns it — the ghost writer
 * and every chat-shaped completion (chat rail, selection edits, the plugin
 * adapter) both set it, and the status bar reads it. State is separated from
 * the command module that tears streams down (§13.4): `ai-stream.ts` is what
 * runs, this is what the UI watches.
 *
 * It is deliberately not a Pinia store. There is no action, no persistence and
 * no second consumer to coordinate; a `ref` with one writer function is the
 * whole requirement, and a store would add a lifecycle dependency to a flag
 * that must be readable from anywhere, including a plugin host with no app.
 */

import { ref } from 'vue'

/**
 * True while the running completion has reported reasoning progress but no
 * answer text yet.
 *
 * Reasoning models stream their thinking first — measured against the
 * `deepseek-flash` endpoint, 27 reasoning deltas arrived before the first
 * content delta — and the backend deliberately keeps that monologue out of the
 * document text. Without a visible state the editor simply looked frozen for
 * that whole phase, so the UI shows a "thinking" hint instead.
 */
export const aiThinking = ref(false)

/**
 * Set by every stream transition: on for a reasoning tick, off as soon as
 * answer text starts, the stream finishes, fails, or is cancelled — a flag left
 * true would pin the hint on forever.
 */
export function markThinking(on: boolean): void {
  aiThinking.value = on
}
