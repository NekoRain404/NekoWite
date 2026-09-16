//! 恢复: the ledger survives a restart, and the vocabulary it writes in is the contract's.
//!
//! §6.3 requires the pet to read a processed ledger after a restart, and the ledger's own note (§7.7)
//! says why it must be *this* ledger and not a re-read of a snapshot: D1 measured that a `completed`
//! snapshot carries no stop reason, so an ended run cannot be told apart from a turn that hit a
//! ceiling once it is only a snapshot. The mapping therefore happens when the event arrives and is
//! written down — and `encode`/`decode` is what makes "written down" mean anything across a restart.
//!
//! The last four cases read `pet-contracts/task.ts` and `pet-contracts/config.ts` rather than a copy
//! of either. D1 froze those vocabularies, and a second spelling is the one that drifts.

use crate::desktop_pet::history::{
    Decoded, DeliveryState, MarkOutcome, TaskHistory, TaskRecord, HISTORY_SCHEMA_VERSION,
    PET_TASK_STATES,
};
use crate::desktop_pet::notification_policy::{
    channel_for, NotificationPreferences, SilenceReason,
};
use crate::desktop_pet::task_projection::{PetTaskKey, PetTaskState};
use crate::support::{
    boolean_pairs, contract, delivered, identifiers, key, policy, quoted, quoted_pairs, session_of,
    silent, slice_after, slice_between, state_named, RecordingChannel, Stream,
};

fn record(history: &mut TaskHistory, task: &PetTaskKey, state: PetTaskState, at_ms: i64, unread: bool) {
    let _ = history.record(TaskRecord {
        key: task.clone(),
        state,
        permission_request_id: None,
        at_ms,
        delivery: DeliveryState::Delivered,
        unread,
    });
}

#[test]
fn a_row_holds_ids_and_a_state_and_nowhere_for_what_was_said() {
    let value = serde_json::to_value(TaskRecord {
        key: key("run-1"),
        state: PetTaskState::Failed,
        permission_request_id: None,
        at_ms: 1_000,
        delivery: DeliveryState::Delivered,
        unread: true,
    })
    .expect("a record of ids and states serialises");

    // §9's 「有限任务索引，不存聊天全文」 and §6.1's 「原始聊天内容、推理文本、凭据和工具完整输出不发给桌宠
    // 窗口」, as a shape rather than a promise: there is no field a prompt, a tool result or a note
    // title could be written into, so no later edit can start storing one by accident.
    let mut fields: Vec<&str> = value
        .as_object()
        .expect("a row is an object")
        .keys()
        .map(String::as_str)
        .collect();
    fields.sort();
    assert_eq!(fields, ["atMs", "delivery", "key", "state", "unread"]);

    // And the identity is the contract's tuple, field for field.
    let mut identity: Vec<&str> = value["key"]
        .as_object()
        .expect("the key is an object")
        .keys()
        .map(String::as_str)
        .collect();
    identity.sort();
    assert_eq!(
        identity,
        [
            "agentId",
            "profileId",
            "runId",
            "runtimeEpoch",
            "sessionId",
            "vaultId"
        ]
    );
}

#[test]
fn the_key_token_is_injective_where_a_join_by_colons_is_not() {
    let mut split_one_way = key("run-1");
    split_one_way.agent_id = "a:b".to_string();
    let mut split_another = key("run-1");
    split_another.agent_id = "a".to_string();
    split_another.profile_id = "b:default".to_string();

    let joined = |task: &PetTaskKey| {
        format!(
            "{}:{}:{}:{}:{}:{}",
            task.agent_id, task.profile_id, task.runtime_epoch, task.vault_id, task.session_id,
            task.run_id
        )
    };
    // §6.1: 「业务键用结构化元组或明确编码，不以未转义冒号拼接后做后缀匹配」. The collision below is why.
    assert_eq!(joined(&split_one_way), joined(&split_another));
    assert_ne!(split_one_way.token(), split_another.token());
}

