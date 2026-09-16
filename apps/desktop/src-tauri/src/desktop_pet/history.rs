//! What the pet remembers about runs that ended: bounded, durable, and free of anything anyone said.
//!
//! §6.3 requires one backend reminder ledger to own the decision to notify, and requires the pet to
//! read a processed ledger after a restart. Both need somewhere for a fact to be written down that
//! outlives a window, and this is it: {@link TaskHistory} is a bounded index of tasks and how they
//! ended, plus the two things a decision about them needs back — whether the user has seen the row,
//! and how far each session's event stream has been read.
//!
//! Three rules are structural rather than documented:
//!
//! - **There is nowhere to put content.** §9 asks for 「有限任务索引，不存聊天全文」 and §6.1 forbids
//!   sending chat text, reasoning, credentials or tool output to the pet window. A record holds the
//!   contract's identity tuple, a state, an optional permission request id, a host timestamp and two
//!   flags. A field that could hold a prompt does not exist, so no later edit can quietly start
//!   storing one — and the task *title* a user may opt into (§6.3's 通知标题) is deliberately not
//!   here either, because it is a thing the user said.
//! - **Nothing but the user clears unread.** {@link TaskHistory::record} keeps an existing row's
//!   `unread` flag when it replaces it, so a task that moved from one ending to another cannot lose
//!   the notice the user still has not looked at (§6.3's 未读). Only {@link TaskHistory::mark_read}
//!   clears it.
//! - **A bound is a report, not a silence.** §9 requires the index to be finite, so a full store
//!   evicts — the oldest row the user has already seen, and failing that the oldest row at all, whose
//!   eviction comes back in {@link Evicted} with `was_unread` set. A bound that dropped an unseen
//!   notice without saying so would be the 漏提示 this task is graded against.
//!
//! The task vocabulary is [`super::task_projection`]'s: `PetTaskKey`, `PetTaskState` and the
//! [`SessionKey`] an event stream's marks are filed under are defined once in that module's
//! `vocabulary` and imported here. All three used to be defined in both files, field for field and
//! spelling for spelling, and two types with one name and one shape diverge on the day someone
//! edits one of them — the bug that produces is an identity bug, which is the class this whole
//! module exists to make impossible.
//!
//! What stays here is what the ledger *adds* to them: the token both keys are encoded with, the row
//! that records a state — plus the two methods the ledger is the reason for
//! ([`PetTaskKey::session`], [`SessionKey::token`]).

use serde::{Deserialize, Serialize};

use super::task_projection::{PetTaskKey, PetTaskState, SessionKey};

/// Every state the pet can show, in the contract's order (`pet-contracts/task.ts:69-84`).
///
/// The names of [`PetTaskState`], kept beside the pin test that reads every one of them against
/// `pet-contracts/task.ts` (`tests/desktop_pet_notification_test/history.rs`) rather than beside the
/// enum: nothing in `task_projection` reads the array, and the list a test holds the vocabulary to
/// belongs with the test's own module.
pub const PET_TASK_STATES: [&str; 9] = [
    "working",
    "waiting-input",
    "turn-finished",
    "stopped",
    "refused",
    "cancelled",
    "failed",
    "interrupted",
    "unknown",
];

/// The schema this build writes. A state or a field added to the vocabulary has to bump it.
///
/// §10.2's rule for a versioned record is applied here in the other direction too: a build that
/// meets a higher version reports {@link Decoded::NewerSchema} instead of reading the rows it
/// recognises and writing the rest back as defaults.
pub const HISTORY_SCHEMA_VERSION: u32 = 1;

/// How many task rows are kept. Ours, not upstream's: upstream logs a session per line with no
/// bound at all (`windows/src/main.ts:424-427`).
pub const DEFAULT_RECORD_CAPACITY: usize = 200;

/// How many sessions' stream positions are kept. A mark is a line of defence, not the ledger.
pub const DEFAULT_MARK_CAPACITY: usize = 64;

