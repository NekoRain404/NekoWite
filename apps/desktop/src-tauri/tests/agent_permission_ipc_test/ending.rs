//! Ending a request without an answer: the user's cancel and its ordering against the engine's own
//! cancel, the click that races a Stop, the process leaving, and the engine withdrawing its own
//! request (§6.2, §2.0b, §2.3).
//!
//! The process watchers at the bottom are the instrument this domain alone needs: the fixture reports
//! its own pid, and "the exit ended the request" is only honest if the process is really gone.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use nekowite_lib::agent_runtime::permissions::{cancel_run, PermissionRefusal};
use nekowite_lib::commands::agent::apply_permission_answer;

use crate::support::{
    answered_once, ask, ask_full, drain_until_text, permission_frame, refused_and_silent, replies,
    temp_dir, wait_for_an_answer, wait_for_replies, PATIENCE, SILENCE,
};

// --- Ending a request: cancel, exit, and the engine giving up ---

#[tokio::test]
async fn cancelling_ends_the_prompt_and_answers_it_cancelled() {
    // §6.2: cancelling ends the pending request and the old authorise button is inert afterwards.
    // The answer is `cancelled`, not a rejection: the turn died and the user decided nothing (spec
    // §2.0b) — and the engine is blocking on this request either way.
    let asked = ask("cancel", true).await;

    cancel_run(&asked.runtime, &asked.table, &asked.session_id)
        .await
        .expect("the session is this host's");
    answered_once(&asked.capture, json!({ "outcome": "cancelled" })).await;

    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a prompt that ended cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired {
            request_id: asked.prompt.request_id.clone()
        }
    );
    // The refused click adds nothing: the engine's one answer is the `cancelled`
    // above, and it stays that way.
    tokio::time::sleep(SILENCE).await;
    assert_eq!(
        replies(&asked.capture).len(),
        1,
        "a refused answer must not reach the engine"
    );
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_stop_resolves_the_prompt_before_the_engine_is_told_to_cancel() {
    // §2.0b's ordering requirement — resolve outstanding permissions *before*
    // sending the turn cancel — measured rather than assumed.
    //
    // The instrument is the fixture's own read loop: while a turn is in flight it sits in an inner
    // `read` that only looks for `session/cancel` and swallows everything else, returning to the
    // loop that records reverse-request replies only after it has seen the cancel. A permission
    // answer sent *before* the cancel is therefore never recorded, and one sent after it always is.
    // `stream` is the behaviour that holds a turn open like that.
    //
    // The guards are what keep this from passing for the wrong reason: the fixture must have
    // entered that inner loop, the prompt must have been adopted and revoked, and the connection
    // must still be alive when its answer is written — so an empty capture cannot mean "we sent
    // nothing".
    let mut asked = ask_full("stop-order", "stream", true, None).await;
    drain_until_text(&mut asked).await;
    // The fixture waits 300 ms inside its prompt branch before it starts
    // reading; the turn's first delta is written before that.
    tokio::time::sleep(Duration::from_millis(500)).await;

    cancel_run(&asked.runtime, &asked.table, &asked.session_id)
        .await
        .expect("the session is this host's");

    assert!(asked.table.pending().is_empty(), "the prompt was resolved");
    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a prompt that ended cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired {
            request_id: asked.prompt.request_id.clone()
        }
    );
    // Alive, and still answering the engine: a dead transport would make the
    // empty capture below meaningless.
    asked
        .runtime
        .cancel(&asked.session_id)
        .await
        .expect("the engine is still connected");
    tokio::time::sleep(SILENCE).await;
    let captured = replies(&asked.capture);
    assert!(
        captured.is_empty(),
        "the prompt was answered after the cancel, not before it: {captured:?}"
    );
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_cancel_and_an_authorization_race_and_exactly_one_wins() {
    // §2.3's 「取消与授权同时发生」: a click and a Stop can land in the same instant, and the
    // protocol allows exactly one answer per request. Whichever wins, the losing side must have
    // changed nothing on the wire.
    let asked = ask("race", true).await;
    let answer = asked.answer("once");
    let table = Arc::clone(&asked.table);
    let session_id = asked.session_id.clone();

    let clicked = tokio::spawn(async move { apply_permission_answer(&table, answer) });
    let stopped = asked.table.revoke_session(&session_id);
    let click = clicked.await.expect("the click task finished");

    wait_for_an_answer(&asked.capture).await;
    tokio::time::sleep(SILENCE).await;
    let captured = replies(&asked.capture);
    assert_eq!(
        captured.len(),
        1,
        "a race is still one answer: {captured:?}"
    );
    let outcome = captured[0]["result"]["outcome"].clone();
    // Either side may win, and the pair of results has to agree about which did: an accepted click
    // means nothing was cancelled, a revoked prompt means the click was refused.
    if click.is_ok() {
        assert_eq!(stopped, 0, "the click won, so there was nothing to revoke");
        assert_eq!(outcome["outcome"], json!("selected"));
    } else {
        assert_eq!(stopped, 1, "the cancel won, so it revoked the prompt");
        assert_eq!(outcome["outcome"], json!("cancelled"));
    }
    assert!(
        asked.table.pending().is_empty(),
        "and it is over either way"
    );
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_process_exit_ends_every_pending_request() {
    // §6.2's other route to the same rule: 「进程退出使所有悬挂请求结束」. Zed implements neither
    // this nor the cancel case (spec §6 item 6), so the only authority is what happens here.
    let asked = ask("exit", false).await;
    let pid = wait_for_pid(&asked.capture).await;

    asked.runtime.shutdown();
    assert!(
        wait_until_gone(pid).await,
        "the fixture engine should have exited"
    );

    assert_eq!(
        asked.table.revoke_all(),
        1,
        "the exit ends the one request still open"
    );
    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a request that ended with the process cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired {
            request_id: asked.prompt.request_id.clone()
        }
    );
    // Nothing was sent: the engine it would have been sent to is gone.
    refused_and_silent(&asked.capture).await;
}

