/**
 * The `+`'s rows: which ones the composer offers, and what a chosen one puts in the message.
 *
 * Zed's composer carries an "Add Context" menu whose rows insert a *mention* of the chosen thing
 * into the message text (`conversation_view/thread_view.rs:5538`'s `build_add_context_menu` calling
 * `message_editor.update(|editor, cx| editor.insert_context_type("file", window, cx))`). That is the
 * only shape this app can copy honestly, because **the message text is the only channel a turn
 * has**: `AgentGateway.prompt(session, text)` takes a string, and the host builds one `ContentBlock::
 * Text` from it (`src-tauri/src/agent_runtime/acp_transport/calls.rs:177`, `EngineConnection::
 * prompt`). There is no content slot for an attachment, so nothing here may promise that a model was
 * *shown* a file — a row names a path, and the engine's own tools decide what to do with it.
 *
 * Three rules follow from that, and all three are structural rather than careful:
 *
 *  - **Every reference is inside the vault.** The engine runs with the vault as its working
 *    directory, so a vault-relative path is the one spelling it can resolve; a path that is not
 *    under the vault is dropped from the listing rather than inserted, because the alternative is a
 *    row that names a file outside the workspace the user opened. The containment test is the
 *    attachments feature's own (`isPathWithinVault`) and the prefix strip is the shared path
 *    grammar's (`stripVaultPrefix`) — one rule, not a second one written here.
 *  - **The reference is the path and nothing else.** No `@` sigil: the catalogue's own note in the
 *    panel's copy is that `prompt()` takes no context slot and nothing in the composer triggers
 *    `@`, and a syntax the engine does not parse would be a promise made by punctuation. The
 *    inserted text is what a user would type to point the agent at a file.
 *  - **A selection is added as its own words.** {@link selectedPassage} is the one kind of row that
 *    is not a path, and the reason is that a range has no path to name: the reader cannot type one
 *    and the engine cannot look one up. What a reader would otherwise do by hand — copy the passage
 *    and paste it into the message — is what the row does for them, in the same channel as
 *    everything else here.
 *
 * **Why there is no attachment row, and why no capability gates the rows above.** Zed's menu has an
 * Image entry, `.disabled(!supports_images)`, and ours has no counterpart — not because this app
 * has not read the capability, but because reading it would licence the wrong thing. The engine's
 * answer (`promptCapabilities.image`; the pinned OpenCode advertises it, `adapters/opencode.rs:117`)
 * is about content *blocks* in a prompt, and this host cannot put one there: `prompt` builds a
 * single `ContentBlock::Text` from one string, which is why `AgentModelCapabilities`'
 * `acceptedAttachmentKinds` (`agent-context-snapshot.ts`) has no production reader — a gate keyed
 * to it would draw a row that looks available at exactly the engine whose capability is `true`, and
 * the file would not travel. That is the defect the capability rule names, arriving from the
 * direction the rule does not usually come from. A path or a passage in the message needs no
 * capability at all: it is text on every engine, and the one thing it must not do — claim the file
 * itself was sent — no capability can make true. Sending what Zed's menu gates is a host change
 * (one `prompt` call carrying more than one block), not a UI change.
 */

import { isPathWithinVault } from '../../attachments'
import { stripVaultPrefix } from '../../../services/paths'
import type { FileEntry } from '../../../platform/gateways/contracts'

/** One thing a reference can name: a file, or a folder to walk into. */
export interface AgentFileReference {
  /**
   * Vault-relative and `/`-separated. This is what is inserted AND what the listing is keyed by,
   * so the row the user picked and the text that reaches the engine cannot drift.
   */
  readonly path: string
  /** What the row is labelled with — the entry's own name, never a path the row does not show. */
  readonly name: string
  readonly isDirectory: boolean
}

/**
 * One directory as the menu holds it.
 *
 * `parent` is `null` exactly at the vault root, and the menu reads it as "no row up": at the root
 * there is nothing above the vault to show, and a row that walked out of the workspace would be
 * offering a listing this app refuses to build.
 */
export interface AgentReferenceFolder {
  readonly directory: string
  readonly parent: string | null
  readonly entries: readonly AgentFileReference[]
}

/**
 * The directory one level up, in this vocabulary — `''` is the root, so the root's answer is
 * `null` rather than `''`, which is the same string it is asked about.
 */
export function parentDirectory(directory: string): string | null {
  if (directory === '') return null
  const cut = directory.lastIndexOf('/')
  return cut === -1 ? '' : directory.slice(0, cut)
}

