/**
 * The window's half of the live-buffer seam: answering what a note holds, when the host asks.
 *
 * `fs/read_text_file` is described by ACP as access to unsaved editor state, and the reference
 * client answers it from the open buffer. This host asks the window instead
 * (`agent_runtime/live_notes.rs` declares the port and owns the questions; `state/live_note_windows.rs`
 * publishes them on Tauri's event surface), and this module is the frontend end of that wire: it
 * listens for a question, asks the ONE lookup, and answers.
 *
 * ## The three properties this file exists to keep
 *
 * - **One lookup, not two.** The answer is
 *   {@link AgentLiveNoteSource.lookUpLiveNote} — the same `stores/tabs.ts` method the conflict
 *   baseline and the SVG-insertion anchor read through. Nothing here reads a tab, a path or a
 *   revision for itself, so the host and the editor cannot end up with two definitions of "the
 *   same version of this note".
 * - **A refusal is a distinct answer, never an empty note.** A tab that is still on its first
 *   read holds a placeholder wearing the note's path (§4.3 of the seam report), and answering
 *   `not-held` for it would serve the FILE for a note the user is looking at. The `cannot-answer`
 *   arm carries a reason, and the host turns it into an error.
 * - **A question about a vault this window does not hold is not answered.** The host only asks
 *   windows that registered for the vault, so this is the belt to that braces: an answer naming a
 *   vault the window does not speak for is refused by the host's own vault check, and not sending
 *   it at all is one fewer wrong answer in the world.
 *
 * ## The wire
 *
 * The three channel names are half of a contract whose other half is `state/live_note_windows.rs`;
 * the strings have to match exactly, and a mismatch is a wire that silently never connects. The
 * Rust side asserts against the constants in this file (`agent_live_note_test.rs`,
 * `the_channel_names_are_the_ones_the_host_publishes_on`), because nothing else can.
 *
 * ## Why events and not a command
 *
 * A command would need `lib.rs`, `build.rs` and `capabilities/default.json`, and it would need
 * Tauri to report the calling window — which is what makes a command the better shape for a
 * permission answer. An event needs none of the three: `core:default` already grants
 * `core:event:allow-emit` to the main window, and the pet windows' capability deliberately grants
 * `listen` and not `emit`, so a window that must not answer cannot. The window names itself
 * instead, and the host uses that name only to keep a registration set — never to grant anything.
 */

import type { EventPort } from '../../../platform/gateways/contracts'
import type { AgentLiveNote, LiveNoteLookup } from './agent-context-snapshot'

/** The host's question: which note, in which vault, and the host's own id for it. */
export interface LiveNoteQuestion {
  requestId: string
  vaultId: string
  path: string
}

/** `held`: the window has the note and this is its buffer. */
export interface LiveNoteHeldAnswer {
  requestId: string
  vaultId: string
  path: string
  windowId: string
  state: 'held'
  revision: string
  text: string
  dirty: boolean
}

/** `not-held`: a window holding this vault has no tab for the path — the one arm the host may
 *  serve from the file, because it was asked for. */
export interface LiveNoteNotHeldAnswer {
  requestId: string
  vaultId: string
  path: string
  windowId: string
  state: 'not-held'
}

/** `cannot-answer`: this window holds the note and cannot say what is in it yet. There is no
 *  `unknown` here on purpose — that word belongs to the host, and it means "no answer I trust". */
export interface LiveNoteCannotAnswer {
  requestId: string
  vaultId: string
  path: string
  windowId: string
  state: 'cannot-answer'
  reason: string
}

export type LiveNoteAnswer =
  | LiveNoteHeldAnswer
  | LiveNoteNotHeldAnswer
  | LiveNoteCannotAnswer

/** Which vault this window can be asked about, and whether it still can. Carries no document. */
export interface LiveNoteAttach {
  vaultId: string
  windowId: string
  attached: boolean
}

export const LIVE_NOTE_REQUEST_CHANNEL = 'agent-live-note-request'
export const LIVE_NOTE_ANSWER_CHANNEL = 'agent-live-note-answer'
export const LIVE_NOTE_ATTACH_CHANNEL = 'agent-live-note-attach'

/**
 * The editor, as this responder needs it.
 *
 * Structural rather than a store: the composition supplies it, a test supplies a double, and this
 * module never reaches for a global. It is the SAME lookup the rest of the agent feature reads a
 * note through — the interface exists so that there can be exactly one implementation of it.
 */
export interface AgentLiveNoteSource {
  /** The editor's account of one note, by path. Three arms: see {@link LiveNoteLookup}. */
  lookUpLiveNote(path: string): LiveNoteLookup
}

