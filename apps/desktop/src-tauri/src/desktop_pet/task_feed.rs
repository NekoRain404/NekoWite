//! The one place a runtime frame becomes a task a pet window can read, the one place a window is told
//! that the list moved, and the one place a fact reaches the two ledgers that decide about it.
//!
//! D4 delivered [`TaskProjection`] — the state machine that tells two engines' tasks apart — and left
//! it with no home. Nothing in the process held it, so `desktop_pet_tasks` had no state to answer from
//! and the window's subscription died on its first read: a pet that looks quiet instead of a pet that
//! says it cannot see anything. This module is the home.
//!
//! D5 delivered §6.3's ledger (`notification_policy.rs`) and left it in the same position one layer up:
//! constructed nowhere, so the switches the notification page writes were read by nobody, no ending was
//! ever recorded as unread, and no delivery was ever attempted. §8's care ledger arrived the same way.
//! [`PetTaskFeed`] holds all three, for the reason it holds the projection: a frame is applied once,
//! here, and the decisions about it belong to the same motion.
//!
//! **Two ledgers, two modules, one fan-out.** [`TaskReminders`] owns §6.3's ledger, its file and the
//! host's way back to a closing burst; [`CareFeed`] owns §8's ledger and its file. Neither knows the
//! other exists, and this module is the only place that knows both — which is what keeps a rule about
//! rewards out of the reminder path and a rule about notices out of the care path. Each was fields on
//! this struct until the file passed the line budget `docs/dev.md:286` sets for a business file; the
//! split is by *reason to change*, which is the criterion that same section states.
//!
//! Three rules are structural here rather than documented, because each is a mistake that would look
//! like a working window:
//!
//! - **The record is the truth, and the push is only how a window hears about it sooner.** A frame is
//!   applied to the projection first and emitted second, so an emit that nobody hears (the hide path, a
//!   closed window, a shutdown) costs a *notification*, never the fact. That ordering is the same one
//!   the reference client's archive store uses — it records what it has handled only after the write
//!   succeeded (`references/desktop-pet/Sources/DesktopPetCore/SessionArchiveStore.swift:51`) — read in
//!   this direction: what is durable (here, the projection) is written before what is best-effort (the
//!   frame on a channel), and a reader always has the list as the source of truth. `subscribe` in
//!   `tauri-pet.ts` reads after it listens for exactly this reason.
//! - **Exactly one reader applies a frame.** §6.3's single account: the projection reports replays and
//!   gaps (`Ingest`), so a second writer — another command, a second subscription — would make its
//!   sequence log see a stream that is really two interleaved halves. The lock is here so there is one
//!   place a frame is applied, and every caller goes through it.
//! - **A ledger is told once per applied fact, and is told nothing else.** Every entry point here
//!   carries what it just applied to both ledgers; a replayed sequence, a frame from an instance this
//!   host is not serving and a fact about a run that already ended are not carried, because the window
//!   already has them and a ledger would be deciding about a fact that did not happen.
//!
//! What this module deliberately is not: it never removes a task and it decides nothing about either
//! ledger. A window reads the list; the two ledgers decide what to make of it; this is only the place
//! they are held together, because a frame becomes a task and a fact about that task in the same motion
//! and a second reader would be a second place for the three to disagree.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Runtime};

use crate::agent_runtime::events::{AgentEventEnvelope, AgentIdentity};
use crate::agent_runtime::snapshot::SessionSnapshot;
use crate::agent_runtime::usage;

use super::care_feed::{CareFeed, SettledTask};
use super::care_ledger::CareLedger;
use super::history::{HistoryStore, TaskHistory};
use super::notification_delivery::system_channel;
use super::notification_policy::{
    NotificationOutcome, NotificationPolicy, NotificationPreferences, TaskFact,
};
use super::task_projection::{
    system_clock, Disposition, Ingest, PetTaskProjection, TaskProjection,
};
use super::task_reminders::TaskReminders;

