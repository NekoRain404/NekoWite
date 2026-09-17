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
 *  - **T11, now**: `connectSvgInsertion` below binds §7.3's insertion to the two things the
 *    service cannot have of its own — the session identity a plan is made under, and the editor's
 *    account of a note *by path* — so that no call site can consult "the active note" or invent an
 *    identity. **Not implemented here**: reading the staged artifact, writing the attachment and
 *    applying the markdown edit, all three of which belong to the host and to the tab that holds
 *    the note.
 *  - **The live-buffer seam, now**: the composition is where the editor's ONE lookup
 *    (`stores/tabs.ts`'s `lookUpLiveNote`) is bound to the two things that read it — the
 *    `AgentSvgInsertionEditor` this file hands out, and the responder that answers the host's
 *    `fs/read_text_file` questions (`features/agent/services/live-note-responder.ts`). It is here
 *    rather than in either consumer because one lookup with two consumers is the whole point: two
 *    bindings would be two spellings of "the same version of this note", and the read path and the
 *    conflict check would drift apart the first time one of them changed.
 *  - **T13a, now**: `registry` below is the settings section's client, built from the window's
 *    registry commands. It is not a fourth gateway: the definitions it reads and changes live in
 *    the backend's own state (there is no session, no vault and no event stream in it), and the
 *    section that calls it takes it as a prop rather than reaching for a singleton — which is why
 *    the choice is made here and nowhere else.
 *
 * What this file must never become: a second store. Session state, sequencing and "is this run
 * still current" belong to `features/agent` (T5), and a decision taken here would be taken
 * again there. Binding a lookup that lives in a store is not holding one — nothing below reads
 * a tab, and no value it builds is kept anywhere but in the two objects that consume it.
 *
 * `AppShell.vue` is T16's file, not this task's: the panel is not mounted by anything yet, and
 * the wiring that mounts it — with the feature switch §12 describes for a staged rollout — is
 * reported in this task's report rather than edited.
 */

import type {
  AgentGateway,
  AgentIdentity,
  AgentOpenRequest,
  AgentSession,
} from '../platform/gateways/agent-contracts'
import type { EventPort } from '../platform/gateways/contracts'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'
import { createTauriAgentGateway } from '../platform/gateways/tauri-agent'
import type { AgentIpc } from '../platform/gateways/tauri-agent/ipc'
import { createTauriEventAdapter } from '../platform/events/tauri-event-adapter'
import {
  createTauriAgentRegistryCommands,
  type AgentRegistryCommands,
} from '../platform/gateways/tauri-agent/registry'
import type { AgentLiveNote } from '../features/agent/services/agent-context-snapshot'
import {
  createLiveNoteResponder,
  liveNoteEditorOf,
  type AgentLiveNoteSource,
  type LiveNoteResponder,
} from '../features/agent/services/live-note-responder'
import { createAgentRegistryClient } from '../features/agent-settings/services/agent-registry-ipc'
import type { AgentRegistryClient } from '../features/agent-settings/services/agent-registry-policy'
import { useTabsStore } from '../stores/tabs'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  captureInsertionTarget,
  commitSvgInsertion,
  planSvgInsertion,
  type AgentInsertionCapture,
  type AgentInsertionCommitRequest,
  type AgentInsertionOutcome,
  type AgentInsertionPlanRequest,
  type AgentInsertionPlanResult,
  type AgentSvgInsertionPlan,
} from '../features/agent/services/agent-svg-insertion'
// The binding's shape is the feature's own interface — every type in its signature belongs to
// `agent-svg-insertion.ts` — so it is declared there and implemented here. Re-exported because
// callers of this file have always named it from here.
import type { AgentSvgInsertionBinding } from '../features/agent/services/agent-insertion-source'
export type { AgentSvgInsertionBinding } from '../features/agent/services/agent-insertion-source'

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
  /**
   * The registry's IPC port, for a test that wants to drive the real client without a window.
   *
   * The same shape as `ipc` above and for the same reason. Nothing is passed in the app: the
   * composition builds the client over the window's own commands, which is what makes
   * `composition.registry` the one object a settings section needs.
   */
  registryCommands?: AgentRegistryCommands
  /**
   * The editor's ONE lookup of a note by path, for a test that drives the composition without a
   * tab store.
   *
   * Nothing is passed in the app: the default is the tab store's own
   * (`stores/tabs.ts`'s `lookUpLiveNote`), which is the implementation the read path, the
   * conflict baseline and the insertion anchor must all read through. A second one would be a
   * second answer to "what version is this note", which is the failure this composition step
   * exists to make impossible.
   */
  liveNotes?: AgentLiveNoteSource
  /**
   * This window's own name, as the host's registry spells it.
   *
   * Defaults to Tauri's answer for the calling window, read lazily — never at module load, so a
   * browser build never asks for a window that does not exist. Injected by a test.
   */
  windowId?: string
  /**
   * The event surface a live-note question arrives on, for a test that drives the responder
   * without a window.
   */
  events?: EventPort
}

