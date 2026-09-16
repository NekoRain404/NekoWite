//! The one place a runtime frame becomes a task a pet window can read, the one place a window is
//! told that the list moved, and the one place a fact reaches §6.3's notification ledger.
//!
//! D4 delivered [`TaskProjection`] — the state machine that tells two engines' tasks apart — and
//! left it with no home. Nothing in the process held it, so `desktop_pet_tasks` had no state to
//! answer from and the window's subscription died on its first read: a pet that looks quiet
//! instead of a pet that says it cannot see anything. This module is the home.
//!
//! D5 delivered the ledger (`notification_policy.rs`) and left it in the same position one layer
//! up: constructed nowhere, so the switches the notification page writes were read by nobody, no
//! ending was ever recorded as unread, and no delivery was ever attempted — the app ran without a
//! reminder path while a comment said it ran with a failing one. [`PetTaskFeed`] holds that ledger
//! beside the projection, for the reason it holds the projection: a frame is applied once, here,
//! and the decision about it belongs to the same motion.
//!
//! Three rules are structural here rather than documented, because each is a mistake that would
//! look like a working window:
//!
//! - **The record is the truth, and the push is only how a window hears about it sooner.** A frame
//!   is applied to the projection first and emitted second, so an emit that nobody hears (the hide
//!   path, a closed window, a shutdown) costs a *notification*, never the fact. That ordering is
//!   the same one the reference client's archive store uses — it records what it has handled only
//!   after the write succeeded, so a failed write is not mistaken for a handled one
//!   (`references/desktop-pet/Sources/DesktopPetCore/SessionArchiveStore.swift:51`) — read in this
//!   direction: what is durable (here, the projection) is written before what is best-effort (the
//!   frame on a channel), and a reader always has the list as the source of truth. `subscribe` in
//!   `tauri-pet.ts` reads after it listens for exactly this reason.
//! - **Exactly one reader applies a frame.** §6.3's single account: the projection reports replays
//!   and gaps (`Ingest`), so a second writer — another command, a second subscription — would make
//!   its sequence log see a stream that is really two interleaved halves. The lock is here so there
//!   is one place a frame is applied, and every caller goes through it.
//! - **The ledger is told once per applied fact, and is told nothing else.** Every entry point here
//!   carries what it just applied to §6.3's one ledger and asks the host to come back when a
//!   completion burst closes; a replayed sequence, a frame from an instance this host is not
//!   serving and a fact about a run that already ended are not carried, because the window already
//!   has them and the ledger would be deciding about a fact that did not happen. The decisions —
//!   dedup, do-not-disturb, the switches, unread — are `notification_policy.rs`'s, and this module
//!   has no second opinion about any of them.
//!
//! What this module deliberately is not: it never removes a task, and it decides nothing about a
//! *reminder*. A window reads the list; the ledger decides what to say about it; this is only the
//! place the two are held together, because a frame becomes a task and a fact about that task in
//! the same motion and a second reader would be a second place for the two to disagree.
//!
//! **The ledger reaches the disk from here too, and only from here.** §6.3's 「重启读取已处理账本」
//! is met by `history::store`, and the write has to happen where the change does: a save called from
//! anywhere else would have to take the ledger's lock a second time and would be a second reader
//! deciding what was written. A feed built without a store — every test that is not about the file,
//! and `PetTaskFeed::new` — is the same feed with nothing to write to, which is what keeps this from
//! being a cost the frame path pays for a feature it is not exercising.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Runtime};

use crate::agent_runtime::events::{AgentEventEnvelope, AgentIdentity};
use crate::agent_runtime::snapshot::SessionSnapshot;

use super::history::{HistoryStore, TaskHistory};
use super::notification_delivery::NoChannel;
use super::settings::{self, PetSettingsDomain, PetSettingsStore};
use super::notification_policy::{
    NotificationOutcome, NotificationPolicy, NotificationPreferences, TaskFact,
};
use super::task_projection::{
    system_clock, Disposition, Ingest, PetTaskProjection, TaskProjection,
};

/// The channel the host publishes the task list on.
///
/// The whole list every time, never a delta: a window that missed a frame is stale for one frame
/// rather than wrong for ever, and the first delivery needs no replay machinery because the list
/// is complete. `tauri-pet.ts` declares the same name; the two spellings are one decision.
pub const PET_TASKS_CHANNEL: &str = "pet-task";

