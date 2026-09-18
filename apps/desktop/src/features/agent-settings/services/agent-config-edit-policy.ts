/**
 * V10's other half — the engine's own configuration document: what an editor may submit, which arm a
 * document is in, and whether a submission may be applied.
 *
 * This was the second half of `agent-settings-policy.ts`, and it is a file of its own because it is a
 * different subject from the profile record, with a different counterpart in Rust. `profile.rs`
 * decides the profile's members, its mode and its credentials for the file itself; `config_edit.rs`
 * decides the document's — the path an edit is submitted with, the revision it is built on, and the
 * claim a write carries. The two share one rule and nothing else: 并发冲突, the revision rule
 * {@link decideConfigWrite} applies here and `decideProfileWrite` applies there, which is why the
 * rule is spelled the same way in both files rather than written once and parameterized over two
 * unrelated shapes. What separates them is what a change to one costs the other: a JSONC member's
 * shape and a profile's fields have no line in common.
 *
 * Two of the four things §10.2's T12 row asks for are decided here:
 *
 *  - **JSONC 保留.** The page submits *edits* — a path and a value — and never a document. There is
 *    deliberately no field of {@link ConfigWrite} that could carry text, so a page that wanted to
 *    save a reformatted file has nothing to send. Everything else about preservation is Rust's:
 *    the file is spliced, not re-serialized.
 *  - **并发冲突.** See above: a write built on a revision that has moved is refused and the caller
 *    reloads, never merged, and there is no "force" arm for a page to reach for.
 *
 * Nothing here reads storage, reaches IPC or knows a window, and nothing here reads the profile
 * record: given what the backend said about a document and what the form holds, it answers, and the
 * caller does the writing.
 *
 * Every name below is re-exported from `agent-settings-policy.ts`, so the callers that already name
 * that module — the configuration page, the provider authoring form, `agent-config-ipc.ts`,
 * `agent-provider-block.ts` and their specs — keep the specifier they have.
 */

/** One member the editor changed: a path and a value, and nothing that could be a document. */
export interface ConfigEdit {
  path: string[]
  value: unknown
  /**
   * Whether this member may only be *added* — the backend's `ConfigEdit::if_absent`, which leaves a
   * member that is already there, and every byte around it, exactly as it was found.
   *
   * Absent means the plain `set` the editor has always sent. The arm exists for one shape: a form
   * that has to write a member *inside* a group — a provider block lives inside `provider` — has to
   * be able to put the group there without replacing the ones a document already holds, and a plain
   * `set` of the group would delete every provider in it. An edit that writes nothing is not a
   * rewrite either: the backend answers the revision that is already on disk and touches no bytes.
   */
  ifAbsent?: boolean
}

/** What the backend said about the document, before the user touched it. */
export interface ConfigRead {
  /**
   * The path an edit is submitted with: the document's location *inside the profile root*, which is
   * what `agent_config_document` and `agent_config_edit` take and what `decideConfigWrite` compares.
   *
   * Relative rather than absolute, and the backend's choice: every document read is confined to the
   * profile root by `Profile::document_path`, and the relative spelling is the one that check takes.
   */
  path: string
  /** Where the file really is, as the backend resolved it. Shown; never submitted. */
  resolved: string
  exists: boolean
  /**
   * The revision the document was read at, and the token a write is built on.
   *
   * `null` is the answer for a file that is not there, and it is a *claim* rather than the absence
   * of one: it is what the backend's `apply_claim` checks as "there was no document", and a write
   * carrying it is the create whose result is that member and nothing else. The backend answers
   * `null` exactly when the file is absent and checks it against the disk like any other revision,
   * so a document that appeared in the meantime is a conflict rather than an overwrite.
   */
  revision: string | null
  /**
   * The file as written, or `null` when it is not there.
   *
   * Carried because §8.1 asks a page to say what is actually in effect, and an engine's
   * configuration is a JSONC file whose comments and unknown members a parse would lose — so the
   * page draws the text and edits members, and nothing here re-serializes it.
   */
  text: string | null
  editable: boolean
}

/**
 * Whether this host may write this document at all, or `null` when it may.
 *
 * One predicate with two callers, and that is the whole reason it is a function rather than a
 * condition written where it is needed: {@link decideConfigWrite} refuses a write for this reason,
 * and {@link configEditor} decides whether the page may draw a control at all. A second spelling of
 * "this host does not write here" would be the two answers the page shows disagreeing — and the
 * direction that disagreement fails in is a form over a file the backend will refuse to write.
 *
 * A document that is *not there* is deliberately not in this predicate any more. It used to be:
 * the backend could not create one, so a form over the absence would have been a control that could
 * not work. `apply_claim` creates, so the absence is a state a form may act on, and the one thing
 * left that removes the control is the mode.
 */
type ConfigAbsence = Extract<ConfigRefusal, 'not-editable'>

function configAbsence(read: ConfigRead): ConfigAbsence | null {
  return read.editable ? null : 'not-editable'
}

