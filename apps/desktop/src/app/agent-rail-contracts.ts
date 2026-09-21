import type { Ref } from 'vue'
import type { AgentGateway, AgentSession } from '../platform/gateways/agent-contracts'
import type { AgentComposition } from './agent-composition'

/** What the shell can be showing, and nothing else. `idle` is both "the switch is off" and
 *  "the rail is not open" — the shell does not render either, so they are one arm. */
export type AgentRailState =
  | { kind: 'idle' }
  | { kind: 'starting'; vaultId: string }
  | {
      kind: 'live'
      vaultId: string
      /**
       * The directory the engine runs in — the vault root on disk, which is what an open or a
       * load was asked for.
       *
       * Carried because a *load* needs it: `AgentOpenRequest` takes a vault and a folder, and a
       * reopen is a call for the vault the runtime was started for rather than for a new one.
       * The panel's history rows read it too, to say which of the engine's sessions were recorded
       * somewhere else.
       */
      cwd: string
      /** Stable per session, and the key the panel is mounted under — see {@link railKey}. */
      key: string
      gateway: AgentGateway
      session: AgentSession
      /**
       * The engine's own name, for the sentences that have to name it — the session bar's title
       * and the transcript's first line. Read from the registration the backend holds
       * ({@link engineNameFor}), never a constant here, and never absent: an engine the registry
       * does not describe is named by its id, and the id is a fact.
       */
      engineName: string
    }
  | { kind: 'refused'; vaultId: string; reason: string }

export interface AgentRailDeps {
  /** How a runtime for one vault is built. Injected by a test; the app builds the real one. */
  compose?: (vaultId: string) => AgentComposition
  /** A `stop` that failed. Reported rather than swallowed: an engine that would not go away
   *  is a fact about the machine, and it is the one failure the next start will meet again. */
  onStopFailed?: (error: unknown) => void
  /**
   * A `loadSession` that failed — the engine would not hand back a session the user picked out of
   * its history.
   *
   * Reported rather than drawn, and for a reason the other failures here do not have: the rail
   * has no arm for "live, with a notice", and the session on screen is *not* the one at fault, so
   * publishing a refusal would take a running conversation off the screen because a different one
   * could not be opened. The rail keeps the session it is on and hands the engine's own sentence
   * to the caller, which is where the user is looking.
   */
  onResumeFailed?: (error: unknown) => void
  /**
   * A `session/new` that failed — the engine would not open another session on a runtime that is
   * already serving one.
   *
   * The same shape as {@link onResumeFailed}, for the same reason: the session on screen is not
   * the one at fault and the reader is looking at a list rather than at a broken panel, so a live
   * conversation must not be taken off the screen because a *new* one could not be opened.
   */
  onNewSessionFailed?: (error: unknown) => void
}

export interface AgentRail {
  readonly state: Ref<AgentRailState>
  /**
   * The composition behind the runtime that is up, or null.
   *
   * Published because it is the only object that can mint an SVG-insertion binding
   * (`AgentComposition.connectSvgInsertion`), and the surface that needs one is the editor pane's —
   * a different subtree from the rail, with no path to this file's closure. Held here rather than in
   * {@link AgentRailState} because it is a handle and not something to draw: the state is what the
   * rail shows, and a second reader of one value is how the two would come to disagree about when
   * the runtime ended.
   *
   * It is the LIVE one and only the live one: cleared by every teardown, so a binding minted after
   * a stop is a binding to nothing rather than to a runtime that has gone away.
   */
  readonly composition: Ref<AgentComposition | null>
  /**
   * Bring an engine up for this vault and open a session, unless one is already live for it.
   * Idempotent, because the caller watches three inputs (the switch, the vault, the rail) and
   * two of them can change without the answer changing.
   *
   * Resolves when the attempt has settled — `live` or `refused` — and never rejects: every
   * failure this call can meet is a state the rail draws, which is what lets a caller that
   * does not care about the answer leave it as a floating promise (`void`) without an
   * unhandled rejection waiting to happen.
   */
  open(vaultId: string, cwd: string): Promise<void>
  /**
   * Put one of this runtime's sessions on screen — the one move between two sessions of one
   * runtime, and the only one there is.
   *
   * Two ways in, and which one is taken is a fact about this window, not a preference: a session
   * this runtime has **already served** is shown from the handle this window holds for it
   * (nothing is asked of the engine — a load is refused for a session a runtime is serving, and
   * rightly so: a conversation does not change by being looked at), and a session it has not is
   * loaded, which is what `loadSession` is for. Both land in the same `live` arm under a new
   * {@link railKey}, so a session change is a remount and never a re-point of the panel.
   *
   * Resolves when the attempt has settled, and never rejects: a load that failed leaves the
   * session that was already open exactly where it was, and reports the engine's refusal through
   * {@link AgentRailDeps.onResumeFailed}. Nothing happens for a rail that is not `live` — a
   * reopen is a move *within* a runtime, so there is nothing to move from — and nothing happens
   * for the session already on screen, which is the row a list is most likely to be asked about.
   */
  resume(sessionId: string): Promise<void>
  /**
   * Open a session that has never existed before, on the runtime that is already up, and put it on
   * screen — a *new* conversation rather than an old one.
   *
   * `resume`'s sibling and deliberately not a restart. A new session is one more `session/new` on
   * the engine that is serving this one, so the session the reader was in is left open on it and
   * the run it may be in the middle of is untouched: a "New session" that quietly cancelled the
   * answer being read would be the one thing a reader pressing it does not expect. The vault and
   * the folder do not change — a session is a move *within* a runtime, and the runtime is started
   * for a folder the user opened.
   *
   * Resolves when the attempt has settled and never rejects, like the rest of this file: nothing
   * happens for a rail that is not `live` (there is no runtime to open one on), and a refusal is
   * reported through {@link AgentRailDeps.onNewSessionFailed} with the session that was open left
   * exactly where it was.
   */
  newSession(): Promise<void>
  /** Ask again after a refusal: a fresh composition, which is a fresh `runtimeEpoch`. */
  retry(): Promise<void>
  /** Take the runtime down and go back to `idle`. */
  close(): Promise<void>
}
