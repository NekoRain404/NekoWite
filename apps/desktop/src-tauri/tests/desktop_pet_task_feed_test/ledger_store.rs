//! §6.3's 「重启读取已处理账本」: the ledger reaches a file, and comes back.
//!
//! This is the store half, and the read-back a restart is owed. The file is `ledger.json` under the
//! pet's own directory, with a schema latch that leaves a newer build's file alone and a save that
//! answers `Unchanged` rather than writing the same bytes again; what comes back is the row the user
//! still has to look at, the bound that drops one too old to be a reminder, and the sentences that
//! count what was lost rather than reporting it as a restart failure. The last case assembles the
//! feed the app starts with, because both of its inputs are files and building them here would cover
//! everything except the two reads that are the point.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::support::{due, ending, identity, Recording, AGENT, PROFILE, SESSION, VAULT};
use nekowite_lib::desktop_pet::history::{
    MarkOutcome, DEFAULT_MARK_CAPACITY, DEFAULT_RECORD_CAPACITY,
};
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
};
use nekowite_lib::desktop_pet::task_feed::loss_report;
use nekowite_lib::desktop_pet::task_projection::{PetTaskState, SessionKey};
use nekowite_lib::desktop_pet::{
    DeliveryState, HistoryStore, NotificationOutcome, NotificationPolicy, NotificationPreferences,
    PetTaskFeed, SaveOutcome, TaskHistory, TaskRecord, HISTORY_SCHEMA_VERSION, LEDGER_FILE,
    UNREAD_MAX_AGE_MS,
};

