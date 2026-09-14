/**
 * The AI feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout (prompt / gate /
 * stream registry / thinking state / the two lifecycles) can change without
 * touching a call site.
 *
 * The gate is deliberately absent. `aiDisabled`/`aiWritesForbidden` are the
 * feature's internal policy checks — callers that need a permission decision
 * ask `services/aiPermissions.ts`, which owns the table, rather than reading
 * the answer the lifecycle happens to compute.
 */

export { buildAIPrompt, getCursorPrefix } from './services/ai-prompt'

export { aiThinking } from './services/ai-thinking'

export { nextRequestId } from './services/ai-stream'

export { aiService } from './services/ai-ghost'

export { CHAT_PROMPTS, CHAT_PROMPT_IDS, enabledPrompts } from './prompts'
export type { ChatPrompt } from './prompts'

export { startChatCompletion, usageTotal } from './services/ai-chat'
export type { AiTokenUsage, ChatStream, ChatStreamHandlers } from './services/ai-chat'
