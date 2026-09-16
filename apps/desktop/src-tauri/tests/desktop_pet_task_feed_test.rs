//! R2's missing half — the host's tasks, as a pet window can finally read them.
//!
//! D4 delivered the projection and D12 reported the hole this file is about: `desktop_pet_tasks`
//! had no state behind it, so a window's subscription died on its first read and a pet that could
//! not see any work looked exactly like a pet with none. `PetTaskFeed` is that state, and these
//! cases are the ones that matter about it:
//!
//! - **A window reads the list**, in the shape D1 froze, after the facts a real host applies —
//!   an instance installed, a turn started, a permission raised, an answer given, a turn ended.
//! - **A push happens when, and only when, the list changed.** A replayed frame, a foreign
//!   instance's frame, a kind that says nothing about a task and a fact about a run that already
//!   ended are all answers the window already has; pushing for one of them would have it apply the
//!   same fact twice.
//! - **The record survives a push nobody heard.** The whole point of the ordering in `task_feed`:
//!   the projection is written first and the emit is best-effort, so the read is the truth. This
//!   is the reference rule `SessionArchiveStore.swift:51` states from the other end — what is
//!   durable is recorded before what is not — and the case below is what makes it an assertion
//!   rather than a comment.
//!
//! The frames are the host's own envelopes, constructed here field by field: the feed never
//! touches an engine, so a case builds exactly the frame it is about, including the ones a
//! well-behaved runtime would not send.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::json;

use nekowite_lib::agent_runtime::events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};
use nekowite_lib::desktop_pet::history::MarkOutcome;
use nekowite_lib::desktop_pet::notification_delivery::DeliveryFailure;
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
};
use nekowite_lib::desktop_pet::task_projection::{PetTaskState, SessionKey};
use nekowite_lib::desktop_pet::{
    DeliveryState, HistoryStore, NotificationDelivery, NotificationOutcome, NotificationPolicy,
    NotificationPreferences, PetNotice, PetTaskFeed, SaveOutcome, TaskHistory, TaskRecord,
    HISTORY_SCHEMA_VERSION, LEDGER_FILE, PET_TASKS_CHANNEL, UNREAD_MAX_AGE_MS,
};

const AGENT: &str = "opencode";
const PROFILE: &str = "default";
const VAULT: &str = "vault-a";
const SESSION: &str = "ses-1";

fn identity(epoch: &str) -> AgentIdentity {
    AgentIdentity {
        agent_id: AGENT.to_string(),
        profile_id: PROFILE.to_string(),
        runtime_epoch: epoch.to_string(),
        vault_id: VAULT.to_string(),
    }
}

fn envelope(
    identity: &AgentIdentity,
    run_id: Option<&str>,
    sequence: u64,
    kind: AgentEventKind,
    payload: serde_json::Value,
) -> AgentEventEnvelope {
    AgentEventEnvelope {
        agent_id: identity.agent_id.clone(),
        profile_id: identity.profile_id.clone(),
        runtime_epoch: identity.runtime_epoch.clone(),
        vault_id: identity.vault_id.clone(),
        session_id: SESSION.to_string(),
        run_id: run_id.map(str::to_string),
        sequence,
        kind,
        payload,
    }
}

/// A feed with one instance installed and one run in flight, as a prompt leaves it.
fn running() -> PetTaskFeed {
    let feed = PetTaskFeed::new();
    feed.install(&identity("epoch-1")).expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    feed
}

#[test]
fn a_window_reads_the_task_its_host_started() {
    let tasks = running().read().expect("the lock is fresh");

    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].key.run_id, "run-0");
    assert_eq!(tasks[0].key.session_id, SESSION);
    assert_eq!(tasks[0].state, PetTaskState::Working);
}

#[test]
fn a_push_happens_when_a_fact_changed_the_list() {
    let feed = running();

    let pushed = feed
        .apply(&envelope(
            &identity("epoch-1"),
            Some("run-0"),
            1,
            AgentEventKind::RunFinished,
            json!({ "stopReason": "end-turn" }),
        ))
        .expect("the lock is fresh");

    // The whole list, not a delta: a window that missed one frame is stale for a frame rather
    // than wrong for ever, and the first delivery needs no replay machinery.
    let tasks = pushed.expect("a run ending is a change");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].state, PetTaskState::TurnFinished);
}

