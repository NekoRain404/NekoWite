//! When the user is told, and — the harder half — when they are not.
//!
//! §6.3 asks for one backend ledger that decides whether a notification happens, with every window
//! and every character only displaying. This is that decision. Upstream makes it in the window that
//! happens to be the main one: `maybeNotify` (`references/desktop-pet/windows/src/main.ts:403-441`)
//! runs per window, guards itself with `if (!IS_MAIN) return`, and remembers what it announced in a
//! `Map` keyed `` `${agent}:${session}` `` — the concatenated key §6.1 forbids, holding one state
//! per session rather than per run, and forgettable in a way nothing can recover from because it
//! lives in the window. Every rule below is a different answer to one of those.
//!
//! **The two opposite failures are the whole design.** Deduplicating too eagerly drops the notice
//! the user was waiting for; deduplicating too weakly tells them four times that a run finished.
//! So the identifications are exact — the full task key, the permission request id, the session's own
//! sequence — and every suppression has a name {@link SilenceReason} that a test can hold to, rather
//! than being a branch that returns nothing.
//!
//! **Do-not-disturb drops; it does not queue.** §6.3 requires the suppressed events to be
//! recoverable and requires leaving do-not-disturb not to re-pop them, and those two together admit
//! exactly one answer: the *notice* is dropped and the *record* is kept unread. What the user turned
//! the feature on for is the pet's unread list (§7.2's `unread-list` fallback), which is still there
//! when they come back — a queue that fired on the way out would be the re-pop the plan forbids, and
//! a queue that fired immediately would not be do-not-disturb.
//!
//! **Record first, deliver second, at most once.** §6.3 admits that delivery and persistence cannot
//! be atomic, and chooses the direction: the row is written before the channel is called, so a crash
//! between the two loses the toast rather than the knowledge that something happened. A failed
//! delivery is therefore a *reported* outcome and never a success — the row stays unread and says
//! `failed`, and the next tick does not try again.
//!
//! The clock is a parameter, not a timer (§10.2, §6.3's 「参数注入时钟测试」): every entry point takes
//! the host's milliseconds, so coalescing is exercised by handing it two numbers rather than by
//! sleeping.

use super::history::{
    DeliveryState, Evicted, MarkOutcome, PetTaskKey, PetTaskState, SessionKey, TaskHistory,
    TaskRecord,
};
use super::notification_delivery::{DeliveryFailure, NotificationDelivery, PetNotice};

/// §6.3's 「3 秒内多个完成合并」: how long a burst of completions gathers before one notice goes out.
pub const COALESCE_WINDOW_MS: i64 = 3_000;

/// How many discovered stream gaps are kept for the diagnostics surface.
pub const GAPS_KEPT: usize = 16;

/// How many evictions of an unseen row are kept, for the same reason.
pub const DROPPED_UNREAD_KEPT: usize = 16;

/// Which of the user's switches governs a state.
///
/// Four channels for nine states because the switches are named after what the *user* wants to hear
/// about — 完成/失败/等待 and the limit policy §5.2 adds — while a state is what the *engine* did.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationChannel {
    TurnFinished,
    Stopped,
    Failed,
    WaitingInput,
}

