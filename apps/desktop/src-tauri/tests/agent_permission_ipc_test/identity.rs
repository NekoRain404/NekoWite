//! §6.1's enforcement half: the renderer is not a trusted source of a request's identity, so an
//! answer is checked against what the backend recorded, and a request naming a session this host
//! never opened is refused back to the engine rather than published as a prompt.
//!
//! These are IPC-boundary cases, not helper tests: remove the binding in the permission table and
//! [`forged_identity_fields_are_refused_one_by_one`] and [`an_answer_for_another_vault_is_refused`]
//! fail, and [`refused_and_silent`](crate::support::refused_and_silent) fails if anything else —
//! the SDK's default handler — answers the engine for us.

use serde_json::json;

use nekowite_lib::agent_runtime::permissions::{
    PermissionIdentity, PermissionRefusal, PermissionTable,
};
use nekowite_lib::commands::agent::apply_permission_answer;

use crate::support::{
    answered_once, ask, fixture, identity, permission_frame, refused_and_silent, start, temp_dir,
    wait_for_replies,
};

#[tokio::test]
async fn an_answer_for_another_vault_is_refused() {
    // §10.2's cross-vault case. The engine session outlives a vault switch, so a window still
    // holding this prompt would otherwise authorize work in a vault the user has left.
    let asked = ask("cross-vault", false).await;

    let mut answer = asked.answer("once");
    answer.session.vault_id = "vault-2".to_string();
    let refusal = apply_permission_answer(&asked.table, answer).expect_err("not this vault");
    assert_eq!(
        refusal,
        PermissionRefusal::IdentityMismatch { field: "vaultId" }
    );
    refused_and_silent(&asked.capture).await;

    apply_permission_answer(&asked.table, asked.answer("once")).expect("the real vault still wins");
    answered_once(
        &asked.capture,
        json!({ "outcome": "selected", "optionId": "once" }),
    )
    .await;
    asked.runtime.shutdown();
}

#[tokio::test]
async fn forged_identity_fields_are_refused_one_by_one() {
    // §11.1: the renderer is not a trusted source of identity. Each field is checked against what
    // the backend recorded, so a forged session, engine, profile or runtime incarnation is refused
    // rather than acted on — and the prompt survives every one of them.
    let asked = ask("forged", true).await;
    let forgeries: [(&str, fn(&mut PermissionIdentity)); 4] = [
        ("sessionId", |session| {
            session.session_id = "ses_someone_elses".to_string()
        }),
        ("agentId", |session| {
            session.agent_id = "another-engine".to_string()
        }),
        ("profileId", |session| {
            session.profile_id = "another-profile".to_string()
        }),
        ("runtimeEpoch", |session| {
            session.runtime_epoch = "epoch-0".to_string()
        }),
    ];

    for (field, spoil) in forgeries {
        let mut answer = asked.answer("once");
        spoil(&mut answer.session);
        let refusal = apply_permission_answer(&asked.table, answer)
            .expect_err("a forged field must be refused");
        assert_eq!(refusal, PermissionRefusal::IdentityMismatch { field });
    }

    refused_and_silent(&asked.capture).await;
    apply_permission_answer(&asked.table, asked.answer("reject")).expect("the real answer works");
    answered_once(
        &asked.capture,
        json!({ "outcome": "selected", "optionId": "reject" }),
    )
    .await;
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_request_for_an_unknown_session_is_refused_to_the_engine() {
    // The engine asked about a session this host never opened: nothing to bind the request to, so
    // no prompt — and the engine is told, because it is blocking on this request (spec §2.5: an
    // error naming the id, not silence).
    let dir = temp_dir("unknown-session");
    let capture = dir.join("capture");
    let frame = permission_frame("ses_not_ours", &dir.join("note.md"));
    let (runtime, mut events) = start(&fixture("good", &capture, &frame)).await;
    runtime.initialize().await.expect("initialize");
    let vault = temp_dir("unknown-session-vault");
    runtime
        .open_session(&vault)
        .await
        .expect("a session of our own");
    let table = PermissionTable::new(identity(), &runtime);

    let refused = table
        .adopt_next(&mut events)
        .await
        .expect("the engine asked anyway")
        .expect_err("that session is not this host's");
    assert!(matches!(refused, PermissionRefusal::UnknownSession { .. }));

    let captured = wait_for_replies(&capture, 1).await;
    let error = &captured[0]["error"];
    assert_eq!(error["code"], json!(-32603), "{captured:?}");
    assert_eq!(error["data"], json!("unknown session: ses_not_ours"));
    assert!(table.pending().is_empty(), "no prompt was published");
    runtime.shutdown();
}