#[test]
fn every_state_round_trips_through_the_name_it_is_written_with() {
    for name in PET_TASK_STATES {
        let state = state_named(name);
        assert_eq!(
            serde_json::to_string(&state).expect("a state serialises"),
            format!("\"{name}\"")
        );
    }
}

#[test]
fn the_bound_drops_the_oldest_row_the_user_has_seen() {
    let mut history = TaskHistory::with_capacity(2, 2);
    let seen = key("run-1");
    let unseen = key("run-2");
    let newest = key("run-3");

    record(&mut history, &seen, PetTaskState::Failed, 1_000, false);
    record(&mut history, &unseen, PetTaskState::Failed, 2_000, true);

    let evicted = history
        .record(TaskRecord {
            key: newest.clone(),
            state: PetTaskState::Failed,
            permission_request_id: None,
            at_ms: 3_000,
            delivery: DeliveryState::Delivered,
            unread: true,
        })
        .expect("the bound was reached");

    assert_eq!(evicted.key, seen);
    assert!(!evicted.was_unread, "there was something seen to drop instead");
    assert!(history.get(&seen).is_none());
    assert!(history.get(&unseen).is_some(), "an unseen row is not dropped for a seen one");
    assert!(history.get(&newest).is_some());
}

#[test]
fn when_every_row_is_unseen_the_eviction_is_reported() {
    let mut history = TaskHistory::with_capacity(2, 2);
    let first = key("run-1");
    let second = key("run-2");
    record(&mut history, &first, PetTaskState::Failed, 1_000, true);
    record(&mut history, &second, PetTaskState::Failed, 2_000, true);

    let evicted = history
        .record(TaskRecord {
            key: key("run-3"),
            state: PetTaskState::Failed,
            permission_request_id: None,
            at_ms: 3_000,
            delivery: DeliveryState::Delivered,
            unread: true,
        })
        .expect("the bound was reached");

    // §9 requires the index to be finite, so something has to go — and the one case where the bound
    // can cost the user a notice is the case that has to come back named.
    assert_eq!(evicted.key, first);
    assert!(evicted.was_unread);
}

#[test]
fn a_row_the_bound_had_to_drop_is_reported_by_the_ledger() {
    let channel = RecordingChannel::new();
    let mut policy = crate::support::restored(
        &channel,
        NotificationPreferences::default(),
        TaskHistory::with_capacity(1, 2),
    );
    let stream = Stream::new();
    let older = key("run-1");
    let newer = key("run-2");

    let _ = policy.observe(stream.at(&older, PetTaskState::Failed, 1_000));
    let _ = policy.observe(stream.at(&newer, PetTaskState::Failed, 2_000));

    // The index is finite (§9) and the one case where that can cost the user a notice is the case the
    // ledger has to name — so a diagnostics surface can say the pet dropped one, rather than the user
    // finding out by not being told.
    let dropped = policy.dropped_unread();
    assert_eq!(dropped.len(), 1);
    assert_eq!(dropped[0].key, older);
    assert!(dropped[0].was_unread);
    assert_eq!(
        channel.count(),
        2,
        "a notice going out is not the same fact as a row staying"
    );
}

#[test]
fn updating_a_key_evicts_nothing_and_never_clears_unread() {
    let mut history = TaskHistory::with_capacity(2, 2);
    let older = key("run-1");
    let task = key("run-2");
    record(&mut history, &older, PetTaskState::Failed, 1_000, true);
    record(&mut history, &task, PetTaskState::Unknown, 2_000, true);

    let evicted = history.record(TaskRecord {
        key: task.clone(),
        state: PetTaskState::Failed,
        permission_request_id: None,
        at_ms: 3_000,
        delivery: DeliveryState::NotAttempted,
        unread: false,
    });

    assert!(evicted.is_none(), "an update reuses a row rather than needing one");
    assert_eq!(history.len(), 2);
    let row = history.get(&task).expect("the row is there");
    assert_eq!(row.state, PetTaskState::Failed);
    assert!(
        row.unread,
        "the ending moved on; the notice the user has not looked at did not"
    );
}

