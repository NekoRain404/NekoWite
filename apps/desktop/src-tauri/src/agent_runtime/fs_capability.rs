//! The client file-system capability: the agent asks, the host writes.
//!
//! P0 §7.2 measured the engine sending `fs/write_text_file` — asking the HOST to
//! perform a write — even though our handshake advertised `clientCapabilities:
//! {}`. So an undeclared capability is not a mechanism that stops the request —
//! it was never one — and a request nobody claims is answered `-32601` by the SDK
//! (`Error::method_not_found`, the SDK's own default for an unhandled method).
//!
//! Declaring the capability is what makes a **delegated** write ours. An edit the
//! engine hands over stops being something we reconstruct from a watcher
//! afterwards and becomes something this host performs, so the baseline and the
//! attribution are exact instead of inferred. That is the whole of what the
//! declaration buys, and what follows is what it does not buy.
//!
//! **It does not make this host the only writer, and nothing here may be read as
//! saying it does.** P0 §7's default-configuration probe measured the same engine
//! writing a file through its own tools with **zero reverse requests** — no
//! permission frame and no `fs/write_text_file` (the measurement is in §7's preamble,
//! not in §7.1, which records a different run) — so the engine has a write path that
//! does not involve us, and used it. That was the suspicion; it is now a measurement.
//! `tests/agent_fs_write_refusal_test.rs` ran three times against the pinned 1.18.29 and
//! every run refused the delegated write and found the file written anyway. The artifact
//! says why: the engine asks this host to write **only** on the permission path, fires
//! that request without awaiting it and discards the answer, and unblocks its own edit
//! tool either way (the engine's single `writeTextFile` call site, inside
//! `writeProposedEdit`). A refusal here is therefore invisible to the engine, and
//! refusing is not a way to prevent a write — the capability is an **opportunity the
//! engine may take, not a gate every write must pass**. What can stop the tool is the
//! permission answer, which is a different module and a different question. A
//! conflict-detection design built on "every agent write reaches this module" rests on
//! something this code cannot support. Full argument:
//! `.superpowers/sdd/roadmap/reports/fs-capability-reargued.md`.
//!
//! **The read half is a buffer read, and the window is asked for it.** `fs/read_text_file` is
//! described by ACP as access to "unsaved editor state" and Zed answers it from the open
//! buffer (`project.open_buffer`, `acp_thread.rs:4595`); this host used to answer it from
//! `std::fs::read_to_string` (`storage/file_store.rs`), which meant an agent reading a note
//! the user was mid-edit in received the older, saved text and proposed against a version they
//! had already moved past. The direction that closes it is [`super::live_notes`]: the read
//! resolves the path inside the session root, asks the windows holding that vault what the
//! path holds, and serves the buffer.
//!
//! **The disk is served in exactly one case, and it is one that was ASKED FOR.** A window must
//! answer "no tab holds this path" for the file to be read, and only that arm may reach
//! `VaultFiles::read`. Everything else — no window registered for the vault, a window that
//! went away, a window that says it cannot answer yet, the ten-second bound, two windows
//! disagreeing — is an error the model can act on, and the file is not consulted. The wrong
//! version of this is the one that looks finished: ask with a short timeout and return disk on
//! timeout, on a dropped sender and on every error. It never fails visibly and it is *less*
//! correct than doing nothing, because it converts "we know we serve disk" into "we may serve
//! disk and say nothing about it" — and a stale read that silently succeeds is
//! indistinguishable from a correct one.
//!
//! **The path is confined before the question is asked**, not after: a window must never be
//! asked about a path the write path would refuse, and the key it is asked with has to be the
//! spelling the editor uses for an open tab (see [`super::live_notes::LiveNoteQuestion::path`]).
//!
//! **And the pinned engine never sends this request.** `readTextFile` has no call site in the
//! 1.18.29 artifact — the schema field, the two capability defaults and the client SDK's own
//! method definition are the whole of it — so its Read tool opens the file from disk and the
//! arm below is for engines that do delegate reads. The stale-read divergence this arm closes
//! is therefore **not** closed by the capability on this engine: plan §7.1's rule, save the
//! note before a disk tool touches it or propose instead, is what stands between the agent and
//! a version the user has moved past.
//!
//! Two rules shape everything here, and both are about not being able to lie:
//!
//! - **A delegated write goes through the app's write path, never a raw
//!   `fs::write`.** That is the entire point of the decision, and it binds this
//!   module rather than the engine: nothing here can compel a write the engine
//!   performs itself. [`VaultFiles`] is the seam: the real implementation is
//!   `storage::save_store::write_file`, which already resolves the path inside
//!   the vault, takes the write lock that serializes it against restores and
//!   renames, refuses a destination the user made read-only, and snapshots
//!   history. A second path to the filesystem would bypass all four.
//! - **A refusal is an error, never silence.** A success response for a write
//!   that did not happen lets the model believe it edited a file it never
//!   touched — the same failure class as a guard that cannot fail.
//!
//! **Cancellation: neither handler is cancellable, and that is a deliberate
//! divergence from Zed**, which wraps its read in
//! `cancellation.run_until_cancelled(...)` and leaves its write alone. Zed needs
//! the wrapper because its handlers run on the foreground thread, where a slow
//! read stalls everything; ours are forwarded off the SDK's dispatch loop
//! entirely, so a slow read delays nothing but its own answer. More
//! importantly, both operations are performed by `spawn_blocking`, and dropping
//! the future would not stop the work — it would only discard the reply. For a
//! write that is the worst available outcome: `save_store` publishes atomically
//! (staged sibling, fsync, rename), so there is no safe midpoint to abandon at,
//! and abandoning after the rename but before the answer would leave the engine
//! believing a write failed that had already succeeded. Answering is the only
//! honest end to either request.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    ClientCapabilities, Error, ErrorCode, FileSystemCapabilities, ReadTextFileRequest,
    ReadTextFileResponse, SessionId, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::Responder;