/// The host's trusted tasks, as one window-readable value.
///
/// The lock is inside rather than around: `TaskProjection` is deliberately not `Sync`
/// (its own doc says a caller that wants to share it takes a lock, so there is exactly one place a
/// frame is applied), and this is that lock — the same shape `PetWindowHost` and `CareLedger` have
/// in `DesktopPetState`.
pub struct PetTaskFeed {
    tasks: Mutex<TaskProjection>,
    /// §6.3's one ledger, beside the list it decides about. A lock of its own rather than the
    /// projection's: the two are written in one motion but read for different reasons — a window
    /// reads the list on every push, a page or a command reads the unread rows far less often — and
    /// one lock would make the second wait behind the first's readers.
    notifications: Mutex<NotificationPolicy>,
    /// Who to call when a gathering burst closes. See [`PetTaskFeed::set_notice_waker`].
    wake: Mutex<Wake>,
    /// Where the ledger is written out, when this feed was built with a file to write it to.
    ///
    /// Not a lock, because it is set once at construction and never replaced: a feed with a store
    /// persists on every write, and a feed without one — the shape every test that is not about
    /// persistence builds — is the same feed with nothing to write to.
    ledger: Option<HistoryStore>,
}

/// How the host is asked to come back when a completion burst's window closes.
///
/// A callback rather than a tick: this module has no timer and no runtime handle, and a periodic
/// wake would be the polling §7.3's budget refuses, run for a notice that happens a few times an
/// hour. It is `Send + Sync` because the host's own waker hands the wait to another task, and it
/// takes the ledger's due time in host milliseconds rather than a duration, so nothing here has to
/// agree with the host about when "now" was.
type NoticeWaker = Box<dyn Fn(i64) + Send + Sync>;

/// The waker, and the due time it has already been asked for.
///
/// One lock for both because they are one fact: a request is only meaningful beside what has
/// already been requested, and two locks would let two frames of one burst both see "not asked yet"
/// and wake the host twice for one notice.
#[derive(Default)]
struct Wake {
    waker: Option<NoticeWaker>,
    asked_for: Option<i64>,
}

impl Default for PetTaskFeed {
    fn default() -> Self {
        Self::new()
    }
}

impl PetTaskFeed {
    /// A feed with no tasks, the real clock, and the ledger this build runs with.
    ///
    /// The channel is [`NoChannel`] because this build has none: adding the Tauri notification
    /// plugin is the integrator's dependency change (`notification_delivery.rs`), and the failing
    /// channel is what §7.2's `unread-list` fallback is stated from — every notice the ledger
    /// decides on leaves an unread row that says `failed`, which is the honest version of "the app
    /// cannot show you a toast". It is not a placeholder: a build that gains the plugin replaces
    /// this one argument.
    pub fn new() -> Self {
        Self::with_notifications(NotificationPolicy::new(
            Box::new(NoChannel::new()),
            NotificationPreferences::default(),
            TaskHistory::new(),
        ))
    }

    /// The feed with a ledger the caller built — channel, switches and history injected (§10.2),
    /// which is how a test drives a notice that goes out and one that cannot.
    pub fn with_notifications(policy: NotificationPolicy) -> Self {
        Self::with_ledger(policy, None)
    }

    /// The same, with the file §6.3's 「重启读取已处理账本」 is kept in.
    ///
    /// A store rather than a path is what makes the feed testable without a disk, and the store is
    /// built by whoever has a data directory — [`Self::for_app`], or a test with a temporary one.
    pub fn with_ledger(policy: NotificationPolicy, ledger: Option<HistoryStore>) -> Self {
        Self {
            tasks: Mutex::new(TaskProjection::new(system_clock())),
            notifications: Mutex::new(policy),
            wake: Mutex::new(Wake::default()),
            ledger,
        }
    }

