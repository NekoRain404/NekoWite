//! R2 — the permission boundary: does *this host* answer the engine's request,
//! and does it refuse the answers it must?
//!
//! The engine half is the fixture (`tests/fixtures/agent/fake_agent.sh`), which sends a
//! `session/request_permission` frame verbatim from the environment — the shape P0 §7.1 measured on
//! the pinned engine, not one invented here. Every test drives that frame through the real runtime,
//! the real transport and the real permission table, then reads what the engine received back out
//! of the fixture's capture file.
//!
//! **Why the capture file is the assertion, and not "the call returned Ok".** A previous version of
//! the runtime's handlers was never invoked at all: `Responder<T>` defaults its type parameter to
//! `serde_json::Value`, so a handler registered without the annotation took requests of the wrong
//! type and the SDK answered them itself — and three tests passed on the SDK's answer. A success
//! response is therefore not evidence that our code produced it. What this file asserts instead is
//! the frame that reached the engine, plus a negative control: while a prompt is open and
//! unanswered, and after every refusal, the wire stays silent. If the SDK were answering for us,
//! that silence is the first assertion to fail.
//!
//! Module inclusion: `agent_runtime/mod.rs` declares `permissions` and `commands/mod.rs` declares
//! `agent`, so both trees are the library's own — the shims this file used to carry were what a
//! test does while the files that register them belong to another task.

//! The cases are divided by behaviour domain rather than kept in one file, because this target
//! outgrew a page and passed AGENTS.md's 800-line rule for a test: `answer` for the frame that
//! reaches the engine, `prompt` for the payload a window is shown, `refusal` for the decisions the
//! host will not take from the renderer at face value, `identity` for §6.1's field-by-field binding
//! and the request that names an unknown session, `ending` for the ways a request ends without an
//! answer, and `state` for the composition root that holds the prompt list. `support` is the fixture
//! world and the harness they share, and each section comment travelled with the cases it
//! introduces. They are one target and one command — `cargo test --test agent_permission_ipc_test` —
//! because a test in a file nobody runs is not evidence.

use nekowite_lib::agent_runtime;
use nekowite_lib::commands;

use agent_runtime::driver::Session;
use agent_runtime::permissions::PermissionTable;
use agent_runtime::AgentRuntime;
use commands::agent::AgentIpcState;

// `#[path]` rather than a bare `mod`, because a test target's root file resolves a plain `mod x;`
// against `tests/` rather than against this directory: the bare form fails with rustc's
// `file not found for module x` and `create file "tests/x.rs"`, and a flat `tests/*.rs` layout would
// make Cargo build each of them as a test binary of its own. The directory holds behaviour, not
// targets. The convention is the one `desktop_pet_ipc_test.rs` and `agent_settings_ipc_test.rs`
// established.
#[path = "agent_permission_ipc_test/answer.rs"]
mod answer;
#[path = "agent_permission_ipc_test/ending.rs"]
mod ending;
#[path = "agent_permission_ipc_test/identity.rs"]
mod identity;
#[path = "agent_permission_ipc_test/prompt.rs"]
mod prompt;
#[path = "agent_permission_ipc_test/refusal.rs"]
mod refusal;
#[path = "agent_permission_ipc_test/state.rs"]
mod state;
#[path = "agent_permission_ipc_test/support.rs"]
mod support;

/// Compile-time claims about what T4 will wire: the state `tauri::State` needs is `Send + Sync +
/// 'static`, and the command entry points and constructor referenced here are the ones that exist —
/// nothing in this crate registers them yet (`generate_handler!` is in `lib.rs`, T4's file), and a
/// rename that no handler noticed would otherwise only surface there.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync + 'static>() {}
    assert_send_sync::<AgentRuntime>();
    assert_send_sync::<PermissionTable>();
    assert_send_sync::<AgentIpcState>();
    assert_send_sync::<Session>();
    let _ = AgentIpcState::default;
    let _ = AgentIpcState::session;
    // Monomorphised over a concrete runtime, because the command gained the `R: tauri::Runtime`
    // parameter the pet's commands already carry: it takes an `AppHandle` so the pet's task list
    // can follow an answer, and a signature naming `AppHandle<Wry>` cannot be driven from a
    // `MockRuntime` test. Naming `Wry` here keeps the claim this block is making — that the entry
    // point exists under the runtime the app ships.
    let _ = commands::agent::agent_permission_answer::<tauri::Wry>;
    let _ = commands::agent::agent_cancel_run;
    // The session half, which `generate_handler!` names: a rename that no handler noticed would
    // otherwise only surface in `lib.rs`.
    let _ = commands::agent::agent_start;
    let _ = commands::agent::agent_stop::<tauri::Wry>;
    let _ = commands::agent::agent_open_session;
    let _ = commands::agent::agent_set_config_option;
    let _ = commands::agent::agent_prompt::<tauri::Wry>;
    let _ = commands::agent::agent_session_snapshot;
};