use sha2::{Digest, Sha256};

use super::live_notes::{LiveNoteAnswer, LiveNotes};
use super::recovery::Recovery;

/// How many agent-attributed changes are kept for review (T10).
///
/// Bounded because this is a review aid, not a ledger: the history snapshots
/// that make a change reversible are the app's own, and they are already
/// bounded. What T10 needs from here is the attribution — which session, which
/// path, from what baseline — not an unbounded log.
const MAX_RECORDS: usize = 200;

/// The app's own file path, as this module must use it.
///
/// Deliberately a trait rather than a direct call: `agent_runtime` is a library
/// module and must not reach into Tauri state or into `storage` by absolute
/// path, for the same reason it does not import the IPC surface. Whoever wires
/// the runtime supplies the implementation, and the tests below supply the
/// REAL one — `nekowite_lib::storage::save_store::write_file` — so what is
/// proved here is the app's write path, not a stand-in for it.
///
/// Both methods confine the path to `vault_root` themselves (they resolve
/// through the app's path policy), so a path escaping the vault cannot be
/// written even if this layer were wrong about it. That is the second line of
/// defence, not the first: the first is that nothing here builds a path at all.
pub trait VaultFiles: Send + Sync + 'static {
    /// The path as the FRONTEND spells it for an open tab: confined to the vault, resolved, and
    /// rendered the way the app renders every path it hands a window.
    ///
    /// This is the key a live-note question is asked with, and it has to be exactly the spelling
    /// `OpenTab.path` holds — `file_store::list_dir_entries` renders every entry through
    /// `domain::path_policy::ipc_path`, so a question asked with anything else would never match
    /// a tab. A lookup that never matches answers "no tab holds this path", which serves the
    /// disk: the silent failure this whole arm exists to remove. It is a method on this port
    /// rather than a call from here because confinement is the app's policy and it lives with
    /// the app's paths — a second implementation of it in this module is how two answers to
    /// "is this path inside the vault" appear.
    ///
    /// Refusing is part of the answer: a path that escapes the vault is refused here, before
    /// any question is asked, so a window is never asked about a path the write path would
    /// refuse.
    fn frontend_path(&self, vault_root: &str, path: &str) -> Result<String, String>;
    /// The file **as it is on disk**.
    ///
    /// Reached by a read only after a window holding the vault has answered that no tab holds
    /// this path ([`super::live_notes`]) — so this is the file's text *because it was asked
    /// for*, never because nothing answered. Nothing else in the read path may call it.
    fn read(&self, vault_root: &str, path: &str) -> Result<String, String>;
    /// Writes and returns `Some(warning)` when the text landed but something
    /// optional around it (the history snapshot) did not.
    fn write(&self, vault_root: &str, path: &str, content: &str) -> Result<Option<String>, String>;
}