impl PetTaskKey {
    /// The session this run belongs to, and therefore the stream its sequence is read from.
    ///
    /// Inherent impls sit with the types they are about, and this one is about the ledger's own
    /// session key: the mark a frame is compared against is filed under what this returns, so the
    /// method lives in the file that keeps the marks rather than in the vocabulary that defines
    /// the key. §6.1's composite identity is what it is for — two engines sharing a session id are
    /// two streams, and a mark filed by session id alone would consume each other's frames.
    pub fn session(&self) -> SessionKey {
        SessionKey {
            agent_id: self.agent_id.clone(),
            profile_id: self.profile_id.clone(),
            runtime_epoch: self.runtime_epoch.clone(),
            vault_id: self.vault_id.clone(),
            session_id: self.session_id.clone(),
        }
    }

    /// The key as one string, for a log line or a map.
    pub fn token(&self) -> String {
        pet_key_token(&[
            &self.agent_id,
            &self.profile_id,
            &self.runtime_epoch,
            &self.vault_id,
            &self.session_id,
            &self.run_id,
        ])
    }
}

impl SessionKey {
    pub fn token(&self) -> String {
        pet_key_token(&[
            &self.agent_id,
            &self.profile_id,
            &self.runtime_epoch,
            &self.vault_id,
            &self.session_id,
        ])
    }
}

/// The one encoding this module writes keys with: each part preceded by its own length.
///
/// The contract's `petKeyToken` (`pet-contracts/task.ts:52-54`), and the reason it is not bare
/// colons: `{agent: 'a:b', session: 'c'}` and `{agent: 'a', session: 'b:c'}` join to one string, and
/// that string is what a suffix match then confuses. Lengths leave no such pair, so a token is a
/// safe map key and a safe log field — never a thing this module matches a *suffix* of.
pub fn pet_key_token(parts: &[&str]) -> String {
    let mut token = String::new();
    for part in parts {
        token.push_str(&part.len().to_string());
        token.push(':');
        token.push_str(part);
    }
    token
}

/// Whether a notice for this row reached the user, and whether it was tried at all.
///
/// Three arms rather than a boolean because "the user turned the notices off", "do-not-disturb was
/// on" and "the channel could not show it" are three different facts about a row the user has still
/// not seen (§6.3's 投递失败 must be visible). The *reason* a channel failed is not stored: it is
/// environment detail that the immediate report and D3's capability report carry, and a durable row
/// is about whether the user was told.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryState {
    /// No delivery was attempted: a switch is off, do-not-disturb is on, or the state is quiet.
    NotAttempted,
    /// The channel took it.
    Delivered,
    /// The channel was asked and could not.
    Failed,
}

/// One task, as the ledger remembers it.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub key: PetTaskKey,
    pub state: PetTaskState,
    /// The request the host's permission UI has to answer, when the state is `waiting-input`.
    /// Carried so a restored unread row can still route (§6.2: the pet never authorises).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_request_id: Option<String>,
    /// Host clock when this state was observed, in epoch ms.
    pub at_ms: i64,
    #[serde(default = "not_attempted")]
    pub delivery: DeliveryState,
    /// Whether the pet still owes the user a look at this (§6.3's 未读).
    pub unread: bool,
}

fn not_attempted() -> DeliveryState {
    DeliveryState::NotAttempted
}

/// A row the bound pushed out, named so the loss can be stated rather than assumed away.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Evicted {
    pub key: PetTaskKey,
    pub state: PetTaskState,
    pub at_ms: i64,
    /// True when there was nothing the user had already seen to drop instead — the one case where a
    /// bound can cost a notice, and therefore the one case the caller has to be told about.
    pub was_unread: bool,
}

/// Where one session's event stream stands.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamMark {
    pub session: SessionKey,
    /// The highest sequence seen. A frame at or below it is a replay, not news (§6.3).
    pub sequence: u64,
    pub at_ms: i64,
}

