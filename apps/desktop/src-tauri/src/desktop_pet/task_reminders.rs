//! §6.3's reminder ledger, as the task feed's half of it: the one place a fact is decided into a
//! notice, and the one place that decision reaches the disk.
//!
//! **Why this is a module and not fields on `PetTaskFeed`.** It was two fields and four methods, and
//! the feed grew past the line budget `docs/dev.md:286` puts on a business file with them. The split
//! is not arithmetic: the two ledgers the feed drives answer different questions about one fact — a
//! reminder is a nudge, a reward is the user's progress — and each reaches its own file with its own
//! schema, its own refusal rule and its own lifetime. §6.3's half is here, §8's is in `care_feed`, and
//! [`PetTaskFeed`](super::task_feed) is left as the one place a frame becomes a fact and the two are
//! told.
//!
//! **What is decided here, and what is decided a layer down.** Nothing. `notification_policy.rs` owns
//! dedup, do-not-disturb, the switches, unread, quiet states and the coalescing window; this module
//! holds that policy, hands it each applied fact in the order the policy's header states, and asks the
//! host to come back when a burst's window closes. A second opinion about any of those rules is the
//! defect this arrangement exists to make impossible to write by accident.
//!
//! **The burst scheduling is here because it is the ledger's own.** The policy knows *when* a notice
//! is due and cannot come back then — it has no timer and no runtime. The waker below is that one
//! shot: the feed asks for a wake once per due time, the host waits the difference, and it calls
//! `flush` with the due time rather than a clock of its own. A tick would be a poll running all day
//! for a notice that happens a few times an hour, which §7.3's budget refuses.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use super::history::{HistoryStore, TaskHistory};
use super::notification_delivery::system_channel;
use super::notification_policy::{
    NotificationOutcome, NotificationPolicy, NotificationPreferences, TaskFact,
};
use super::settings::{self, PetSettingsDomain, PetSettingsStore};

/// How the host is asked to come back when a completion burst's window closes.
///
/// A callback rather than a tick, for the reason this module's header gives. It is `Send + Sync`
/// because the host's own waker hands the wait to another task, and it takes the ledger's due time in
/// host milliseconds rather than a duration, so nothing here has to agree with the host about when
/// "now" was.
type NoticeWaker = Box<dyn Fn(i64) + Send + Sync>;

/// The waker, and the due time it has already been asked for.
///
/// One lock for both because they are one fact: a request is only meaningful beside what has already
/// been requested, and two locks would let two frames of one burst both see "not asked yet" and wake
/// the host twice for one notice.
#[derive(Default)]
struct Wake {
    waker: Option<NoticeWaker>,
    asked_for: Option<i64>,
}

/// §6.3's ledger, the file behind it, and the host's way back to a closing burst.
pub struct TaskReminders {
    /// The ledger the switches, the rows and the dedup memory live in. A lock of its own rather than
    /// the projection's: the two are written in one motion but read for different reasons — a window
    /// reads the task list on every push, a page or a command reads the unread rows far less often —
    /// and one lock would make the second wait behind the first's readers.
    policy: Mutex<NotificationPolicy>,
    /// Where that ledger is written out, when this feed was built with a file to write it to.
    ///
    /// Not a lock, because it is set once at construction and never replaced: a feed with a store
    /// persists on every write, and a feed without one — the shape every test that is not about
    /// persistence builds — is the same feed with nothing to write to.
    store: Option<HistoryStore>,
    wake: Mutex<Wake>,
}

impl Default for TaskReminders {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskReminders {
    /// A ledger with the shipped switches, nothing on disk, and the system's own channel.
    ///
    /// The channel is chosen here rather than passed in because a feed with no app is still the app's
    /// feed: on Linux the session's notification daemon over D-Bus, and
    /// [`NoChannel`](super::notification_delivery::NoChannel) only where there is no bus to reach —
    /// the arm §7.2's `unread-list` fallback is stated from, where every notice the ledger decides on
    /// leaves an unread row that says `failed`. A caller who wants another one says so through
    /// [`Self::with_policy`].
    pub fn new() -> Self {
        Self::with_policy(NotificationPolicy::new(
            system_channel(),
            NotificationPreferences::default(),
            TaskHistory::new(),
        ))
    }

    /// The ledger a caller built — channel, switches and history injected (§10.2), which is how a test
    /// drives a notice that goes out and one that cannot.
    pub fn with_policy(policy: NotificationPolicy) -> Self {
        Self::with_store(policy, None)
    }

    /// The same, with the file §6.3's 「重启读取已处理账本」 is kept in.
    ///
    /// A store rather than a path is what makes this testable without a disk, and the store is built by
    /// whoever has a data directory — [`Self::for_app`], or a test with a temporary one.
    ///
    /// **One store, not two.** The instance that reads the ledger is the one that saves through it, and
    /// that is not tidiness: a `HistoryStore` remembers what a *newer* build's file did to it, so a
    /// load through a store that was then thrown away would leave the real one believing it may replace
    /// a ledger it has never read — the overwrite §10.2 forbids.
    pub fn with_store(policy: NotificationPolicy, store: Option<HistoryStore>) -> Self {
        Self {
            policy: Mutex::new(policy),
            store,
            wake: Mutex::new(Wake::default()),
        }
    }