/// What the host advertises in the handshake.
///
/// Zed's shape, and the one place the declaration is made. What it buys is that
/// a delegated request has a handler at all — unclaimed, the SDK answers the
/// engine `-32601` when the request arrives and nobody is listening for it. What it
/// does not buy is exclusivity: P0 §7's default-configuration probe measured this
/// engine writing a file through its own tools with zero reverse requests, so
/// declaring this does not make the host the only writer. See the module header.
pub fn client_capabilities() -> ClientCapabilities {
    ClientCapabilities::new().fs(FileSystemCapabilities::new()
        .read_text_file(true)
        .write_text_file(true))
}

/// A reverse request the engine is waiting on, paired with the way to answer it.
///
/// The two request types answer with different response types, so the responder
/// cannot be erased into one field; the pair travels together through the
/// runtime so that the answer happens on a task of ours rather than inside the
/// SDK's dispatch loop (a write fsyncs, and a blocked dispatch loop stops
/// answering the engine altogether).
pub enum FsRequest {
    Read {
        request: ReadTextFileRequest,
        responder: Responder<ReadTextFileResponse>,
    },
    Write {
        request: WriteTextFileRequest,
        responder: Responder<WriteTextFileResponse>,
    },
}

impl FsRequest {
    /// The session the engine says this belongs to. An assertion by the engine,
    /// like every other field here, which is why it is resolved against the
    /// host's own table before anything is touched.
    pub fn session_id(&self) -> &SessionId {
        match self {
            FsRequest::Read { request, .. } => &request.session_id,
            FsRequest::Write { request, .. } => &request.session_id,
        }
    }

    /// Refuses the request: the engine must learn it did not happen.
    ///
    /// `Error::internal_error().data(...)` is Zed's shape for the unknown-session
    /// case, and the reason holds here too: the engine named a session this host
    /// does not have, which is an inconsistency between the two sides rather
    /// than a malformed argument. The detail travels in `data`, because the
    /// engine is the party that needs to see which id it was.
    pub fn refuse_unknown_session(self, session_id: &str) {
        self.refuse_with(Error::internal_error().data(format!("unknown session: {session_id}")));
    }

    /// Refuses a request the host understood and will not perform.
    ///
    /// A path that escapes the vault, a destination the user made read-only, a
    /// file that is not UTF-8: all of them are the engine asking for something
    /// this host will not do, and all of them must come back as an error so the
    /// model cannot report an edit it never made.
    pub fn refuse_with(self, error: Error) {
        match self {
            FsRequest::Read { responder, .. } => {
                let _ = responder.respond_with_error(error);
            }
            FsRequest::Write { responder, .. } => {
                let _ = responder.respond_with_error(error);
            }
        }
    }
}

