/**
 * Compatibility surface, ONE stage only (§10.1.5).
 *
 * The AI service's implementation moved into the AI feature: the prompt
 * construction to `ai-prompt.ts`, the permission gate to `ai-gate.ts`, the
 * shared registry of in-flight streams to `ai-stream.ts`, the observable
 * thinking flag to `ai-thinking.ts`, and the two request lifecycles to
 * `ai-ghost.ts` (the inline suggestion, and the two keystrokes that finish it)
 * and `ai-chat.ts` (every chat-shaped completion). This file keeps the old
 * `services/ai` path resolving so an import this change did not reach cannot
 * break, and is deleted with the rest of the compatibility layer once nothing
 * imports it.
 *
 * It re-exports through `features/ai` — the feature's public entry point —
 * rather than reaching into its service files. The list below is therefore the
 * compatibility contract as a whole: a helper the new modules share internally
 * cannot leak out here by accident, and a name dropped from either surface is a
 * failing typecheck rather than a silent absence.
 *
 * Nothing outside the AI feature should import its internals directly: new
 * callers go through `features/ai`, which exports the same names.
 */

/* Prompt construction: pure text, no request. */
export { buildAIPrompt, getCursorPrefix } from '../features/ai'

/* The observable "a reasoning model is thinking" flag, read by the status bar. */
export { aiThinking } from '../features/ai'

/* The ghost writer's request id allocation. */
export { nextRequestId } from '../features/ai'

/* The inline-suggestion lifecycle: trigger, accept, reject, cancel. */
export { aiService } from '../features/ai'

/* The chat-shaped completion and the token accounting it reports. */
export { startChatCompletion, usageTotal } from '../features/ai'
export type { AiTokenUsage, ChatStream, ChatStreamHandlers } from '../features/ai'
