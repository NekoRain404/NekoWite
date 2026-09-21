//! JSONC documents: reading them, splicing one value in without rewriting the rest, and refusing
//! an edit built on a revision that has moved.
//!
//! §8.1 asks for two things that pull against each other — 「结构化编辑器」 and 「保留注释和未知字段」
//! — and there is exactly one way to have both: never re-serialize the document. So this module
//! does not model a document as data. It scans the text for the **byte span** of the value an edit
//! names and splices text there; every byte outside that span is the user's, unchanged. That makes
//! "the comments survive" a property of the implementation rather than a promise in this comment,
//! and it is also why `serde_json` is not enough: it cannot read a document with comments
//! (`docs/architecture/agent-dependencies.md` §2 records the same fact for the frontend's
//! `@codemirror/lang-json`, whose grammar turns a comment into a parse error).
//!
//! **The revision is not about JSONC.** It is the rule for editing *any* document this host stores,
//! and it is the one `platform/gateways/memory-pet/settings.ts` states for the pet's records: an
//! edit built on a revision that has moved is refused and the caller reloads, never merged, because
//! a merge is how a value the user changed elsewhere gets undone. A *content hash* rather than a
//! counter, because the writers this must notice are not all this app — the engine rewrites its own
//! configuration and the user may open the file in an editor, and a counter would only count our
//! own writes. `profile.rs` uses the same revision for its own record.
//!
//! What a caller can claim is what it read, and one of the things it can read is **nothing**: an
//! engine that has not written its configuration yet has no document, and that state is one an
//! editor has to be able to write out of rather than only report. So the claim an edit carries is
//! the revision it read *or* the fact that there was no document ([`apply_claim`]), and a create is
//! a compare-and-swap against that absence — the same rule, checked the same way, against the same
//! "what is on disk now".
//!
//! What this module does **not** provide is a cross-process compare-and-swap, and the plan says so
//! itself (§7.2): 「应用内锁不能锁住外部 shell；普通"读取后检查再写入"不是跨进程原子比较替换」. The
//! lock below serializes this process's writers; a writer outside it is a window this module states
//! rather than closes.
//!
//! **The pieces are files of their own**, and this one is the composition root the callers name: it
//! keeps the claim/apply entry points and re-exports every item that used to live here, so
//! `agent_runtime::config_edit::X` is the path it always was. Each piece's reason to change is
//! stated at the top of its file: the grammar ([`scanner`]), the text an edit produces ([`splice`]),
//! the document model ([`document`]), the write protocol ([`write`]) and the refusals ([`error`]).

use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;

mod document;
mod error;
mod scanner;
mod splice;
mod write;

// The split's promise: every item a caller names keeps the path it had, so nothing outside this file
// has to learn where a piece went — `agent_runtime::config_edit::{read, ConfigDocument, ConfigError,
// Revision, WriteOutcome, DOCUMENT_MODE}` and the `pub(crate)` write path all still resolve here.
pub use document::{read, ConfigDocument};
pub use error::ConfigError;
pub use write::{Revision, WriteOutcome, DOCUMENT_MODE};
// `pub(crate)`, not `pub`: the write path was crate-visible before the move and stays that way.
pub(crate) use write::write_replacing;
// The same visibility, for the one document whose mode is a claim the settings page makes: the
// credentials file is the host's own, so its writer sets the mode rather than preserving whatever a
// backup or an older build left behind (finding S7).
pub(crate) use write::write_replacing_private;

// The create path's seed text, imported rather than spelled out at the call below, so the doc link
// in `apply_claim` resolves: it lives with the splice that consumes it.
use splice::EMPTY_DOCUMENT;

/// Serializes the read-check-write of every document this host stores, in this process.
///
/// Refusing the loser of a race is only possible if the two steps cannot overlap: two callers that
/// both read revision *r* would both write, and the second would silently win. A second *process*
/// is outside this lock (see the module comment).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// One structural change to a document.
pub struct ConfigEdit {
    path: Vec<String>,
    value: Value,
    /// Whether the member may only be *added*, never replaced: see [`ConfigEdit::if_absent`].
    only_when_absent: bool,
}