#[test]
fn reading_is_the_only_thing_that_clears_unread() {
    let mut history = TaskHistory::with_capacity(4, 4);
    let task = key("run-1");
    record(&mut history, &task, PetTaskState::Failed, 1_000, true);

    assert_eq!(history.unread().len(), 1);
    assert!(history.mark_read(&task));
    assert!(history.unread().is_empty());

    // A row that moves on is unread again only if its new state is one the pet owes a look at —
    // which the policy decides when it writes the row, not this store.
    record(&mut history, &task, PetTaskState::TurnFinished, 2_000, true);
    assert_eq!(history.unread().len(), 1);
}

#[test]
fn a_restored_ledger_does_not_replay_what_it_already_announced() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000));
    assert_eq!(channel.count(), 1);

    // The restart: the ledger as bytes, read back by a new process.
    let stored = policy.history().encode();
    let Decoded::Restored(restored) = TaskHistory::decode(&stored, 200, 64) else {
        panic!("a ledger this build wrote has to be one it can read");
    };
    assert_eq!(restored.dropped, 0);

    let second_channel = RecordingChannel::new();
    let mut restarted =
        crate::support::restored(&second_channel, NotificationPreferences::default(), restored.history);

    // §6.3: 「在同次应用运行内，关开桌宠或重连不重复提醒；重启读取已处理账本」. The same ending, one frame
    // later on the same stream — what a remounting window would replay — is a duplicate rather than
    // a second notice, and the answer comes from the record rather than from the mark.
    let replay = restarted.observe(stream.at(&task, PetTaskState::Failed, 2_000));
    assert_eq!(silent(&replay), SilenceReason::Duplicate);
    assert_eq!(second_channel.count(), 0, "nothing is announced twice across a restart");

    // And a *new* ending after the restart is still announced: the restored ledger is a memory, not
    // a mute.
    let fresh = delivered(&restarted.observe(stream.at(&key("run-2"), PetTaskState::Failed, 3_000)));
    assert_eq!(fresh.state, PetTaskState::Failed);
    assert_eq!(second_channel.count(), 1);
}

#[test]
fn a_restored_ledger_keeps_the_unread_rows_and_what_happened_to_their_notices() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let waiting = key("run-1");

    let _ = policy.observe(stream.asking(&waiting, "req-1", 1_000));
    assert!(policy.mark_read(&key("run-1")));
    let _ = policy.observe(stream.at(&key("run-2"), PetTaskState::Failed, 2_000));

    let stored = policy.history().encode();
    let Decoded::Restored(restored) = TaskHistory::decode(&stored, 200, 64) else {
        panic!("readable");
    };
    let mut restarted = crate::support::restored(
        &RecordingChannel::new(),
        NotificationPreferences::default(),
        restored.history,
    );

    let unread = restarted.unread();
    assert_eq!(unread.len(), 1, "the row the user has not seen is the one that came back");
    assert_eq!(unread[0].key, key("run-2"));
    assert_eq!(unread[0].delivery, DeliveryState::Delivered);
    assert_eq!(
        restarted.history().get(&waiting).map(|row| row.delivery),
        Some(DeliveryState::Delivered),
        "what happened to a notice is part of what the ledger remembers"
    );
    assert!(restarted.mark_read(&key("run-2")));
    assert!(restarted.unread().is_empty());
}