/// The reminder ledger's own loss report, re-exported at the path it has always had.
///
/// It moved to [`TaskReminders`] with the rest of §6.3's half — it reads `history::Loaded`, so it is
/// that ledger's question and not this module's — and the re-export is what keeps
/// `tests/desktop_pet_task_feed_test.rs`'s import, and anyone reading this module for the answer,
/// pointed at one definition rather than two.
pub use super::task_reminders::loss_report;

/// The channel the host publishes the task list on.
///
/// The whole list every time, never a delta: a window that missed a frame is stale for one frame rather
/// than wrong for ever, and the first delivery needs no replay machinery because the list is complete.
/// `tauri-pet.ts` declares the same name; the two spellings are one decision.
pub const PET_TASKS_CHANNEL: &str = "pet-task";

/// The host's trusted tasks, as one window-readable value.
///
/// The projection's lock is inside rather than around: `TaskProjection` is deliberately not `Sync` (its
/// own doc says a caller that wants to share it takes a lock, so there is exactly one place a frame is
/// applied), and this is that lock.
pub struct PetTaskFeed {
    tasks: Mutex<TaskProjection>,
    /// §6.3's ledger, beside the list it decides about.
    reminders: TaskReminders,
    /// §8's ledger, beside the same list and for the same reason: one place a fact is applied is one
    /// place a reward can be decided.
    care: CareFeed,
}

impl Default for PetTaskFeed {
    fn default() -> Self {
        Self::new()
    }
}

impl PetTaskFeed {
    /// A feed with no tasks, the real clock, and the ledgers this build runs with.
    ///
    /// The channel is the system's (`notification_delivery.rs`) and the care ledger is in memory:
    /// [`Self::for_app`] is the app's own assembly, and this is what a caller with no data directory
    /// gets — which is every test that is not about a file.
    pub fn new() -> Self {
        Self::assembled(
            NotificationPolicy::new(
                system_channel(),
                NotificationPreferences::default(),
                TaskHistory::new(),
            ),
            None,
        )
    }

    /// The feed with a reminder ledger the caller built — channel, switches and history injected
    /// (§10.2), which is how a test drives a notice that goes out and one that cannot.
    pub fn with_notifications(policy: NotificationPolicy) -> Self {
        Self::assembled(policy, None)
    }

    /// The same, with the file §6.3's 「重启读取已处理账本」 is kept in.
    ///
    /// A store rather than a path is what makes the feed testable without a disk, and the store is built
    /// by whoever has a data directory — [`Self::for_app`], or a test with a temporary one.
    pub fn with_ledger(policy: NotificationPolicy, ledger: Option<HistoryStore>) -> Self {
        Self::assembled(policy, ledger)
    }

    /// The feed with a caller-built reminder ledger and no care ledger behind it.
    fn assembled(policy: NotificationPolicy, ledger: Option<HistoryStore>) -> Self {
        Self {
            tasks: Mutex::new(TaskProjection::new(system_clock())),
            reminders: TaskReminders::with_store(policy, ledger),
            care: CareFeed::in_memory(),
        }
    }

    /// The feed the app runs with, assembled from the directory it keeps its files in.
    ///
    /// Both ledgers are built here rather than on first use because this is the one moment an app data
    /// directory is known and no frame has arrived: the switches the notification page writes, the rows
    /// the last run left, and the care record's totals are all read now, so a settlement or a notice
    /// later in this process never pays for a file read on the driver's task.
    ///
    /// Neither ledger can stop the app from starting. A directory this build cannot use still answers
    /// with a feed — the shipped switches, an empty care ledger, nothing on disk — and what is printed
    /// is each ledger's own trouble, which is a mistake, rather than a settings file that is merely
    /// absent.
    pub fn for_app(data: &Path, now_ms: i64) -> Self {
        Self {
            tasks: Mutex::new(TaskProjection::new(system_clock())),
            reminders: TaskReminders::for_app(data, now_ms),
            care: CareFeed::on(data),
        }
    }

