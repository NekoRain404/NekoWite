//! The answers refused because the decision itself is invalid: an option the engine never offered,
//! and a second click on a request that is already answered (§6.3 with §2.0b, §2.3).
//!
//! Both leave the prompt answerable — a bad answer must not be able to consume a live request — and
//! both are measured against the wire rather than against the refusal's return value.

use serde_json::json;

use nekowite_lib::agent_runtime::permissions::PermissionRefusal;
use nekowite_lib::commands::agent::{apply_permission_answer, refusal_message};

use crate::support::{answered_once, ask, refused_and_silent};

// --- The refusals ---

#[tokio::test]
async fn an_option_the_engine_never_offered_is_refused() {
    // §6.3 with §2.0b: the host must not invent a decision the engine did not offer.
    // `always-forever` is not one of the engine's ids, so it is refused — and the prompt stays
    // answerable, because a bad answer must not be able to consume a live request.
    let asked = ask("unknown-option", false).await;

    let refusal = apply_permission_answer(&asked.table, asked.answer("always-forever"))
        .expect_err("an id the engine did not offer is not a decision");
    assert_eq!(
        refusal,
        PermissionRefusal::OptionNotOffered {
            option_id: "always-forever".to_string()
        }
    );
    refused_and_silent(&asked.capture).await;

    apply_permission_answer(&asked.table, asked.answer("once")).expect("an offered id");
    answered_once(
        &asked.capture,
        json!({ "outcome": "selected", "optionId": "once" }),
    )
    .await;
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_second_answer_to_the_same_request_is_refused() {
    // §6.3's 「重复点击幂等」, made a no-op where the decision is taken rather than relying on the
    // engine ignoring it (spec §3.5: Zed's duplicate still repaints the tool call). The evidence is
    // that the engine was answered once, with the option that won.
    let asked = ask("duplicate", false).await;

    apply_permission_answer(&asked.table, asked.answer("once")).expect("the first click");
    let refusal = apply_permission_answer(&asked.table, asked.answer("reject"))
        .expect_err("the second click is not a second decision");
    assert_eq!(
        refusal,
        PermissionRefusal::AlreadyAnswered {
            request_id: asked.prompt.request_id.clone()
        }
    );
    // The renderer is told which fact it hit, not only that something failed.
    assert!(
        refusal_message(&refusal).contains("answered already"),
        "{}",
        refusal_message(&refusal)
    );
    answered_once(
        &asked.capture,
        json!({ "outcome": "selected", "optionId": "once" }),
    )
    .await;
    asked.runtime.shutdown();
}
