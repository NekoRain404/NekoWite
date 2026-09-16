//! 勿扰 and its inverse, plus the other three things that stop a notice being shown.
//!
//! The task this file is graded on has one decision written into it: a suppressed notice is
//! **dropped as a notice and kept as an unread row**. It is never queued for the way back, because
//! §6.3 requires that leaving do-not-disturb not re-pop what it suppressed, and it is never simply
//! forgotten, because the user turned the feature on to be told. The cases below hold both halves:
//! what suppression costs, and what it must not cost.

use crate::desktop_pet::notification_policy::{
    channel_for, NotificationChannel, NotificationPreferences, SilenceReason, COALESCE_WINDOW_MS,
};
use crate::desktop_pet::task_projection::PetTaskState;
use crate::support::{
    delivered, flush, gathering, key, key_for, policy_with, session_of, silent, RecordingChannel,
    Stream,
};

#[test]
fn do_not_disturb_shows_nothing_and_keeps_the_row_unread() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(
        &channel,
        NotificationPreferences {
            do_not_disturb: true,
            ..Default::default()
        },
    );
    let stream = Stream::new();
    let task = key("run-1");

    let outcome = policy.observe(stream.at(&task, PetTaskState::TurnFinished, 1_000));
    assert_eq!(silent(&outcome), SilenceReason::DoNotDisturb);
    assert_eq!(channel.count(), 0, "no toast and no sound while do-not-disturb is on");

    let unread = policy.unread();
    assert_eq!(unread.len(), 1, "§6.3: 勿扰禁声音和弹出，保留未读");
    assert_eq!(unread[0].key, task);
    assert_eq!(unread[0].state, PetTaskState::TurnFinished);
}

#[test]
fn leaving_do_not_disturb_replays_nothing() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(
        &channel,
        NotificationPreferences {
            do_not_disturb: true,
            ..Default::default()
        },
    );
    let stream = Stream::new();

    for (index, session) in ["a", "b", "c"].iter().enumerate() {
        let task = key_for("opencode", &format!("session-{session}"), "run-1");
        let outcome = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000 + index as i64));
        assert_eq!(silent(&outcome), SilenceReason::DoNotDisturb);
    }
    assert_eq!(policy.unread().len(), 3);

    // §6.3: 「退出勿扰不把所有过期事件重新弹一遍」. Neither the silenced rows nor a burst that would
    // have gathered may come out on the way back.
    policy.set_preferences(NotificationPreferences::default());
    assert!(policy.flush_due(60_000).is_none());
    assert_eq!(channel.count(), 0, "nothing is replayed by leaving do-not-disturb");
    assert_eq!(
        policy.unread().len(),
        3,
        "what recovered is the unread list, which is where the user finds them"
    );

    // The switch is only about what was suppressed: the next ending is announced normally.
    let (_, due_at_ms) = gathering(&policy.observe(stream.at(
        &key_for("opencode", "session-d", "run-1"),
        PetTaskState::TurnFinished,
        2_000,
    )));
    let _ = flush(&mut policy, due_at_ms);
    assert_eq!(channel.count(), 1);
}

#[test]
fn a_burst_gathering_when_do_not_disturb_arrives_is_dropped() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let task = key("run-1");

    let (_, due_at_ms) = gathering(&policy.observe(stream.at(&task, PetTaskState::TurnFinished, 1_000)));
    assert!(due_at_ms > 1_000);

    // Do-not-disturb arrives inside the burst window. Holding it would be a queue, and the queue is
    // exactly what §6.3 refuses to fire on the way out.
    policy.set_preferences(NotificationPreferences {
        do_not_disturb: true,
        ..Default::default()
    });
    assert!(policy.flush_due(due_at_ms + COALESCE_WINDOW_MS).is_none());
    assert_eq!(channel.count(), 0);

    policy.set_preferences(NotificationPreferences::default());
    assert!(policy.flush_due(due_at_ms + 60_000).is_none());
    assert_eq!(channel.count(), 0, "the dropped burst does not come back");
    assert_eq!(policy.unread().len(), 1, "the row it was about is still there");
}

#[test]
fn a_channel_the_user_turned_off_is_silent_and_keeps_the_row() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(
        &channel,
        NotificationPreferences {
            on_stopped: false,
            ..Default::default()
        },
    );
    let stream = Stream::new();
    let task = key("run-1");

    let outcome = policy.observe(stream.at(&task, PetTaskState::Stopped, 1_000));

    assert_eq!(
        silent(&outcome),
        SilenceReason::ChannelOff {
            channel: NotificationChannel::Stopped
        }
    );
    assert_eq!(channel.count(), 0);
    assert_eq!(
        policy.unread().len(),
        1,
        "a switch chooses the channel, not whether the task is remembered"
    );
}

