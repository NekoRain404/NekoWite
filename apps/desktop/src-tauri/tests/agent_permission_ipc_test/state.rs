//! The IPC layer as the composition root holds it: the state Tauri registers carries the session,
//! the runtime, the permission table and the snapshots together, and §6.2's remount snapshot —
//! taken before a window subscribes — has to see the open prompt.
//!
//! `install` is what makes the table the one that saw the prompt, so the case below answers through
//! the state's own `session()` rather than through the table the harness handed it.

use std::sync::Arc;

use nekowite_lib::agent_runtime::driver::Session;
use nekowite_lib::agent_runtime::snapshot::{SessionSnapshots, REPLAY_WINDOW};
use nekowite_lib::commands::agent::{apply_permission_answer, pending_prompts, AgentIpcState};

use crate::support::{ask, wait_for_an_answer};

// --- The IPC layer, as the composition root will hold it ---

#[tokio::test]
async fn the_ipc_state_carries_the_runtime_and_the_prompt_snapshot() {
    // The state Tauri registers, filled the way `agent_start` fills it: the session that carries
    // the runtime, the table and the snapshots together. §6.2's remount snapshot — taken before
    // the subscription starts — has to see the open prompt, or a reloaded window would answer
    // blind.
    let asked = ask("ipc-state", false).await;
    assert_eq!(
        pending_prompts(&asked.table).len(),
        1,
        "the open prompt is in the snapshot"
    );

    // The table is the one that saw this prompt. `install` builds it from the runtime before the
    // runtime is shared, so a state holding a second table is not a state this composition can
    // produce — the shape that made it possible (receivers reached through `&mut`, and therefore
    // a table that had to exist before the runtime was shared) went with the reading half.
    let state = AgentIpcState::default();
    state.install(Session {
        identity: asked.runtime_identity(),
        runtime: Arc::clone(&asked.runtime),
        permissions: Arc::clone(&asked.table),
        snapshots: Arc::new(SessionSnapshots::new(
            asked.runtime_identity(),
            REPLAY_WINDOW,
        )),
        model_option_id: Some("model".to_string()),
        // This fixture's engine is a script with no HTTP surface, which is the `Unsupported`
        // arm the grants readout reports rather than an empty list.
        http: None,
    });

    let session = state.session().expect("a session is running");
    apply_permission_answer(&session.permissions, asked.answer("once"))
        .expect("through the state's own table");

    assert!(
        pending_prompts(&session.permissions).is_empty(),
        "answered, so nothing is pending"
    );
    wait_for_an_answer(&asked.capture).await;
    session.runtime.shutdown();
}
