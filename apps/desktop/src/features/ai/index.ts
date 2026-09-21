/**
 * The AI feature's public API.
 *
 * Callers outside the feature reach it through this entry point, so the
 * internal layout (prompt / stream registry / thinking state / the two
 * lifecycles) can change without touching a call site.
 *
 * The gate is not on this list, but it is not private to the feature either:
 * `stores/settings-ai.ts` (the model-list fetch both settings gestures pass
 * through) and `features/agent-settings/services/agent-provider-authoring.ts`
 * (the provider form's own fetch) import `services/ai-gate.ts` by path for the
 * master-switch rule and its announcement — the one by-path import the feature
 * has from outside, kept there because the rule has to sit on the far side of
 * the port for a second caller of the client to inherit it. Callers that want
 * the bare decision table ask `services/aiPermissions.ts`, which owns it.
 */

export { buildAIPrompt, getCursorPrefix } from './services/ai-prompt'

export { aiThinking } from './services/ai-thinking'

export { nextRequestId } from './services/ai-stream'

export { aiService } from './services/ai-ghost'

export { CHAT_PROMPTS, CHAT_PROMPT_IDS, enabledPrompts } from './prompts'
export type { ChatPrompt } from './prompts'

export { startChatCompletion, usageTotal } from './services/ai-chat'
export type { AiTokenUsage, ChatStream, ChatStreamHandlers } from './services/ai-chat'
