//! R5 — Skills: what an import touches, and what switching one off actually does.
//!
//! §10.2's T13 row states three things, and this target is where two of them are settled — the third
//! (模型/MCP/命令来源明确) is a settings page's, and is E3's.
//!
//! - **导入不执行脚本.** The risk this row carries is that a Skills importer takes content from
//!   outside the app and makes it available to something that will execute it. So the central test
//!   (`execution.rs`) does not assert that nothing ran: it builds a skill whose payload leaves a
//!   canary file, **fires the payload on purpose** to prove the canary can appear, removes the
//!   canary, and then imports. The absence afterwards is evidence because the presence was observed
//!   first — the same discipline the ACP side applies to a downloaded binary ("a download is not
//!   executable until it passes"), and the reason a canary that cannot fire would prove nothing.
//! - **禁用真实生效.** A disabled-looking feature that still runs is worse than one that never
//!   existed, so a switch here is a *move*, and the tests (`disable.rs`) re-scan after moving: the
//!   skill is gone from discovery, it is present in the store, and switching it back on restores
//!   it. The other half is the refusal — a scope whose contents this host cannot affect is refused
//!   with the engine's own variable named, and the directory is asserted to be untouched
//!   afterwards, because a refused action that had already half-happened would be the same lie in a
//!   different place.
//!
//! Everything the tests here call is measured from the pinned OpenCode 1.18.29 rather than assumed
//! (`docs/audits/2026-09-16-opencode-acp-p0.md` §1): the directory list, the frontmatter rules, the
//! two engine switches, and what was observed of a duplicate name — both load, and which one wins is
//! not settled by anything this host can see. That is why the conflict test asserts that *both*
//! directories are reported and that neither is nominated as the winner.
//!
//! Where a scope is found, whether this launch reads it, and what the engine does with a skill in
//! it is `agent_skills_scope_test.rs`'s. That is one of `skills.rs`'s three responsibilities —
//! scope, discovery, import — and it moved out when the file that held this target's cases reached
//! the 800-line budget for a test target (§13.1: 按行为域拆分). This target still includes the whole
//! of `skills.rs`; only the tests about *which directories are sources* live next door.
//!
//! ## How this target is divided
//!
//! The file those cases were in then reached 799 lines against the same budget — one line of
//! headroom — and was split along the section headings it was already written under rather than at
//! a line count: each heading was one behaviour domain, so no case had to be reclassified to move
//! it. `execution.rs` 导入不执行脚本, `frontmatter.rs` 导入前的校验, `containment.rs`
//! 符号链接逃逸与大小上限, `overwrite.rs` 覆盖必须确认并保留可恢复副本, `disable.rs` 禁用真实生效,
//! `discovery.rs` 发现：冲突, and `support.rs` — the fixtures every one of them builds its tree with.
//! The cases moved with their names, bodies and assertions; what changed is the file each one lives
//! in, and it is one target and one command either way — `cargo test --test agent_skills_test` —
//! because a test in a file nobody runs is not evidence.
//!
//! Module inclusion: the module is declared here by path rather than through `agent_runtime/mod.rs`,
//! which is the convention every target in this directory uses. It is included once, in this root,
//! and the domain modules reach it as `crate::skills` — one copy of the tree for the whole target,
//! so no two files can be testing different ones. It is included on its own, with no sibling modules,
//! because `skills.rs` reaches for nothing but `std`: the profile and adapter layers are not this
//! target's dependencies, and a module that needs no tree is a module a test cannot accidentally
//! test a different copy of.
//!
//! Scratch directories live under this crate's `target/`, which is inside the repository and
//! git-ignored: §3.2 forbids a development profile from being the developer's own, and `$HOME` is
//! never read anywhere in this target.

// The re-exports `skills.rs` writes for the library are unused in a copy that reaches only part of
// it, and the items this target never calls are reported as dead rather than being dead — both are
// what a `#[path]`-included module looks like from one target's side (`desktop_pet_resources_test.rs`).
#[path = "../src/agent_runtime/skills.rs"]
#[allow(dead_code, unused_imports)]
mod skills;

// `#[path]` rather than a bare `mod`, because a target root resolves a plain `mod x;` against
// `tests/` — the compiler says `E0583: create file "tests/x.rs"` — and not against this directory,
// the rule `agent_settings_ipc_test.rs` and `agent_exit_teardown_test.rs` state. Every path below
// points inside `tests/agent_skills_test/`; there is no `main.rs` in it, so the directory holds
// modules and never becomes a target of its own.
//
// The division is by behaviour domain — the section headings the single file these cases were
// written in had drawn — and each domain is named in the header above.
#[path = "agent_skills_test/containment.rs"]
mod containment;
#[path = "agent_skills_test/disable.rs"]
mod disable;
#[path = "agent_skills_test/discovery.rs"]
mod discovery;
#[path = "agent_skills_test/execution.rs"]
mod execution;
#[path = "agent_skills_test/frontmatter.rs"]
mod frontmatter;
#[path = "agent_skills_test/overwrite.rs"]
mod overwrite;
#[path = "agent_skills_test/support.rs"]
mod support;
