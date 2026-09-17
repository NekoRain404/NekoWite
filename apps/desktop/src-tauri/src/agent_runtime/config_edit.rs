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

use std::fmt;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// The mode a document this host creates is written with: owner read and write, nothing else.
///
/// §8.1's 「受管目录和敏感文件使用最小文件权限」, and it is not only the credential file that needs
/// it — a provider block in an engine's configuration holds a key just as often.
pub const DOCUMENT_MODE: u32 = 0o600;

/// Serializes the read-check-write of every document this host stores, in this process.
///
/// Refusing the loser of a race is only possible if the two steps cannot overlap: two callers that
/// both read revision *r* would both write, and the second would silently win. A second *process*
/// is outside this lock (see the module comment).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Names the temporary sibling a write stages through. A counter and the pid are enough: two live
/// processes cannot share a pid, and the counter separates calls within one.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The identity of the bytes a document was read from: their SHA-256, in lowercase hex.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Revision(String);

impl Revision {
    pub fn of(text: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        Self(format!("{:x}", hasher.finalize()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The revision a caller claims, when it arrives as text from outside this process.
    ///
    /// Only ever compared, so what a caller sends must at least have the shape this host issues —
    /// and a token that does not is refused at the boundary rather than compared and reported as a
    /// conflict, because those are two different things for a user to act on: "someone else changed
    /// this" and "this form was not built from a document at all".
    pub fn parse(value: &str) -> Option<Self> {
        let well_formed = value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        well_formed.then(|| Self(value.to_ascii_lowercase()))
    }
}

/// Why a document could not be read, scanned or written.
///
/// Data only, like `registry::RegistryError`: the sentence a user reads is built at the IPC boundary,
/// and it is built there because it names a field of a form rather than a fact about a file.
#[derive(Debug)]
pub enum ConfigError {
    /// The filesystem refused, or the file is not text this host can hold as a `String`.
    Io { path: PathBuf, message: String },
    /// The text is not JSONC this scanner can follow, at a byte offset. The edit is refused:
    /// rewriting a file we cannot read is how comments and unknown fields are lost.
    Syntax {
        path: PathBuf,
        offset: usize,
        message: String,
    },
    /// The edit names a key the document does not have there. Intermediate objects are *not*
    /// invented: creating a chain of parents would be this host deciding what an engine's
    /// configuration should look like, which §3.4.5 leaves to a verified adapter.
    Missing { path: Vec<String> },
    /// The path descends through a value that is not an object (an array, a string, a number).
    NotAnObject { path: Vec<String> },
    /// An empty path, or a path with an empty segment — what an unfilled form field produces.
    BlankPath,
}

/// One structural change to a document.
pub struct ConfigEdit {
    path: Vec<String>,
    value: Value,
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
        if path.is_empty() || path.iter().any(|segment| segment.trim().is_empty()) {
            return Err(ConfigError::BlankPath);
        }
        Ok(Self { path, value })
    }

    /// The member as compact JSON. `Value`'s `Display` is that serialization and cannot fail, so
    /// there is no failure arm for a caller to invent handling for.
    fn rendered_value(&self) -> String {
        self.value.to_string()
    }
}

/// A document as it was read: the bytes, where they came from, and the revision they hash to.
pub struct ConfigDocument {
    path: PathBuf,
    text: String,
    revision: Revision,
}

impl ConfigDocument {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn revision(&self) -> &Revision {
        &self.revision
    }

    /// The document as written, for the structured editor — the only caller that may hold it.
    ///
    /// It can contain a credential (a provider block holds a key as often as a host), so this text
    /// is the editor's and nothing else's: not a log line, not a diagnostic, not an error message.
    /// Nothing in this module prints it — [`WriteOutcome`]'s `Debug` is hand-written for that
    /// reason — and the only answer that carries it is the one a settings page renders.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Whether this document already has a member named `name` at its root.
    ///
    /// The question `apply` cannot answer, and the one a *default* needs: a value this host ships
    /// may only be written where the document has not spoken, and a caller that cannot tell "the
    /// member is absent" from "the member is there and says something else" cannot tell a first run
    /// from a user who made their own choice. Deliberately a `bool` and not a value: this document
    /// can hold a credential, and a query whose answer is a value would be a second way for that
    /// text to leave the module.
    ///
    /// A document whose root is not an object has no members, which is the honest answer and not a
    /// failure — nothing in this module writes such a document, and refusing here would make a file
    /// the host does not own a reason for a settings page to stop working.
    pub fn has_member(&self, name: &str) -> Result<bool, ConfigError> {
        let root = scan(&self.text, &self.path)?;
        Ok(root
            .object
            .as_ref()
            .is_some_and(|object| object.entries.iter().any(|entry| entry.key == name)))
    }

    /// Whether the member `name` is, byte for byte, `value` as this host serializes it.
    ///
    /// The question "is the thing in this document the thing I would write?" — which is what an
    /// idempotent default and a settings readout both need, and which [`has_member`] cannot answer:
    /// a member that is *there* and one that is *mine* are different facts, and the difference is
    /// the whole of whether a host may leave it alone.
    ///
    /// A comparison rather than a reader, deliberately. The text of a value is exactly what
    /// [`ConfigDocument::text`] exists to keep out of every other channel, and a method that handed
    /// back a member's span would be a second way for a credential to leave this module — so this
    /// one answers with a `bool` and the caller never sees the bytes it compared.
    ///
    /// Whitespace is part of the comparison and that is the safe direction: a member a user
    /// reformatted by hand compares unequal, and the caller's conservatism is to treat it as
    /// theirs rather than as its own.
    ///
    /// [`has_member`]: ConfigDocument::has_member
    pub fn member_is(&self, name: &str, value: &Value) -> Result<bool, ConfigError> {
        let root = scan(&self.text, &self.path)?;
        let found = root
            .object
            .as_ref()
            .and_then(|object| object.entries.iter().find(|entry| entry.key == name));
        Ok(found.is_some_and(|entry| {
            self.text[entry.value.start..entry.value.end] == value.to_string()
        }))
    }
}

/// What a write did.
pub enum WriteOutcome {
    /// The bytes are on disk, under this revision.
    Written { revision: Revision },
    /// The document is not the one the caller read, so nothing was written. `current` is what is
    /// there now — the caller reloads and rebuilds its edit from it. `None` means there is no
    /// document there now: the one the caller read was removed, or the caller read none and there
    /// is still none to write into.
    Conflicted { current: Option<ConfigDocument> },
}

/// Hand-written, because a derived one would print `current`'s text: the document this module is
/// careful never to print, and the one that can hold a credential.
impl fmt::Debug for WriteOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteOutcome::Written { revision } => f.debug_tuple("Written").field(revision).finish(),
            WriteOutcome::Conflicted { current } => f
                .debug_tuple("Conflicted")
                .field(&current.as_ref().map(ConfigDocument::revision))
                .finish(),
        }
    }
}