/// A data directory nothing else in the process is using.
///
/// Removed first and named after the test, so a leftover from a killed run cannot make the next one
/// pass — the convention the pet's settings and resource tests established. Nothing is planted in
/// the repository and nothing in the developer's own data directory is read or written.
fn data_dir(label: &str) -> PathBuf {
    let data = std::env::temp_dir().join(format!("nkw-pet-ledger-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).expect("a temporary data directory");
    data
}

/// A feed on a store that has read, which is every path the app takes.
///
/// The read is not optional and that is deliberate: a `HistoryStore` writes nothing until it has
/// loaded, because it cannot otherwise know whether the file it would replace belongs to a newer
/// build (§10.2). A test that skipped it would be testing a store the app never builds, so this is
/// the helper every case here goes through.
fn feed_on(channel: &Recording, store: HistoryStore, now_ms: i64) -> PetTaskFeed {
    let loaded = store.load(now_ms);
    PetTaskFeed::with_ledger(
        NotificationPolicy::new(
            Box::new(channel.clone()),
            NotificationPreferences::default(),
            loaded.history,
        ),
        Some(store),
    )
}

/// The ledger a restart reads: the file, put through the store's own rules.
fn reopen(channel: &Recording, data: &Path, now_ms: i64) -> (PetTaskFeed, Vec<String>) {
    let store = HistoryStore::new(data).expect("an absolute data directory is in scope");
    let detail = store.load(now_ms).detail.into_iter().collect();
    (feed_on(channel, store, now_ms), detail)
}

/// One session, as the ledger files its stream marks.
fn session() -> SessionKey {
    SessionKey {
        agent_id: AGENT.to_string(),
        profile_id: PROFILE.to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: VAULT.to_string(),
        session_id: SESSION.to_string(),
    }
}

fn ledger_path(data: &Path) -> PathBuf {
    data.join("desktop-pet").join(LEDGER_FILE)
}

fn stored_ledger(data: &Path) -> String {
    std::fs::read_to_string(ledger_path(data)).expect("the ledger was written")
}

/// The ending the user never looked at is on disk, and a restart finds it.
///
/// This is the whole of what 「重启读取已处理账本」 buys: the *dedup memory* cannot survive a restart
/// in any meaningful sense — a task's key carries the runtime epoch, and a restarted runtime is a
/// new one — so what the file is for is the row the user still owes a look at. A ledger that forgot
/// it would be a delivery mechanism with amnesia, which is the one thing §7.2's unread-list fallback
/// cannot be.
#[test]
fn an_ending_the_user_never_looked_at_survives_a_restart() {
    let data = data_dir("survives");
    let channel = Recording::new();
    let store = HistoryStore::new(&data).expect("an absolute data directory is in scope");
    assert_eq!(
        store.path(),
        ledger_path(&data),
        "the ledger lives beside the character library, inside the pet's own directory"
    );
    let feed = feed_on(&channel, store, 1_000);
    feed.install(&identity("epoch-1"))
        .expect("the lock is fresh");
    ending(&feed, "run-0", 1);
    let _ = feed
        .flush_notices(due(&feed))
        .expect("the ledger's lock is fresh");
    assert_eq!(channel.notices().len(), 1, "the notice went out");
    drop(feed);

    let (restarted, detail) = reopen(&channel, &data, 2_000);
    assert!(detail.is_empty(), "the ledger was read: {detail:?}");
    let unread = restarted
        .notifications()
        .expect("the ledger's lock is fresh");
    assert_eq!(
        unread.unread().len(),
        1,
        "the row the user never saw is back"
    );
    assert_eq!(unread.unread()[0].key.agent_id, AGENT);
    assert_eq!(
        unread.unread()[0].delivery,
        DeliveryState::Delivered,
        "how the notice went is part of what the row records"
    );
}

/// A reminder older than the bound does not come back, and the loss is counted rather than silent.
///
/// §6.3's unread list is not an archive: a row from before a night, a weekend or a holiday names a
/// session this process never had and work the user has moved past, so what it would be is a stale
/// notification dressed as a fresh one. The bound is a *policy* and lives in one constant, so the
/// alternative — persisting everything for ever — is the thing this case exists to refuse.
#[test]
fn a_reminder_older_than_the_bound_does_not_come_back() {
    let data = data_dir("ages-out");
    let now = 10 * UNREAD_MAX_AGE_MS;
    let mut history = TaskHistory::new();
    let key = |run: &str| nekowite_lib::desktop_pet::PetTaskKey {
        agent_id: AGENT.to_string(),
        profile_id: PROFILE.to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: VAULT.to_string(),
        session_id: SESSION.to_string(),
        run_id: run.to_string(),
    };
    let row = |run: &str, at_ms: i64| TaskRecord {
        key: key(run),
        state: PetTaskState::TurnFinished,
        permission_request_id: None,
        at_ms,
        delivery: DeliveryState::Failed,
        unread: true,
    };
    // One row just inside the bound and one just outside it, so the case fails if the rule is
    // dropped entirely as loudly as it fails if the rule drops everything.
    let _ = history.record(row("run-old", now - UNREAD_MAX_AGE_MS - 1));
    let _ = history.record(row("run-new", now - UNREAD_MAX_AGE_MS + 1));
    std::fs::create_dir_all(ledger_path(&data).parent().expect("a parent directory"))
        .expect("the ledger's directory");
    std::fs::write(ledger_path(&data), history.encode()).expect("the ledger is written");

    let channel = Recording::new();
    let (restarted, _) = reopen(&channel, &data, now);
    let ledger = restarted
        .notifications()
        .expect("the ledger's lock is fresh");
    let unread = ledger.unread();
    assert_eq!(unread.len(), 1, "{unread:?}");
    assert_eq!(
        unread[0].key.run_id, "run-new",
        "the row inside the bound is kept"
    );
}

/// The sentences about a lost reminder count rows, name the bound that dropped them, and say one row
/// as one row.
///
/// The app prints these lines at startup, so they are the one place a user is told that something
/// they were going to be shown is gone — which makes them the worst place in this feature to be
/// wrong. They were wrong twice. The count was rows + aged-out rows + *stream marks*, and a ledger
/// whose only missing entries were marks was announced as 「2 rows … did not survive the restart」 on
/// this machine (the marks were the two sessions the previous instance had watched); and a single row
/// was announced as 「1 rows」, which a log from the real-window harness shows. Then the count was
/// still two row-shaped causes under the one sentence, so a row the *age* rule had let go — read back
/// perfectly, then dropped on purpose — was announced as a restart failure, which is a bug report
/// about a data loss that never happened. Every arm is asserted here, from the store's own read
/// rather than from a number handed to the formatter.
#[test]
fn the_loss_sentences_count_rows_and_name_the_bound_that_dropped_them() {
    let row = |run: &str, at_ms: i64| TaskRecord {
        key: nekowite_lib::desktop_pet::PetTaskKey {
            agent_id: AGENT.to_string(),
            profile_id: PROFILE.to_string(),
            runtime_epoch: "epoch-1".to_string(),
            vault_id: VAULT.to_string(),
            session_id: SESSION.to_string(),
            run_id: run.to_string(),
        },
        state: PetTaskState::TurnFinished,
        permission_request_id: None,
        at_ms,
        delivery: DeliveryState::Failed,
        unread: true,
    };
    let now = 10 * UNREAD_MAX_AGE_MS;
    let write = |data: &Path, history: &TaskHistory| {
        std::fs::create_dir_all(ledger_path(data).parent().expect("a parent directory"))
            .expect("the ledger's directory");
        std::fs::write(ledger_path(data), history.encode()).expect("the ledger is written");
        HistoryStore::new(data)
            .expect("an absolute data directory is in scope")
            .load(now)
    };

    // A ledger whose only missing entry is a stream mark: nothing the user was going to see was
    // lost, so the app owes them no sentence about rows at all.
    let data = data_dir("report-marks-only");
    let mut marks_only = TaskHistory::new();
    assert_eq!(
        marks_only.observe_stream(&session(), 3, 1_000),
        MarkOutcome::Fresh
    );
    let loaded = write(&data, &marks_only);
    assert_eq!(loaded.forgotten_marks, 1, "the mark was forgotten");
    assert!(
        loss_report(&loaded).is_empty(),
        "a forgotten mark is not a lost reminder, and the app must not say it is"
    );

    // One row too old to be a reminder: dropped by the age bound, and the sentence says so. It is
    // not a restart failure — the row was read back and then let go — so the sentence may not say
    // that, and may not be silent either.
    let data = data_dir("report-one-aged");
    let mut one_aged = TaskHistory::new();
    let _ = one_aged.record(row("run-old", now - UNREAD_MAX_AGE_MS - 1));
    let loaded = write(&data, &one_aged);
    assert_eq!((loaded.dropped_records, loaded.aged_out_rows), (0, 1));
    assert_eq!(
        loss_report(&loaded),
        vec![
            "nekowite: 1 unread reminder was dropped on load, older than the day a reminder is \
             still worth showing"
        ],
        "the row was read and then aged out, which is what the sentence has to say"
    );

    // And two, so the plural arm is measured rather than assumed from a suffix rule.
    let data = data_dir("report-two-aged");
    let mut two_aged = TaskHistory::new();
    let _ = two_aged.record(row("run-old-a", now - UNREAD_MAX_AGE_MS - 1));
    let _ = two_aged.record(row("run-old-b", now - UNREAD_MAX_AGE_MS - 2));
    let loaded = write(&data, &two_aged);
    assert_eq!((loaded.dropped_records, loaded.aged_out_rows), (0, 2));
    assert_eq!(
        loss_report(&loaded),
        vec![
            "nekowite: 2 unread reminders were dropped on load, older than the day a reminder is \
             still worth showing"
        ]
    );

    // A ledger longer than the bound this build reads with: `decode` keeps the newest 200 and the
    // rest never become rows. That is the other cause — bytes that were there and could not be
    // kept — and it keeps the sentence it has always had, both arms of the plural.
    //
    // The rows the reader cannot keep go at the *front*, because that is the end `decode` drops
    // from; a row that is to age out instead has to survive the read to reach the age rule, so it
    // goes last.
    let over_bound = |label: &str, ancient: usize, aged: bool| {
        let data = data_dir(label);
        let mut history =
            TaskHistory::with_capacity(DEFAULT_RECORD_CAPACITY + ancient, DEFAULT_MARK_CAPACITY);
        for index in 0..ancient {
            let _ = history.record(row(
                &format!("run-dropped-{index}"),
                now - 3 * UNREAD_MAX_AGE_MS,
            ));
        }
        for index in 0..(DEFAULT_RECORD_CAPACITY - usize::from(aged)) {
            let _ = history.record(row(
                &format!("run-fresh-{index}"),
                now - 1_000 + index as i64,
            ));
        }
        if aged {
            let _ = history.record(row("run-aged", now - UNREAD_MAX_AGE_MS - 1));
        }
        write(&data, &history)
    };

    let loaded = over_bound("report-over-bound", 1, false);
    assert_eq!((loaded.dropped_records, loaded.aged_out_rows), (1, 0));
    assert_eq!(
        loss_report(&loaded),
        vec!["nekowite: 1 row of the pet's reminder ledger did not survive the restart"],
        "one row is one row — the line this replaced read `1 rows`"
    );

    // Both causes in one read: two sentences, and a reader who sees both can tell which bound cost
    // them what. The maintainer's own ledger produced the *second* of these alone — one row, read
    // back and then aged out — which is the reading this split exists to get right, and which the
    // one sentence used to report as a restart failure.
    let loaded = over_bound("report-both-causes", 2, true);
    assert_eq!((loaded.dropped_records, loaded.aged_out_rows), (2, 1));
    assert_eq!(
        loss_report(&loaded),
        vec![
            "nekowite: 2 rows of the pet's reminder ledger did not survive the restart",
            "nekowite: 1 unread reminder was dropped on load, older than the day a reminder is \
             still worth showing"
        ]
    );
}

/// A mark written by a previous run is not a mark.
///
/// The failure this refuses is the one that would be invisible: `runtime_epoch` carries the process
/// id, so a restarted runtime's frames carry a new epoch and no restored mark can match them — but a
/// *recycled* process id would produce the same epoch, and a mark from the last run would then make
/// this run's first frames look like replays. A replay is silenced by the ledger, so the cost would
/// be the reminder itself: the user would be told nothing and nothing would say why.
#[test]
fn a_mark_from_a_previous_run_does_not_swallow_this_runs_ending() {
    let data = data_dir("forget-marks");
    let now = 10 * UNREAD_MAX_AGE_MS;

    // The ledger a killed run left: the session's stream was at seven, and no row had been written.
    let mut history = TaskHistory::new();
    assert_eq!(
        history.observe_stream(&session(), 7, 1_000),
        MarkOutcome::Fresh,
        "the first frame of a stream is fresh"
    );
    std::fs::create_dir_all(ledger_path(&data).parent().expect("a parent directory"))
        .expect("the ledger's directory");
    std::fs::write(ledger_path(&data), history.encode()).expect("the ledger is written");

    let channel = Recording::new();
    let store = HistoryStore::new(&data).expect("an absolute data directory is in scope");
    let loaded = store.load(now);
    let mut restored = loaded.history.clone();
    assert_eq!(
        restored.observe_stream(&session(), 1, 2_000),
        MarkOutcome::Fresh,
        "a mark from another process is not a mark"
    );
    // Counted, and counted as what it is: a mark was forgotten — and **nothing the user could miss
    // was lost**, which is the distinction the app's own startup sentence depends on. The two
    // counts were one number once, and the sum reached a line that said "rows … did not survive":
    // this ledger holds no rows at all, so that sentence would have been false about a file whose
    // only missing entry was a stream position.
    assert_eq!(
        loaded.forgotten_marks, 1,
        "the mark the previous run left is forgotten rather than carried"
    );
    assert_eq!(
        (loaded.dropped_records, loaded.aged_out_rows),
        (0, 0),
        "a forgotten mark is not a row, so neither row count has anything to report here"
    );

    // And the same through the feed, which is where it matters: the ending this run produces at
    // sequence one is news, is recorded, and is announced.
    let feed = PetTaskFeed::with_ledger(
        NotificationPolicy::new(
            Box::new(channel.clone()),
            NotificationPreferences::default(),
            loaded.history,
        ),
        Some(store),
    );
    feed.install(&identity("epoch-1"))
        .expect("the lock is fresh");
    ending(&feed, "run-0", 1);
    let notice = feed
        .flush_notices(due(&feed))
        .expect("the ledger's lock is fresh")
        .expect("the ending's burst was due");
    assert!(
        matches!(notice, NotificationOutcome::Delivered(_)),
        "the ending reached the channel rather than being read as a replay: {notice:?}"
    );
    assert_eq!(channel.notices().len(), 1);
}

/// A ledger a newer build wrote is left alone, and this build says so.
///
/// §10.2's rule, and it has to be a latch rather than a check at write time: a build that read a
/// future ledger as "this version, with defaults for anything I did not recognise" would write that
/// reading back on its first ending and destroy whatever the newer build meant by it.
#[test]
fn a_ledger_a_newer_build_wrote_is_read_only() {
    let data = data_dir("newer-schema");
    std::fs::create_dir_all(ledger_path(&data).parent().expect("a parent directory"))
        .expect("the ledger's directory");
    let future = format!(
        "{{\"version\": {}, \"records\": [], \"marks\": []}}",
        HISTORY_SCHEMA_VERSION + 1
    );
    std::fs::write(ledger_path(&data), &future).expect("the ledger is written");

    let store = HistoryStore::new(&data).expect("an absolute data directory is in scope");
    let loaded = store.load(0);
    assert!(loaded.history.is_empty());
    assert!(
        loaded
            .detail
            .as_deref()
            .is_some_and(|d| d.contains("newer") || d.contains("schema")),
        "the caller is told why nothing was restored: {:?}",
        loaded.detail
    );

    assert_eq!(
        store
            .save(&TaskHistory::new())
            .expect("a refusal is an answer"),
        SaveOutcome::ReadOnly
    );
    assert_eq!(
        stored_ledger(&data),
        future,
        "the future ledger is untouched"
    );
}

/// A ledger that did not change is not written again.
///
/// The save is called from the driver's task for every applied fact, and most facts change no row —
/// a permission asked and answered, a run restored — so the comparison is what keeps a file write
/// off the frame path. Stated as a case because it is a decision and not an optimisation detail: the
/// three arms are three different answers, and a store that answered `Written` for an unchanged
/// ledger would make the count meaningless.
#[test]
fn a_ledger_that_did_not_change_is_not_written_again() {
    let data = data_dir("unchanged");
    let store = HistoryStore::new(&data).expect("an absolute data directory is in scope");
    // Read first, as every path the app takes does. A store that has read nothing writes nothing:
    // it cannot know whether the file it would replace belongs to a newer build, and the safe
    // answer to "I do not know" is the one §10.2 gives.
    assert!(
        store.load(0).history.is_empty(),
        "a fresh directory holds no ledger"
    );
    let mut history = TaskHistory::new();
    assert_eq!(
        store.save(&history).expect("the first write"),
        SaveOutcome::Written
    );
    assert_eq!(
        store.save(&history).expect("the second write"),
        SaveOutcome::Unchanged
    );

    let _ = history.record(TaskRecord {
        key: nekowite_lib::desktop_pet::PetTaskKey {
            agent_id: AGENT.to_string(),
            profile_id: PROFILE.to_string(),
            runtime_epoch: "epoch-1".to_string(),
            vault_id: VAULT.to_string(),
            session_id: SESSION.to_string(),
            run_id: "run-0".to_string(),
        },
        state: PetTaskState::TurnFinished,
        permission_request_id: None,
        at_ms: 1_000,
        delivery: DeliveryState::Failed,
        unread: true,
    });
    assert_eq!(
        store.save(&history).expect("the third write"),
        SaveOutcome::Written,
        "a row that changed the ledger is written out"
    );
}

/// The feed the app starts with, assembled the way the app assembles it.
///
/// This is the startup half of the reminder path, and both of its inputs are files: the switches the
/// notification page last saved, and the rows the last run left. The case drives
/// `PetTaskFeed::for_app` on a data directory rather than a hand-built policy, because assembling
/// the policy in the test would cover everything except the two reads that are the point.
#[test]
fn the_feed_the_app_starts_with_reads_its_switches_and_its_ledger() {
    let data = data_dir("for-app");
    let channel = Recording::new();
    let store = HistoryStore::new(&data).expect("an absolute data directory is in scope");
    let first = feed_on(&channel, store, 1_000);
    first
        .install(&identity("epoch-1"))
        .expect("the lock is fresh");
    ending(&first, "run-0", 1);
    drop(first);

    // The switch the user turned off in the page, written through the store that page writes to —
    // the whole domain, which is what a settings page submits (§5.3 refuses a partial one).
    let mut switches = defaults(PetSettingsDomain::Notification);
    switches.insert("onTurnFinished".to_string(), json!(false));
    let settings = PetSettingsStore::new(&data).expect("an absolute data directory is in scope");
    let applied = settings.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Notification,
        revision: 0.0,
        values: serde_json::Value::Object(switches),
    });
    assert!(
        matches!(applied, PetSettingsUpdate::Applied { .. }),
        "{applied:?}"
    );

    let feed = PetTaskFeed::for_app(&data, 2_000);
    assert_eq!(
        feed.notifications()
            .expect("the ledger's lock is fresh")
            .unread()
            .len(),
        1,
        "the row the last run left is back"
    );

    // And the switch is the one this process decides by — which is only visible in what the ledger
    // does with the next ending: the row is still written, and no notice is attempted.
    feed.install(&identity("epoch-1"))
        .expect("the lock is fresh");
    ending(&feed, "run-1", 2);
    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    assert!(
        ledger.pending_due().is_none(),
        "the switch the page saved silences the burst"
    );
    assert_eq!(
        ledger.unread().len(),
        2,
        "the ending is still recorded as unread"
    );
}