/// What one observed frame did to a session's mark.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarkOutcome {
    /// The first frame this build has seen for the session.
    Fresh,
    /// The next frame in order.
    Advanced,
    /// At or below the mark: the same frame again, or an older one.
    Replay,
    /// Ahead of the mark by more than one: frames happened that this pet never saw. The caller
    /// proceeds — a gap is not a reason to ignore the frame in hand — but has to be able to say so,
    /// because it is the boundary §6.3 admits to (「崩溃空窗可能漏外部提示」).
    Gap { missed: u64 },
}

/// What reading a stored ledger produced.
///
/// Three arms and not an option, because §10.2's rule about a versioned record is that the caller's
/// next move differs per arm: `Restored` may be used, `Unreadable` must not be written over as if it
/// had been empty, and `NewerSchema` must not be interpreted with this build's defaults.
#[derive(Debug)]
pub enum Decoded {
    Restored(Restored),
    /// The bytes are not this record. The consequence is bounded and worth stating: the dedup
    /// memory starts empty, so an ending that was already announced may be announced again. The
    /// unread list is what remains, and the caller is expected to say so rather than pretend.
    Unreadable { detail: String },
    NewerSchema { found: u32 },
}

/// A ledger that was read back, and how much of it did not fit.
#[derive(Debug)]
pub struct Restored {
    pub history: TaskHistory,
    /// Rows and marks the stored file held beyond this build's own bounds, dropped from the old end.
    pub dropped: usize,
}

/// The bounded index: what ended, and how far each stream has been read.
#[derive(Clone, Debug)]
pub struct TaskHistory {
    capacity: usize,
    mark_capacity: usize,
    /// Oldest first. Insertion order is the eviction order, so it is kept explicitly.
    records: Vec<TaskRecord>,
    /// Least recently observed first, for the same reason.
    marks: Vec<StreamMark>,
}

