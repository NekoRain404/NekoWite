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
//! - [`capabilities`] — §3.4's capability row: the installation's declaration joined to
//!   what the handshake and the session response actually reported. It is its own module
//!   because the join is the *whole* of it — neither half may be answered from here.
//! - [`events`] — the host envelope and failure vocabulary: the one place
//!   protocol frames become the app's language, including what went wrong.
//! - [`fs_capability`] — the client's file-system capability, so an agent write
//!   goes through this app's own write path instead of around it.
//! - [`driver`] — the one task that reads what the engine sends: both of a
//!   runtime's streams, into the snapshot store and the permission table.
//! - [`snapshot`] — §6.2's bounded replay: what a window that mounts late is
//!   given, and the little state the view draws from it.
//! - [`config_edit`] — the document layer: a JSONC edit that keeps the fields
//!   it did not name, and the revision it was made against.
//! - [`registry`] — the agent *definitions*: which engines may be started, and
//!   with what identity. §3.4 keeps this apart from [`binary_registry`], which
//!   knows only versions and paths, because "update this engine" and "start the
//!   engine the user registered" are not the same operation.
//! - [`binary_registry`] — §3.2's managed layout: where a release, a download
//!   and the active pointer live, and which program the pointer names.
//! - [`update`] — the update path: what a candidate must prove before the
//!   pointer moves, and what a rollback must not discard.
//! - [`profile`] — §8.1's configuration mode: the directory a profile's files
//!   live in, the roots the engine is told about, and which values may never be
//!   printed. Kept apart from [`config_edit`], which is the document layer: a
//!   profile is a *place*, and the JSONC splice is what may be written in one.
//! - [`secret`] — the one value that may never be printed. It is its own module
//!   because both the launch environment ([`process`]) and the profile
//!   ([`profile`]) hold one, and a type either of them owned would make one
//!   depend on the other.
//!
//! Nothing here knows about Tauri or the IPC surface: `commands/agent.rs` (T4)
//! wires this to the frontend, which is why the module can be tested against a
//! fake engine with no window in sight.
//!
//! The submodules are `pub` rather than private-with-re-exports, which is the
//! one place this tree deliberately differs from the rest of the crate. The
//! callers that made it so address them *by path* and cannot all be changed to
//! use a shorter name: `commands/agent.rs` reaches
//! `agent_runtime::permissions::…` for the table it answers through and names
//! `driver`/`snapshot` for the two halves of the session IPC, and the
//! integration tests under `tests/` — which is where the runtime is exercised
//! against a real child process — declare their imports as
//! `nekowite_lib::agent_runtime::registry::…` and so on. Only the modules those
//! callers name are public: the transport, the launch environment and the run
//! dispatcher stay behind the re-exports below, which are what the rest of the
//! crate should prefer.

pub mod adapters;
pub mod binary_registry;
pub mod capabilities;
pub mod config_edit;
pub mod driver;
pub mod events;
pub mod fs_capability;
pub mod native_terminal;
pub mod permissions;
pub mod profile;
pub mod registry;
pub mod secret;
pub mod session;
pub mod skills;
pub mod snapshot;
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
pub use process::{env_pairs, EngineLaunch, isolated_profile_env, SYSTEM_CA_BUNDLE};
pub use session::{
    AgentRuntime, AgentRuntimeEvents, INITIALIZE_BOUND, RuntimeEvent, SessionError, SessionInfo,
};