#[test]
fn a_ledger_from_a_newer_schema_is_not_read_with_this_builds_defaults() {
    let mut history = TaskHistory::with_capacity(4, 4);
    record(&mut history, &key("run-1"), PetTaskState::Failed, 1_000, true);
    let stored = history.encode();
    let newer = stored.replace(
        &format!("\"version\":{HISTORY_SCHEMA_VERSION}"),
        &format!("\"version\":{}", HISTORY_SCHEMA_VERSION + 1),
    );
    assert_ne!(stored, newer, "the version field moved, so this test is about nothing");

    // §10.2's rule, in the direction that protects the user's data: a build that meets a record it
    // does not understand reports rather than reading the fields it recognises and writing back the
    // ones it filled in with defaults.
    match TaskHistory::decode(&newer, 200, 64) {
        Decoded::NewerSchema { found } => assert_eq!(found, HISTORY_SCHEMA_VERSION + 1),
        other => panic!("a newer schema must not be read as this one: {other:?}"),
    }
}

#[test]
fn an_unreadable_ledger_is_reported_rather_than_read_as_empty() {
    match TaskHistory::decode("not a ledger at all", 200, 64) {
        Decoded::Unreadable { detail } => assert!(!detail.is_empty(), "the report says nothing"),
        other => panic!("unreadable bytes are not a ledger: {other:?}"),
    }

    // The bound the caller inherits is stated rather than silent: dedup memory starts empty, so an
    // ending already announced may be announced again. The unread list is what remains.
    match TaskHistory::decode("", 200, 64) {
        Decoded::Unreadable { .. } => {}
        other => panic!("an empty file is not a ledger either: {other:?}"),
    }
}

#[test]
fn a_stored_ledger_longer_than_the_bound_is_truncated_from_the_old_end() {
    let mut stored = TaskHistory::with_capacity(5, 5);
    for index in 0..5 {
        record(
            &mut stored,
            &key(&format!("run-{index}")),
            PetTaskState::Failed,
            1_000 + index,
            true,
        );
    }

    let Decoded::Restored(restored) = TaskHistory::decode(&stored.encode(), 2, 2) else {
        panic!("readable");
    };

    // A size difference between builds is not amnesia: the newest rows are the ones kept, and how
    // many did not fit is reported rather than guessed at.
    assert_eq!(restored.dropped, 3);
    assert_eq!(restored.history.len(), 2);
    assert!(restored.history.get(&key("run-4")).is_some());
    assert!(restored.history.get(&key("run-0")).is_none());
}

#[test]
fn the_stream_mark_notices_a_gap_across_a_restart() {
    let mut history = TaskHistory::with_capacity(4, 4);
    let task = key("run-1");
    let session = session_of(&task);
    assert_eq!(history.observe_stream(&session, 1, 1_000), MarkOutcome::Fresh);
    assert_eq!(history.observe_stream(&session, 2, 1_100), MarkOutcome::Advanced);
    assert_eq!(history.observe_stream(&session, 2, 1_200), MarkOutcome::Replay);

    let Decoded::Restored(restored) = TaskHistory::decode(&history.encode(), 4, 4) else {
        panic!("readable");
    };
    let channel = RecordingChannel::new();
    let mut policy = crate::support::restored(
        &channel,
        NotificationPreferences::default(),
        restored.history,
    );

    // §6.3: 「崩溃空窗可能漏外部提示…测试并说明此边界」. The mark is what turns a restart from "the pet
    // does not know" into "the pet knows it was away, and by how much".
    let outcome = policy.observe(Stream::new().numbered(&task, PetTaskState::Failed, 6, 5_000));

    assert_eq!(delivered(&outcome).state, PetTaskState::Failed);
    assert_eq!(policy.gaps().len(), 1);
    assert_eq!(policy.gaps()[0].missed, 3, "frames 3, 4 and 5 are the ones nobody saw");
    assert_eq!(policy.gaps()[0].session, session);
}

