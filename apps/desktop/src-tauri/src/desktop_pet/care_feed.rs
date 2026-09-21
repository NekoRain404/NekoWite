//! §8's care ledger, as the task feed's half of it: where a reward is decided, and where it is
//! written.
//!
//! **Why this is a module and not three fields on `PetTaskFeed`.** It was three fields and two
//! methods, and the feed grew past the line budget `docs/dev.md:286` puts on a business file with
//! them. The split is not arithmetic: the two ledgers the feed drives answer different questions
//! about one fact — a reminder is a nudge, a reward is the user's progress — and each reaches a
//! different file with a different schema, a different refusal rule and a different lifetime. §8's
//! half is therefore here, §6.3's is in `task_reminders`, and [`PetTaskFeed`](super::task_feed) is
//! left as the one place a frame becomes a fact and the two are told.
//!
//! **What it is not: reachable from a window.** `care_ledger.rs` states the rule this module exists
//! to keep — 「a window that could write it could submit any amount of XP」 — so nothing here has a
//! caller a `#[tauri::command]` can produce. The only way in is a fact the runtime's own frame path
//! applied, and the only way out is the ledger handle the read command shares.
//!
//! **Why the ledger is a handle and the store is not.** [`CareFeed::ledger`] hands out the
//! `Arc<Mutex<CareLedger>>` because two readers hold it for different purposes: `desktop_pet_care_read`
//! answers a page, and this settles. A second ledger would be a second streak, which is why
//! `DesktopPetState` takes the handle once at construction rather than building its own. The store is
//! private because nothing outside this module may write the file: a save from anywhere else would be
//! a second writer deciding what the totals on disk are.

use std::path::Path;
use std::sync::{Arc, Mutex};

use super::care_ledger::CareLedger;
use super::care_settlement;
use super::care_store::{CareStore, SaveOutcome};
use super::task_projection::{PetTaskKey, PetTaskState};

/// The three things one applied fact means to §8's ledger.
///
/// A narrowed view of the fact rather than the feed's own type, and deliberately so: the feed's
/// currency (`notification_policy::TaskFact`) carries a task *label* for a notice to show, and a
/// reward has no business knowing that a label exists. This is what settlement actually reads — which
/// run, how it ended, and when the host saw it — so the module cannot grow a second opinion about a
/// reminder by having the shape in hand.
#[derive(Clone, Copy, Debug)]
pub struct SettledTask<'a> {
    /// The run's identity, as the projection mints it. The ledger keys its decision on
    /// `PetTaskKey::token()`, which is what makes a re-delivered ending free rather than paid twice.
    pub key: &'a PetTaskKey,
    pub state: PetTaskState,
    /// The host's clock for the fact, in epoch ms. The day a reward lands on is read from this
    /// instant, once, here — `care_ledger.rs` states at length why nothing later may convert it.
    pub at_ms: i64,
}

/// The ledger the app's page reads and its completions are settled into, with the file behind it.
pub struct CareFeed {
    ledger: Arc<Mutex<CareLedger>>,
    /// `None` for a feed built without a data directory — every test that is not about the file, and
    /// any process that could not resolve one. A feed with no store is the same feed with nothing to
    /// write to, which is what keeps persistence from being a cost the frame path pays for a feature
    /// it is not exercising.
    store: Option<CareStore>,
}

impl CareFeed {
    /// A ledger in memory and nothing to write to.
    pub fn in_memory() -> Self {
        Self {
            ledger: Arc::new(Mutex::new(CareLedger::new())),
            store: None,
        }
    }

    /// The app's: the record loaded out of `data`, with the store that wrote it kept to write it back.
    ///
    /// Loaded here rather than on the first settlement because this is the one moment an app data
    /// directory is known and no frame has arrived: a later load would happen on the driver's task,
    /// per frame, or on the first reward — which is the worst place for a file read that can fail.
    ///
    /// Nothing here is fatal. A directory this build cannot use still answers with a feed, because the
    /// app runs without a pet just as it runs without an engine, and what is printed is the ledger's
    /// own trouble rather than a failure: a record that could not be read means a run already paid may
    /// be paid again, and one a newer build wrote means the user's progress is on disk and this build
    /// will not touch it. Neither is a reason to refuse to start.
    pub fn on(data: &Path) -> Self {
        match CareStore::new(data) {
            Ok(store) => {
                let loaded = store.load();
                if let Some(detail) = &loaded.detail {
                    eprintln!("nekowite: the pet's care ledger did not come back: {detail}");
                }
                Self {
                    ledger: Arc::new(Mutex::new(loaded.ledger)),
                    store: Some(store),
                }
            }
            Err(detail) => {
                eprintln!("nekowite: the pet's care ledger has nowhere to live: {detail}");
                Self::in_memory()
            }
        }
    }

    /// The one ledger, as the handle the page's own read and this feed share.
    ///
    /// Handed out rather than answered field by field for the reason
    /// [`PetTaskFeed::notifications`](super::task_feed::PetTaskFeed::notifications) gives: the
    /// ledger's API *is* the answer, and a second set of accessors would be a second place every rule
    /// about it has to be kept in step.
    pub fn ledger(&self) -> Arc<Mutex<CareLedger>> {
        Arc::clone(&self.ledger)
    }