    /// §8's care ledger, as the handle the page's own read and this feed share.
    ///
    /// Handed out rather than answered field by field for the reason [`Self::notifications`] gives: the
    /// ledger's API *is* the answer, and a second set of accessors here would be a second place every
    /// rule about it has to be kept in step. `DesktopPetState` takes it once at construction, so the
    /// ledger the page reads and the ledger a completion is settled into are one value.
    pub fn care(&self) -> Arc<Mutex<CareLedger>> {
        self.care.ledger()
    }

    /// Whether the care record on disk belongs to a newer build (§10.2).
    ///
    /// Answered through the feed because the store is the care ledger's: the read command asks here
    /// rather than keeping a second copy of a latch, and a feed with no store is never read-only — there
    /// is no file for a newer build to have written.
    pub fn care_read_only(&self) -> bool {
        self.care.read_only()
    }

    /// Tell the reminder ledger how to ask for a wake at a burst's due time.
    pub fn set_notice_waker(&self, waker: impl Fn(i64) + Send + Sync + 'static) {
        self.reminders.set_waker(waker)
    }

    /// §6.3's ledger: the unread rows, the switches, the gaps and the burst in flight.
    pub fn notifications(&self) -> Result<MutexGuard<'_, NotificationPolicy>, String> {
        self.reminders.policy()
    }

    /// Deliver whatever the gathering burst's window has closed on, as the host's clock reads.
    pub fn flush_notices(&self, now_ms: i64) -> Result<Option<NotificationOutcome>, String> {
        self.reminders.flush(now_ms)
    }

    /// Every task the pet shows, for a window that is mounting or asking again.
    ///
    /// A complete list every time, which is what makes the subscription's listen-then-read ordering a
    /// choice about duplicates rather than a race about loss.
    pub fn read(&self) -> Result<Vec<PetTaskProjection>, String> {
        Ok(self.with(|_| ())?.0)
    }

    /// The host started an instance. Its in-flight runs, if the previous incarnation had any, are
    /// restated by the projection and reported here as a change.
    pub fn install(
        &self,
        identity: &AgentIdentity,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        let (list, restated) = self.with(|tasks| tasks.install(identity))?;
        self.restated(&restated, None);
        Ok((!restated.is_empty()).then_some(list))
    }

    /// The host's instance is over, so nothing it was running can still be running.
    pub fn retire(
        &self,
        identity: &AgentIdentity,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        let (list, restated) = self.with(|tasks| tasks.retire(identity))?;
        self.restated(&restated, None);
        Ok((!restated.is_empty()).then_some(list))
    }

    /// A turn began. §6.1: no frame says this, so the host's own view is where it comes from.
    pub fn started(
        &self,
        identity: &AgentIdentity,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        self.accepted(None, |tasks| tasks.started(identity, session_id, run_id))
    }

    /// The user answered a permission, so the run is no longer waiting on it.
    ///
    /// The run is looked up from the request id rather than asked of the caller, and the lookup is here
    /// rather than on `TaskProjection` because it is a *policy* about several tasks: the projection
    /// deliberately has no way to find a task by anything but its whole key, and adding one there would
    /// be the convenience method that one day clicks the wrong task. The id is the host's own, minted
    /// per request, so the task holding it is the one this answer is about — and the whole identity is
    /// compared anyway, because §6.1's key is a tuple for a reason.
    pub fn answered(
        &self,
        identity: &AgentIdentity,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        let (list, ingest) = self.with(|tasks| {
            let waiting = tasks
                .tasks()
                .into_iter()
                .find(|task| {
                    task.permission_request_id.as_deref() == Some(request_id)
                        && task.key.session_id == session_id
                        && task.key.agent_id == identity.agent_id
                        && task.key.profile_id == identity.profile_id
                        && task.key.runtime_epoch == identity.runtime_epoch
                        && task.key.vault_id == identity.vault_id
                })
                .map(|task| task.key.run_id);
            // No task holds this request: the answer is about a prompt the projection never saw (a
            // frame that was refused, a run that had already ended), and there is nothing to change —
            // the projection's own `answered` refuses an id that does not match for the same reason.
            waiting.and_then(|run_id| tasks.answered(identity, session_id, &run_id, request_id))
        })?;
        Ok(self.settled(list, ingest, None))
    }

    /// One frame off the runtime's stream.
    ///
    /// The usage the engine reported for the turn travels with the frame, and it is read here because
    /// this is the only layer that sees both: `TaskProjection` decides *what happened* and deliberately
    /// carries no payload, while §8's ledger needs the one number that only the `RunFinished` frame
    /// carries. `runs.rs` puts `PromptResponse.usage` into that frame's payload as the engine sent it,
    /// and [`usage::counters`] is the same reader the window's own `usage-changed` goes through — one
    /// interpretation of one value, so the care page and the context meter cannot disagree about what
    /// the engine said.
    ///
    /// `None` is "the engine reported nothing this build can read", which is not a zero: the care ledger
    /// counts it as `unreported_runs` and refuses to add it to a total (§8's 「token 未知不是 0」).
    pub fn apply(
        &self,
        envelope: &AgentEventEnvelope,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        let reported = usage::counters(envelope.payload.get("usage"))
            .and_then(|counters| counters.total_tokens);
        self.accepted(reported, |tasks| tasks.apply(envelope))
    }

    /// One of the host's own session snapshots.
    pub fn observe(
        &self,
        snapshot: &SessionSnapshot,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        self.accepted(None, |tasks| tasks.observe(snapshot))
    }

    /// Apply one fact and answer the list as it now stands, plus the projection's own account of what
    /// the fact did.
    ///
    /// A poisoned lock is a sentence rather than a panic: a Tauri command that panics is a rejected
    /// promise on the other side with no explanation, and every caller here is either a command or the
    /// driver's own task, neither of which may take the process down over a lock.
    fn with<T>(
        &self,
        frame: impl FnOnce(&mut TaskProjection) -> T,
    ) -> Result<(Vec<PetTaskProjection>, T), String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "the pet's task projection was poisoned by a panic".to_string())?;
        let answer = frame(&mut tasks);
        Ok((tasks.tasks(), answer))
    }

    /// Answer the whole list when the projection *changed* for it.
    ///
    /// The decision is the projection's own `Disposition`, not a guess made here: a replayed sequence, a
    /// frame from another incarnation, a kind that says nothing about a task, and a fact about a run
    /// that already ended are all things a window has already been told — and a push for one of them
    /// would have the window apply the same fact twice.
    fn accepted(
        &self,
        reported: Option<u64>,
        frame: impl FnOnce(&mut TaskProjection) -> Ingest,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        let (list, ingest) = self.with(frame)?;
        Ok(self.settled(list, Some(ingest), reported))
    }

    /// Carry an entry point's fact to both ledgers, and answer the list when the projection changed.
    ///
    /// Every entry point ends here, which is what makes "the ledgers hear every applied fact" a property
    /// of the tree rather than of each method remembering to call it. A ledger hears an applied frame
    /// and nothing else: each has its own replay check and its own rule about a settled run, and this
    /// module deliberately has neither of the two facts that make those decisions — so the projection's
    /// answer is what is handed over, because a `Settled` or `Replayed` disposition is a decision
    /// already taken, and asking a ledger to take it again would be the second opinion §6.3 forbids.
    /// `None` is the entry point that found nothing to apply (an answer to a request no task holds),
    /// which is not a fact either.
    ///
    /// `reported` is the usage the engine sent with this frame, and it is passed along rather than
    /// stored: it belongs to the frame, not to the row the frame left (§8's totals are the only place a
    /// count is kept, and `TaskHistory` deliberately has no field that could hold one).
    fn settled(
        &self,
        list: Vec<PetTaskProjection>,
        ingest: Option<Ingest>,
        reported: Option<u64>,
    ) -> Option<Vec<PetTaskProjection>> {
        if let Some(fact) = ingest.as_ref().and_then(Self::fact_of) {
            self.note([fact], reported);
        }
        ingest
            .filter(|ingest| ingest.disposition == Disposition::Applied)
            .map(|_| list)
    }

    /// Carry the runs an `install`/`retire` restated to the ledgers, as the host's own facts.
    ///
    /// No usage is reported here and that is a fact about the path rather than an omission: an instance
    /// that ended is a run the host never saw the engine answer, so `reported` is `None` and the care
    /// ledger counts it as an unreported run if it pays at all — which it does not, because
    /// `install`/`retire` restate `interrupted`.
    fn restated(&self, restated: &[PetTaskProjection], reported: Option<u64>) {
        self.note(restated.iter().map(|task| Self::fact(task, 0)), reported);
    }

    /// Hand one entry point's facts to both ledgers.
    ///
    /// **The care ledger is settled first, and on its own lock.** The two ledgers answer different
    /// questions about one fact — a reminder is a nudge, a reward is the user's progress — and the order
    /// is the choice that keeps a failure in one from costing the other: the reward is written before §6.3's
    /// lock is even taken, so a poisoned reminder ledger (or a channel that cannot be reached) loses the
    /// notice and never the meal. Neither call returns anything: each owns its own reporting, and a caller
    /// here has no decision left to make.
    fn note(&self, facts: impl IntoIterator<Item = TaskFact>, reported: Option<u64>) {
        let facts: Vec<TaskFact> = facts.into_iter().collect();
        // A narrowed view rather than the facts themselves: §8's ledger has no business knowing that a
        // notice can carry a label, so `SettledTask` is the three fields settlement actually reads.
        self.care.settle(
            facts.iter().map(|fact| SettledTask {
                key: &fact.key,
                state: fact.state,
                at_ms: fact.at_ms,
            }),
            reported,
        );
        self.reminders.note(facts);
    }

    /// One task as §6.3's ledger keys it — the run, its state, and the stream position it came off.
    ///
    /// `label` is the host's own name for the task, and this host has none: a session's title lives in
    /// the agent panel, and the projection deliberately carries none of it (§6.1's 「不发送聊天内容」).
    /// A notice therefore never names a task here, which is also §6.3's default.
    fn fact(task: &PetTaskProjection, sequence: u64) -> TaskFact {
        TaskFact {
            key: task.key.clone(),
            state: task.state,
            permission_request_id: task.permission_request_id.clone(),
            sequence,
            at_ms: task.updated_at as i64,
            label: None,
        }
    }

    /// The fact one applied frame is, or `None` when the frame is not news.
    ///
    /// A replayed sequence, a frame from an instance this host is not serving, a kind that says nothing
    /// about a task and a fact about a run that already ended all leave `task` empty or the disposition
    /// elsewhere, and all of them are answers the window already has.
    fn fact_of(ingest: &Ingest) -> Option<TaskFact> {
        if ingest.disposition != Disposition::Applied {
            return None;
        }
        let task = ingest.task.as_ref()?;
        Some(Self::fact(task, ingest.order.sequence))
    }
}

/// Tell every window what the task list is now.
///
/// Broadcast rather than addressed, because the address would be a window label and a label is the one
/// thing this backend does not hand out (`window_host.rs`'s rule). A failed emit is not an error: it
/// means no window is listening — a hidden or closed pet, or the shutdown path — and the list is
/// readable on request in any case, which is what keeps a missed frame from being a lost task.
pub fn publish_tasks<R: Runtime>(app: &AppHandle<R>, tasks: &[PetTaskProjection]) {
    let _ = app.emit(PET_TASKS_CHANNEL, tasks);
}