    /// The feed the app runs with, assembled from the directory it keeps its files in.
    ///
    /// Four things meet here and nowhere else, and each is here for the reason this module exists:
    /// the switches the notification page writes ([`settings::notification_preferences`], read
    /// once because the alternative is a file read on the driver's task for every frame), the rows
    /// the last run left (`history::store`, so a reminder survives a crash), the history they were
    /// read into, and the channel — which this build does not have, so every notice the ledger
    /// decides on fails visibly and leaves the row unread (§7.2's `unread-list` fallback, stated
    /// rather than substituted).
    ///
    /// **One store, not two.** The instance that reads the ledger is the one the feed saves
    /// through, and that is not tidiness: a `HistoryStore` remembers what a *newer* build's file
    /// did to it, so a load through a store that was then thrown away would leave the real one
    /// believing it may replace a ledger it has never read — the overwrite §10.2 forbids.
    ///
    /// `now_ms` is the host's clock and it is a parameter for the reason every entry point here
    /// takes one: the ageing rule a restored ledger is put through is then exercised by handing it
    /// two numbers rather than by writing a file with old rows in it and waiting.
    ///
    /// A directory this build cannot use still answers with a feed — the shipped switches, an empty
    /// ledger, nothing on disk — because the reminder path must not be able to stop the app from
    /// starting. What is printed is the ledger's own trouble, a directory it cannot live in or a
    /// file it could not restore: those are mistakes. A settings file that is merely absent or
    /// unreadable is not one, and is left to the settings page that already states it.
    pub fn for_app(data: &Path, now_ms: i64) -> Self {
        let ledger = match HistoryStore::new(data) {
            Ok(store) => Some(store),
            Err(detail) => {
                eprintln!("nekowite: the pet's reminder ledger has nowhere to live: {detail}");
                None
            }
        };
        let history = match ledger.as_ref() {
            Some(store) => restored_history(store, now_ms),
            None => TaskHistory::new(),
        };
        Self::with_ledger(
            NotificationPolicy::new(
                Box::new(NoChannel::new()),
                stored_switches(data),
                history,
            ),
            ledger,
        )
    }

    /// Tell the feed how to ask for a wake at a burst's due time (§6.3's coalescing window).
    ///
    /// Set once, by whoever built the feed with an app to reach (`state::DesktopPetState::new`);
    /// a feed without one keeps its bursts and delivers nothing, which is the state the cases that
    /// do not care about timing run in. The request in flight is forgotten, so a waker installed
    /// after a burst opened is told about that burst rather than waiting for the next one.
    pub fn set_notice_waker(&self, waker: impl Fn(i64) + Send + Sync + 'static) {
        let Ok(mut wake) = self.wake.lock() else { return };
        wake.waker = Some(Box::new(waker));
        wake.asked_for = None;
    }