    /// Whether the record on disk belongs to a newer build (§10.2).
    ///
    /// Answered here because the latch is the store's: the read command asks rather than keeping a
    /// second copy of the fact, and a feed with no store is never read-only — there is no file for a
    /// newer build to have written.
    pub fn read_only(&self) -> bool {
        self.store.as_ref().is_some_and(CareStore::is_read_only)
    }

    /// Move §8's totals by the endings in `tasks`.
    ///
    /// Only endings reach `care_settlement::settle` — it answers `None` for a fact that is not one —
    /// so a frame about a run still going changes nothing here, however many of them arrive, and the
    /// idempotence is that seam's: the ledger keys its decision on `PetTaskKey::token()`, so a
    /// re-delivered frame, a second frame about a settled run and a replay all find the decision
    /// already made and pay nothing.
    ///
    /// A refusal is reported and never fatal, and a poisoned lock costs the reward rather than the
    /// frame: the projection has already applied it, which is what the window reads, and a panic here
    /// would take the driver's task — and with it the whole task list — down over a counter.
    pub fn settle<'a>(
        &self,
        tasks: impl IntoIterator<Item = SettledTask<'a>>,
        reported: Option<u64>,
    ) {
        let Ok(mut ledger) = self.ledger.lock() else {
            eprintln!("nekowite: the pet's care ledger was poisoned by a panic");
            return;
        };
        let mut decided = false;
        for task in tasks {
            let at = care_settlement::local_time_of(task.at_ms);
            match care_settlement::settle(&mut ledger, task.key, task.state, at, reported) {
                // Not an ending: the ordinary case, and not worth a line.
                None => {}
                // `first` is the side that matters for the file: a replay changes nothing, so writing
                // after one would be a save of identical bytes (`CareStore::save` would answer
                // `Unchanged` anyway, but the comparison is a string compare on the driver's task and
                // there is no reason to pay it for every re-delivered frame).
                Some(Ok(settlement)) => decided |= settlement.first,
                Some(Err(refusal)) => eprintln!(
                    "nekowite: a completion did not reach the pet's care ledger: {}",
                    refusal.detail()
                ),
            }
        }
        if decided {
            self.persist(&ledger);
        }
    }

    /// Put the ledger on disk, when this feed was built with a file for it.
    ///
    /// Called with the ledger's own guard held, so the bytes written are the totals as they stand and
    /// two writers cannot put an older ledger back — the same rule `task_reminders` keeps for the
    /// reminder ledger, and for the same reason. A failure costs the file and never the frame: the
    /// reward is already in memory, where the page's read answers from.
    ///
    /// `ReadOnly` is a reported outcome rather than a silent one, and it is the arm §10.2 exists for: a
    /// newer build owns the file, so this run's progress is real but is not written to it. Every other
    /// arm is either success or the absence of a store.
    fn persist(&self, ledger: &CareLedger) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        match store.save(ledger) {
            Ok(SaveOutcome::Written | SaveOutcome::Unchanged) => {}
            Ok(SaveOutcome::ReadOnly) => eprintln!(
                "nekowite: the pet's care ledger at {} belongs to a newer build, so this run's \
                 progress was not written to it",
                store.path().display()
            ),
            Err(detail) => {
                eprintln!("nekowite: the pet's care ledger was not written out: {detail}")
            }
        }
    }
}

/// The care ledger's own shape, for the tests that drive it without a file.
#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> PetTaskKey {
        PetTaskKey {
            agent_id: "opencode".into(),
            profile_id: "default".into(),
            runtime_epoch: "epoch-1".into(),
            vault_id: "vault-a".into(),
            session_id: "ses-1".into(),
            run_id: "run-0".into(),
        }
    }

    /// A feed with no store answers the ledger's own rules and nothing else: an ending pays once,
    /// and the same ending again pays nothing.
    #[test]
    fn an_ending_pays_once_and_a_replay_pays_nothing() {
        let care = CareFeed::in_memory();
        let key = key();
        let ending = [SettledTask {
            key: &key,
            state: PetTaskState::TurnFinished,
            at_ms: 1_789_000_000_000,
        }];

        care.settle(ending, Some(4_200));
        care.settle(ending, Some(4_200));

        let ledger = care.ledger();
        let ledger = ledger.lock().expect("the ledger's lock is fresh");
        let summary = ledger.summary();
        assert_eq!(
            summary.meals, 1,
            "one run is one meal, however often it is decided"
        );
        assert_eq!(summary.reported_tokens, Some(4_200));
        assert!(
            !care.read_only(),
            "a feed with no store has no file to be read-only about"
        );
    }

    /// A state that is not an ending reaches nobody — the case the feed cannot get wrong because
    /// settlement, not the feed, is what decides it.
    #[test]
    fn a_run_still_going_is_not_a_reward() {
        let care = CareFeed::in_memory();
        let key = key();
        care.settle(
            [SettledTask {
                key: &key,
                state: PetTaskState::Working,
                at_ms: 1_789_000_000_000,
            }],
            None,
        );

        let ledger = care.ledger();
        assert_eq!(
            ledger
                .lock()
                .expect("the ledger's lock is fresh")
                .revision(),
            0
        );
    }
}
