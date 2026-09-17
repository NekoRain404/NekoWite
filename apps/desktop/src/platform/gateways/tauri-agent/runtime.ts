/**
 * The runtime IPC: one read, and the reason it takes nothing.
 *
 * This is the window's half of `R/src/commands/agent_runtime.rs`'s `agent_runtime_read`. The
 * command answers about **the engine this app starts** — the registry's own default, which is the
 * one a new session uses — and about the runtime instance this app has running, if it has one. Both
 * are app state; neither is something a window names, so there is no argument here and no key that
 * could be given the wrong case. A window that could name an engine would be a window choosing one,
 * which is §3.4.1's decision and not a renderer's.
 *
 * ## Why it is not `session.ts`
 *
 * That port's calls all carry a session id, because every fact it asks about belongs to one
 * session. This one carries none because its subject is the *connection*: `initialize` is a
 * connection's first request, so the negotiated protocol version and the engine's `agentInfo` are
 * per incarnation and not per session. It is the half of the runtime state a settings dialog can
 * read — a dialog that has no session and never will — and the reason it can read it at all is that
 * this host keeps the handshake rather than the response it came in.
 *
 * ## What it can answer, and what a rejection means
 *
 * Every state the readout describes is a state of the *host* — no engine running, an engine running
 * before its first session, a program that is registered but not installed — so all of them arrive
 * as data and none as an error. A rejection from this port therefore means the call did not
 * complete: no handler, no window permission, the app shutting down, or a registry whose default
 * names no registration. The page's unreadable state with a retry is the answer to that, and it is a
 * different sentence from "no engine is running".
 *
 * The answer is `unknown` for the reason every other port in this adapter gives: what a readout
 * means is the feature's vocabulary, it lives in `features/agent-settings/`, and `platform` may not
 * import from `features` (plan §6.1). The two sides meet at the composition site, where a drift
 * between them is a compile error rather than a call that fails at runtime.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * The one call, as the backend answers it.
 *
 * The name is the page's — `read` — because it is what the settings section asks for; the
 * `agent_runtime_` prefix appears only where a command is actually named.
 */
export interface AgentRuntimeCommands {
  read(): Promise<unknown>
}

/**
 * The port implemented by the running app.
 *
 * A port rather than a free function, for the reason `AgentRegistryCommands` is one: a test can
 * drive the client without a window, and the composition site chooses which implementation a build
 * gets.
 */
export function createTauriAgentRuntimeCommands(): AgentRuntimeCommands {
  return {
    read: () => invoke('agent_runtime_read'),
  }
}