/// One agent-attributed change, as §7.2 requires it to be recorded.
///
/// 「记录基线哈希、结果哈希、来源、会话和时间」 — and because this host performed
/// the write, the baseline is taken from the real pre-write bytes instead of
/// being reconstructed from a watcher's diff later, which is the difference the
/// capability buys.
///
/// It records the changes the engine **delegated** and no others. A change the
/// engine made with its own tools produces no record here, which is the "only
/// the watcher saw it" case §7.2 gives its own treatment to.
#[derive(Debug, Clone)]
pub struct ChangeRecord {
    pub session_id: String,
    pub vault_root: String,
    pub path: String,
    /// `None` when the file did not exist: a creation has no baseline, and
    /// inventing one (the empty string's hash) would claim the agent replaced
    /// content that was never there.
    pub baseline_hash: Option<String>,
    pub result_hash: String,
    pub source: &'static str,
    pub at: String,
}

/// Serves the engine's file requests against the app's write path, and its reads against the
/// window that holds the note.
pub struct FsCapability {
    files: Arc<dyn VaultFiles>,
    /// The same seam the edit-conflict baseline reads through, reached from the other side:
    /// one table, one lookup, one definition of what "the same version of the note" means.
    live_notes: LiveNotes,
    changes: Mutex<VecDeque<ChangeRecord>>,
    /// What the version each delegated write replaced *held*, kept beside the record that
    /// describes it.
    ///
    /// A [`ChangeRecord`] carries the hash of the bytes a write replaced and not the bytes, which
    /// is enough to *judge* a recovery and not enough to perform one: a host holding hashes alone
    /// would have to call a change recoverable it cannot restore (§7.2's own line — 恢复前检查
    /// is a check, and the material is the text). The text is read anyway on this path — it is
    /// where the record's `baseline_hash` comes from — so keeping it costs the write nothing and
    /// makes every change this host *performed* one it can put back.
    ///
    /// It is the strongest form of §7.2's 「会话开始前…保存基线」 that this host can take, and it
    /// is deliberately not the window's version of it: the window can only capture the notes it
    /// has open at the send, while this is the file as it was at the instant of the change,
    /// whether or not any tab held it.
    recovery: Arc<Recovery>,
}

impl FsCapability {
    pub fn new(files: Arc<dyn VaultFiles>, live_notes: LiveNotes, recovery: Arc<Recovery>) -> Self {
        Self {
            files,
            live_notes,
            changes: Mutex::new(VecDeque::new()),
            recovery,
        }
    }

    /// The agent-attributed changes, oldest first.
    pub fn changes(&self) -> Vec<ChangeRecord> {
        self.changes.lock().unwrap().iter().cloned().collect()
    }

    /// The baselines those changes left, and the recovery that judges them.
    pub fn recovery(&self) -> &Arc<Recovery> {
        &self.recovery
    }