#[test]
fn a_replayed_frame_is_not_pushed_twice() {
    let feed = running();
    let frame = envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::PermissionRequest,
        json!({ "requestId": "req-1" }),
    );

    assert!(
        feed.apply(&frame).expect("the lock is fresh").is_some(),
        "the first frame is news"
    );
    assert!(
        feed.apply(&frame).expect("the lock is fresh").is_none(),
        "the same sequence again is not: §6.3's 「重放去重」, one layer below the ledger"
    );
    // And the task is still the one the first frame left, with the request it was waiting on.
    let tasks = feed.read().expect("the lock is fresh");
    assert_eq!(tasks[0].state, PetTaskState::WaitingInput);
    assert_eq!(tasks[0].permission_request_id.as_deref(), Some("req-1"));
}

#[test]
fn a_frame_from_an_instance_this_host_never_started_is_not_pushed() {
    let feed = running();

    let pushed = feed
        .apply(&envelope(
            &identity("epoch-9"),
            Some("run-0"),
            1,
            AgentEventKind::RunFinished,
            json!({ "stopReason": "end-turn" }),
        ))
        .expect("the lock is fresh");

    assert!(pushed.is_none(), "a foreign instance's frame changes nothing");
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].state,
        PetTaskState::Working,
        "and the run it named is still running here"
    );
}

#[test]
fn an_ending_is_not_revived_and_is_not_pushed_as_one() {
    let feed = running();
    let finished = envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "end-turn" }),
    );
    assert!(feed.apply(&finished).expect("the lock is fresh").is_some());

    // A later *work* frame for the same run, with a sequence the host has not seen: only the
    // settled check can refuse it, and if that check were gone this would push a `working` task
    // over a run that had ended — the reminder lost, not duplicated.
    let pushed = feed
        .apply(&envelope(
            &identity("epoch-1"),
            Some("run-0"),
            2,
            AgentEventKind::PermissionRequest,
            json!({ "requestId": "req-2" }),
        ))
        .expect("the lock is fresh");
    assert!(pushed.is_none());
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].state,
        PetTaskState::TurnFinished
    );
}

#[test]
fn an_answer_releases_the_wait_and_is_pushed() {
    let feed = running();
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::PermissionRequest,
        json!({ "requestId": "req-1" }),
    ))
    .expect("the lock is fresh");

    let pushed = feed
        .answered(&identity("epoch-1"), SESSION, "req-1")
        .expect("the lock is fresh");

    let tasks = pushed.expect("the run stopped waiting on it");
    assert_eq!(tasks[0].state, PetTaskState::Working);
    assert_eq!(tasks[0].permission_request_id, None);

    // A second answer to the same request changes nothing: the task no longer holds it, and
    // §6.2's 「过期请求按钮不能继续操作」 is the same rule one layer up.
    assert!(feed
        .answered(&identity("epoch-1"), SESSION, "req-1")
        .expect("the lock is fresh")
        .is_none());
}

#[test]
fn an_answer_to_another_sessions_request_does_not_touch_this_task() {
    let feed = running();
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::PermissionRequest,
        json!({ "requestId": "req-1" }),
    ))
    .expect("the lock is fresh");

    let pushed = feed
        .answered(&identity("epoch-1"), "ses-other", "req-1")
        .expect("the lock is fresh");

    assert!(pushed.is_none());
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].state,
        PetTaskState::WaitingInput
    );
}

#[test]
fn stopping_the_instance_restates_what_it_was_running_and_pushes_it() {
    let feed = running();

    let pushed = feed.retire(&identity("epoch-1")).expect("the lock is fresh");

    let tasks = pushed.expect("a run in flight is restated");
    assert_eq!(tasks[0].state, PetTaskState::Interrupted);
}

#[test]
fn a_new_instance_restates_the_previous_ones_run() {
    let feed = running();

    // A restart is a new epoch for the same triple, which is proof the old incarnation is over
    // rather than a guess (`registry::LiveInstances::claim` refuses a second live one).
    let pushed = feed.install(&identity("epoch-2")).expect("the lock is fresh");

    let tasks = pushed.expect("the previous run cannot still be running");
    assert_eq!(tasks[0].state, PetTaskState::Interrupted);
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].key.runtime_epoch,
        "epoch-1",
        "the task keeps the epoch it ran under: it is the retired instance's record, and the new \
         one's frames will file under their own"
    );
}