#[test]
fn a_mark_from_another_incarnation_is_not_compared_against_this_one() {
    // A restarted runtime mints a new epoch and starts counting again, so its early frames must not
    // look like a replay of the previous runtime's.
    let mut history = TaskHistory::with_capacity(4, 4);
    let old = key("run-1");
    let mut new_runtime = key("run-1");
    new_runtime.runtime_epoch = "epoch-2".to_string();

    assert_eq!(
        history.observe_stream(&session_of(&old), 1, 1_000),
        MarkOutcome::Fresh
    );
    assert_eq!(
        history.observe_stream(&session_of(&new_runtime), 1, 2_000),
        MarkOutcome::Fresh,
        "a new incarnation's stream starts at the beginning, and that is not a repeat"
    );
}

// --- the frozen vocabularies ----------------------------------------------------------------------

#[test]
fn the_rust_states_are_the_typescript_ones() {
    let task = contract("pet-contracts/task.ts");
    let states = quoted(slice_between(&task, "PET_TASK_STATES = [", "] as const"));

    assert_eq!(states, PET_TASK_STATES.to_vec());
}

#[test]
fn the_quiet_states_are_the_ones_the_contract_calls_quiet() {
    let task = contract("pet-contracts/task.ts");
    let alerts = quoted_pairs(slice_between(&task, "PET_ALERT_BY_STATE", "\n}"));
    assert_eq!(alerts.len(), PET_TASK_STATES.len());

    // This is the pin the whole ledger hangs on: the contract's `quiet` is 「animate, do not
    // interrupt」, and it is what decides that a state produces neither a notice nor an unread row.
    // A state that becomes noisy on the TypeScript side fails here rather than going unnoticed.
    for (name, alert) in alerts {
        let state = state_named(&name);
        assert_eq!(
            channel_for(state).is_none(),
            alert == "quiet",
            "{name} is {alert} in the contract"
        );
    }
}

#[test]
fn the_settled_states_are_the_typescript_ones() {
    let task = contract("pet-contracts/task.ts");
    let settled = quoted(slice_between(
        &task,
        "export function isPetTaskSettled",
        "\n}",
    ));
    assert_eq!(settled.len(), 6);

    // §6.3's no-revival rule reads this predicate, so a state that becomes terminal on one side
    // alone would let a settled run be reported as live again.
    for name in PET_TASK_STATES {
        assert_eq!(
            state_named(name).is_settled(),
            settled.contains(&name.to_string()),
            "{name}"
        );
    }
}

#[test]
fn the_notification_switches_are_the_typescript_domain() {
    let config = contract("pet-contracts/config.ts");
    let fields = identifiers(slice_after(&config, "notification: {", 0, "\n  }"));
    let defaults = boolean_pairs(slice_after(&config, "notification: {", 1, "\n  }"));

    let shipped = serde_json::to_value(NotificationPreferences::default()).expect("serialises");
    let mut rust: Vec<String> = shipped
        .as_object()
        .expect("an object")
        .keys()
        .cloned()
        .collect();
    rust.sort();
    let mut typescript = fields.clone();
    typescript.sort();

    // A switch the settings page writes and this file does not read would be a control that does
    // nothing (§5.2), so the two lists are the same list.
    assert_eq!(rust, typescript);
    assert_eq!(defaults.len(), fields.len());
    for (name, value) in defaults {
        assert_eq!(
            shipped[&name],
            serde_json::json!(value),
            "{name} defaults differently in the settings page and in the ledger"
        );
    }
}

#[test]
fn every_channel_is_a_switch_the_settings_page_offers() {
    // The channels are this file's own vocabulary — four for nine states — so the check is that each
    // one has a field in D1's domain rather than that the two lists match.
    let config = contract("pet-contracts/config.ts");
    let fields = identifiers(slice_after(&config, "notification: {", 0, "\n  }"));
    for field in [
        "onTurnFinished",
        "onStopped",
        "onFailed",
        "onWaitingInput",
    ] {
        assert!(
            fields.contains(&field.to_string()),
            "{field} is not a switch the contract has: {fields:?}"
        );
        assert!(
            serde_json::to_value(NotificationPreferences::default())
                .expect("serialises")
                .get(field)
                .is_some(),
            "{field} has no field in the ledger's own preferences"
        );
    }
}