    /// The ledger the app runs with, assembled from the directory it keeps its files in.
    ///
    /// Three things meet here and nowhere else, and each is here for the reason this module exists:
    /// the switches the notification page writes ([`settings::notification_preferences`], read once
    /// because the alternative is a file read on the driver's task for every frame), the rows the last
    /// run left (`history::store`, so a reminder survives a crash), and the history they were read
    /// into.
    ///
    /// `now_ms` is the host's clock and it is a parameter for the reason every entry point here takes
    /// one: the ageing rule a restored ledger is put through is then exercised by handing it two
    /// numbers rather than by writing a file with old rows in it and waiting.
    ///
    /// A directory this build cannot use still answers with a ledger — the shipped switches and nothing
    /// on disk — because the reminder path must not be able to stop the app from starting. What is
    /// printed is the ledger's own trouble, a directory it cannot live in or a file it could not
    /// restore: those are mistakes. A settings file that is merely absent or unreadable is not one, and
    /// is left to the settings page that already states it.
    pub fn for_app(data: &Path, now_ms: i64) -> Self {
        let store = match HistoryStore::new(data) {
            Ok(store) => Some(store),
            Err(detail) => {
                eprintln!("nekowite: the pet's reminder ledger has nowhere to live: {detail}");
                None
            }
        };
        let history = match store.as_ref() {
            Some(store) => restored_history(store, now_ms),
            None => TaskHistory::new(),
        };
        Self::with_store(
            NotificationPolicy::new(system_channel(), stored_switches(data), history),
            store,
        )
    }

    /// Tell the ledger how to ask for a wake at a burst's due time (§6.3's coalescing window).
    ///
    /// Set once, by whoever built the feed with an app to reach (`state::DesktopPetState::new`); a
    /// ledger without one keeps its bursts and delivers nothing, which is the state the cases that do
    /// not care about timing run in. The request in flight is forgotten, so a waker installed after a
    /// burst opened is told about that burst rather than waiting for the next one.
    pub fn set_waker(&self, waker: impl Fn(i64) + Send + Sync + 'static) {
        let Ok(mut wake) = self.wake.lock() else {
            return;
        };
        wake.waker = Some(Box::new(waker));
        wake.asked_for = None;
    }

    /// §6.3's ledger: the unread rows, the switches, the gaps and the burst in flight.
    ///
    /// Handed out rather than answered field by field, because the ledger's own API is the answer:
    /// `unread` is a view over rows a later write must not be reordered against, and a second set of
    /// accessors here would be a second place every rule about them has to be remembered and kept in
    /// step.
    pub fn policy(&self) -> Result<MutexGuard<'_, NotificationPolicy>, String> {
        self.policy
            .lock()
            .map_err(|_| "the pet's notification ledger was poisoned by a panic".to_string())
    }