/// Reads a document, or reports that there is none.
///
/// A missing file is `Ok(None)` and not an error: a profile whose engine has never been configured
/// has no document yet, and that is the state §3.1's first-run flow starts from.
pub fn read(path: &Path) -> Result<Option<ConfigDocument>, ConfigError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ConfigError::Io {
                path: path.to_path_buf(),
                message: error.to_string(),
            })
        }
    };
    let text = String::from_utf8(bytes).map_err(|_| ConfigError::Io {
        path: path.to_path_buf(),
        message: "the file is not UTF-8".to_string(),
    })?;
    Ok(Some(ConfigDocument {
        path: path.to_path_buf(),
        revision: Revision::of(&text),
        text,
    }))
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

/// The document an edit that read nothing is applied to: no members.
///
/// *No members* rather than no bytes, and the difference is not cosmetic — a file of zero bytes is
/// not JSONC this scanner can follow, so a create that wrote one would hand the engine a document
/// nothing can read (including this host, on the next read). A create is not a second kind of
/// splice either: it is the same [`splice`] against `{}`, so the members a create produces are the
/// ones the caller named and nothing else.
const EMPTY_DOCUMENT: &str = "{}";

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
    for edit in edits {
        text = splice(&text, edit, path)?;
    }
    write_replacing(path, &text)?;
    Ok(WriteOutcome::Written {
        revision: Revision::of(&text),
    })
}