impl ConfigEdit {
    /// An edit that sets the member at `path` to `value`: it replaces the member when it is there
    /// and adds it when it is not.
    ///
    /// `path` holds member names from the document's root, as in
    /// `["provider", "acme", "options", "apiKey"]`. An empty path, or a blank segment, is refused
    /// rather than written — a blank segment is what an unfilled form field produces, and a member
    /// named `""` is not something a configuration means.
    pub fn set(path: Vec<String>, value: Value) -> Result<Self, ConfigError> {
        Ok(Self::edit(path, value, false)?)
    }

    /// An edit that writes `value` at `path` **only where the document has not spoken**, and leaves
    /// the document byte for byte when the member is already there.
    ///
    /// It exists for one shape a settings form cannot avoid. A member a form wants to write lives
    /// *inside* a group — `provider` is where a provider block goes — and [`ConfigEdit::set`] cannot
    /// put the group there: replacing `provider` wholesale would delete the providers a user already
    /// has, and [`ConfigError::Missing`] refuses a path whose parents are absent, which is exactly
    /// the state a profile whose engine has never been given a provider is in. So a form submits
    /// two edits in one call: this one for the group it has to be sure of, and a plain
    /// [`ConfigEdit::set`] for the member itself. A group that is already there is left exactly as
    /// it was found — whatever else it holds, and whatever comments are written inside it.
    ///
    /// **This does not invent a shape**, which is the rule [`ConfigError::Missing`] holds. The
    /// caller names the group as a path segment and hands over the value that goes in it; nothing
    /// here derives a member name or a nesting from the ones it was given. That the value is an
    /// object at all is the caller's statement about the engine's format, which is where §3.4.5
    /// leaves it — the same way a provider block's own members are the form's to name.
    ///
    /// **The editing order is the caller's**, and this arm is why the order matters: it is a no-op
    /// when the group is there, so a submission that puts it first cannot depend on what the later
    /// edits did.
    ///
    /// **It is a write, not a read-back.** Nothing here reports whether the member was absent: the
    /// answer a caller would use it for is "does the document have this group", which is
    /// [`ConfigDocument::has_member`]'s question, asked of a revision the caller is not editing.
    pub fn if_absent(path: Vec<String>, value: Value) -> Result<Self, ConfigError> {
        Ok(Self::edit(path, value, true)?)
    }

    fn edit(path: Vec<String>, value: Value, only_when_absent: bool) -> Result<Self, ConfigError> {
        if path.is_empty() || path.iter().any(|segment| segment.trim().is_empty()) {
            return Err(ConfigError::BlankPath);
        }
        Ok(Self {
            path,
            value,
            only_when_absent,
        })
    }

    /// The member as compact JSON. `Value`'s `Display` is that serialization and cannot fail, so
    /// there is no failure arm for a caller to invent handling for.
    fn rendered_value(&self) -> String {
        self.value.to_string()
    }
}

/// Applies `edits` to the document at `path`, or refuses because the document moved.
///
/// The narrow form of [`apply_claim`]: the caller read a document and claims the bytes it read.
pub fn apply(
    path: &Path,
    expected: &Revision,
    edits: &[ConfigEdit],
) -> Result<WriteOutcome, ConfigError> {
    apply_claim(path, Some(expected), edits)
}

