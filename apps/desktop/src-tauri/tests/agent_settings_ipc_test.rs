//! R4 — profile and configuration ownership: which files a profile owns, what survives an edit of
//! one, who loses a write race, and what a report may never contain.
//!
//! Four clauses, and each of them names a failure rather than a feature:
//!
//! - **配置隔离** (§3.4's Profile row): 不在多个引擎间复制凭据、模型 ID 或配置文件. The evidence is
//!   not a comment claiming isolation — it is every byte under one engine's profile root, read back
//!   and searched for the other engine's credential and model id, plus the refusal that a profile
//!   bound to one engine cannot be opened as another.
//! - **JSONC 保留** (§8.1): a real configuration has comments in it, and a round-trip that
//!   reformats it is data loss from the user's point of view. The strongest form of that is
//!   asserted below — after an edit the document is byte-for-byte the original with exactly one
//!   span replaced.
//! - **并发冲突**: two writers, and the loser finds out. The rule is the one
//!   `platform/gateways/memory-pet/settings.ts` states: an update built on a moved revision is
//!   refused and the caller reloads, never merged.
//! - **凭据脱敏**: values are reported with credentials removed. `secret::Secret` is the mechanism —
//!   a module of its own, because the launch environment holds one too — and the tests below search
//!   the readout, the `Debug` lines and the refusal messages for a value that must not be in any of
//!   them.
//!
//! The cases are divided by behaviour domain rather than kept in one file, because this target
//! outgrew a page: `isolation` for what one engine's profile may not contain of another's, `jsonc`
//! for what an edit must leave alone, `conflict` for the write race, `redaction` for what a report
//! may never carry, and `boundary` for the requests that are not taken at face value. They are one
//! target and one command — `cargo test --test agent_settings_ipc_test` — because a test in a file
//! nobody runs is not evidence.
//!
//! Module inclusion: `agent_runtime/mod.rs` does not declare `profile` or `config_edit`, and
//! `commands/mod.rs` does not declare `agent_settings` — those registrations are the integrator's
//! serialized change (T4 holds `lib.rs` and `commands/mod.rs`) — so the tree is declared here by
//! path, the convention `agent_permission_ipc_test.rs`, `agent_registry_test.rs` and
//! `desktop_pet_ipc_test.rs` established. The list below is `agent_runtime/mod.rs`'s own list plus
//! this task's two files: a name that drifted fails to compile here rather than silently testing a
//! different tree.

#[path = "../src/agent_runtime"]
mod agent_runtime {
    // These are the library's own modules, compiled here only so that the `super::` paths inside
    // `profile.rs` and `config_edit.rs` resolve to the same places they do in the library. The
    // library reaches every item in them; this target reaches only what the profile layer names, so
    // the rest is reported as dead rather than being dead.
    #[allow(dead_code)]
    pub mod adapters;
    // Included because `runs` and `session` both name it through `super::`: the command list an
    // engine publishes is recorded as a capability fact (plan §3.4's row), so the two modules that
    // carry it have to find it here too.
    #[allow(dead_code)]
    pub mod capabilities;
    pub mod config_edit;
    #[allow(dead_code)]
    pub mod events;
    #[allow(dead_code)]
    pub mod fs_capability;
    // Included because `fs_capability`'s read arm names it through `super::`: what a read
    // serves, and what it refuses to serve, are one question now.
    #[allow(dead_code)]
    pub mod live_notes;
    #[allow(dead_code)]
    pub mod permissions;
    #[allow(dead_code)]
    pub mod process;
    pub mod profile;
    // Included because the profile's readout and the skills scope list answer one question between
    // them — which directories this launch really reads. `boundary.rs` feeds the launch's own
    // environment through both, so it needs the scope list compiled against the same tree the
    // library builds rather than against a hand-written copy of it. `unused_imports` is allowed
    // with `dead_code` because this target reaches the tree through the names its tests use, while
    // `skills.rs` re-exports the rest for the library.
    #[allow(dead_code, unused_imports)]
    pub mod skills;
    #[allow(dead_code)]
    pub mod registry;
    // Included because `process` and `profile` both name it through `super::`: the launch
    // environment and the credential holder share the one type that may not be printed, and this
    // target reaches it from both sides.
    pub mod secret;
    #[allow(dead_code)]
    pub mod session;
    // Private in `mod.rs`, public here because `registry`, `session`, `permissions` and the
    // transport reach each other through `super::` and the module list has to be complete for those
    // paths to resolve.
    #[allow(dead_code)]
    pub mod acp_transport;
    #[allow(dead_code)]
    pub mod runs;
    // Included because `acp_transport` names it through `super::`: the counters a turn reported,
    // read where the schema's own `Usage` cannot hold the partial object P0 §6.3 measured.
    #[allow(dead_code)]
    pub mod usage;
}

#[path = "../src/commands/agent_settings.rs"]
mod agent_settings;

// `#[path]` rather than a bare `mod`, because a test target's root file resolves a plain `mod x;`
// against `tests/` rather than against this directory — and these names are behaviour, not targets,
// so a flat `tests/*.rs` layout would make Cargo build each of them as a test binary of its own.
#[path = "agent_settings_ipc_test/boundary.rs"]
mod boundary;
#[path = "agent_settings_ipc_test/conflict.rs"]
mod conflict;
#[path = "agent_settings_ipc_test/isolation.rs"]
mod isolation;
#[path = "agent_settings_ipc_test/jsonc.rs"]
mod jsonc;
#[path = "agent_settings_ipc_test/redaction.rs"]
mod redaction;
#[path = "agent_settings_ipc_test/support.rs"]
mod support;
