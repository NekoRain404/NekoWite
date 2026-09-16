//! The agent runtime: the process that runs the engine, the ACP connection to
//! it, and the host's own events for what it does.
//!
//! Layering, so that a change has one place to land:
//!
//! - [`process`] — the environment the engine is launched with, including the
//!   CA bundle of P0 §2.4. Spawning, the process group and its teardown belong
//!   to the ACP SDK's transport (see that module for why).
//! - [`acp_transport`] — the ACP connection itself: the SDK's client, our own
//!   per-call timeouts, and the failure classification the SDK cannot do.
//! - [`session`] — sessions: which engine session the host knows about.
//! - [`runs`] — runs: one generation, and the single ending it is allowed.
//! - [`events`] — the host envelope and failure vocabulary: the one place
//!   protocol frames become the app's language, including what went wrong.
//! - [`fs_capability`] — the client's file-system capability, so an agent write
//!   goes through this app's own write path instead of around it.
//! - [`registry`] — the agent *definitions*: which engines may be started, and
//!   with what identity. §3.4 keeps this apart from [`binary_registry`], which
//!   knows only versions and paths, because "update this engine" and "start the
//!   engine the user registered" are not the same operation.
//! - [`binary_registry`] — §3.2's managed layout: where a release, a download
//!   and the active pointer live, and which program the pointer names.
//! - [`update`] — the update path: what a candidate must prove before the
//!   pointer moves, and what a rollback must not discard.
//!
//! Nothing here knows about Tauri or the IPC surface: `commands/agent.rs` (T4)
//! wires this to the frontend, which is why the module can be tested against a
//! fake engine with no window in sight.
//!
//! The submodules are `pub` rather than private-with-re-exports, which is the
//! one place this tree deliberately differs from the rest of the crate. Two
//! callers address them *by path* and neither can be changed to use a shorter
//! name: `commands/agent.rs` reaches `agent_runtime::permissions::…` for the
//! table it answers through, and the integration tests under `tests/` — which
//! is where the runtime is exercised against a real child process — declare
//! their imports as `nekowite_lib::agent_runtime::registry::…` and so on. Only
//! the modules those two callers name are public: the transport, the launch
//! environment and the run dispatcher stay behind the re-exports below, which
//! are what the rest of the crate should prefer.

pub mod adapters;
pub mod binary_registry;
pub mod events;
pub mod fs_capability;
pub mod permissions;
pub mod registry;
pub mod session;
pub mod update;

mod acp_transport;
mod process;
mod runs;

pub use acp_transport::{EngineConnection, EngineEvents, PermissionRequest};
pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentFailureCode, AgentIdentity, TransportError,
};
pub use fs_capability::{
    ChangeRecord, FsCapability, FsRequest, VaultFiles, client_capabilities, slice_lines,
};
pub use process::{EngineLaunch, isolated_profile_env, SYSTEM_CA_BUNDLE};
pub use session::{AgentRuntime, INITIALIZE_BOUND, SessionError, SessionInfo};
