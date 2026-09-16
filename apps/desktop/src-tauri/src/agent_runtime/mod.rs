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
//!
//! Nothing here knows about Tauri or the IPC surface: `commands/agent.rs` (T4)
//! wires this to the frontend, which is why the module can be tested against a
//! fake engine with no window in sight.

mod acp_transport;
mod events;
mod fs_capability;
mod process;
mod runs;
mod session;

pub use acp_transport::{EngineConnection, EngineEvents, PermissionRequest};
pub use events::{
    AgentEventEnvelope, AgentEventKind, AgentFailureCode, AgentIdentity, TransportError,
};
pub use fs_capability::{
    ChangeRecord, FsCapability, FsRequest, VaultFiles, client_capabilities, slice_lines,
};
pub use process::{EngineLaunch, isolated_profile_env, SYSTEM_CA_BUNDLE};
pub use session::{AgentRuntime, INITIALIZE_BOUND, SessionError, SessionInfo};