/// The text with one edit applied.
fn splice(text: &str, edit: &ConfigEdit, path: &Path) -> Result<String, ConfigError> {
    let value = edit.rendered_value();
    let root = scan(text, path)?;
    let (last, parents) = edit.path.split_last().expect("checked by ConfigEdit::set");
    let mut node = &root;
    // Every segment but the last names a container that must already exist. Only the last may be
    // added, and only to an object the document already has.
    for (depth, segment) in parents.iter().enumerate() {
        let here = || edit.path[..=depth].to_vec();
        let object = node
            .object
            .as_ref()
            .ok_or_else(|| ConfigError::NotAnObject { path: here() })?;
        let entry = object
            .entries
            .iter()
            .find(|entry| &entry.key == segment)
            .ok_or_else(|| ConfigError::Missing { path: here() })?;
        node = &entry.value;
    }
    let container = edit.path[..edit.path.len() - 1].to_vec();
    let object = node
        .object
        .as_ref()
        .ok_or(ConfigError::NotAnObject { path: container })?;
    match object.entries.iter().find(|entry| &entry.key == last) {
        // The span is the *value's*, so the member's name, its position, the comments around it and
        // every other byte of the document are untouched. The value itself is the caller's
        // serialization — that is what "set this member to this value" means.
        Some(entry) => Ok(splice_at(text, entry.value.start, entry.value.end, &value)),
        None => {
            let (at, insertion) = member_insertion(text, object, last, &value);
            Ok(splice_at(text, at, at, &insertion))
        }
    }
}

fn splice_at(text: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len() + replacement.len());
    out.push_str(&text[..start]);
    out.push_str(replacement);
    out.push_str(&text[end..]);
    out
}

/// Where a new member goes, and the text that puts it there.
///
/// Never by replacing the whitespace between the last member and `}`: a comment can live there, and
/// adding a member by deleting a comment is the data loss this module exists to prevent. The text
/// is inserted at a position instead, and the document's own style decides what it looks like — the
/// indentation of its last member, and whether it writes a comma after one.
fn member_insertion(text: &str, object: &ObjectNode, key: &str, value: &str) -> (usize, String) {
    match object.entries.last() {
        None => {
            let close_indent = line_indent(text, object.close);
            (
                object.open + 1,
                format!("\n{close_indent}  \"{key}\": {value}\n{close_indent}"),
            )
        }
        Some(last) => {
            let indent = line_indent(text, last.key_start);
            match object.trailing_comma_at {
                // The author writes a comma after the last member. The new one goes *past* that
                // comma and brings its own, so the document keeps its style instead of ending up
                // with one member separated by a newline and the rest by commas.
                Some(after_comma) => (after_comma, format!("\n{indent}\"{key}\": {value},")),
                None => (last.value.end, format!(",\n{indent}\"{key}\": {value}")),
            }
        }
    }
}

/// The whitespace a line starts with: the indentation a member added beside `at` should wear.
///
/// A line whose content begins before the whitespace run ends — `{"a": 1}` written on one line —
/// has no indentation, and answers with the empty string rather than with the previous line's.
fn line_indent(text: &str, at: usize) -> String {
    let before = &text[..at];
    let line = match before.rfind('\n') {
        Some(newline) => &before[newline + 1..],
        None => before,
    };
    if !line.is_empty() && line.bytes().all(|byte| byte == b' ' || byte == b'\t') {
        line.to_string()
    } else {
        String::new()
    }
}