#[test]
fn the_record_survives_a_push_that_nobody_heard() {
    // The ordering rule, made an assertion: the frame is applied to the projection before it is
    // ever published, so a window that was hidden, closed, or not yet mounted finds the task on
    // its next read. Nothing here can observe the emit (there is no app in this target), which is
    // exactly the case being asserted — a lost push must not be a lost task.
    let feed = running();
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "refusal" }),
    ))
    .expect("the lock is fresh");

    let read = feed.read().expect("the lock is fresh");
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].state, PetTaskState::Refused);
}

// --- §6.3's ledger, reached the way the app reaches it --------------------------------------------
//
// `notification_delivery.rs` takes its channel through a port (§10.2), and the cases below use that
// to substitute the one thing this machine cannot provide while leaving everything else real: the
// frame is a runtime frame, the projection is the one the app holds, the ledger is the one
// `PetTaskFeed::new` builds, and only the channel is a double. What they assert is the wiring —
// that a completion reaches a channel at all, that the switches decide, and that the row the user
// keeps is written before the channel is asked.

/// A channel that keeps what it was asked to show, and can be told to refuse.
#[derive(Clone, Default)]
struct Recording {
    state: Arc<Mutex<ChannelState>>,
}

#[derive(Default)]
struct ChannelState {
    notices: Vec<PetNotice>,
    /// Set when every delivery must fail, so the "nothing can show it" machine is reachable without
    /// inventing a different port.
    refusal: Option<DeliveryFailure>,
}

impl Recording {
    fn new() -> Self {
        Self::default()
    }

    fn refusing() -> Self {
        let channel = Self::new();
        channel.accepted_state().refusal = Some(DeliveryFailure::NoChannel {
            detail: "this machine has no notification daemon".to_string(),
        });
        channel
    }

    fn accepted_state(&self) -> std::sync::MutexGuard<'_, ChannelState> {
        self.state.lock().expect("the fake's lock is never held across a panic")
    }

    fn notices(&self) -> Vec<PetNotice> {
        self.accepted_state().notices.clone()
    }
}

impl NotificationDelivery for Recording {
    fn deliver(&mut self, notice: &PetNotice) -> Result<(), DeliveryFailure> {
        let mut state = self.accepted_state();
        if let Some(failure) = &state.refusal {
            return Err(failure.clone());
        }
        state.notices.push(notice.clone());
        Ok(())
    }
}

/// A feed whose ledger was given this channel and these switches.
fn feed_with(channel: &Recording, preferences: NotificationPreferences) -> PetTaskFeed {
    PetTaskFeed::with_notifications(NotificationPolicy::new(
        Box::new(channel.clone()),
        preferences,
        TaskHistory::new(),
    ))
}

/// A feed with one run in flight, as a prompt leaves it.
fn feed_running(channel: &Recording) -> PetTaskFeed {
    let feed = feed_with(channel, NotificationPreferences::default());
    feed.install(&identity("epoch-1")).expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    feed
}

/// One run ending, as the driver publishes it.
fn ending(feed: &PetTaskFeed, run: &str, sequence: u64) {
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some(run),
        sequence,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "end-turn" }),
    ))
    .expect("the lock is fresh");
}

/// The due time of the burst that is gathering, or a panic naming what is wrong.
fn due(feed: &PetTaskFeed) -> i64 {
    feed.notifications()
        .expect("the ledger's lock is fresh")
        .pending_due()
        .expect("a completion is gathering")
}

#[test]
fn a_completion_reaches_the_channel_and_the_row_says_so() {
    let channel = Recording::new();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);

    // §6.3 merges a burst of completions into one notice, so what goes out is what the window's
    // close produces — and the wake is the host's to make, so the test flushes at the ledger's own
    // due time rather than sleeping for it.
    let due = due(&feed);
    let outcome = feed
        .flush_notices(due)
        .expect("the lock is fresh")
        .expect("the burst was due");

    assert!(matches!(outcome, NotificationOutcome::Delivered(_)));
    let notices = channel.notices();
    assert_eq!(notices.len(), 1, "one completion is one notice");
    assert_eq!(notices[0].state, PetTaskState::TurnFinished);
    assert_eq!(
        notices[0]
            .target
            .as_ref()
            .map(|key| (key.session_id.as_str(), key.run_id.as_str())),
        Some((SESSION, "run-0")),
        "the notice names the run a click has to return to"
    );

    // And the user's own record of it, which is what survives a notice that nobody saw.
    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].delivery, DeliveryState::Delivered);
    assert!(rows[0].unread, "a notice the user has not looked at is still owed");
}