/// The channel a state's notice goes out on, or `None` when the contract calls the state quiet.
///
/// Total over the nine states so a state added to the vocabulary has to say what the pet does about
/// it instead of inheriting a default. `None` is D1's `PET_ALERT_BY_STATE`'s `quiet` arm — the
/// contract's own word for 「animate, do not interrupt」 — and it covers two states that are quiet
/// for opposite reasons: `working` is not an ending at all, and `cancelled` is an ending the user
/// caused, which §6.2 says gets neither a success sound nor a failure reward. A test pins the two
/// tables together, so a state that becomes noisy on the TypeScript side fails here.
///
/// `refused` is on the failure channel. That is a statement about the *channel*, not about the run:
/// §6.2 is explicit that a refusal is 「不算成功」 and not a failure either, and the notice
/// {@link PetNotice::body} renders for it says the engine declined. What the channel decides is
/// whose switch silences it — and a user who has asked not to be told that things did not work out
/// is the one who asked for this to be silent, not the user who turned off limit notices.
pub fn channel_for(state: PetTaskState) -> Option<NotificationChannel> {
    match state {
        PetTaskState::Working | PetTaskState::Cancelled => None,
        PetTaskState::WaitingInput => Some(NotificationChannel::WaitingInput),
        PetTaskState::TurnFinished => Some(NotificationChannel::TurnFinished),
        PetTaskState::Stopped => Some(NotificationChannel::Stopped),
        PetTaskState::Refused
        | PetTaskState::Failed
        | PetTaskState::Interrupted
        | PetTaskState::Unknown => Some(NotificationChannel::Failed),
    }
}

/// The notification switches, field for field D1's `notification` domain.
///
/// D6 owns the settings schema and its storage; this is the value the policy reads, so the policy
/// needs neither a store nor a window to be exercised (§10.2). The names are the contract's own —
/// `@serde(rename_all = "camelCase")` — and a test reads `pet-contracts/config.ts` and checks both
/// the fields and the defaults against it, because a switch the settings page writes and this file
/// does not read would be a control that does nothing.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub on_turn_finished: bool,
    pub on_stopped: bool,
    pub on_failed: bool,
    pub on_waiting_input: bool,
    pub sound: bool,
    pub do_not_disturb: bool,
    pub show_task_title: bool,
}

impl Default for NotificationPreferences {
    /// D1's defaults (`pet-contracts/config.ts:299-307`), restated rather than reached through a
    /// settings load so a policy built in a test or at startup behaves as the shipped defaults do.
    fn default() -> Self {
        Self {
            on_turn_finished: true,
            on_stopped: true,
            on_failed: true,
            on_waiting_input: true,
            sound: true,
            do_not_disturb: false,
            show_task_title: false,
        }
    }
}

impl NotificationPreferences {
    pub fn channel_on(&self, channel: NotificationChannel) -> bool {
        match channel {
            NotificationChannel::TurnFinished => self.on_turn_finished,
            NotificationChannel::Stopped => self.on_stopped,
            NotificationChannel::Failed => self.on_failed,
            NotificationChannel::WaitingInput => self.on_waiting_input,
        }
    }
}

/// One observed fact about one task.
///
/// The label is the host's own name for the task, and it is the only thing here that came from
/// anywhere near the user's notes: §6.3 keeps it out of a notice unless the user asked for it, and
/// the policy never derives one — a session's title is the host's to supply, and D4's projection
/// does not carry one.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TaskFact {
    pub key: PetTaskKey,
    pub state: PetTaskState,
    pub permission_request_id: Option<String>,
    /// The host's sequence for this session, which is what separates a replay from news (§6.3).
    pub sequence: u64,
    /// Host clock, epoch ms.
    pub at_ms: i64,
    pub label: Option<String>,
}

/// Why nothing was delivered. One arm per reason, because "the user was not told" is not an answer
/// anyone can act on without the reason.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SilenceReason {
    /// The frame is one the pet has already seen: at or below the session's mark.
    Replay,
    /// A settled run was reported as live again. §6.3 refuses the revival.
    NoRevival,
    /// This run is already recorded in exactly this state (and, for a permission, this request).
    Duplicate,
    /// `working`: not an ending, so there is nothing to say and nothing to record.
    NothingToSay,
    /// The contract calls this state quiet. `cancelled` is the one that ends a run.
    QuietState,
    /// The user turned this state's channel off.
    ChannelOff { channel: NotificationChannel },
    /// Do-not-disturb is on. The record stays unread and is not replayed on the way out.
    DoNotDisturb,
    /// The user is looking at this task. §6.3's 当前正在查看该任务时抑制重复系统通知.
    BeingViewed,
}