impl Default for TaskHistory {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskHistory {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_RECORD_CAPACITY, DEFAULT_MARK_CAPACITY)
    }

    pub fn with_capacity(capacity: usize, mark_capacity: usize) -> Self {
        Self {
            // A zero-capacity index could hold nothing at all, which would make every observation a
            // fresh one and every restart a re-announcement.
            capacity: capacity.max(1),
            mark_capacity: mark_capacity.max(1),
            records: Vec::new(),
            marks: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn get(&self, key: &PetTaskKey) -> Option<&TaskRecord> {
        self.records.iter().find(|row| &row.key == key)
    }

    /// The rows the user has not seen, newest first.
    pub fn unread(&self) -> Vec<&TaskRecord> {
        self.records
            .iter()
            .rev()
            .filter(|row| row.unread)
            .collect()
    }

    /// Write a row, replacing the one for the same key if there is one.
    ///
    /// The replacement keeps the old row's `unread` when it was set: §6.3's 未读 is cleared by the
    /// user looking, not by the task moving on to another ending, and an update that cleared it
    /// would be the pet deciding the user had seen something it never showed them.
    pub fn record(&mut self, record: TaskRecord) -> Option<Evicted> {
        if let Some(existing) = self.records.iter_mut().find(|row| row.key == record.key) {
            let unread = existing.unread || record.unread;
            *existing = TaskRecord { unread, ..record };
            return None;
        }
        let evicted = if self.records.len() >= self.capacity {
            self.evict_one()
        } else {
            None
        };
        self.records.push(record);
        evicted
    }

    /// Mark a row as seen, answering whether that cleared anything.
    ///
    /// `false` covers both "no such row" and "already read", which is the whole of what a caller
    /// does with the answer: a surface that has just shown a task recomputes its badge either way.
    pub fn mark_read(&mut self, key: &PetTaskKey) -> bool {
        match self.records.iter_mut().find(|row| &row.key == key) {
            Some(row) => std::mem::replace(&mut row.unread, false),
            None => false,
        }
    }

    /// Record whether the user was told about this row.
    pub fn set_delivery(&mut self, key: &PetTaskKey, delivery: DeliveryState) -> bool {
        match self.records.iter_mut().find(|row| &row.key == key) {
            Some(row) => {
                row.delivery = delivery;
                true
            }
            None => false,
        }
    }

    /// Note where a session's stream has reached, and say what the frame in hand was.
    ///
    /// The mark only moves forward: a frame at or below it is a replay, and a frame above it is
    /// either the next one or — when it skipped — news with a hole behind it.
    pub fn observe_stream(&mut self, session: &SessionKey, sequence: u64, at_ms: i64) -> MarkOutcome {
        if let Some(index) = self.marks.iter().position(|mark| &mark.session == session) {
            let previous = self.marks[index].sequence;
            if sequence <= previous {
                return MarkOutcome::Replay;
            }
            let mut mark = self.marks.remove(index);
            mark.sequence = sequence;
            mark.at_ms = at_ms;
            self.marks.push(mark);
            return if sequence == previous + 1 {
                MarkOutcome::Advanced
            } else {
                MarkOutcome::Gap {
                    missed: sequence - previous - 1,
                }
            };
        }
        if self.marks.len() >= self.mark_capacity {
            // A dropped mark costs replay detection for that session and nothing else: the record
            // for a task is what prevents a second notice, and it is not in here.
            self.marks.remove(0);
        }
        self.marks.push(StreamMark {
            session: session.clone(),
            sequence,
            at_ms,
        });
        MarkOutcome::Fresh
    }

    /// The row to drop when the bound is reached: the oldest the user has already seen, or — with
    /// nothing seen to spare — the oldest there is, reported as unseen.
    fn evict_one(&mut self) -> Option<Evicted> {
        let index = self
            .records
            .iter()
            .position(|row| !row.unread)
            .unwrap_or(0);
        let row = self.records.remove(index);
        Some(Evicted {
            key: row.key,
            state: row.state,
            at_ms: row.at_ms,
            was_unread: row.unread,
        })
    }

    /// The ledger as bytes, for the caller to persist.
    pub fn encode(&self) -> String {
        let persisted = Persisted {
            version: HISTORY_SCHEMA_VERSION,
            records: self.records.clone(),
            marks: self.marks.clone(),
        };
        serde_json::to_string(&persisted).expect("a record of ids and states always serialises")
    }

    /// Read a stored ledger back (§6.3's 「重启读取已处理账本」).
    ///
    /// A file longer than this build's bounds is truncated from the old end and counted in
    /// {@link Restored::dropped} rather than rejected: a bound that refused the whole ledger because
    /// a previous build kept more rows would turn a size difference into amnesia.
    pub fn decode(raw: &str, capacity: usize, mark_capacity: usize) -> Decoded {
        let parsed = match serde_json::from_str::<Persisted>(raw) {
            Ok(parsed) => parsed,
            Err(error) => {
                return Decoded::Unreadable {
                    detail: error.to_string(),
                }
            }
        };
        if parsed.version > HISTORY_SCHEMA_VERSION {
            return Decoded::NewerSchema {
                found: parsed.version,
            };
        }
        let mut history = Self::with_capacity(capacity, mark_capacity);
        let dropped_records = parsed.records.len().saturating_sub(history.capacity);
        for record in parsed.records.into_iter().skip(dropped_records) {
            history.record(record);
        }
        let dropped_marks = parsed.marks.len().saturating_sub(history.mark_capacity);
        for mark in parsed.marks.into_iter().skip(dropped_marks) {
            history.marks.push(mark);
        }
        Decoded::Restored(Restored {
            history,
            dropped: dropped_records + dropped_marks,
        })
    }
}

/// The ledger's wire shape. `version` is first so a human reading the file sees it first too.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    version: u32,
    records: Vec<TaskRecord>,
    marks: Vec<StreamMark>,
}
