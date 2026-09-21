//! `live_notes`' own tests: the wire vocabulary's spellings, the table's resolution rule, and the
//! refusals an answer that does not belong to a question earns.
//!
//! **Why it is a file of its own.** It was the bottom of `live_notes.rs`, which passed the 600-line
//! budget `docs/dev.md:286` puts on a business source file, and it was the largest single piece of
//! that file. A test changes for its own reason — when the behaviour it pins does — and not when the
//! code above it is rearranged. `use super::*` is deliberate: these tests read the same surface a
//! caller outside the module does, so a name that stopped being re-exported would fail here rather
//! than pass against a path only the tests know.
//!
//! **The imports whose paths moved.** `Arc`, `Duration` and `oneshot` used to arrive through the
//! parent's `use super::*` from the parent's own imports; the code that names them moved one module
//! down, so this file imports them itself. The type the parking helper builds was the parent's
//! private `Pending` and belongs to `super::table` now, so it is named where it lives. No test body,
//! assertion, message or ordering moved with them.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use tokio::sync::oneshot;

use super::*;
// `Pending` is private to `super::table`, and the helper below parks a question by hand: it is named
// where it lives now rather than re-exported from the module root for a test's sake.
use super::table::Pending;

/// A window that answers the moment it is asked.
///
/// The real one answers one IPC hop later, which is the same order of events: the table has
/// parked the question and set `expected` before the reply is delivered. What this cannot
/// exercise is the deadline, which is ten seconds by design — the test below reaches the
/// late-answer path by ending the asking itself instead.
struct AnsweringWindow {
    reached: usize,
    /// What each answering window says, in the order the answers are delivered.
    replies: Vec<(String, LiveNoteReply)>,
    table: StdMutex<Option<Arc<LiveNoteTable>>>,
    asked: StdMutex<Vec<LiveNoteQuestion>>,
}

impl AnsweringWindow {
    fn new(reached: usize, replies: Vec<(String, LiveNoteReply)>) -> Arc<Self> {
        Arc::new(Self {
            reached,
            replies,
            table: StdMutex::new(None),
            asked: StdMutex::new(Vec::new()),
        })
    }
}

impl LiveNoteWindows for AnsweringWindow {
    fn ask(&self, question: &LiveNoteQuestion) -> usize {
        self.asked.lock().unwrap().push(question.clone());
        let table = self.table.lock().unwrap().clone().expect("installed");
        for (window_id, reply) in &self.replies {
            // Identity is copied from the question rather than scripted: these three
            // fields are evidence, and a window cannot get them wrong without being
            // refused. The refusal vocabulary is exercised directly, below.
            let payload = match reply.clone() {
                LiveNoteReply::Held {
                    revision,
                    text,
                    dirty,
                } => LiveNoteAnswerPayload::Held {
                    request_id: question.request_id.clone(),
                    vault_id: question.vault_id.clone(),
                    path: question.path.clone(),
                    window_id: window_id.clone(),
                    revision,
                    text,
                    dirty,
                },
                LiveNoteReply::NotHeld => LiveNoteAnswerPayload::NotHeld {
                    request_id: question.request_id.clone(),
                    vault_id: question.vault_id.clone(),
                    path: question.path.clone(),
                    window_id: window_id.clone(),
                },
                LiveNoteReply::CannotAnswer { reason } => LiveNoteAnswerPayload::CannotAnswer {
                    request_id: question.request_id.clone(),
                    vault_id: question.vault_id.clone(),
                    path: question.path.clone(),
                    window_id: window_id.clone(),
                    reason,
                },
            };
            // A refusal is a bug in this file or a real disagreement; either way the test
            // asserts on the answer the asking half receives, so the refusal is carried to
            // it rather than swallowed. A refused answer simply does not resolve.
            let _ = table.answer(payload);
        }
        self.reached
    }
}

/// A window that can answer and never does.
struct SilentWindow;

impl LiveNoteWindows for SilentWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        1
    }
}

fn held(window: &str, text: &str) -> (String, LiveNoteReply) {
    (
        window.to_string(),
        LiveNoteReply::Held {
            revision: format!("{window}:tab-1:7"),
            text: text.to_string(),
            dirty: true,
        },
    )
}

fn not_held(window: &str) -> (String, LiveNoteReply) {
    (window.to_string(), LiveNoteReply::NotHeld)
}

async fn ask_with(reached: usize, replies: Vec<(String, LiveNoteReply)>) -> LiveNoteAnswer {
    let window = AnsweringWindow::new(reached, replies);
    let table = Arc::new(LiveNoteTable::new());
    *window.table.lock().unwrap() = Some(Arc::clone(&table));
    LiveNotes::new(table, window)
        .ask("/vault", "/vault/notes/x.md")
        .await
}

#[tokio::test]
async fn a_vault_no_window_holds_is_unknown_and_is_not_waited_for() {
    let window = AnsweringWindow::new(0, Vec::new());
    let table = Arc::new(LiveNoteTable::new());
    *window.table.lock().unwrap() = Some(Arc::clone(&table));
    let started = std::time::Instant::now();
    let answer = LiveNotes::new(table, window)
        .ask("/vault", "/vault/notes/x.md")
        .await;
    // The bound is ten seconds: a version of this that waited for a listener which does
    // not exist would be the stall the count exists to prevent.
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(matches!(answer, LiveNoteAnswer::Unknown(_)), "{answer:?}");
}