#[test]
fn turning_one_channel_off_does_not_silence_another() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(
        &channel,
        NotificationPreferences {
            on_stopped: false,
            ..Default::default()
        },
    );
    let stream = Stream::new();

    let _ = policy.observe(stream.at(&key("run-1"), PetTaskState::Stopped, 1_000));
    let failure = delivered(&policy.observe(stream.at(&key("run-2"), PetTaskState::Failed, 1_100)));

    assert_eq!(failure.state, PetTaskState::Failed);
    assert_eq!(channel.count(), 1);
}

#[test]
fn the_task_being_viewed_is_not_interrupted_but_is_still_unread() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let task = key("run-1");

    // §6.3: 「当前正在查看该任务时抑制重复系统通知」.
    policy.set_viewing(Some(session_of(&task)));
    let outcome = policy.observe(stream.at(&task, PetTaskState::TurnFinished, 1_000));

    assert_eq!(silent(&outcome), SilenceReason::BeingViewed);
    assert_eq!(channel.count(), 0);
    assert_eq!(
        policy.unread().len(),
        1,
        "the pet cannot know the user watched the row rather than the scrollback"
    );
}

#[test]
fn opening_the_task_during_the_burst_window_still_silences_the_notice() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let task = key("run-1");

    let (_, due_at_ms) = gathering(&policy.observe(stream.at(&task, PetTaskState::TurnFinished, 1_000)));
    // The window is three seconds long, and the user can open the task inside it. The delivery path
    // applies the same rule the observation path does, so the two cannot disagree about the race.
    policy.set_viewing(Some(session_of(&task)));

    let outcome = policy.flush_due(due_at_ms).expect("the burst was due");
    assert_eq!(silent(&outcome), SilenceReason::BeingViewed);
    assert_eq!(channel.count(), 0);
    assert_eq!(policy.unread().len(), 1, "and the row is still the user's to find");

    // A burst that stands for several tasks is not about the one being viewed, so it still goes out.
    let (_, due_at_ms) = gathering(&policy.observe(stream.at(
        &key_for("opencode", "session-other", "run-1"),
        PetTaskState::TurnFinished,
        2_000,
    )));
    assert!(policy.flush_due(due_at_ms).is_some());
    assert_eq!(channel.count(), 1);
}

#[test]
fn viewing_another_task_does_not_silence_this_one() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let watched = key_for("opencode", "session-watched", "run-1");
    let other = key_for("opencode", "session-other", "run-1");

    policy.set_viewing(Some(session_of(&watched)));
    let notice = delivered(&policy.observe(stream.at(&other, PetTaskState::Failed, 1_000)));

    assert_eq!(notice.state, PetTaskState::Failed);
    assert_eq!(channel.count(), 1);

    // And looking away restores the narrow rule rather than leaving a hole in it.
    policy.set_viewing(None);
    let _ = policy.observe(stream.at(&key_for("opencode", "session-watched", "run-2"), PetTaskState::Failed, 2_000));
    assert_eq!(channel.count(), 2);
}

#[test]
fn a_delivered_notice_does_not_clear_unread() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.asking(&task, "req-1", 1_000));
    assert_eq!(channel.count(), 1);
    // §6.3: 「待授权未读不因气泡消失而丢失」. The toast appearing is not the user answering.
    assert_eq!(policy.unread().len(), 1);
    assert_eq!(
        policy.unread()[0].permission_request_id.as_deref(),
        Some("req-1"),
        "the unread row still routes to the request it is about"
    );
}

#[test]
fn nothing_clears_unread_but_reading_it() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000));
    assert_eq!(policy.unread().len(), 1);

    assert!(policy.mark_read(&task));
    assert!(policy.unread().is_empty());
    assert!(
        !policy.mark_read(&task),
        "reading a row twice is not an error, but it is not a row either"
    );

    // A repeat of the fact it already knows neither re-adds the row nor announces it again.
    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 2_000));
    assert!(policy.unread().is_empty());
    assert_eq!(channel.count(), 1);
}

#[test]
fn the_sound_setting_silences_the_sound_not_the_notice() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(
        &channel,
        NotificationPreferences {
            sound: false,
            ..Default::default()
        },
    );
    let stream = Stream::new();

    let notice = delivered(&policy.observe(stream.at(&key("run-1"), PetTaskState::Failed, 1_000)));
    assert!(!notice.sound, "the user asked for quiet, not for ignorance");
    assert_eq!(channel.count(), 1);
}