/// What one observation did.
#[derive(Debug)]
pub enum NotificationOutcome {
    Silent(SilenceReason),
    Delivered(PetNotice),
    /// A completion gathered into the burst window; one notice will stand for all of them.
    Coalescing { count: usize, due_at_ms: i64 },
    /// The channel was asked and could not. The row is kept unread and says `failed`, and the next
    /// tick does not ask again (§6.3's at-most-once attempt).
    DeliveryFailed {
        notice: PetNotice,
        failure: DeliveryFailure,
    },
}

/// Frames that happened while the pet was not looking, named so the hole is visible.
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceGap {
    pub session: SessionKey,
    pub missed: u64,
    pub at_ms: i64,
}

/// The completions gathered so far.
///
/// The whole fact is kept rather than its key alone: the row it produced was already written, and
/// the two things the flush reads back — which task and what to call it — are both on it.
struct Pending {
    due_at_ms: i64,
    members: Vec<TaskFact>,
}

/// The one ledger that decides (§6.3).
pub struct NotificationPolicy {
    delivery: Box<dyn NotificationDelivery>,
    preferences: NotificationPreferences,
    history: TaskHistory,
    /// The session the user is looking at, when the host has said.
    viewing: Option<SessionKey>,
    pending: Option<Pending>,
    gaps: Vec<SequenceGap>,
    dropped_unread: Vec<Evicted>,
}

impl NotificationPolicy {
    pub fn new(
        delivery: Box<dyn NotificationDelivery>,
        preferences: NotificationPreferences,
        history: TaskHistory,
    ) -> Self {
        Self {
            delivery,
            preferences,
            history,
            viewing: None,
            pending: None,
            gaps: Vec::new(),
            dropped_unread: Vec::new(),
        }
    }

    /// Change the switches.
    ///
    /// Turning do-not-disturb *on* drops a burst that was still gathering. That is the same decision
    /// as dropping one that arrives during it, taken at the other end: §6.3 requires leaving
    /// do-not-disturb not to re-pop what it suppressed, so nothing may be held across it. The rows
    /// are already written and unread, and that is what the user finds.
    pub fn set_preferences(&mut self, preferences: NotificationPreferences) {
        if preferences.do_not_disturb {
            self.pending = None;
        }
        self.preferences = preferences;
    }

    /// The task the user is looking at, or `None` when they are not looking at one.
    ///
    /// Suppression, not a read receipt: the notice is not shown because the user is already there,
    /// and the row stays unread because the pet cannot know they watched the row rather than the
    /// scrollback. Only {@link Self::mark_read} says they saw it.
    pub fn set_viewing(&mut self, session: Option<SessionKey>) {
        self.viewing = session;
    }