/// Replaces a file's bytes, atomically and with [`DOCUMENT_MODE`].
///
/// Staged through a temporary sibling in the same directory and renamed, so no reader ever sees a
/// half-written document and a failure leaves the original in place. A file that is already there
/// keeps the mode it has: this host sets the mode of what it creates, and tightening a user's file
/// behind their back is not a configuration edit.
pub(crate) fn write_replacing(path: &Path, text: &str) -> Result<(), ConfigError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let io = |message: String| ConfigError::Io {
        path: path.to_path_buf(),
        message,
    };
    let parent = path
        .parent()
        .ok_or_else(|| io("the path has no directory".into()))?;
    fs::create_dir_all(parent).map_err(|error| io(error.to_string()))?;
    let mode = fs::metadata(path)
        .ok()
        .map_or(DOCUMENT_MODE, |meta| meta.permissions().mode() & 0o777);
    let temp = parent.join(format!(
        ".nekowite-config-{}-{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let staged = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(text.as_bytes())
                .and_then(|()| file.sync_all())
        })
        .and_then(|()| fs::rename(&temp, path));
    if let Err(error) = staged {
        let _ = fs::remove_file(&temp);
        return Err(io(error.to_string()));
    }
    // The rename is what makes the new bytes visible; fsyncing the directory is what makes it
    // survive a power loss, since the directory's entry list is a separate write from the file's.
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io(error.to_string()))
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/// A value's byte span, and — when it is an object — its members.
///
/// Arrays are scanned for their end and nothing else: an edit names member *names*, so there is no
/// path into an array for this module to represent, and not modelling them keeps the tree the size
/// of the question being asked.
struct Node {
    start: usize,
    end: usize,
    object: Option<Box<ObjectNode>>,
}

struct ObjectNode {
    /// The `{`, which is where a member is added to an empty object.
    open: usize,
    /// The `}`, which is where the object's own indentation is measured from.
    close: usize,
    entries: Vec<Entry>,
    /// Just past a comma that follows the *last* member, when the author writes one: a style JSONC
    /// files keep, and one an added member has to keep too rather than producing a document whose
    /// last two members are separated differently from the rest.
    trailing_comma_at: Option<usize>,
}

struct Entry {
    key: String,
    /// Where the member's name starts, which is where its line's indentation starts.
    key_start: usize,
    value: Node,
}

/// One scan failure: the byte offset it was found at, and what was wrong with it.
type ScanError = (usize, String);

