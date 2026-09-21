//! What the renderer is told when the engine asks: the option set with the engine's own ids, the
//! `rawInput` and the diff block the request itself carried, and the contract's
//! `AgentPermissionRequest` field for field (§6.3, and §6.1's tell side).
//!
//! This is the window-facing half of the identity rule; the enforcing half — an answer whose
//! identity does not match is refused — is `identity.rs`.

use serde_json::json;

use nekowite_lib::agent_runtime::permissions::payload::ToolInput;
use nekowite_lib::commands::agent::apply_permission_answer;

use crate::support::ask;

#[tokio::test]
async fn the_prompt_carries_the_engines_own_options_and_its_identity() {
    let asked = ask("payload", true).await;
    let prompt = &asked.prompt;

    // §6.3: the option set is the engine's, ids included — the prompt shows what the engine sent,
    // not a list this host rebuilt — and all four kinds survive rather than a collapsed pair.
    let offered: Vec<&str> = prompt
        .options
        .iter()
        .map(|option| option.option_id.as_str())
        .collect();
    assert_eq!(offered, ["once", "always", "reject"]);
    assert_eq!(prompt.options[1].name, "Always allow");
    assert_eq!(
        serde_json::to_value(prompt.options[1].kind).expect("a kind serializes"),
        json!("allow_always")
    );

    // What the user is asked to approve, out of the engine's own frame: its title, and the
    // arguments it sent (the measured frame carries `rawInput` with the diff in it).
    assert!(prompt.title.ends_with("note.md"), "{}", prompt.title);
    let ToolInput::Text { json } = &prompt.input else {
        panic!(
            "the measured frame carries rawInput, so the input is text: {:?}",
            prompt.input
        );
    };
    assert!(json.contains("Index:"), "{json}");

    // The payload is the contract's `AgentPermissionRequest`, field for field: the reader that
    // validates it at the gateway drops anything it cannot read, so a renamed or missing field
    // here would silently take the prompt away from the user.
    let payload = serde_json::to_value(prompt).expect("the payload serializes");
    for key in [
        "requestId",
        "toolCallId",
        "title",
        "input",
        "content",
        "options",
    ] {
        assert!(
            payload.get(key).is_some(),
            "the contract reads {key}: {payload}"
        );
    }
    assert_eq!(payload["input"]["state"], json!("text"));
    assert_eq!(payload["options"][0]["kind"], json!("allow_once"));

    // And the blocks the *request itself* carried, in the contract's shapes — the measured frame's
    // own `toolCall` holds the diff, which is the whole reason the prompt does not have to read the
    // transcript's row for one: on a host where this request is the first frame to carry a block,
    // the row would have none, and a prompt that joined it would ask for consent to an edit it
    // showed no text of.
    let carried = payload["content"]
        .as_array()
        .unwrap_or_else(|| panic!("the payload states the request's blocks: {payload}"));
    assert_eq!(carried.len(), 1, "{payload}");
    assert_eq!(carried[0]["type"], json!("diff"));
    assert_eq!(carried[0]["oldText"], json!("HELLO"));
    assert_eq!(carried[0]["newText"], json!("HELLO"));
    assert!(
        carried[0]["path"]
            .as_str()
            .is_some_and(|path| path.ends_with("note.md")),
        "the engine's own path: {payload}"
    );

    // §6.1: the identity the renderer is told is the identity an answer must come back with — the
    // envelope's fields and the binding agree by construction, since `adopt` builds both from one
    // identity.
    assert_eq!(prompt.tool_call_id, "call_1");
    assert_eq!(asked.envelope.agent_id, "opencode");
    assert_eq!(asked.envelope.vault_id, "vault-1");
    assert_eq!(asked.envelope.session_id, asked.session_id);
    assert_eq!(asked.envelope.run_id.as_deref(), Some("run-0"));

    // And the answer built from that envelope is accepted — the other half of the claim: the
    // binding is not stricter than what the UI is given.
    apply_permission_answer(&asked.table, asked.answer("once")).expect("the identity matches");
    asked.runtime.shutdown();
}
