//! The fixtures the behaviour files share: the launch a domain starts an engine with, the readers
//! it reads host events with, and the vault and window stubs that keep a transport test honest.
//!
//! They are here rather than in one behaviour file because more than one of them needs each:
//! `fixture`/`start` open a case in every file but this one, `events_until`/`texts` are what a
//! whole-run assertion is built from in both `runs.rs` and `event_translation.rs`, and `PATIENCE`
//! is the bound the framing, the exit and the teardown files each measure against. What is *not*
//! here is anything a single domain uses: `events_for` (cancel's timing window) moved to `runs.rs`
//! with its only caller, and `wait_for_pids`/`wait_until_gone` to `teardown.rs` for the same
//! reason.
//!
//! Visibility changed in the move and nothing else did: a helper another file reaches is `pub`,
//! while `fixture_script`, `identity`, `NoVault` and `NoWindow` — whose only user is `start` —
//! stay private to this file.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::{
    env_pairs, AgentEventEnvelope, AgentEventKind, AgentIdentity, AgentRuntime, AgentRuntimeEvents,
    EngineConnection, EngineLaunch, VaultFiles,
};

/// The transport tests touch no vault: the fixture engine sends no `fs/*`
/// request, so reaching here would mean something unexpected was being served
/// rather than that a stub needs filling in.
struct NoVault;

/// The window side, for a test that never reads a note: no window is registered for any vault,
/// so a read would be refused rather than served from disk — which is the direction the seam
/// is built to fail in, and which keeps a test that does not exercise reads honest about it.
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a transport test must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a transport test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a transport test must not write a vault")
    }
}

/// Generous enough that a slow machine does not produce a flake, short enough
/// that a genuine hang fails the run rather than the suite's timeout.
pub const PATIENCE: Duration = Duration::from_secs(10);

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

pub fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-agent-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-1".to_string(),
    }
}

/// Launches the fixture engine, optionally letting it report what it was
/// started with through a capture file.
pub fn fixture(behaviour: &str, capture: Option<&Path>) -> EngineLaunch {
    let mut env = Vec::new();
    if let Some(path) = capture {
        env.push((
            "NWK_FAKE_CAPTURE".to_string(),
            path.to_string_lossy().into_owned(),
        ));
    }
    EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        env: env_pairs(env),
        ca_bundle: None,
    }
}

pub async fn start(launch: &EngineLaunch) -> (AgentRuntime, AgentRuntimeEvents) {
    let (connection, events) = EngineConnection::connect(launch)
        .await
        .expect("the fixture engine should start");
    AgentRuntime::new(
        identity(),
        connection,
        events,
        Arc::new(NoVault),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    )
}

/// The next host event, failing the test rather than hanging.
pub async fn next_event(events: &mut AgentRuntimeEvents) -> AgentEventEnvelope {
    tokio::time::timeout(PATIENCE, events.next_event())
        .await
        .expect("an event should arrive")
        .expect("the runtime should still be running")
}

/// Reads events until `stop` says so, so a test can assert on a whole run
/// instead of on whichever event happened to arrive first.
pub async fn events_until(
    events: &mut AgentRuntimeEvents,
    mut stop: impl FnMut(&AgentEventEnvelope) -> bool,
) -> Vec<AgentEventEnvelope> {
    let mut collected = Vec::new();
    loop {
        let event = next_event(events).await;
        let done = stop(&event);
        collected.push(event);
        if done {
            return collected;
        }
    }
}

pub fn texts(events: &[AgentEventEnvelope]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .filter_map(|event| event.payload.get("text")?.as_str().map(str::to_string))
        .collect()
}