#[tokio::test]
async fn one_window_holding_the_path_is_the_answer() {
    assert_eq!(
        ask_with(1, vec![held("page-a", "IN THE BUFFER")]).await,
        LiveNoteAnswer::Held(LiveNote {
            revision: "page-a:tab-1:7".to_string(),
            text: "IN THE BUFFER".to_string(),
            dirty: true,
        })
    );
}

#[tokio::test]
async fn one_window_saying_no_tab_holds_it_is_not_held() {
    assert_eq!(
        ask_with(1, vec![not_held("page-a")]).await,
        LiveNoteAnswer::NotHeld
    );
}

#[tokio::test]
async fn a_window_that_cannot_answer_yet_is_unknown_and_never_not_held() {
    let answer = ask_with(
        1,
        vec![(
            "page-a".to_string(),
            LiveNoteReply::CannotAnswer {
                reason: "the tab is still reading the file".to_string(),
            },
        )],
    )
    .await;
    assert_eq!(
        answer,
        LiveNoteAnswer::Unknown("the tab is still reading the file".to_string())
    );
}

#[tokio::test]
async fn two_windows_holding_one_path_is_unknown_and_never_a_pick() {
    let answer = ask_with(2, vec![held("page-a", "A"), held("page-b", "B")]).await;
    assert!(matches!(answer, LiveNoteAnswer::Unknown(_)), "{answer:?}");
}

#[tokio::test]
async fn a_held_beside_a_not_held_is_unknown() {
    let answer = ask_with(2, vec![held("page-a", "A"), not_held("page-b")]).await;
    assert!(matches!(answer, LiveNoteAnswer::Unknown(_)), "{answer:?}");
}

#[tokio::test]
async fn two_windows_agreeing_that_no_tab_holds_it_is_not_held() {
    assert_eq!(
        ask_with(2, vec![not_held("page-a"), not_held("page-b")]).await,
        LiveNoteAnswer::NotHeld
    );
}

#[tokio::test]
async fn the_same_window_answering_twice_is_a_duplicate_and_not_a_disagreement() {
    // Two answers, one expected window: the second is refused as a duplicate, so the
    // question resolves on the first rather than reading as two windows disagreeing.
    assert_eq!(
        ask_with(1, vec![held("page-a", "A"), held("page-a", "B")]).await,
        LiveNoteAnswer::Held(LiveNote {
            revision: "page-a:tab-1:7".to_string(),
            text: "A".to_string(),
            dirty: true,
        })
    );
}

/// Parks one question by hand, the way `ask` parks it, so the refusal vocabulary can be
/// exercised without a window.
fn parked(table: &Arc<LiveNoteTable>) -> LiveNoteQuestion {
    let question = LiveNoteQuestion {
        request_id: "live-0".to_string(),
        vault_id: "/vault".to_string(),
        path: "/vault/notes/x.md".to_string(),
    };
    let (sender, _receiver) = oneshot::channel();
    table.pending.lock().unwrap().insert(
        question.request_id.clone(),
        Pending {
            question: question.clone(),
            expected: 1,
            answers: Vec::new(),
            sender: Some(sender),
        },
    );
    question
}

#[tokio::test]
async fn an_answer_that_names_another_vault_or_path_is_refused() {
    let table = Arc::new(LiveNoteTable::new());
    parked(&table);
    let refusal = |vault: &str, path: &str| {
        table.answer(LiveNoteAnswerPayload::NotHeld {
            request_id: "live-0".to_string(),
            vault_id: vault.to_string(),
            path: path.to_string(),
            window_id: "page-a".to_string(),
        })
    };
    assert!(matches!(
        refusal("/other", "/vault/notes/x.md"),
        Err(LiveNoteRefusal::VaultMismatch { .. })
    ));
    assert!(matches!(
        refusal("/vault", "/vault/notes/y.md"),
        Err(LiveNoteRefusal::PathMismatch { .. })
    ));
    // A well-formed answer is still accepted after the two refusals, so neither of them
    // consumed the question.
    assert!(refusal("/vault", "/vault/notes/x.md").is_ok());
}

#[tokio::test]
async fn an_answer_to_a_question_this_host_never_asked_is_refused() {
    let table = Arc::new(LiveNoteTable::new());
    let refusal = table.answer(LiveNoteAnswerPayload::NotHeld {
        request_id: "live-404".to_string(),
        vault_id: "/vault".to_string(),
        path: "/vault/notes/x.md".to_string(),
        window_id: "page-a".to_string(),
    });
    assert!(matches!(
        refusal,
        Err(LiveNoteRefusal::NoSuchRequest { .. })
    ));
}

#[tokio::test]
async fn a_late_answer_to_a_question_that_ended_is_refused_as_expired() {
    let table = Arc::new(LiveNoteTable::new());
    let notes = LiveNotes::new(Arc::clone(&table), Arc::new(SilentWindow));
    let asking = tokio::spawn(async move { notes.ask("/vault", "/vault/notes/x.md").await });
    // Long enough for the child to have parked its question; the ten-second bound is not
    // what ends this one.
    tokio::time::sleep(Duration::from_millis(50)).await;
    asking.abort();
    let _ = asking.await;
    // `Parked` removed the entry when the abort dropped the future, so the id is in the
    // retired ring rather than the pending map.
    let late = table.answer(LiveNoteAnswerPayload::NotHeld {
        request_id: "live-0".to_string(),
        vault_id: "/vault".to_string(),
        path: "/vault/notes/x.md".to_string(),
        window_id: "page-a".to_string(),
    });
    assert!(
        matches!(late, Err(LiveNoteRefusal::Expired { .. })),
        "{late:?}"
    );
}