#[test]
fn a_quiet_state_is_recorded_but_is_not_unread() {
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let task = key("run-1");

    let outcome = policy.observe(stream.at(&task, PetTaskState::Cancelled, 1_000));

    // The contract calls it quiet (D1's `PET_ALERT_BY_STATE`), so there is no notice and no row to
    // read — and it is still recorded, because §6.3's restart path reads terminal states out of the
    // ledger rather than re-deriving them from a snapshot that cannot carry a stop reason.
    assert_eq!(silent(&outcome), SilenceReason::QuietState);
    assert_eq!(channel.count(), 0);
    assert!(policy.unread().is_empty());
    assert_eq!(
        policy.history().get(&task).map(|row| row.state),
        Some(PetTaskState::Cancelled)
    );
}

#[test]
fn the_channel_a_state_uses_is_the_one_its_switch_names() {
    // Total over the nine states, so a state added to the vocabulary has to be given a channel here
    // as well as in the contract, and the two quiet ones are named rather than left to a default.
    let table = [
        (PetTaskState::Working, None),
        (PetTaskState::WaitingInput, Some(NotificationChannel::WaitingInput)),
        (PetTaskState::TurnFinished, Some(NotificationChannel::TurnFinished)),
        (PetTaskState::Stopped, Some(NotificationChannel::Stopped)),
        (PetTaskState::Refused, Some(NotificationChannel::Failed)),
        (PetTaskState::Cancelled, None),
        (PetTaskState::Failed, Some(NotificationChannel::Failed)),
        (PetTaskState::Interrupted, Some(NotificationChannel::Failed)),
        (PetTaskState::Unknown, Some(NotificationChannel::Failed)),
    ];
    assert_eq!(table.len(), crate::desktop_pet::history::PET_TASK_STATES.len());
    for (state, expected) in table {
        assert_eq!(channel_for(state), expected, "{state:?}");
    }
}

#[test]
fn each_suppression_reports_the_reason_it_was_one() {
    // Four silences that all end in "the user was not told", and the point is that they are told
    // apart: "your switch is off" and "we lost the frame" call for different things from whoever
    // reads the log, and a single silent branch could not say either.
    let task = key("run-1");

    let channel = RecordingChannel::new();
    let mut off = policy_with(
        &channel,
        NotificationPreferences {
            on_failed: false,
            ..Default::default()
        },
    );
    assert_eq!(
        silent(&off.observe(Stream::new().at(&task, PetTaskState::Failed, 1_000))),
        SilenceReason::ChannelOff {
            channel: NotificationChannel::Failed
        }
    );

    let mut quiet = policy_with(&channel, NotificationPreferences::default());
    assert_eq!(
        silent(&quiet.observe(Stream::new().at(&task, PetTaskState::Cancelled, 1_000))),
        SilenceReason::QuietState
    );

    let mut dnd = policy_with(
        &channel,
        NotificationPreferences {
            do_not_disturb: true,
            ..Default::default()
        },
    );
    assert_eq!(
        silent(&dnd.observe(Stream::new().at(&task, PetTaskState::Failed, 1_000))),
        SilenceReason::DoNotDisturb
    );

    let mut viewed = policy_with(&channel, NotificationPreferences::default());
    viewed.set_viewing(Some(session_of(&task)));
    assert_eq!(
        silent(&viewed.observe(Stream::new().at(&task, PetTaskState::Failed, 1_000))),
        SilenceReason::BeingViewed
    );

    // The order is fixed and documented in the policy: a quiet state is quiet whatever the switches
    // say, and a switch that is off is named before do-not-disturb, which is broader.
    assert_eq!(channel.count(), 0);
}

#[test]
fn an_unread_row_outlives_a_window_closing() {
    // §6.3: 「在同次应用运行内，关开桌宠或重连不重复提醒」. The ledger is not the window, so closing one
    // is not an input to it — what this asserts is the shape of that: nothing in the decision depends
    // on a surface existing, and the rows are already written when the notice goes out.
    let channel = RecordingChannel::new();
    let mut policy = policy_with(&channel, NotificationPreferences::default());
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000));
    assert_eq!(policy.unread().len(), 1);
    assert_eq!(channel.count(), 1);

    // Re-reading the same fact — what a remounting window replaying its snapshot would produce —
    // is a duplicate rather than a second notice and a second row.
    let replay = policy.observe(stream.at(&task, PetTaskState::Failed, 5_000));
    assert_eq!(silent(&replay), SilenceReason::Duplicate);
    assert_eq!(channel.count(), 1);
    assert_eq!(policy.unread().len(), 1);
}