/**
 * What the configuration page may draw for one document.
 *
 * The four arms are the four honest answers, and `none` is not an absence of information: it is the
 * pair having no document of this host's at all (`user-config`, where the engine reads the user's
 * own installation). The other three lead a user to three different next moves: set a member, set
 * the first member of a document that does not exist yet, or change the profile's mode.
 *
 * `editable` and `creatable` draw the same form, because it is the same form: what differs is the
 * claim the submission carries (`revision`, or `null`) and the sentence above it, and both are
 * decided from the same read. The arm is separate rather than folded into `editable` because the
 * page owes the user the difference in words: saving here *creates the engine's file*, which is a
 * bigger thing than changing a member of one, and §5.2 asks for the real reason rather than a form
 * that quietly did one when the user expected the other.
 *
 * `not-editable` is `ConfigRefusal`'s own id rather than a parallel string, so that rule lives in
 * one place; `creatable` is a state of the *document* rather than a refusal, which is why it is
 * named here and not there.
 */
export type ConfigEditor =
  | { kind: 'editable' }
  | { kind: 'creatable' }
  | { kind: 'not-editable' }
  | { kind: 'none' }

/** Which arm of {@link ConfigEditor} a document — or the lack of one — is in. */
export function configEditor(document: ConfigRead | null): ConfigEditor {
  if (document === null) return { kind: 'none' }
  const absence = configAbsence(document)
  if (absence !== null) return { kind: absence }
  // The revision is the test, not `exists`: it is the value the submission carries, and the two
  // answers cannot disagree — the backend reads the file and hashes it in one step, so `null` is
  // exactly the document that is not there.
  return document.revision === null ? { kind: 'creatable' } : { kind: 'editable' }
}

/**
 * What the user typed as a member's value.
 *
 * `invalid` is its own arm rather than a thrown error: a form that threw would lose what the user
 * typed, and "that is not JSON" is a sentence the page draws next to the field. The parse is of the
 * *value alone* — a fragment the user wrote, not the document — so no comment or trailing comma
 * survives it, and nothing here round-trips the document's own text through `JSON.parse`.
 */
export type ConfigValueParse = { kind: 'value'; value: unknown } | { kind: 'invalid' }

export function parseConfigValue(text: string): ConfigValueParse {
  try {
    return { kind: 'value', value: JSON.parse(text) }
  } catch {
    return { kind: 'invalid' }
  }
}

export interface ConfigWrite {
  path: string
  /**
   * The revision the form read — the token the write is built on, and the only field of this type
   * that can express a *create*: `null` is the claim "the document I read was not there", which the
   * backend checks against the disk exactly as it checks a hash (see {@link ConfigRead.revision}).
   */
  revision: string | null
  edits: ConfigEdit[]
}

export type ConfigUpdate =
  | { status: 'applied'; edits: ConfigEdit[] }
  | { status: 'conflict'; current: ConfigRead }
  | { status: 'refused'; reason: ConfigRefusal; message: string }

/**
 * Why a submission may not be sent. Three arms rather than four: `absent` used to be one of them —
 * "the document does not exist yet, so there is nothing to edit" — and it is not a refusal any
 * more, because a document that is not there is exactly what {@link decideConfigWrite} now allows a
 * create against. A refusal that stayed in this union would be a sentence no state can produce.
 */
export type ConfigRefusal = 'other-document' | 'not-editable' | 'malformed-edit'

export function configRefusalMessage(reason: ConfigRefusal): string {
  switch (reason) {
    case 'other-document':
      return 'These changes were built from another file. Reload it and edit again.'
    case 'not-editable':
      return 'This profile reuses your own configuration, so settings does not write to it.'
    case 'malformed-edit':
      return 'A setting has to be named.'
  }
}

/**
 * Whether one submitted document write may be applied.
 *
 * The same four decisions as the record, with one addition: the edits themselves are checked for
 * the shape Rust requires — a path that names something. The check is not redundant with the
 * backend's: a blank segment is what an unfilled field produces, and sending it would land as
 * "the document has no member at ``" rather than as a form the user can fix.
 *
 * The revision comparison is the whole of the conflict rule and it is unchanged, which is what
 * makes a create the same rule rather than a second one: `null` equals `null` (the document is
 * still not there — write it), and `null` against a revision, or a revision against `null`, is a
 * mismatch in both directions. The second is a document that appeared since the read, and the page
 * answers it the way it answers any moved revision: reload, never merge.
 */
export function decideConfigWrite(read: ConfigRead, write: ConfigWrite): ConfigUpdate {
  if (write.path !== read.path) {
    return {
      status: 'refused',
      reason: 'other-document',
      message: configRefusalMessage('other-document'),
    }
  }
  // The same predicate the page's own arm comes from, so "this host does not write here" cannot be
  // true on screen and false here.
  const absence = configAbsence(read)
  if (absence !== null) {
    return { status: 'refused', reason: absence, message: configRefusalMessage(absence) }
  }
  if (write.revision !== read.revision) {
    return { status: 'conflict', current: read }
  }
  if (!write.edits.every((edit) => edit.path.length > 0 && edit.path.every((part) => part.trim() !== ''))) {
    return {
      status: 'refused',
      reason: 'malformed-edit',
      message: configRefusalMessage('malformed-edit'),
    }
  }
  return { status: 'applied', edits: write.edits }
}