#[test]
fn a_delivery_that_failed_keeps_the_row_unread_and_says_so() {
    // §6.3's 先记录再投递, as an assertion rather than a comment. The row is written before the
    // channel is asked, so a channel that cannot show the notice loses the toast and never the fact
    // — and the failure is recorded rather than reported as a success. Written the other way round
    // (deliver, then record) this case fails on the first row assertion, which is the failure the
    // ordering exists to prevent: a task marked delivered but never shown is lost.
    let channel = Recording::refusing();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);

    let outcome = feed
        .flush_notices(due(&feed))
        .expect("the lock is fresh")
        .expect("the burst was due");

    let NotificationOutcome::DeliveryFailed { failure, .. } = &outcome else {
        panic!("a refusing channel cannot have delivered: {outcome:?}");
    };
    assert_eq!(failure.kind(), "no-channel");
    assert!(channel.notices().is_empty(), "nothing was shown");

    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1, "the row is what the user still has");
    assert_eq!(rows[0].delivery, DeliveryState::Failed);
    assert_eq!(rows[0].state, PetTaskState::TurnFinished);
    assert!(rows[0].unread, "a failed delivery is not a seen one");
}

#[test]
fn nothing_leaves_before_the_burst_window_closes() {
    let channel = Recording::new();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);
    let due = due(&feed);

    assert!(
        feed.flush_notices(due - 1)
            .expect("the lock is fresh")
            .is_none(),
        "the burst is still gathering"
    );
    assert!(channel.notices().is_empty());

    assert!(feed
        .flush_notices(due)
        .expect("the lock is fresh")
        .is_some());
    assert_eq!(channel.notices().len(), 1);
}

#[test]
fn the_switch_the_settings_page_writes_decides_the_notice() {
    // §5.2: a switch the page writes and nothing reads is a control that does nothing. The ledger is
    // what reads it, and this is that read reaching the user's own settings.
    let channel = Recording::new();
    let feed = feed_with(
        &channel,
        NotificationPreferences {
            on_turn_finished: false,
            ..NotificationPreferences::default()
        },
    );
    feed.install(&identity("epoch-1")).expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    ending(&feed, "run-0", 1);

    // Nothing is gathering to flush, and that is the switch working: the burst is dropped at the
    // channel check rather than held for a delivery that will never be asked for.
    assert_eq!(
        feed.notifications().expect("the ledger's lock is fresh").pending_due(),
        None
    );
    assert!(channel.notices().is_empty(), "the user asked not to be told");

    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1, "silence is not a lost task (§6.3's 未读)");
    assert_eq!(rows[0].delivery, DeliveryState::NotAttempted);
}

#[test]
fn a_burst_asks_the_host_for_one_wake_at_the_ledgers_own_due_time() {
    // The wake is how the host comes back when a burst closes, and it is a callback rather than a
    // tick: the feed has no timer, and one wake per burst is what keeps a burst of ends from being a
    // timer per end. The due time is the ledger's, so the host never keeps a second copy of the
    // coalescing window.
    let channel = Recording::new();
    let feed = feed_with(&channel, NotificationPreferences::default());
    let asked = Arc::new(Mutex::new(Vec::<i64>::new()));
    let sink = Arc::clone(&asked);
    feed.set_notice_waker(move |due_at_ms| sink.lock().expect("the lock is fresh").push(due_at_ms));

    feed.install(&identity("epoch-1")).expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-1")
        .expect("the lock is fresh");
    ending(&feed, "run-0", 1);
    let first = due(&feed);
    ending(&feed, "run-1", 2);

    assert_eq!(
        *asked.lock().expect("the lock is fresh"),
        vec![first],
        "two completions in one window are one notice, so the host is asked once"
    );

    // And the request is not sticky: a burst that is delivered, followed by another one, is asked
    // for again. The two due times can be equal — they are host milliseconds and this test runs in
    // less than one — which is the point: what is asked for is the ledger's number, whatever it is.
    feed.started(&identity("epoch-1"), SESSION, "run-2")
        .expect("the lock is fresh");
    feed.flush_notices(first).expect("the lock is fresh");
    ending(&feed, "run-2", 3);
    assert_eq!(*asked.lock().expect("the lock is fresh"), vec![first, due(&feed)]);
}

