//! The refusals: what this host answers instead of serving when the id or the root was not one it
//! was given.
//!
//! Both are security boundaries rather than error handling — an id the host never received is not
//! one it answers about, and the renderer names a vault but does not choose one — so each refusal
//! carries the condition as a code and not only as a sentence.

use nekowite_lib::agent_runtime::events::AgentFailureCode;
use nekowite_lib::commands::agent::{agent_open_session, agent_session_snapshot};

use crate::support::{rooted, temp_dir, wired};

#[tokio::test]
async fn a_session_this_host_never_opened_is_refused_rather_than_answered_about() {
    // §6.1: an id the host did not receive is not one it answers about — and the snapshot is the
    // surface a forged id would otherwise read state out of.
    let wired = wired("unknown", "good", None).await;
    let refusal = agent_session_snapshot(wired.ipc(), "ses_somebody_elses".to_string())
        .await
        .expect_err("this host never opened that session");
    // The condition travels with the sentence: this is the value the window's IPC rejects with, and
    // a caller that had only the words would have to match on them to learn which of the two
    // refusals on this path it hit (`session-stale` here, `runtime-unavailable` for no engine).
    assert_eq!(refusal.code, AgentFailureCode::SessionStale);
    assert!(
        refusal.message.contains("not one this app opened"),
        "{refusal:?}"
    );
}

#[tokio::test]
async fn a_session_root_is_the_vault_the_user_opened() {
    // §6.1/§11.1: the renderer names a vault, it does not choose one. The root it sends becomes the
    // engine's confinement, so a root accepted on the request alone would be a sandbox drawn
    // around a directory the user never picked.
    let wired = wired("root", "good", None).await;
    let elsewhere = temp_dir("root-elsewhere");

    let refusal = agent_open_session(
        wired.vaults(),
        wired.ipc(),
        "vault-1".to_string(),
        rooted(&elsewhere),
    )
    .await
    .expect_err("that folder was never opened as a vault");
    assert_eq!(
        refusal.code,
        AgentFailureCode::PermissionDenied,
        "a folder the user never opened is a request outside what this window may reach: {refusal:?}"
    );
    assert!(
        refusal.message.contains("vault root is not open"),
        "the refusal is the one every path-confined command gives for a root the user never \
         opened: {refusal:?}"
    );

    // And the vault named has to be the one this engine was started for: a runtime is per (agent,
    // profile, vault), so another vault's session is not this runtime's to open.
    let refusal = agent_open_session(
        wired.vaults(),
        wired.ipc(),
        "another-vault".to_string(),
        rooted(&wired.vault_root),
    )
    .await
    .expect_err("this engine was started for one vault");
    assert_eq!(refusal.code, AgentFailureCode::SessionStale);
    assert!(
        refusal
            .message
            .contains("was started for the vault vault-1"),
        "{refusal:?}"
    );
}