/// Scans a whole document, which is what every edit does before it changes anything.
///
/// The whole document and not only the path: an edit is refused when the file is not something this
/// scanner can follow anywhere in it, because the alternative — editing around a region we cannot
/// read — is how a hand-written file with a comment block in the middle gets half-rewritten.
fn scan(text: &str, path: &Path) -> Result<Node, ConfigError> {
    let mut scanner = Scanner::new(text);
    let syntax = |(offset, message): ScanError| ConfigError::Syntax {
        path: path.to_path_buf(),
        offset,
        message,
    };
    scanner.skip_trivia().map_err(syntax)?;
    let node = scanner.parse_value().map_err(syntax)?;
    scanner.skip_trivia().map_err(syntax)?;
    if scanner.pos != text.len() {
        return Err(syntax((
            scanner.pos,
            "there is more than one root value".to_string(),
        )));
    }
    Ok(node)
}

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// Whitespace and comments — the whole difference between JSONC and JSON, and the reason a
    /// stock parser cannot be used to find a span in one.
    fn skip_trivia(&mut self) -> Result<(), ScanError> {
        loop {
            while self.peek().is_some_and(|byte| byte.is_ascii_whitespace()) {
                self.pos += 1;
            }
            match (self.peek(), self.bytes.get(self.pos + 1).copied()) {
                (Some(b'/'), Some(b'/')) => {
                    self.pos += 2;
                    while self.peek().is_some_and(|byte| byte != b'\n') {
                        self.pos += 1;
                    }
                }
                (Some(b'/'), Some(b'*')) => {
                    let open = self.pos;
                    let rest = self.bytes.get(self.pos + 2..).unwrap_or_default();
                    let end = rest
                        .windows(2)
                        .position(|pair| pair[0] == b'*' && pair[1] == b'/');
                    match end {
                        Some(offset) => self.pos += 2 + offset + 2,
                        None => return Err((open, "a block comment is never closed".to_string())),
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    fn parse_value(&mut self) -> Result<Node, ScanError> {
        let start = self.pos;
        let object = match self.peek() {
            Some(b'{') => Some(Box::new(self.parse_object(start)?)),
            Some(b'[') => {
                self.parse_array()?;
                None
            }
            Some(b'"') => {
                self.parse_string()?;
                None
            }
            Some(_) => {
                self.parse_primitive()?;
                None
            }
            None => return Err((start, "a value was expected".to_string())),
        };
        Ok(Node {
            start,
            end: self.pos,
            object,
        })
    }

    fn parse_object(&mut self, start: usize) -> Result<ObjectNode, ScanError> {
        self.pos += 1; // the `{`, already seen by the caller
        let mut entries = Vec::new();
        let mut trailing_comma_at = None;
        let close = loop {
            self.skip_trivia()?;
            match self.peek() {
                Some(b'}') => {
                    let close = self.pos;
                    self.pos += 1;
                    break close;
                }
                None => return Err((start, "an object is never closed".to_string())),
                Some(_) => {}
            }
            let key_start = self.pos;
            let key = self.parse_string()?;
            if key.contains('\\') {
                return Err((
                    key_start,
                    "a member name written with an escape cannot be matched".to_string(),
                ));
            }
            self.skip_trivia()?;
            if self.peek() != Some(b':') {
                return Err((self.pos, "expected a colon after a member name".to_string()));
            }
            self.pos += 1;
            self.skip_trivia()?;
            let value = self.parse_value()?;
            entries.push(Entry {
                key,
                key_start,
                value,
            });
            self.skip_trivia()?;
            // Recorded from this member's own comma, and left alone when the loop meets the `}`:
            // that is what makes it mean "the *last* member has one".
            trailing_comma_at = match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    Some(self.pos)
                }
                _ => None,
            };
        };
        Ok(ObjectNode {
            open: start,
            close,
            entries,
            trailing_comma_at,
        })
    }

    /// Scans an array and leaves the cursor just past its `]`.
    fn parse_array(&mut self) -> Result<(), ScanError> {
        let start = self.pos;
        self.pos += 1;
        loop {
            self.skip_trivia()?;
            match self.peek() {
                Some(b']') => {
                    self.pos += 1;
                    return Ok(());
                }
                None => return Err((start, "an array is never closed".to_string())),
                Some(_) => {}
            }
            self.parse_value()?;
            self.skip_trivia()?;
            if self.peek() == Some(b',') {
                self.pos += 1;
            }
        }
    }

    /// Reads one string token and answers with the text between its quotes, as written.
    ///
    /// Escapes are left as written rather than resolved, and a member *name* containing one is
    /// refused by the caller. A key is what a lookup compares, and a half-resolved key would let a
    /// document spelling a member `"apiKey"` be read as not having it and then be handed a
    /// second member of the same name — one object with two keys, which a JSONC reader may resolve
    /// either way. Values are never compared with anything, so their escapes cost nothing. What
    /// this does have to know is where the token ends, which is the whole of the loop below: the
    /// byte after a backslash cannot close the string, whatever it is.
    fn parse_string(&mut self) -> Result<String, ScanError> {
        let open = self.pos;
        if self.peek() != Some(b'"') {
            return Err((open, "expected a quoted string".to_string()));
        }
        let mut end = self.pos + 1;
        loop {
            match self.bytes.get(end) {
                None => return Err((open, "a string is never closed".to_string())),
                Some(b'\\') => end += 2,
                Some(b'"') => break,
                Some(_) => end += 1,
            }
        }
        let raw = std::str::from_utf8(&self.bytes[self.pos + 1..end])
            .map_err(|_| (open, "a string is not UTF-8".to_string()))?;
        self.pos = end + 1;
        Ok(raw.to_string())
    }

    /// Scans `true`, `false`, `null` or a number, and leaves the cursor just past it.
    ///
    /// The token is taken up to the first byte that could not be part of one and then checked,
    /// which is what refuses `tru` rather than editing around something the engine would reject.
    /// What it accepts is the shape of a number, not its value: this scanner locates spans and
    /// never reads numbers, and a document whose numbers are wrong is already the engine's problem.
    fn parse_primitive(&mut self) -> Result<(), ScanError> {
        let start = self.pos;
        while self.peek().is_some_and(|byte| {
            !matches!(
                byte,
                b',' | b'}' | b']' | b'/' | b' ' | b'\t' | b'\r' | b'\n'
            )
        }) {
            self.pos += 1;
        }
        let token = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap_or("");
        let body = token.strip_prefix('-').unwrap_or(token);
        let numeric = !body.is_empty()
            && body.bytes().all(|byte| {
                byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-')
            });
        if matches!(token, "true" | "false" | "null") || numeric {
            Ok(())
        } else {
            Err((start, format!("`{token}` is not a value")))
        }
    }
}
