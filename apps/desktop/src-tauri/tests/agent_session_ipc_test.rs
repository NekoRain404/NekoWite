//! The session half of the agent IPC: does a window get a session, do its frames arrive, and does
//! the snapshot it takes before subscribing say the same thing the stream will?
//!
//! Everything but the window is real here. The engine is the fixture
//! (`tests/fixtures/agent/fake_agent.sh`), the runtime is T2's, the driver and the snapshot store
//! are the ones `agent_start` wires, and the commands are the `#[tauri::command]` functions
//! `generate_handler!` names — called directly, with the states a real app manages. Two things are
//! stood in for: the window's event channel is a collector this test reads (`install` takes a sink
//! rather than a Tauri handle, which is exactly what makes that possible), and `agent_start`
//! itself — its app-side half resolves a real app data directory, so what runs here is the second
//! half it performs, plus the program resolution it does first.
//!
//! The two claims this file exists for:
//!
//! - **A session can be started at all.** T4 delivered the adapter with six of its eight calls
//!   unimplemented, because the runtime's two receivers could only be reached through `&mut`. The
//!   tests below fail on that shape if it ever comes back.
//! - **The snapshot and the stream agree.** §6.2 requires the snapshot to be taken before the
//!   subscription starts, so a frame that is in neither is data the window never sees. The
//!   snapshot's own sequence and tail are asserted against the frames the sink received.
//!
//! The cases are divided by behaviour domain rather than kept in one file, because this target
//! outgrew a page (§13.1): `session_lifecycle` for opening a session, running a turn and stopping
//! it, `snapshot_handshake` for §6.2's handshake, `event_sequence` for the numbering every consumer
//! reads frames by, `config_options` for the engine's own option list and the frame that says one
//! moved, `permission_prompt` for a decision the snapshot may not lose, `refusal_paths` for the ids
//! and roots this host answers instead of serving, `session_load` for reopening a session the
//! engine holds, `startup_program` for the program a start launches, and `support` for the engine
//! they share. They are one target and one command — `cargo test --test agent_session_ipc_test` —
//! because a test in a file nobody runs is not evidence.
//!
//! `#[path]` rather than a bare `mod`, matching `agent_settings_ipc_test.rs`: a test target's root
//! file resolves a plain `mod x;` against `tests/` rather than against this directory — `rustc`
//! answers `mod support;` with "create file tests/support.rs" — so the names below are behaviour,
//! not targets, and a flat `tests/*.rs` layout would make Cargo build each of them as a test binary
//! of its own.

#[path = "agent_session_ipc_test/config_options.rs"]
mod config_options;
#[path = "agent_session_ipc_test/event_sequence.rs"]
mod event_sequence;
#[path = "agent_session_ipc_test/permission_prompt.rs"]
mod permission_prompt;
#[path = "agent_session_ipc_test/refusal_paths.rs"]
mod refusal_paths;
#[path = "agent_session_ipc_test/session_lifecycle.rs"]
mod session_lifecycle;
#[path = "agent_session_ipc_test/session_load.rs"]
mod session_load;
#[path = "agent_session_ipc_test/snapshot_handshake.rs"]
mod snapshot_handshake;
#[path = "agent_session_ipc_test/startup_program.rs"]
mod startup_program;
#[path = "agent_session_ipc_test/support.rs"]
mod support;
