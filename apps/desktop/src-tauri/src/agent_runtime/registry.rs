//! Agent definitions: which engines this app may start, and what identity each launch
//! carries.
//!
//! §3.4 splits this in two: `registry.rs` owns the *definitions* — id, source, program,
//! arguments, environment policy, enabled flag, config adapter — while
//! `binary_registry.rs` (T14) owns version and path *selection*. Not one manager, because
//! merging them would make "update this engine" and "start the engine the user registered"
//! the same operation.
//!
//! Two rules shape the rest. **Identity is composite** (§6.1): agentId + profileId +
//! vaultId + runtimeEpoch, the epoch minted here and never supplied by a caller — two
//! engines issuing the same `sessionId` is normal (§3.4's session row), so §6.2's
//! stale-frame check needs two incarnations never to share a name. **Validation proves
//! launchability, nothing more** (§3.4.4): registration is not a sandbox, so
//! [`ProgramState::Launchable`] means a file existed and was executable when it was
//! checked, not that the program is safe.
//!
//! **Split by what makes each part change, not by arithmetic.** `docs/dev.md` §5.4.2 puts the
//! criterion on the number of reasons a file changes rather than on its line count, and this file
//! had six: what a refusal *is*, the rules that decide a draft is acceptable, what one registration
//! *is*, the vocabularies a definition is spelled in, the live-instance bookkeeping, and the
//! registry's own table. Each is now a child module whose header argues why it is the one that
//! moves when its subject does:
//!
//! - [`error`] — the refusal vocabulary: what a settings form maps to a sentence.
//! - [`validation`] — the predicates that decide a draft is acceptable, and the one redaction of a
//!   value that may be printed.
//! - [`registration`] — one registration: §3.4's first row field for field, its redacting `Debug`,
//!   and the launch it produces.
//! - [`taxonomy`] — the closed vocabularies ([`InstallSource`], [`UpdatePolicy`], [`EnvPolicy`],
//!   [`ProgramState`]) and the wire spelling each one carries.
//! - [`instances`] — the live-instance bookkeeping and the handle that owns one incarnation.
//! - [`table`] — the registry's own table, the profile bindings beside it, and the launch sequence
//!   that needs all three of the above at once.
//!
//! Every name a caller outside this module reached before is re-exported below, so the split moved
//! no path: `state::app_state`, `commands::agent_registry`, `agent_runtime::update`,
//! `binary_registry`, `environment`, `profile`, `driver`, `adapters::opencode` and the integration
//! tests under `tests/` name the same symbols through `agent_runtime::registry` as they always did.

// The six reasons-to-change this file had, each now a file that says why it is the one that moves
// when its subject does.
mod error;
mod instances;
mod registration;
mod table;
mod taxonomy;
mod validation;

// Seven of the re-exports below carry `unused_imports`, and only in a target that `#[path]`-includes
// this tree whole: `tests/agent_settings_ipc_test.rs` declares `pub mod registry` because
// `permission_grants` is named through it, and that target names none of these seven itself, so the
// compiler counts no caller for them there. The library does count one — every path below is reached
// as `agent_runtime::registry::…` — which is why the import is allowed rather than dropped: dropping
// it would take away a path that existed before the split. The same allow, for the same reason, is
// recorded in `agent_runtime::process`, `profile`, `session` and `capabilities`. `AgentRegistration`,
// `EnvPolicy` and `InstallSource` need no allow because `adapters::opencode.rs`, which that target
// does compile, imports exactly those three from here.
#[allow(unused_imports)]
pub use error::RegistryError;
#[allow(unused_imports)]
pub use instances::AgentInstance;
pub use registration::AgentRegistration;
#[allow(unused_imports)]
pub use table::AgentRegistry;
pub use taxonomy::{EnvPolicy, InstallSource};
#[allow(unused_imports)]
pub use taxonomy::{ProgramState, UpdatePolicy};
#[allow(unused_imports)]
pub use validation::{redacted_env, validate_args};

/// The profile the first-run flow uses, before T12's settings pages exist (§8.1's
/// app-managed profile, under the name it has until a UI can choose another).
pub const DEFAULT_PROFILE: &str = "default";