    /// The newest change this host performed for `path` inside `vault_root`, if it performed one.
    ///
    /// **Compared by the app's own spelling of the path, not by the engine's.** A record's path is
    /// whatever the engine put in its request — absolute, relative, doubly slashed — because that
    /// is what the write was resolved from, while a window names a file the way its tabs do
    /// (`file_store::list_dir_entries` renders every path through `ipc_path`, and
    /// [`VaultFiles::frontend_path`] is that same rendering). Comparing the two strings directly
    /// would find nothing for the very asking side this exists for, and finding nothing is
    /// indistinguishable from "this host never wrote it". Both sides are therefore put through
    /// `frontend_path`, which also means a path outside the vault is refused here rather than
    /// searched for.
    ///
    /// The **newest** match wins: two writes to one file are two changes, and the one a recovery
    /// can undo is the last one — the earlier change's result is no longer what the file holds.
    pub fn change_for(&self, vault_root: &str, path: &str) -> Option<ChangeRecord> {
        let wanted = self.files.frontend_path(vault_root, path).ok()?;
        self.changes
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|record| {
                record.vault_root == vault_root
                    && self
                        .files
                        .frontend_path(&record.vault_root, &record.path)
                        .is_ok_and(|key| key == wanted)
            })
            .cloned()
    }

    /// Answers one request. `vault_root` is the session's root as the HOST
    /// knows it; `None` means the engine named a session this host never opened,
    /// and the request is refused — §6.1 forbids acting on a session id the
    /// host did not receive, and a path is only confined relative to a root we
    /// chose.
    pub async fn serve(&self, request: FsRequest, vault_root: Option<&str>) {
        let Some(vault_root) = vault_root else {
            let unknown = request.session_id().to_string();
            return request.refuse_unknown_session(&unknown);
        };

        match request {
            FsRequest::Read { request, responder } => {
                let root = vault_root.to_string();
                let path = request.path.to_string_lossy().into_owned();
                // Confinement first, and before any question: the window must never be asked
                // about a path the write path would refuse, and the key it is asked with has to
                // be the spelling the editor has for an open tab. Both are the app's path
                // policy's answer, so both come from the port that owns it — see
                // [`VaultFiles::frontend_path`].
                let key = match self.files.frontend_path(&root, &path) {
                    Ok(key) => key,
                    Err(message) => {
                        let _ = responder.respond_with_error(Error::invalid_params().data(message));
                        return;
                    }
                };

                // The one lookup. `Held` is the buffer; `NotHeld` is the ONLY arm that may
                // become disk, and it is the only one a window answered on purpose; every
                // `Unknown` is an error, so a read that could not reach the live buffer can
                // never be mistaken for one that did.
                let content = match self.live_notes.ask(&root, &key).await {
                    LiveNoteAnswer::Held(note) => note.text,
                    LiveNoteAnswer::NotHeld => {
                        let files = Arc::clone(&self.files);
                        let disk_root = root.clone();
                        let disk_path = path.clone();
                        // Off the async worker: the app's read is blocking, and this task is
                        // shared with everything else the runtime is doing.
                        match tokio::task::spawn_blocking(move || {
                            files.read(&disk_root, &disk_path)
                        })
                        .await
                        {
                            Ok(Ok(content)) => content,
                            Ok(Err(message)) => {
                                let _ = responder
                                    .respond_with_error(Error::invalid_params().data(message));
                                return;
                            }
                            Err(join) => {
                                let _ = responder.respond_with_internal_error(join.to_string());
                                return;
                            }
                        }
                    }
                    LiveNoteAnswer::Unknown(reason) => {
                        // Loudly, with the vault and the path named, and with the disk NOT
                        // consulted: the engine can act on an error — it can ask again, and it
                        // has tools of its own — while it cannot act on a silent lie.
                        let _ = responder.respond_with_error(Error::internal_error().data(
                            format!("could not read the live buffer of {key} in {root}: {reason}"),
                        ));
                        return;
                    }
                };

                // The slice is the host's business, not the engine's: `line` and `limit` are
                // applied here, to whichever text won, so the engine never receives more of a
                // note than it asked for.
                match slice_lines(&content, request.line, request.limit) {
                    Ok(content) => {
                        let _ = responder.respond(ReadTextFileResponse::new(content));
                    }
                    Err(message) => {
                        let _ = responder.respond_with_error(Error::invalid_params().data(message));
                    }
                }
            }
            FsRequest::Write { request, responder } => {
                let files = Arc::clone(&self.files);
                let root = vault_root.to_string();
                let path = request.path.to_string_lossy().into_owned();
                let content = request.content;
                let session_id = request.session_id.to_string();

                // Baseline and write together in one blocking step: the baseline
                // is only meaningful if it describes the bytes the write is
                // about to replace. It is still not atomic across processes —
                // §7.2 says as much ("普通读取后检查再写入不是跨进程原子比较替换")
                // — but within this process the app's write lock serializes it
                // against every other save.
                let target = path.clone();
                let written = tokio::task::spawn_blocking(move || {
                    let baseline = files.read(&root, &target).ok();
                    let warning = files.write(&root, &target, &content)?;
                    Ok::<_, String>((baseline, warning, content))
                })
                .await;

                match written {
                    Ok(Ok((baseline, _warning, content))) => {
                        // The baseline becomes recovery material before the record is written,
                        // and from the same read: this is the text the write just replaced. A
                        // creation has none (`None`), which is not an empty file — the distinction
                        // the record keeps and the one a recovery moves on.
                        if let Some(before) = &baseline {
                            self.recovery.remember(&vault_root, &path, before.clone());
                        }
                        self.record(ChangeRecord {
                            session_id,
                            vault_root: vault_root.to_string(),
                            path,
                            baseline_hash: baseline.as_deref().map(hash_of),
                            result_hash: hash_of(&content),
                            source: "agent",
                            at: chrono::Utc::now().to_rfc3339(),
                        });
                        let _ = responder.respond(WriteTextFileResponse::new());
                    }
                    // A refusal is an error. The engine has to be able to tell
                    // that the file is untouched, because the alternative is a
                    // model that reports an edit it never made.
                    Ok(Err(message)) => {
                        let _ = responder.respond_with_error(Error::invalid_params().data(message));
                    }
                    Err(join) => {
                        let _ = responder.respond_with_internal_error(join.to_string());
                    }
                }
            }
        }
    }

    fn record(&self, record: ChangeRecord) {
        let mut changes = self.changes.lock().unwrap();
        if changes.len() == MAX_RECORDS {
            changes.pop_front();
        }
        changes.push_back(record);
    }
}