    /// One fact from the host, and what to do about it.
    pub fn observe(&mut self, fact: TaskFact) -> NotificationOutcome {
        let session = fact.key.session();
        match self
            .history
            .observe_stream(&session, fact.sequence, fact.at_ms)
        {
            MarkOutcome::Replay => {
                return NotificationOutcome::Silent(SilenceReason::Replay);
            }
            MarkOutcome::Gap { missed } => self.note_gap(&session, missed, fact.at_ms),
            MarkOutcome::Fresh | MarkOutcome::Advanced => {}
        }

        // The request id a repeat has to be compared by. §6.2 allows a waiting-input frame to arrive
        // without one — the host could not say — and that frame is still about the same question
        // when it is about the same state, so a weaker repeat must neither count as a new question
        // nor erase the id the user's answer routes with.
        let carries = match fact.permission_request_id.clone() {
            Some(request_id) => Some(request_id),
            None => self
                .history
                .get(&fact.key)
                .filter(|row| row.state == fact.state)
                .and_then(|row| row.permission_request_id.clone()),
        };

        if let Some(recorded) = self.history.get(&fact.key) {
            // §6.3: a terminal state is not revived by a live one. A permission request is the
            // exception, and deliberately so: it is a question the user is being asked, not a
            // progress report, and §6.2 requires it to be visible rather than lost to a state the
            // run had already reached.
            let live_again = recorded.state.is_settled()
                && !fact.state.is_settled()
                && fact.state != PetTaskState::WaitingInput;
            if live_again {
                return NotificationOutcome::Silent(SilenceReason::NoRevival);
            }
            let repeated = recorded.state == fact.state
                && (fact.state != PetTaskState::WaitingInput
                    || recorded.permission_request_id == carries);
            if repeated {
                return NotificationOutcome::Silent(SilenceReason::Duplicate);
            }
        }

        if fact.state == PetTaskState::Working {
            // Not an ending: nothing to record, and nothing to say about it. A lull in the text is
            // not a completion and a task in flight is not news (§6.2).
            return NotificationOutcome::Silent(SilenceReason::NothingToSay);
        }

        // Recorded before the channel is called, so a crash between the two loses the toast and not
        // the fact (§6.3's 先记录再投递). `unread` is the contract's own distinction: the states
        // whose alert is quiet are the ones the pet owes nobody a look at.
        let unread = channel_for(fact.state).is_some();
        let evicted = self.history.record(TaskRecord {
            key: fact.key.clone(),
            state: fact.state,
            permission_request_id: carries.clone(),
            at_ms: fact.at_ms,
            delivery: DeliveryState::NotAttempted,
            unread,
        });
        if let Some(evicted) = evicted.filter(|row| row.was_unread) {
            self.note_dropped(evicted);
        }

        let Some(channel) = channel_for(fact.state) else {
            return NotificationOutcome::Silent(SilenceReason::QuietState);
        };
        if !self.preferences.channel_on(channel) {
            return NotificationOutcome::Silent(SilenceReason::ChannelOff { channel });
        }
        if self.preferences.do_not_disturb {
            return NotificationOutcome::Silent(SilenceReason::DoNotDisturb);
        }
        if self.viewing.as_ref() == Some(&session) {
            return NotificationOutcome::Silent(SilenceReason::BeingViewed);
        }

        if fact.state == PetTaskState::TurnFinished {
            return self.coalesce(fact);
        }
        let notice = self.notice(
            fact.state,
            1,
            Some(fact.key.clone()),
            carries,
            fact.label.clone(),
        );
        let keys = [fact.key];
        self.deliver(notice, &keys)
    }

    /// Deliver whatever has finished gathering, if its window has closed.
    ///
    /// The host calls this on the tick it already runs. `None` means "nothing was due", which is not
    /// the same as "nothing was delivered" — that is an outcome like any other.
    pub fn flush_due(&mut self, now_ms: i64) -> Option<NotificationOutcome> {
        if now_ms < self.pending.as_ref()?.due_at_ms {
            return None;
        }
        let pending = self.pending.take().expect("the pending burst was just read");
        if self.preferences.do_not_disturb {
            // Dropped rather than held — see this file's header. The rows stay unread, which is
            // §6.3's 「勿扰禁声音和弹出，保留未读」, and nothing is replayed on the way out.
            return Some(NotificationOutcome::Silent(SilenceReason::DoNotDisturb));
        }
        let count = pending.members.len();
        // One completion is about that task and a click has somewhere to go; several are about no
        // single one of them, and a target picked out of the burst would send the user to a task
        // the notice never named (§7.2: no button that does not do what it says).
        let (target, label) = match pending.members.as_slice() {
            [only] => (Some(only.key.clone()), only.label.clone()),
            _ => (None, None),
        };
        // The user may have opened the task during the burst window: the same §6.3 rule `observe`
        // applies, applied at delivery too, so the two paths cannot disagree about the race.
        if let Some(only) = target.as_ref() {
            if self.viewing.as_ref() == Some(&only.session()) {
                return Some(NotificationOutcome::Silent(SilenceReason::BeingViewed));
            }
        }
        let notice = self.notice(PetTaskState::TurnFinished, count, target, None, label);
        let keys: Vec<PetTaskKey> = pending.members.into_iter().map(|fact| fact.key).collect();
        Some(self.deliver(notice, &keys))
    }