    /// §6.3's ledger: the unread rows, the switches, the gaps and the burst in flight.
    ///
    /// Handed out rather than answered field by field, because the ledger's own API is the answer:
    /// `unread` is a view over rows a later write must not be reordered against, and a second set
    /// of accessors here would be a second place every rule about them has to be remembered and
    /// kept in step.
    pub fn notifications(&self) -> Result<MutexGuard<'_, NotificationPolicy>, String> {
        self.notifications
            .lock()
            .map_err(|_| "the pet's notification ledger was poisoned by a panic".to_string())
    }

    /// Deliver whatever the gathering burst's window has closed on, as the host's clock reads.
    ///
    /// The host calls this from the wake it was asked for. `None` means nothing was due; a delivery
    /// that failed is an outcome rather than an error, and the row is recorded either way — that
    /// ordering is the ledger's (`notification_policy.rs`), and this is only the way back to it.
    pub fn flush_notices(&self, now_ms: i64) -> Result<Option<NotificationOutcome>, String> {
        let mut policy = self.notifications()?;
        let outcome = policy.flush_due(now_ms);
        let due = policy.pending_due();
        self.persist(&policy);
        drop(policy);
        self.ask_wake(due);
        if let Some(outcome) = &outcome {
            report_notice(outcome);
        }
        Ok(outcome)
    }

    /// Every task the pet shows, for a window that is mounting or asking again.
    ///
    /// A complete list every time, which is what makes the subscription's listen-then-read ordering
    /// a choice about duplicates rather than a race about loss.
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
        self.restated(&restated);
        Ok((!restated.is_empty()).then_some(list))
    }

    /// The host's instance is over, so nothing it was running can still be running.
    pub fn retire(
        &self,
        identity: &AgentIdentity,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        let (list, restated) = self.with(|tasks| tasks.retire(identity))?;
        self.restated(&restated);
        Ok((!restated.is_empty()).then_some(list))
    }

    /// A turn began. §6.1: no frame says this, so the host's own view is where it comes from.
    pub fn started(
        &self,
        identity: &AgentIdentity,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        self.accepted(|tasks| tasks.started(identity, session_id, run_id))
    }


    /// The user answered a permission, so the run is no longer waiting on it.
    ///
    /// The run is looked up from the request id rather than asked of the caller, and the lookup is
    /// here rather than on `TaskProjection` because it is a *policy* about several tasks: the
    /// projection deliberately has no way to find a task by anything but its whole key, and adding
    /// one there would be the convenience method that one day clicks the wrong task. The id is the
    /// host's own, minted per request, so the task holding it is the one this answer is about —
    /// and the whole identity is compared anyway, because §6.1's key is a tuple for a reason.
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
            // No task holds this request: the answer is about a prompt the projection never saw
            // (a frame that was refused, a run that had already ended), and there is nothing to
            // change — the projection's own `answered` refuses an id that does not match for the
            // same reason.
            waiting.and_then(|run_id| tasks.answered(identity, session_id, &run_id, request_id))
        })?;
        Ok(self.settled(list, ingest))
    }

    /// One frame off the runtime's stream.
    pub fn apply(
        &self,
        envelope: &AgentEventEnvelope,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        self.accepted(|tasks| tasks.apply(envelope))
    }

    /// One of the host's own session snapshots.
    pub fn observe(
        &self,
        snapshot: &SessionSnapshot,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        self.accepted(|tasks| tasks.observe(snapshot))
    }

    /// Apply one fact and answer the list as it now stands, plus the projection's own account of
    /// what the fact did.
    ///
    /// A poisoned lock is a sentence rather than a panic: a Tauri command that panics is a rejected
    /// promise on the other side with no explanation, and every caller here is either a command or
    /// the driver's own task, neither of which may take the process down over a lock.
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
    /// The decision is the projection's own `Disposition`, not a guess made here: a replayed
    /// sequence, a frame from another incarnation, a kind that says nothing about a task, and a
    /// fact about a run that already ended are all things a window has already been told — and a
    /// push for one of them would have the window apply the same fact twice.
    fn accepted(
        &self,
        frame: impl FnOnce(&mut TaskProjection) -> Ingest,
    ) -> Result<Option<Vec<PetTaskProjection>>, String> {
        let (list, ingest) = self.with(frame)?;
        Ok(self.settled(list, Some(ingest)))
    }

    /// Carry an entry point's fact to the ledger, and answer the list when the projection changed.
    ///
    /// Every entry point ends here, which is what makes "the ledger hears every applied fact" a
    /// property of the tree rather than of each method remembering to call it. The ledger hears an
    /// applied frame and nothing else: it has its own replay check and its own rule about a settled
    /// run, and it deliberately has neither of the two facts that make those decisions here — so it
    /// is handed the projection's answer rather than the frame, because a `Settled` or `Replayed`
    /// disposition is a decision already taken, and asking the ledger to take it again would be the
    /// second opinion §6.3 forbids. `None` is the entry point that found nothing to apply (an answer
    /// to a request no task holds), which is not a fact either.
    fn settled(
        &self,
        list: Vec<PetTaskProjection>,
        ingest: Option<Ingest>,
    ) -> Option<Vec<PetTaskProjection>> {
        if let Some(fact) = ingest.as_ref().and_then(Self::fact_of) {
            self.note([fact]);
        }
        ingest
            .filter(|ingest| ingest.disposition == Disposition::Applied)
            .map(|_| list)
    }

    /// Carry the runs a `install`/`retire` restated to the ledger, as the host's own facts.
    fn restated(&self, restated: &[PetTaskProjection]) {
        self.note(restated.iter().map(|task| Self::fact(task, 0)));
    }

    /// Hand one entry point's facts to §6.3's ledger, and ask for a wake if a burst is gathering.
    ///
    /// Nothing here decides anything: `observe` writes the row, applies the switches, dedups and
    /// asks the channel — in that order, which is the ledger's own and the one rule this function
    /// must not disturb (`notification_policy.rs`'s header). A poisoned lock costs the reminder and
    /// never the task: the projection has already applied the frame, which is what the window reads.
    fn note(&self, facts: impl IntoIterator<Item = TaskFact>) {
        let Ok(mut policy) = self.notifications.lock() else {
            eprintln!("nekowite: the pet's notification ledger was poisoned by a panic");
            return;
        };
        for fact in facts {
            let outcome = policy.observe(fact);
            report_notice(&outcome);
        }
        let due = policy.pending_due();
        self.persist(&policy);
        drop(policy);
        self.ask_wake(due);
    }

    /// Write the ledger out, when this feed has a file for it.
    ///
    /// Called with the ledger's own guard held, so the bytes written are the rows as they stand and
    /// two writers cannot put an older ledger back: the store is told what to write, and its own
    /// answer says whether anything changed. A failure costs the file and never the frame — the
    /// projection has already applied it and the row is in memory — so it is reported and not
    /// returned, exactly as a failed notice is.
    fn persist(&self, policy: &NotificationPolicy) {
        let Some(store) = self.ledger.as_ref() else { return };
        // The store's two quiet arms are answers, not failures: `Unchanged` means the file already
        // held exactly this, and `ReadOnly` that a newer build owns it (§10.2). Only a write that
        // could not happen is worth a line, and it costs the file rather than the reminder.
        if let Err(detail) = store.save(policy.history()) {
            eprintln!("nekowite: the pet's reminder ledger was not written out: {detail}")
        }
    }

    /// Ask the host for one wake at `due`, and only when that is news.
    ///
    /// A burst is asked for once however many completions join it: a wake per frame would be a
    /// timer per frame for one notice, and the ledger's own due time is the same number for every
    /// member. `None` clears the request, which is how a burst that was dropped — do-not-disturb
    /// turned on, a flush that already ran — stops owing the host a wake.
    fn ask_wake(&self, due: Option<i64>) {
        let Ok(mut wake) = self.wake.lock() else { return };
        if wake.asked_for == due {
            return;
        }
        wake.asked_for = due;
        if let (Some(due), Some(waker)) = (due, wake.waker.as_ref()) {
            waker(due);
        }
    }

    /// One task as §6.3's ledger keys it — the run, its state, and the stream position it came off.
    ///
    /// `label` is the host's own name for the task, and this host has none: a session's title lives
    /// in the agent panel, and the projection deliberately carries none of it (§6.1's 「不发送聊天
    /// 内容」). A notice therefore never names a task here, which is also §6.3's default.
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
    /// A replayed sequence, a frame from an instance this host is not serving, a kind that says
    /// nothing about a task and a fact about a run that already ended all leave `task` empty or the
    /// disposition elsewhere, and all of them are answers the window already has.
    fn fact_of(ingest: &Ingest) -> Option<TaskFact> {
        if ingest.disposition != Disposition::Applied {
            return None;
        }
        let task = ingest.task.as_ref()?;
        Some(Self::fact(task, ingest.order.sequence))
    }
}