#[test]
fn a_run_the_runtime_left_behind_is_announced() {
    // `install`/`retire` restate what an incarnation was running as `interrupted`, and §6.2's last
    // row is a reminder rather than a silence: the work was cut off, and the user is told. The fact
    // comes off no stream — the host reports it — which is why the ledger is handed a zero sequence
    // rather than a number from a stream that has no frame for this.
    let channel = Recording::new();
    let feed = feed_running(&channel);

    feed.install(&identity("epoch-2")).expect("the lock is fresh");

    let notices = channel.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].state, PetTaskState::Interrupted);
    assert_eq!(
        notices[0].target.as_ref().map(|key| key.run_id.as_str()),
        Some("run-0")
    );

    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, PetTaskState::Interrupted);
    assert!(rows[0].unread);
}

#[test]
fn a_frame_the_window_already_has_is_not_a_fact_for_the_ledger() {
    // The dedup §6.3 asks for is the ledger's, but a *replayed* frame is a decision the projection
    // has already made — and the ledger must not be asked to take it again, because a second answer
    // to "is this news" is how one completion becomes two notices. Two frames here: the first is
    // news, the second is the same sequence again.
    let channel = Recording::new();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "end-turn" }),
    ))
    .expect("the lock is fresh");

    feed.flush_notices(due(&feed)).expect("the lock is fresh");

    assert_eq!(channel.notices().len(), 1, "one frame is one notice");
    assert_eq!(
        feed.notifications().expect("the ledger's lock is fresh").unread().len(),
        1
    );
}

#[test]
fn the_channel_name_is_the_contracts_own() {
    // One spelling, two layers: the window listens on this string (`tauri-pet.ts`'s
    // `PET_TASKS_CHANNEL`) and the host publishes on it. A rename on one side alone is a list that
    // is complete and never updates, so the literal is pinned here rather than left to drift.
    assert_eq!(PET_TASKS_CHANNEL, "pet-task");
}

// --- §6.3's 「重启读取已处理账本」: the ledger reaches a file, and comes back -------------------------

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
    feed.install(&identity("epoch-1")).expect("the lock is fresh");
    ending(&feed, "run-0", 1);
    let _ = feed.flush_notices(due(&feed)).expect("the ledger's lock is fresh");
    assert_eq!(channel.notices().len(), 1, "the notice went out");
    drop(feed);

    let (restarted, detail) = reopen(&channel, &data, 2_000);
    assert!(detail.is_empty(), "the ledger was read: {detail:?}");
    let unread = restarted.notifications().expect("the ledger's lock is fresh");
    assert_eq!(unread.unread().len(), 1, "the row the user never saw is back");
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
    let ledger = restarted.notifications().expect("the ledger's lock is fresh");
    let unread = ledger.unread();
    assert_eq!(unread.len(), 1, "{unread:?}");
    assert_eq!(unread[0].key.run_id, "run-new", "the row inside the bound is kept");
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
    assert!(loaded.dropped >= 1, "the drop is counted rather than silent");

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
    feed.install(&identity("epoch-1")).expect("the lock is fresh");
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
        loaded.detail.as_deref().is_some_and(|d| d.contains("newer") || d.contains("schema")),
        "the caller is told why nothing was restored: {:?}",
        loaded.detail
    );

    assert_eq!(
        store.save(&TaskHistory::new()).expect("a refusal is an answer"),
        SaveOutcome::ReadOnly
    );
    assert_eq!(stored_ledger(&data), future, "the future ledger is untouched");
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
    first.install(&identity("epoch-1")).expect("the lock is fresh");
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
    feed.install(&identity("epoch-1")).expect("the lock is fresh");
    ending(&feed, "run-1", 2);
    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    assert!(
        ledger.pending_due().is_none(),
        "the switch the page saved silences the burst"
    );
    assert_eq!(ledger.unread().len(), 2, "the ending is still recorded as unread");
}