/**
 * A backend entry as a reference, or `null` when it is not inside the vault.
 *
 * `null` is a refusal rather than a repair: `stripVaultPrefix` answers with the input unchanged when
 * the prefix does not match, so an entry from outside the vault would otherwise become a row whose
 * text is an absolute path somewhere else on the machine. The host confines `list_dir` to the
 * registered vault already, which is what makes this a guard rather than a filter users will see —
 * and a guard that fails closed is the only kind worth having at a boundary like this.
 *
 * An entry that *is* the vault root is dropped too: it has no vault-relative path to offer, and a
 * blank reference would insert nothing while looking like it had done something.
 */
export function toReference(entry: FileEntry, vault: string): AgentFileReference | null {
  if (!isPathWithinVault(entry.path, vault)) return null
  const path = stripVaultPrefix(entry.path, vault)
  if (path === '') return null
  return { path, name: entry.name, isDirectory: entry.is_dir }
}

/** One listing, with the entries the vault does not contain left out. */
export function toFolder(
  directory: string,
  entries: readonly FileEntry[],
  vault: string,
): AgentReferenceFolder {
  const references: AgentFileReference[] = []
  for (const entry of entries) {
    const reference = toReference(entry, vault)
    if (reference !== null) references.push(reference)
  }
  return { directory, parent: parentDirectory(directory), entries: references }
}

/**
 * The text a chosen reference puts in the message.
 *
 * A folder answers `null`: walking into one is how the user reaches a file, and inserting a
 * directory's path would send the engine a target that is not what the reader was asked to pick.
 * The one place this decision is made, so the menu and the draft cannot disagree about it.
 */
export function referenceText(reference: AgentFileReference): string | null {
  return reference.isDirectory ? null : reference.path
}

/**
 * The passage the editor has selected, as the `+`'s Selection row offers it — or `null` when there
 * is nothing to add.
 *
 * Zed's add-context menu carries this row (`conversation_view/thread_view.rs:5648-5652`, enabled by
 * the `has_selection` check it makes before building the menu, `:5551-5569`), and §7.1 names 选区 among
 * the things a context fixes before a send. What it adds is the selected *text*, which is what makes
 * it a rule of its own rather than a fourth arm of {@link referenceText}: a file is added by naming
 * a path the engine resolves itself, and a selection has no path to name.
 *
 * `null` is a refusal, not an empty insertion, and the two arms are different refusals that both
 * have to hold. No range at all is the editor saying nothing is selected. A range that is only
 * whitespace IS a selection the editor reports — selecting a blank line is an ordinary thing to do
 * — and it would still put nothing in the message, so it is refused for the reason
 * {@link referenceText}'s folder arm is: a row that looks like it did something and did not.
 *
 * The argument is structural (`{ text }`, the shape `ai-prompt.ts`'s `PrefixView` uses for the same
 * reason) so that the editor's types are not dragged in here; `getTextSelection()` satisfies it.
 *
 * The emptiness rule is the one the AI selection commands already apply before they act on a
 * selection (`services/ai-edit.ts`, `d.readSelection()` followed by a trim test) — the same
 * predicate on the same read, written out here rather than imported because that module's refusal
 * is about a rewrite it is about to make rather than about a row it is about to offer.
 */
export function selectedPassage(selection: { readonly text: string } | null): string | null {
  if (selection === null) return null
  const text = selection.text.trim()
  return text === '' ? null : text
}

/**
 * The message with a row's text put in at `at`, and where the caret goes.
 *
 * A space separates what is inserted from a word on either side, and one is added only where the
 * neighbour is not already whitespace — a path joined to the word before it names a different path,
 * and a passage joined to one loses its first word. The space *after* is added even at the end of
 * the message, where there is no neighbour to separate from: the reader's next word would otherwise
 * fuse with what was just added, and Zed's own mention insertion appends one for the same reason
 * (`completion_provider.rs:566`, `format!("{} ", uri.as_link())`). The caret lands after everything
 * inserted, so typing on starts a word rather than extending the path.
 *
 * `at` is clamped rather than trusted: the composer reads it from a textarea, and a caller holding a
 * stale offset would otherwise slice past the end and lose the tail of the message.
 */
export function insertReferenceText(
  text: string,
  at: number,
  reference: string,
): { text: string; caret: number } {
  const cut = Math.max(0, Math.min(at, text.length))
  const before = text.slice(0, cut)
  const after = text.slice(cut)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = /^\s/.test(after) ? '' : ' '
  return {
    text: `${before}${lead}${reference}${trail}${after}`,
    caret: cut + lead.length + reference.length + trail.length,
  }
}
