//! A pending permission: the engine blocks on a question, and the snapshot a window takes before
//! it subscribes has to be holding it.
//!
//! The state and the prompt list come from one read of the permission table, so they cannot
//! disagree about whether a decision is due — which is what a window that remounts while one is
//! open depends on.

use std::fs;
use std::path::Path;

use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::agent_runtime::snapshot::SessionState;

use crate::support::{open, temp_dir, wait_for_state, wired};

/// The permission frame P0 §7.1 measured, trimmed to what the prompt is built from: the engine's
/// own tool call, and its own options with its own ids.
fn permission_frame(path: &Path) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": "fs-1",
        "method": "session/request_permission",
        "params": {
            "sessionId": "ses_fake_1",
            "toolCall": {
                "toolCallId": "call_session",
                "title": path.to_string_lossy(),
                "kind": "edit",
                "status": "pending",
                "rawInput": { "filepath": path.to_string_lossy() },
            },
            "options": [
                { "optionId": "once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
            ],
        },
    })
    .to_string()
}

#[tokio::test]
async fn a_pending_prompt_holds_the_session_in_waiting_permission() {
    // The engine blocks on a permission request, so the one thing the snapshot may not do is lose
    // it: a window that remounts while one is open would show a turn with nothing to allow. The
    // state and the prompt list come from one read of the permission table, so they cannot
    // disagree about whether a decision is due.
    let dir = temp_dir("prompt");
    let vault_root = dir.join("vault");
    fs::create_dir_all(&vault_root).expect("the vault directory");
    let wired = wired(
        "prompt",
        "good",
        Some(permission_frame(&vault_root.join("note.md"))),
    )
    .await;
    let opened = open(&wired).await;

    let waiting = wait_for_state(
        wired.ipc(),
        &opened.session_id,
        SessionState::WaitingPermission,
    )
    .await;
    assert_eq!(
        waiting.permissions.len(),
        1,
        "the question is in the snapshot"
    );
    let prompt = &waiting.permissions[0].payload;
    assert!(
        prompt.get("requestId").is_some(),
        "an answer names this, so the window has to be told it: {prompt}"
    );
    assert_eq!(prompt["toolCallId"], "call_session");
    assert_eq!(
        prompt["options"].as_array().map(Vec::len),
        Some(2),
        "the engine's own options, as the engine spelled them"
    );
    assert!(
        prompt["title"]
            .as_str()
            .is_some_and(|title| !title.is_empty()),
        "a prompt whose title is empty is refused by the contract on the other side: {prompt}"
    );
    assert!(
        waiting
            .events
            .iter()
            .all(|event| event.kind != AgentEventKind::PermissionRequest),
        "a question is not part of the stream a caller replays events from — it would be delivered \
         once as a frame and once again here"
    );
    // The envelope is the runtime's own: the identity an answer is checked against is the one the
    // window was told.
    assert_eq!(waiting.permissions[0].session_id, opened.session_id);
    assert!(waiting.permissions[0].sequence <= waiting.sequence);
}
