/**
 * The permission vocabulary: what the engine asks the user to allow, the answers it offers, and the
 * one request that carries them.
 *
 * Apart from the tool-call shapes beside it because it changes for its own reason: this is ACP's
 * `RequestPermissionRequest` and its `PermissionOption`s — the decision §6.3 makes the user's rather
 * than the host's — so a kind added here is a new thing a person can be asked to weigh. The request
 * carries {@link AgentToolInput} and {@link AgentToolContent} rather than a copy of them, so the
 * prompt shows exactly what the tool call it belongs to stated.
 *
 * The reader is `readers/tools.ts`'s `readPermissionRequest`, and the answer path is the gateway's
 * own `answerPermission` call.
 */

import type { AgentToolContent, AgentToolInput } from './tool-call'

/**
 * One answer the engine offers for a permission request.
 *
 * `kind` exists so the UI can mark a destructive or open-ended answer without
 * inventing one: §6.3 forbids the host from adding an "always allow" the engine
 * never offered, and `optionId` — the engine's own id — is what an answer is
 * validated against.
 *
 * It carries the engine's own four kinds rather than a collapsed allow/reject
 * pair, because the difference between them is the difference the user is being
 * asked to weigh. `allow_always` remembers the choice and `allow_once` does not;
 * a surface that draws them the same cannot warn about the lasting one, and a
 * consumer that cannot tell them apart cannot honestly emphasise either. The
 * values match the wire (`PermissionOptionKind` in the v1 schema).
 */
export type AgentPermissionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

export interface AgentPermissionOption {
  optionId: string
  name: string
  kind: AgentPermissionKind
}

export interface AgentPermissionRequest {
  /**
   * The engine's id for this request. It is what an answer carries back, what
   * makes a repeated click recognisable as a repeat, and what an expired answer is
   * rejected by — so it is the whole binding between the request the user saw and
   * the permission that would be granted.
   */
  requestId: string
  /**
   * The tool call this request is about. Carried because a permission prompt is
   * about a *row* the user can already see in the timeline, and without this the
   * two cannot be related: the prompt would sit there asking to approve something
   * the transcript shows no trace of, and a tool row would show as pending with
   * nothing on screen saying why.
   */
  toolCallId: string
  /** What the user is being asked to allow, in the engine's own wording. */
  title: string
  /**
   * What they are allowing. The `unreadable` state matters most here: this is the
   * surface where §6.3 requires the user to see the target of the action they
   * authorize, so "there were no arguments" and "its arguments could not be read"
   * must not look the same to them.
   */
  input: AgentToolInput
  /**
   * The content blocks **this request's own `tool_call`** carried — the proposed change
   * among them, which is the thing a person decides on.
   *
   * Carried by the request rather than joined from the transcript, and that is the whole
   * point of the field. The engine attaches the blocks to the frame it asks with (P0 §7.1
   * measured a request whose `toolCall` carries the diff), and a prompt that read the
   * same call's *row* instead would show whatever the transcript happened to hold: on a
   * host where the request is the first frame to carry a block, nothing at all — a person
   * asked to allow an edit, shown the file's path and no text.
   *
   * **Empty means the request stated no block, and the prompt then draws none.** It is not
   * a gap to be filled from the row: "this request carried no diff" and "this request's
   * diff happens to equal the row's" are different facts, and a surface that lent the row's
   * blocks in the first case would draw both as one picture.
   */
  content: AgentToolContent[]
  /** Exactly the options the engine offered, in its order. */
  options: AgentPermissionOption[]
}