/**
 * The one `AgentSvgInsertionEditor` in the application, derived from the one lookup.
 *
 * Structural rather than importing the interface from `app/agent-composition.ts`: that file is
 * this module's caller, and a feature service that reached up into the assembly site for a type
 * would be the arrow pointing the wrong way. The shape is checked where it is used, which is
 * where it has to hold.
 *
 * A projection rather than a second lookup: `not-held` and `cannot-answer` both become `null`
 * here, and that is correct for this consumer — the insertion service's `note-not-open` refusal
 * means "nothing is written", so a tab that cannot describe its note yet costs a refusal rather
 * than an insert into a placeholder. The responder, which must not round the two together, reads
 * the richer value directly.
 */
export function liveNoteEditorOf(source: AgentLiveNoteSource): {
  liveNote(path: string): AgentLiveNote | null
} {
  return {
    liveNote(path: string): AgentLiveNote | null {
      const lookup = source.lookUpLiveNote(path)
      return lookup.kind === 'held' ? lookup.note : null
    },
  }
}

export interface LiveNoteResponderDeps {
  /** The one lookup. */
  source: AgentLiveNoteSource
  /** The window's event surface. */
  events: EventPort
  /** The vault this window speaks for; a question about another one is not this window's. */
  vaultId: string
  /**
   * This window's own name, as the host's registry spells it — Tauri's window label. It is a
   * registration key and an answer's evidence, never an authority: the host uses it to *withhold*
   * competence (a label that no longer names a live webview is pruned), and a forged one can only
   * make a read fail.
   */
  windowId: string
}

export interface LiveNoteResponder {
  /** Subscribe, then register. Idempotent, and resolving means both happened. */
  start(): Promise<void>
  /** Unregister and release the subscription. */
  stop(): Promise<void>
}

export function createLiveNoteResponder(deps: LiveNoteResponderDeps): LiveNoteResponder {
  /** Bumped by every start and every stop.
   *
   * The registration below is awaited, so two starts in flight both pass the `off !== null`
   * check and the second would overwrite the first — orphaning a listener nothing holds the
   * unsubscribe for. A stop during that await would leave a listener alive on a responder the
   * caller believes is stopped. A ticket tells a late registration the world moved, so it
   * releases *its own* subscription instead of storing it. Same shape, same reason, as
   * `services/external-doc-sync.ts`. */
  let generation = 0
  let off: (() => void) | null = null

  function answerQuestion(question: LiveNoteQuestion): void {
    // Asked by path, and never about "whatever is open": a question for another vault is not
    // this window's to answer, and answering it would be a window speaking for a vault it does
    // not hold.
    if (question.vaultId !== deps.vaultId) return
    const lookup = deps.source.lookUpLiveNote(question.path)
    const identity = {
      requestId: question.requestId,
      vaultId: question.vaultId,
      path: question.path,
      windowId: deps.windowId,
    }
    const payload: LiveNoteAnswer =
      lookup.kind === 'held'
        ? {
            ...identity,
            state: 'held',
            // The buffer's text, never the disk's: this is the whole of what the seam buys.
            text: lookup.note.buffer.text,
            revision: lookup.note.revision,
            dirty: lookup.note.buffer.state === 'dirty',
          }
        : lookup.kind === 'cannot-answer'
          ? { ...identity, state: 'cannot-answer', reason: lookup.reason }
          : { ...identity, state: 'not-held' }
    // A failed emit is the host going away mid-question, which the host's own bound answers as
    // `Unknown`. There is nothing to retry against and nowhere to report it, so it is not
    // turned into a rejection the caller of `start` would see long after the fact.
    void deps.events.emit(LIVE_NOTE_ANSWER_CHANNEL, payload)
  }

  return {
    async start(): Promise<void> {
      if (off !== null) return
      const mine = ++generation
      const subscription = await deps.events.on<LiveNoteQuestion>(
        LIVE_NOTE_REQUEST_CHANNEL,
        answerQuestion,
      )
      if (mine !== generation) {
        subscription()
        return
      }
      off = subscription
      // Registered *after* the subscription, never before: a question published in between would
      // otherwise be counted as answerable by a window that is not listening yet, and the host
      // would wait its whole bound for an answer nobody was ever going to give.
      await deps.events.emit(LIVE_NOTE_ATTACH_CHANNEL, {
        vaultId: deps.vaultId,
        windowId: deps.windowId,
        attached: true,
      } satisfies LiveNoteAttach)
    },
    async stop(): Promise<void> {
      generation++
      const subscription = off
      off = null
      subscription?.()
      // Unregistered whether or not a subscription was held: the registration is a fact about
      // this window and nothing else releases it.
      await deps.events.emit(LIVE_NOTE_ATTACH_CHANNEL, {
        vaultId: deps.vaultId,
        windowId: deps.windowId,
        attached: false,
      } satisfies LiveNoteAttach)
    },
  }
}