/// The rows the ledger's file held, or an empty ledger when there is no readable one.
///
/// A file this build could not read costs the reminder and never the feature: the app starts with an
/// empty ledger, which is exactly what it started with before the file existed. What is *not* silent
/// is how much did not survive — the count is printed rather than dropped, because a bound that
/// quietly forgets a reminder is the 漏提示 this whole path is graded against.
fn restored_history(store: &HistoryStore, now_ms: i64) -> TaskHistory {
    let loaded = store.load(now_ms);
    if let Some(detail) = &loaded.detail {
        eprintln!("nekowite: the pet's reminder ledger was not restored: {detail}");
    }
    if loaded.dropped > 0 {
        eprintln!(
            "nekowite: {} rows of the pet's reminder ledger did not survive the restart",
            loaded.dropped
        );
    }
    loaded.history
}

/// The notification switches the user has saved, or the shipped defaults.
///
/// The defaults are [`NotificationPreferences::default`] and not an error, for the reason the whole
/// ledger runs on them at a fresh install: a settings file that is absent, unreadable or written by
/// a newer build is a read the settings page states in its own words (§10.2's read-only arm), and a
/// notice decided by the shipped defaults is a better answer than one decided by half a record — or
/// by an error the user never asked for.
fn stored_switches(data: &Path) -> NotificationPreferences {
    let Ok(store) = PetSettingsStore::new(data) else {
        return NotificationPreferences::default();
    };
    store
        .read(PetSettingsDomain::Notification)
        .record()
        .and_then(settings::notification_preferences)
        .unwrap_or_default()
}

/// §6.3: a delivery that failed is *reported*, and the record is what the user still has.
///
/// The row is unread and says `failed` before this line runs — that ordering is the ledger's, and
/// this is only where the failure leaves the process. Written down rather than swallowed because a
/// user who believes they will be told is the one outcome worse than no toast, and the reason a
/// notice could not go out is what tells the difference between a desktop with no daemon and one
/// where the user turned notifications off.
fn report_notice(outcome: &NotificationOutcome) {
    if let NotificationOutcome::DeliveryFailed { failure, .. } = outcome {
        eprintln!(
            "nekowite: the pet could not show a notice ({}): {}",
            failure.kind(),
            failure.detail()
        );
    }
}

/// Tell every window what the task list is now.
///
/// Broadcast rather than addressed, because the address would be a window label and a label is the
/// one thing this backend does not hand out (`window_host.rs`'s rule). A failed emit is not an
/// error: it means no window is listening — a hidden or closed pet, or the shutdown path — and the
/// list is readable on request in any case, which is what keeps a missed frame from being a lost
/// task.
pub fn publish_tasks<R: Runtime>(app: &AppHandle<R>, tasks: &[PetTaskProjection]) {
    let _ = app.emit(PET_TASKS_CHANNEL, tasks);
}