/// The lines a read request asks for.
///
/// The semantics are the schema's own words, and they are the reason this is a
/// named function with its own tests rather than two lines inline: an ecosystem
/// survey found a sibling implementation that had them inverted.
///
/// - `line` is the line to start reading FROM, and it is **1-based** — so
///   `line: 1` is the first line and `line: 2` skips it.
/// - `limit` is a **count of lines**, not an end index — so `line: 2, limit: 2`
///   is two lines (2 and 3), never lines 2 through 2.
///
/// Segments are split *inclusively* of their newline, so the returned slice is
/// byte-for-byte what the file holds: reassembling every line must give the
/// original file back, and a caller that asked for "the first three lines" must
/// not be handed three lines and a lost terminator.
///
/// A start past the end of the file is an error, which is Zed's behaviour and
/// is reproduced rather than simplified into an empty string: the agent asked
/// for lines that do not exist, and an empty answer reads as "the file is
/// empty", which is a different and misleading fact. The boundary is the one a
/// text buffer has, not a line count: a file ending in a newline has a
/// (readable, empty) final line after it, exactly as Zed's `max_point` does.
pub fn slice_lines(content: &str, line: Option<u32>, limit: Option<u32>) -> Result<String, String> {
    // A 1-based number cannot be 0. Clamping rather than refusing is deliberate:
    // the cost of being wrong is one line of context, while refusing a read ends
    // whatever the agent was doing over a field the schema itself treats
    // leniently (`x-deserialize-default-on-error`). It errs towards the first
    // line, which is the range a caller that sent 0 almost certainly meant.
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let segments: Vec<&str> = content.split_inclusive('\n').collect();
    // Every newline ends a line, so the position after the last one is on a new
    // line — that is what makes `line = 2` legal for a one-line file that ends
    // with a newline, and illegal for one that does not.
    let last_addressable = content.matches('\n').count() + 1;
    if start + 1 > last_addressable {
        return Err(format!(
            "read past the end of the file: line {} was requested, the last line is {last_addressable}",
            start + 1
        ));
    }
    let end = match limit {
        Some(limit) => start.saturating_add(limit as usize),
        None => segments.len(),
    };
    Ok(segments
        .get(start..end.min(segments.len()))
        .unwrap_or_default()
        .concat())
}

/// The SHA-256 of a text, in lowercase hex.
fn hash_of(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}
