//! The agent runtime, against a fixture engine and then against the real one.
//!
//! Framing, JSON-RPC and the process lifecycle belong to `agent-client-protocol`
//! (see `src/agent_runtime/mod.rs` for the layering), so what these tests hold
//! down is what this crate still owns: the launch environment, the translation
//! of protocol updates into host events, the run lifecycle and its cancellation
//! race, and the failure classification.
//!
//! The fixture engine (`tests/fixtures/agent/fake_agent.sh`) is a POSIX shell
//! script — no interpreter to install — that can be told to misbehave in one
//! specific way per test. It answers the protocol as measured in P0, so a test
//! that passes here is a statement about our wiring, not about a mock we
//! invented.
//!
//! Where the behaviour went — one file per domain, and the shared fixture beside them:
//!
//! - `handshake.rs` — what `initialize` negotiates, and the line reader's five ways of being handed
//!   a frame: two in one write, a character cut in half, a line that is not JSON, an id nobody asked
//!   for, and no end at all.
//! - `engine_exit.rs` — the engine's own end: a call a dead engine must not park, and the stderr
//!   tail a failed start still carries. The delicate case
//!   `an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why` lives here.
//! - `launch_environment.rs` — the CA bundle the engine is started with, and the certificate
//!   failure that variable exists to prevent, classified and reworded.
//! - `runs.rs` — the run state machine: one generation per session, the ending it may publish, and
//!   the cancellation race.
//! - `event_translation.rs` — the engine's frames as the host's events: the thought chunk, the
//!   unknown update, the tool-call row, and the usage counters.
//! - `teardown.rs` — shutdown's order: the engine exits on its own, then the group goes.
//! - `real_engine.rs` — the same handshake against the artifact the app ships, skipped when absent.
//! - `support.rs` — the fixtures more than one of the above starts from.
//!
//! One target and one command: `cargo test --test agent_runtime_test` runs all of them, because a
//! test in a file nobody runs is not evidence.

// The runtime is a library module now: `lib.rs` declares `pub mod agent_runtime;`
// and `agent_runtime/mod.rs` declares the tree inside it, so this test compiles
// against the same source the app ships rather than a second copy of it. It used
// to be included by path, which is what a test does while the file that
// registers it belongs to another task; that shim is gone, and the
// `use nekowite_lib::agent_runtime;` each behaviour module below carries is the
// whole of what replaced it.

// `#[path]` rather than a bare `mod`, because a test target's root file resolves a plain `mod x;`
// against `tests/` rather than against this directory — the rule `agent_settings_ipc_test.rs`
// states and `rustc` enforces (E0583). Every path points inside `tests/agent_runtime_test/`;
// nothing is included from `src/`.
#[path = "agent_runtime_test/engine_exit.rs"]
mod engine_exit;
#[path = "agent_runtime_test/event_translation.rs"]
mod event_translation;
#[path = "agent_runtime_test/handshake.rs"]
mod handshake;
#[path = "agent_runtime_test/launch_environment.rs"]
mod launch_environment;
#[path = "agent_runtime_test/real_engine.rs"]
mod real_engine;
#[path = "agent_runtime_test/runs.rs"]
mod runs;
#[path = "agent_runtime_test/support.rs"]
mod support;
#[path = "agent_runtime_test/teardown.rs"]
mod teardown;