export interface AgentComposition {
  /** The adapter behind every session this composition opens. */
  readonly gateway: AgentGateway
  /**
   * The registry, as the settings section calls it (T13a's page).
   *
   * On the composition rather than inside the section because the page takes its client as a prop
   * and never reaches for a singleton: which backend answers is the assembly's decision (§6.1), and
   * a page that built its own would be a second place the choice is made.
   */
  readonly registry: AgentRegistryClient
  /** Bring the runtime up. Idempotent: `openSession` calls it, and a second call is a no-op
   *  that leaves the open handles alone. */
  start(): Promise<void>
  /** Start (if needed) and open a session in the requested working directory. */
  openSession(request: AgentOpenRequest): Promise<AgentSession>
  /** Take the runtime down. Turns in flight end as cancelled, and the handles minted by this
   *  runtime stop working — a new `start` is a new epoch. */
  stop(): Promise<void>
  /**
   * Bind §7.3's SVG insertion to one session and the editor (T11).
   *
   * The first argument is the thing the service deliberately does not have: the identity a plan
   * is made under (§6.2's boundary — and a plan made under another session is refused by the
   * service rather than inserted under this one). `identity.vaultId` is expected to be this
   * composition's vault; a binding for another vault is a caller that assembled the wrong pair,
   * and the service's own vault check refuses the targets it would produce.
   *
   * The editor argument is optional and defaults to **this composition's own** — the one built
   * from the single lookup above, which is also what answers the host's reads. A caller that
   * supplies its own is describing a different editor, and the insertion would then be checked
   * against a document the read path cannot see.
   */
  connectSvgInsertion(identity: AgentIdentity, editor?: AgentSvgInsertionEditor): AgentSvgInsertionBinding
}

/** The editor's side of the SVG-insertion binding: one lookup, and no way to write through it. */
export interface AgentSvgInsertionEditor {
  /** The editor's account of one note, or null when no tab holds that path. */
  liveNote(path: string): AgentLiveNote | null
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
  // The ONE lookup, and the ONE editor derived from it. Built here rather than by each consumer
  // because `connectSvgInsertion` and the read responder must be reading the same document: two
  // bindings of one lookup is how "the same version of this note" acquires a second definition.
  const liveNotes: AgentLiveNoteSource = deps.liveNotes ?? tabLiveNotes()
  const editor: AgentSvgInsertionEditor = liveNoteEditorOf(liveNotes)
  // Only in a window. A browser or memory build has no host to ask, and a responder that
  // subscribed to a channel nothing publishes on would be a wire that looks connected and is not.
  const responder: LiveNoteResponder | null =
    environment === 'tauri' ? createLiveNoteResponder({
      source: liveNotes,
      events: deps.events ?? createTauriEventAdapter(),
      vaultId: deps.vaultId,
      windowId: deps.windowId ?? currentWindowLabel(),
    }) : null
  // The registry is *not* chosen by environment, unlike the gateway: there is no registry double,
  // because there is nothing a double could honestly stand in for — the definitions live in the
  // backend's own state, and the settings section that reads them is only mounted in the app. A
  // browser build's call rejects on Tauri's own "command not found", which is loud and names the
  // call, rather than reaching a stub that would look like a host with nothing registered.
  const registry: AgentRegistryClient = createAgentRegistryClient(
    deps.registryCommands ?? createTauriAgentRegistryCommands(),
  )

  return {
    gateway,
    registry,
    async start() {
      await gateway.start()
      // Subscribing is what makes this window answerable, and it happens only once the runtime
      // is up: a window that registered before there was anything to ask would be a registration
      // held against a host that cannot use it.
      await responder?.start()
    },
    async openSession(request) {
      // Started here rather than left to the caller because the two calls are one intention:
      // a session cannot be opened on a runtime that is not up, and the contract's own order
      // is start → openSession. It is idempotent, so a caller that started explicitly pays
      // nothing for this.
      if (environment === 'tauri') await gateway.start()
      // Registered before the session exists, deliberately: `session/new` is what makes the
      // engine able to send `fs/read_text_file`, and a question that arrives in the gap between
      // the session and the registration would be answered `Unknown` — a loud failure for a
      // window that was about to be able to answer.
      await responder?.start()
      return gateway.openSession(request)
    },
    async stop() {
      await gateway.stop()
      // Unregistered after the engine is down, never before: a read still in flight during the
      // teardown is still a read this window can answer, and withdrawing first would turn it
      // into the host's ten-second bound.
      await responder?.stop()
    },
    connectSvgInsertion(identity, editor_ = editor) {
      return Object.freeze({
        identity,
        capture(path: string, from: number, to: number): AgentInsertionCapture {
          const live = editor_.liveNote(path)
          // The lookup is this binding's, so its null case is too: a note no tab holds has no
          // buffer to anchor an insertion in, and saying so is the alternative to inserting into
          // the note that *is* open.
          if (live === null) return { status: 'refused', refusal: { reason: 'note-not-open', path } }
          return captureInsertionTarget(live, identity, { from, to })
        },
        plan(request: Omit<AgentInsertionPlanRequest, 'identity'>): AgentInsertionPlanResult {
          return planSvgInsertion({ ...request, identity })
        },
        commit(plan: AgentSvgInsertionPlan, attachmentSaved: boolean): AgentInsertionOutcome {
          // Read again *now*, by the plan's own path: the check is against the editor's current
          // account of the note the insert was prepared for, and never against the active one.
          const request: AgentInsertionCommitRequest = {
            live: editor_.liveNote(plan.path),
            identity,
            attachmentSaved,
          }
          return commitSvgInsertion(plan, request)
        },
      })
    },
  }
}

/**
 * The app's one `AgentLiveNoteSource`: the tab store's own lookup.
 *
 * Reached through `useTabsStore` rather than through an import of the store's module state, so
 * the lookup is the *live* store the editor is writing into and not a copy taken when this
 * composition was built — a copy would answer every question with the document as it was at
 * assembly time, which is the staleness this seam exists to remove.
 */
function tabLiveNotes(): AgentLiveNoteSource {
  return {
    lookUpLiveNote: (path) => useTabsStore().lookUpLiveNote(path),
  }
}

/**
 * This window's Tauri label, read lazily.
 *
 * `getCurrentWindow()` reads the label Tauri injected into the page and makes no IPC call, so
 * this costs nothing and needs no capability. It is called only on the Tauri branch, and only
 * when a caller did not supply one — a browser build never reaches it.
 */
function currentWindowLabel(): string {
  return getCurrentWindow().label
}