    /// The rows the pet still owes the user a look at, newest first (§6.3's 未读).
    pub fn unread(&self) -> Vec<&TaskRecord> {
        self.history.unread()
    }

    /// The user has seen this row. The only thing that clears unread.
    pub fn mark_read(&mut self, key: &PetTaskKey) -> bool {
        self.history.mark_read(key)
    }

    pub fn history(&self) -> &TaskHistory {
        &self.history
    }

    /// Frames that happened while the pet was not looking (§6.3's 发现缺口).
    pub fn gaps(&self) -> &[SequenceGap] {
        &self.gaps
    }

    /// Unseen rows the index's bound pushed out. Non-empty only when there was nothing already seen
    /// to drop instead, which is the one case where the bound costs a notice.
    pub fn dropped_unread(&self) -> &[Evicted] {
        &self.dropped_unread
    }

    /// Gather a completion into the burst window (§6.3's 合并).
    ///
    /// The window opens with the first completion and does not extend: the burst a user sees is
    /// bounded by the moment it began, so a long trickle of endings cannot hold a notice back
    /// indefinitely and then deliver all of them at once.
    fn coalesce(&mut self, fact: TaskFact) -> NotificationOutcome {
        let pending = self.pending.get_or_insert_with(|| Pending {
            due_at_ms: fact.at_ms + COALESCE_WINDOW_MS,
            members: Vec::new(),
        });
        pending.members.push(fact);
        NotificationOutcome::Coalescing {
            count: pending.members.len(),
            due_at_ms: pending.due_at_ms,
        }
    }

    /// Ask the channel, and write down what it said.
    fn deliver(&mut self, notice: PetNotice, keys: &[PetTaskKey]) -> NotificationOutcome {
        match self.delivery.deliver(&notice) {
            Ok(()) => {
                for key in keys {
                    self.history.set_delivery(key, DeliveryState::Delivered);
                }
                NotificationOutcome::Delivered(notice)
            }
            Err(failure) => {
                // The record is what the user still has: a failed notice is not an unnoticed one.
                for key in keys {
                    self.history.set_delivery(key, DeliveryState::Failed);
                }
                NotificationOutcome::DeliveryFailed { notice, failure }
            }
        }
    }

    /// Build a notice, applying the two rules that are about content rather than about timing.
    fn notice(
        &self,
        state: PetTaskState,
        count: usize,
        target: Option<PetTaskKey>,
        permission_request_id: Option<String>,
        label: Option<String>,
    ) -> PetNotice {
        PetNotice {
            state,
            count,
            target,
            // §6.2: the id is what a click routes to, and it is the only thing a notice carries
            // about a request — no options, no title, no arguments, so a notice cannot authorise.
            permission_request_id: if state == PetTaskState::WaitingInput {
                permission_request_id
            } else {
                None
            },
            // §6.3: the task's own name appears only when the user asked for it.
            label: if self.preferences.show_task_title {
                label
            } else {
                None
            },
            sound: self.preferences.sound,
        }
    }

    fn note_gap(&mut self, session: &SessionKey, missed: u64, at_ms: i64) {
        if self.gaps.len() >= GAPS_KEPT {
            self.gaps.remove(0);
        }
        self.gaps.push(SequenceGap {
            session: session.clone(),
            missed,
            at_ms,
        });
    }

    fn note_dropped(&mut self, evicted: Evicted) {
        if self.dropped_unread.len() >= DROPPED_UNREAD_KEPT {
            self.dropped_unread.remove(0);
        }
        self.dropped_unread.push(evicted);
    }
}