/// Applies `edits` to the document at `path` — creating it when the caller read none — or refuses
/// because the document is not the one the caller read.
///
/// `expected` is the caller's claim about what it read: the bytes it hashed, or `None` when it read
/// no document at all. It is checked against what is **on disk now**, not against anything this
/// module remembers: the caller's copy is a claim about the past, and this is the only place that
/// can compare it with the present. Edits are applied in order, each against the text the previous
/// one produced, so no edit is applied against a span another edit has already moved. Nothing
/// reaches the disk until every edit has succeeded.
///
/// **A create is the same claim, not a second write path.** "There was no document" is checked
/// under the same lock, against the same disk, as "the document was at this revision" — so a file
/// that appeared since the read (the engine writing its own configuration, another window, the user
/// creating it by hand) wins: the caller is handed it and writes nothing. Without that, a create
/// would be the one edit in this module that could overwrite a file nobody read, which is the rule
/// the rest of the module exists to hold.
///
/// **What creation still does not do is invent a shape.** The edits are spliced into
/// [`EMPTY_DOCUMENT`], so a path whose parents are not there is refused with
/// [`ConfigError::Missing`] exactly as it is in a document someone wrote `{}` by hand: which
/// members an engine expects, and in what nesting, is §3.4.5's adapter's answer and not this
/// host's. What a create writes is the member the caller named and its value — the caller being the
/// settings form, which is where that name came from.
///
/// A caller that has to write *inside* a group therefore names the group too, as its own edit, with
/// [`ConfigEdit::if_absent`] — one submission setting `["provider"]` and then
/// `["provider", "<id>"]`. The group is the caller's statement about the format, made in the same
/// place the nested member is, and it is a no-op in the document a user has already put providers
/// in: what that arm may not do is replace a group it did not write.
///
/// **Why creating is this module's to do at all.** A file that is not there has no comments and no
/// unknown members in it, so the one argument against writing a configuration document this host
/// did not author — that a rewrite loses what somebody else put there — has nothing to apply to.
/// The tree's own precedent says the same thing about this exact document: `profile.rs` writes it
/// whole when it is absent (`apply_shipped_permissions`, which runs on every open), and refuses a
/// *member chain* that is not there for the reason above.
pub fn apply_claim(
    path: &Path,
    expected: Option<&Revision>,
    edits: &[ConfigEdit],
) -> Result<WriteOutcome, ConfigError> {
    // A write with no edits is neither a conflict nor a rewrite: it reports the revision that is
    // already there, so a form resubmitted unchanged does not touch the file's mtime — or restart
    // an engine watching it. A claim of *nothing* has no such revision to report: nothing was asked
    // to be written and there is still no document, which is the arm the caller reloads from.
    if edits.is_empty() {
        return Ok(match expected {
            Some(revision) => WriteOutcome::Written {
                revision: revision.clone(),
            },
            None => WriteOutcome::Conflicted { current: None },
        });
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let current = read(path)?;
    // Whether the arm below takes the document that is already there. Read before the match moves
    // it, and used after the edits for the rule just below the loop.
    let existing = current.is_some();
    let mut text = match (expected, current) {
        // The document is the one the caller read: the edit lands in its text.
        (Some(expected), Some(current)) if &current.revision == expected => current.text,
        // The caller read nothing and there is nothing: the edit is the document's first content.
        // Every byte outside the spliced span is still nobody's, because there are no other bytes.
        (None, None) => EMPTY_DOCUMENT.to_string(),
        // Either claim is wrong about the present: bytes the caller did not read, or a document
        // where the caller read none. Both are the same answer — here is what is there, reload.
        (_, current) => return Ok(WriteOutcome::Conflicted { current }),
    };
    let before = text.clone();
    for edit in edits {
        // `None` is an edit that had nothing to say — a member it may only add is already there —
        // and the text is left exactly as the previous edit produced it.
        if let Some(spliced) = splice::splice(&text, edit, path)? {
            text = spliced;
        }
    }
    // Every edit wrote nothing and the document was already there: this is the empty-edit case one
    // step in, and it is answered the same way rather than by writing the same bytes back. What it
    // protects is the file — a form resubmitted unchanged must not move its mtime or restart an
    // engine watching it — and it is reachable in the ordinary way: a provider form's group edit
    // (`if_absent`) is a no-op on every document that already has the group.
    if existing && text == before {
        return Ok(WriteOutcome::Written {
            revision: Revision::of(&text),
        });
    }
    write_replacing(path, &text)?;
    Ok(WriteOutcome::Written {
        revision: Revision::of(&text),
    })
}
