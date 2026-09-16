/**
 * The agent composition root: which adapter the app runs on, and the order its calls go in.
 *
 * §9 gives this file one job — 「注入依赖、连接已有编辑器/库」 — and one rule, its closing line:
 * assembly connects public interfaces and does not reach into a neighbouring feature's
 * internals. So there is no store here, no view, no editor: what is here is the *choice* of
 * `AgentGateway` (§6.1: "the adapter is chosen at the composition site") and the three calls
 * that put a session in front of a window — start the runtime, open a session for a vault, and
 * hand the pair to whoever mounts the panel (T16's `AppShell.vue` passes both to
 * `AgentPanel`, which owns its own binding to the store).
 *
 * ## What belongs here, for the three tasks that will extend it
 *
 * §10.2 names this file for T4, T9, T10 and T11 — it is the only file four tasks share — so the
 * boundary is stated here rather than rediscovered by each of them:
 *
 *  - **T4 (this file, now)**: the gateway choice, the runtime lifecycle, and opening a session.
 *  - **T9** (context): the draft's four call sites, named in `task-167-T9-context-snapshot.md`
 *    §7 — `createContextDraft(session.identity)` when a send begins, the three `attach*`
 *    functions from the editor and the picker, `withdrawItem` from a row's control, and
 *    `commitContext` immediately before the prompt. **Not implemented here**: two of the four
 *    are calls into the editor, and the editor's side of that boundary does not exist yet (the
 *    snapshot layer is delivered and green; what it needs is a caller inside the editor).
 *  - **T10** (change review) and **T11** (SVG insertion): the same shape — a service that has
 *    been written and tested, and a composition step that gives it the editor or the vault it
 *    needs. Add them as further `connect*` functions on this object, not as imports into each
 *    other's modules.
 *
 * What this file must never become: a second store. Session state, sequencing and "is this run
 * still current" belong to `features/agent` (T5), and a decision taken here would be taken
 * again there.
 *
 * `AppShell.vue` is T16's file, not this task's: the panel is not mounted by anything yet, and
 * the wiring that mounts it — with the feature switch §12 describes for a staged rollout — is
 * reported in this task's report rather than edited.
 */

import type {
  AgentGateway,
  AgentOpenRequest,
  AgentSession,
} from '../platform/gateways/agent-contracts'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'
import { createTauriAgentGateway } from '../platform/gateways/tauri-agent'
import type { AgentIpc } from '../platform/gateways/tauri-agent/ipc'

export interface AgentCompositionDeps {
  /**
   * The vault a runtime is started for.
   *
   * Part of the composition rather than of a session request, because a runtime instance is
   * per (agent, profile, vault) — §6.2's identity, enforced by the Rust registry — while the
   * contract's `start()` takes no argument. Switching vault is therefore a new composition
   * (and a new runtime epoch), not a call on this one.
   */
  vaultId: string
  /**
   * Which side to assemble. Defaults to autodetection, the same way `platform/gateways`
   * chooses its adapters, and it is **not** a silent fallback: a Tauri window runs the real
   * adapter, and a test or a browser build runs the double. A composition that quietly
   * preferred the double in the app would be exactly the faked capability this codebase
   * refuses elsewhere.
   */
  environment?: 'tauri' | 'browser'
  /** The identity the double publishes as its own; required by it and unused by the real one,
   *  which is told its identity by the host. */
  agentId?: string
  profileId?: string
  /** The IPC port, for a test that wants to drive the real adapter without a window. */
  ipc?: AgentIpc
}

export interface AgentComposition {
  /** The adapter behind every session this composition opens. */
  readonly gateway: AgentGateway
  /** Bring the runtime up. Idempotent: `openSession` calls it, and a second call is a no-op
   *  that leaves the open handles alone. */
  start(): Promise<void>
  /** Start (if needed) and open a session in the requested working directory. */
  openSession(request: AgentOpenRequest): Promise<AgentSession>
  /** Take the runtime down. Turns in flight end as cancelled, and the handles minted by this
   *  runtime stop working — a new `start` is a new epoch. */
  stop(): Promise<void>
}

function detectEnvironment(): 'tauri' | 'browser' {
  const hasTauri =
    typeof window !== 'undefined' &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  return hasTauri ? 'tauri' : 'browser'
}

export function createAgentComposition(deps: AgentCompositionDeps): AgentComposition {
  const environment = deps.environment ?? detectEnvironment()
  const gateway: AgentGateway =
    environment === 'tauri'
      ? createTauriAgentGateway({ vaultId: deps.vaultId, ...(deps.ipc ? { ipc: deps.ipc } : {}) })
      : createMemoryAgentGateway({
          agentId: deps.agentId ?? 'memory',
          profileId: deps.profileId ?? 'default',
        })

  return {
    gateway,
    async start() {
      await gateway.start()
    },
    async openSession(request) {
      // Started here rather than left to the caller because the two calls are one intention:
      // a session cannot be opened on a runtime that is not up, and the contract's own order
      // is start → openSession. It is idempotent, so a caller that started explicitly pays
      // nothing for this.
      if (environment === 'tauri') await gateway.start()
      return gateway.openSession(request)
    },
    async stop() {
      await gateway.stop()
    },
  }
}