    /// Deliver whatever the gathering burst's window has closed on, as the host's clock reads.
    ///
    /// The host calls this from the wake it was asked for. `None` means nothing was due; a delivery
    /// that failed is an outcome rather than an error, and the row is recorded either way — that
    /// ordering is the ledger's (`notification_policy.rs`), and this is only the way back to it.
    pub fn flush(&self, now_ms: i64) -> Result<Option<NotificationOutcome>, String> {
        let mut policy = self.policy()?;
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

    /// Hand one entry point's facts to the ledger, and ask for a wake if a burst is gathering.
    ///
    /// Nothing here decides anything: `observe` writes the row, applies the switches, dedups and asks
    /// the channel — in that order, which is the ledger's own and the one rule this function must not
    /// disturb. A poisoned lock costs the reminder and never the task: the projection has already
    /// applied the frame, which is what the window reads.
    pub fn note(&self, facts: impl IntoIterator<Item = TaskFact>) {
        let Ok(mut policy) = self.policy.lock() else {
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
    /// Called with the ledger's own guard held, so the bytes written are the rows as they stand and two
    /// writers cannot put an older ledger back: the store is told what to write, and its own answer
    /// says whether anything changed. A failure costs the file and never the frame — the projection has
    /// already applied it and the row is in memory — so it is reported and not returned, exactly as a
    /// failed notice is.
    fn persist(&self, policy: &NotificationPolicy) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        // The store's two quiet arms are answers, not failures: `Unchanged` means the file already held
        // exactly this, and `ReadOnly` that a newer build owns it (§10.2). Only a write that could not
        // happen is worth a line, and it costs the file rather than the reminder.
        if let Err(detail) = store.save(policy.history()) {
            eprintln!("nekowite: the pet's reminder ledger was not written out: {detail}")
        }
    }

    /// Ask the host for one wake at `due`, and only when that is news.
    ///
    /// A burst is asked for once however many completions join it: a wake per frame would be a timer
    /// per frame for one notice, and the ledger's own due time is the same number for every member.
    /// `None` clears the request, which is how a burst that was dropped — do-not-disturb turned on, a
    /// flush that already ran — stops owing the host a wake.
    fn ask_wake(&self, due: Option<i64>) {
        let Ok(mut wake) = self.wake.lock() else {
            return;
        };
        if wake.asked_for == due {
            return;
        }
        wake.asked_for = due;
        if let (Some(due), Some(waker)) = (due, wake.waker.as_ref()) {
            waker(due);
        }
    }
}

/// The sentences a read of the ledger owes the log — one per cause, and none at all when nothing a
/// user could miss was dropped.
///
/// Split from the printing the way `instance_guard`'s probe is split from its report, and for the same
/// reason: what counts as a loss, and how it is spelled, is a rule, and a rule that can only be read
/// off a terminal is one no test holds. It counts **rows**, so a read that dropped nothing but stream
/// marks owes no sentence at all (that sentence used to be the sum of rows, aged-out rows and marks,
/// and it was printed — by this app, on this machine — as 「2 rows … did not survive」 for a file
/// holding no missing row); the plural is written out, because the same line really was printed as
/// 「1 rows」.
///
/// **A second sentence, because the two row counts are two pieces of news.** They were one number once,
/// and that sentence had to be about the sum — so a row that *had* been read back and was then let go
/// by `store`'s age rule was announced as 「did not survive the restart」, pointing its reader at a
/// data-loss bug that is not there. `dropped_records` — bytes the file held and this build could not
/// keep — keeps that sentence; `aged_out_rows` gets one naming the row's state and the bound, which a
/// reader can act on where 「the restart ate it」 is a bug report.
pub fn loss_report(loaded: &super::history::Loaded) -> Vec<String> {
    let lost = (loaded.dropped_records > 0).then(|| {
        format!(
            "nekowite: {} {} of the pet's reminder ledger did not survive the restart",
            loaded.dropped_records,
            spelled(loaded.dropped_records, "row", "rows")
        )
    });
    let aged = (loaded.aged_out_rows > 0).then(|| {
        format!(
            "nekowite: {} unread {} {} dropped on load, older than the day a reminder is still \
             worth showing",
            loaded.aged_out_rows,
            spelled(loaded.aged_out_rows, "reminder", "reminders"),
            spelled(loaded.aged_out_rows, "was", "were")
        )
    });
    [lost, aged].into_iter().flatten().collect()
}

/// The word that agrees with `count`: the `1 rows` this app really printed is why agreement is a named
/// function rather than an inline `if` in each arm.
fn spelled(count: usize, one: &'static str, many: &'static str) -> &'static str {
    if count == 1 {
        one
    } else {
        many
    }
}

/// The rows the ledger's file held, or an empty ledger when there is no readable one.
///
/// A file this build could not read costs the reminder and never the feature: the app starts with an
/// empty ledger, which is exactly what it started with before the file existed. What is *not* silent is
/// how much did not survive — the count is printed rather than dropped, because a bound that quietly
/// forgets a reminder is the 漏提示 this whole path is graded against.
///
/// **The sentences are about rows, and only rows reach them.** They used to be one sentence, and the
/// count behind it was the sum of three different things — rows, rows that aged out, and *stream
/// marks* — which made the app tell its user that 「2 rows of the pet's reminder ledger did not survive
/// the restart」 for a file whose two missing entries were marks: a position in a stream, forgotten on
/// every load by design, and never a reminder. Marks have their own count now
/// (`Loaded::forgotten_marks`) and no sentence: they are dropped on every restart, and a line that
/// always appears is one nobody reads. The plural is spelled rather than left as `1 rows`, which is what
/// the message said before — a real log line, from this app, on this machine.
///
/// **A row that aged out is not a row that failed to be read**: `loss_report` argues the split, and
/// this prints one line each so a reader who sees both sees which is which.
fn restored_history(store: &HistoryStore, now_ms: i64) -> TaskHistory {
    let loaded = store.load(now_ms);
    if let Some(detail) = &loaded.detail {
        eprintln!("nekowite: the pet's reminder ledger was not restored: {detail}");
    }
    for sentence in loss_report(&loaded) {
        eprintln!("{sentence}");
    }
    loaded.history
}

/// The notification switches the user has saved, or the shipped defaults.
///
/// The defaults are [`NotificationPreferences::default`] and not an error, for the reason the whole
/// ledger runs on them at a fresh install: a settings file that is absent, unreadable or written by a
/// newer build is a read the settings page states in its own words (§10.2's read-only arm), and a
/// notice decided by the shipped defaults is a better answer than one decided by half a record — or by
/// an error the user never asked for.
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
/// The row is unread and says `failed` before this line runs — that ordering is the ledger's, and this
/// is only where the failure leaves the process. Written down rather than swallowed because a user who
/// believes they will be told is the one outcome worse than no toast, and the reason a notice could not
/// go out is what tells the difference between a desktop with no daemon and one where the user turned
/// notifications off.
fn report_notice(outcome: &NotificationOutcome) {
    if let NotificationOutcome::DeliveryFailed { failure, .. } = outcome {
        eprintln!(
            "nekowite: the pet could not show a notice ({}): {}",
            failure.kind(),
            failure.detail()
        );
    }
}