#[tokio::test]
async fn the_engine_cancelling_its_own_request_revokes_the_prompt() {
    // The other half of §2.3's mechanism: the side that raised a request can cancel it, and then
    // the prompt must go. The answer is an error, not `cancelled` — which would tell the engine the
    // turn died — and not a silent drop.
    let vault = temp_dir("peer-cancel-vault");
    let frame = format!(
        "{}\n{}",
        permission_frame("ses_fake_1", &vault.join("note.md")),
        json!({
            "jsonrpc": "2.0",
            "method": "$/cancel_request",
            "params": { "requestId": "fs-1" },
        })
    );
    let asked = ask_full("peer-cancel", "good", false, Some(frame)).await;

    let captured = wait_for_replies(&asked.capture, 1).await;
    assert_eq!(
        captured[0]["error"]["code"],
        json!(-32800),
        "the peer gets the standard cancellation error: {captured:?}"
    );
    assert!(captured[0]["error"]["message"].is_string(), "{captured:?}");
    assert!(asked.table.pending().is_empty(), "the prompt was revoked");
    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a revoked prompt cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired {
            request_id: asked.prompt.request_id.clone()
        }
    );
    asked.runtime.shutdown();
}

// --- Watching the process itself ---

/// The fixture's own pid, which it reports as its first capture line.
async fn wait_for_pid(capture: &Path) -> i32 {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        if let Ok(recorded) = fs::read_to_string(capture) {
            if let Some(pid) = recorded
                .lines()
                .find_map(|line| line.strip_prefix("pid="))
                .and_then(|value| value.trim().parse().ok())
            {
                return pid;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the fixture never reported its pid"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Whether the process is gone. Nothing here signals anything: this pid is evidence that the exit
/// happened, not a target.
async fn wait_until_gone(pid: i32) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
