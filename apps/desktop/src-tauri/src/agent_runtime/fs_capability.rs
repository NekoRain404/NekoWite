//! The client file-system capability: the agent asks, the host writes.
//!
//! P0 §7.2 measured the engine sending `fs/write_text_file` — asking the HOST to
//! perform a write — even though our handshake advertised `clientCapabilities:
//! {}`. So the mechanism was already live and simply had no handler, which meant
//! the engine fell back to writing by itself.
//!
//! Declaring the capability is what turns §7.2 from「观察并归因」into「写入必经
//! 宿主」: an agent edit stops being something we reconstruct from a watcher
//! afterwards and becomes something we perform, so the baseline and the
//! attribution are exact instead of inferred.
//!
//! Two rules shape everything here, and both are about not being able to lie:
//!
//! - **A write goes through the app's write path, never a raw `fs::write`.** That
//!   is the entire point of the decision. [`VaultFiles`] is the seam: the real
//!   implementation is `storage::save_store::write_file`, which already resolves
//!   the path inside the vault, takes the write lock that serializes it against
//!   restores and renames, refuses a destination the user made read-only, and
//!   snapshots history. A second path to the filesystem would bypass all four.
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

use agent_client_protocol::Responder;
use agent_client_protocol::schema::v1::{
    ClientCapabilities, Error, ErrorCode, FileSystemCapabilities, ReadTextFileRequest,
    ReadTextFileResponse, SessionId, WriteTextFileRequest, WriteTextFileResponse,
};
use sha2::{Digest, Sha256};

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
    fn read(&self, vault_root: &str, path: &str) -> Result<String, String>;
    /// Writes and returns `Some(warning)` when the text landed but something
    /// optional around it (the history snapshot) did not.
    fn write(
        &self,
        vault_root: &str,
        path: &str,
        content: &str,
    ) -> Result<Option<String>, String>;
}

/// What the host advertises in the handshake.
///
/// Zed's shape, and the reason this task exists: without it the engine writes
/// by itself and we only get to observe the result.
pub fn client_capabilities() -> ClientCapabilities {
    ClientCapabilities::new().fs(
        FileSystemCapabilities::new()
            .read_text_file(true)
            .write_text_file(true),
    )
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
/// 「记录基线哈希、结果哈希、来源、会话和时间」 — and because we are now the
/// writer, the baseline is taken from the real pre-write bytes instead of being
/// reconstructed from a watcher's diff later, which is the difference the
/// capability buys.
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

/// Serves the engine's file requests against the app's write path.
pub struct FsCapability {
    files: Arc<dyn VaultFiles>,
    changes: Mutex<VecDeque<ChangeRecord>>,
}

impl FsCapability {
    pub fn new(files: Arc<dyn VaultFiles>) -> Self {
        Self {
            files,
            changes: Mutex::new(VecDeque::new()),
        }
    }

    /// The agent-attributed changes, oldest first.
    pub fn changes(&self) -> Vec<ChangeRecord> {
        self.changes.lock().unwrap().iter().cloned().collect()
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
                let files = Arc::clone(&self.files);
                let root = vault_root.to_string();
                let path = request.path.to_string_lossy().into_owned();
                // Off the async worker: the app's read is blocking, and this
                // task is shared with everything else the runtime is doing.
                let read = tokio::task::spawn_blocking(move || files.read(&root, &path)).await;
                match read {
                    Ok(Ok(content)) => {
                        // The slice is the host's business, not the engine's:
                        // `line` and `limit` are applied here so the engine
                        // never receives more of a note than it asked for.
                        match slice_lines(&content, request.line, request.limit) {
                            Ok(content) => {
                                let _ = responder.respond(ReadTextFileResponse::new(content));
                            }
                            Err(message) => {
                                let _ = responder
                                    .respond_with_error(Error::invalid_params().data(message));
                            }
                        }
                    }
                    Ok(Err(message)) => {
                        let _ = responder
                            .respond_with_error(Error::invalid_params().data(message));
                    }
                    Err(join) => {
                        let _ = responder.respond_with_internal_error(join.to_string());
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
                        let _ = responder
                            .respond_with_error(Error::invalid_params().data(message));
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
