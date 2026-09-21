//! The consent default this app ships, and the engine's own configuration document this host writes
//! it into.
//!
//! **Why it is a file of its own.** `docs/dev.md:286` puts the budget for a business source file at
//! 600 lines, and [`super`] was 1027. The split is by *reason to change*, which is the criterion
//! that section states rather than the line count: this module moves when the *engine's permission
//! vocabulary or the shipped default* moves — a tool the engine renames, an action its schema
//! spells differently, a rule this app decides to add or drop — and when the member this host writes
//! into the engine's configuration does. It does not move when a credential does
//! ([`super::credentials`]) or when the readout's shape does ([`super`]).
//!
//! The document layer under all of this — reading JSONC, splicing one span, revising — is
//! `agent_runtime::config_edit`'s and deliberately not this module's: what is here is *which*
//! document and member this app owns, never how a document is written.
//!
//! Every name a caller reached as `profile::X` before the split still resolves — [`super`]
//! re-exports it — and the two methods stay inherent methods on [`Profile`].

use serde::Serialize;
use serde_json::{json, Value};

use super::super::config_edit::{self, ConfigEdit, WriteOutcome};
use super::scope::ConfigMode;
use super::{Profile, ProfileError};

/// Where inside a profile the engine's own global configuration lives, as a path relative to the
/// profile root.
///
/// The engine's own layout, not this host's: the launch sets `XDG_CONFIG_HOME` to `<root>` and the
/// engine resolves its global configuration beneath it. Written as the relative path because that
/// is what [`Profile::document_path`] takes, and because a second absolute spelling of the same
/// file is a second place for it to drift.
pub const ENGINE_CONFIG_DOCUMENT: &str = "XDG_CONFIG_HOME/opencode/opencode.json";

/// The member of that document this app writes. The engine's own key, spelled as its schema spells
/// it — see [`SHIPPED_PERMISSION_RULES`] for why this host is the one writing it.
pub const PERMISSION_MEMBER: &str = "permission";

/// One rule of the consent default this app ships, in the engine's own vocabulary.
///
/// **Why this is here and not in an adapter.** §3.4.5 leaves the *format* of an engine's
/// configuration to a verified adapter, and this app has one for the engine it bundles — but the
/// question these rules answer is this host's own: with no rule, the engine raises no permission
/// event at all (measured: `permission-is-the-only-lever.md` §3, where the same harness writes a
/// file with `permission frames: []`), so a profile that ships no rules ships an agent that writes
/// the user's notes and asks nobody. The engine's configuration is where that question is asked, so
/// this is where this host has to say something.
///
/// **`action` is the engine's own word**, `ask`/`allow`/`deny`, exactly as its configuration
/// schema spells it, and `tool` is one of its own tool keys. Nothing here is a name this app made
/// up: an engine that renamed its tools would read these as rules for tools it does not have, and
/// the honest consequence is that it would ask nothing — which is why this list is short and named
/// rather than derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ShippedPermissionRule {
    /// The engine's own tool name.
    pub tool: &'static str,
    /// The engine's own action for it.
    pub action: &'static str,
}

/// The consent default this app ships: the two tools that change the user's files or run code.
///
/// `edit` is the whole reason this exists — it is the tool that writes a note, and the one the
/// falsification was measured against. `bash` is the same power by another name: a shell writes
/// files, and a user who refused an edit while approving a shell has approved the write.
///
/// **What is deliberately not here, and why the list is this short.** A prompt on every trivial
/// read is a prompt users learn to click through, and the one that mattered is clicked through with
/// it. `read`, `glob`, `grep` and `list` only look; the engine's own default already leaves them
/// alone (P0 §6.2), and its own default ruleset is the guide for the rest — it already asks about
/// `external_directory` and `doom_loop`, so writing those here would restate the engine rather than
/// say anything of this host's. `webfetch` and `websearch` reach the network but cannot write the
/// user's notes. `skill`, `lsp` and `todowrite` neither write nor run; `task` starts a subagent
/// whose own tool calls are gated where they are made, so asking at the launch as well would be a
/// second question about the same act.
pub const SHIPPED_PERMISSION_RULES: [ShippedPermissionRule; 2] = [
    ShippedPermissionRule {
        tool: "edit",
        action: "ask",
    },
    ShippedPermissionRule {
        tool: "bash",
        action: "ask",
    },
];

/// The block as the engine's configuration carries it — built from the list above, so the two
/// cannot drift.
///
/// Public because the only honest test of a shipped configuration is a run against the engine with
/// *this* object in its profile, and a test that retyped the rules would be measuring its own copy
/// (`agent_permission_configured_test.rs`).
pub fn shipped_permission_block() -> Value {
    Value::Object(
        SHIPPED_PERMISSION_RULES
            .iter()
            .map(|rule| {
                (
                    rule.tool.to_string(),
                    Value::String(rule.action.to_string()),
                )
            })
            .collect(),
    )
}

/// Whether the engine's configuration carries this app's consent rules — the fact the settings
/// page shows, and the one a test asserts.
///
/// **A state of the document, not a record of a write.** The first version of this reported what
/// [`Profile::apply_shipped_permissions`] had just done, and that turned out to be a fact with a
/// lifetime of one call: the second open finds the member the first one wrote, and "wrote it just
/// now" is false for every open after the first — so the page would have said "the engine's own
/// configuration carries its rules" about the rules this app had written itself. What is answered
/// here is instead whether the member in the document *is* the one this host writes, which is true
/// for every open and false the moment a user replaces it with their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDefaults {
    /// The engine's configuration carries this app's rules, exactly as [`shipped_permission_block`]
    /// serializes them.
    Written,
    /// It carries a `permission` member this host did not write — a user's own rules, made in this
    /// app's own settings editor — so nothing was written over it. The shipped rules are a floor,
    /// and the document has already risen above it.
    Left,
    /// The rules were not written and do not need to be: this profile reuses the user's own
    /// installation, so this host writes no configuration and cannot promise a consent default.
    NotThisHosts,
    /// Someone else wrote the document between this host's read and its write. Nothing was
    /// written, and the next open tries again — merging here would be the one thing [`config_edit`]
    /// forbids, since a merge is how the other writer's member gets undone.
    Contended,
}

impl Profile {
    /// Puts this app's consent default into the engine's own configuration, or leaves what is
    /// there alone.
    ///
    /// **A floor and not an override.** The three arms are the three states of one question — has
    /// the engine's configuration already spoken about permissions — and only the first of them
    /// writes anything. A document that carries a `permission` member is left byte for byte: it may
    /// be the user's own rules, written in the settings editor this app provides, and a host that
    /// overwrote them on every open would be undoing a decision the user made in this app's own UI.
    ///
    /// **Why this runs on open rather than once at creation.** §8.1's first-run flow opens the
    /// profile before the engine is started, and a profile that already existed when these rules
    /// landed needs them too — a rule that only applies to profiles created after a release would
    /// leave every existing installation asking nobody, which is the state this exists to end. The
    /// write happens at most once per profile: after it, the member is there and the second arm
    /// answers.
    ///
    /// A failure is returned rather than swallowed. The engine's configuration is inside a root
    /// this host made and owns, so a write that fails there is a root that cannot be written at
    /// all — [`super::ProfileStore::open`] fails on that already, one step earlier, and reporting
    /// "the profile opened" while the consent default was not applied would be the one claim this
    /// app must not make about permissions.
    pub fn apply_shipped_permissions(&self) -> Result<PermissionDefaults, ProfileError> {
        if self.fields.mode != ConfigMode::AppManaged {
            return Ok(PermissionDefaults::NotThisHosts);
        }
        let path = self.document_path(ENGINE_CONFIG_DOCUMENT)?;
        let block = shipped_permission_block();
        let edit = ConfigEdit::set(vec![PERMISSION_MEMBER.to_string()], block.clone())?;
        match config_edit::read(&path)? {
            None => {
                // The whole document is this host's, so it is written as one: the engine writes
                // nothing here until something configures it, and an `apply` against a document
                // that is not there can only refuse.
                let created = json!({ PERMISSION_MEMBER: shipped_permission_block() });
                config_edit::write_replacing(&path, &created.to_string())?;
                Ok(PermissionDefaults::Written)
            }
            Some(document) => {
                // Already this host's, which is the state every open after the first one is in —
                // and answering `Left` here would be the page reporting a user's own rules about a
                // member this app wrote.
                if document.member_is(PERMISSION_MEMBER, &block)? {
                    return Ok(PermissionDefaults::Written);
                }
                if document.has_member(PERMISSION_MEMBER)? {
                    return Ok(PermissionDefaults::Left);
                }
                // Into the existing text, not over it: every comment, every provider block and
                // every member this app has never heard of is outside the span this splices.
                match config_edit::apply(&path, document.revision(), &[edit])? {
                    WriteOutcome::Written { .. } => Ok(PermissionDefaults::Written),
                    WriteOutcome::Conflicted { .. } => Ok(PermissionDefaults::Contended),
                }
            }
        }
    }

    /// Whether this app's consent rules are the ones the engine's configuration carries, as of now.
    ///
    /// Read on every [`Profile::readout`] rather than remembered from the open, because the
    /// question is about a *file*: the settings editor this app provides writes that same document,
    /// so between two reads of the page a user can replace the member — and a page that reported a
    /// remembered answer would go on claiming the old one.
    ///
    /// A document that cannot be read is reported as [`PermissionDefaults::Left`], which is the
    /// conservative direction and not a guess: `open()` ran this same read a moment earlier and
    /// propagated a failure, so reaching here with an unreadable file means it changed underneath
    /// this process — and "this app's rules are not in force" is the answer that claims nothing.
    /// `pub(super)` rather than private, because the readout that calls it is [`super`]'s and an
    /// ancestor cannot see a child's private item — the parent's right to the answer is the right
    /// it had when this method sat in the same file as the readout.
    pub(super) fn permission_defaults(&self) -> PermissionDefaults {
        if self.fields.mode != ConfigMode::AppManaged {
            return PermissionDefaults::NotThisHosts;
        }
        let Ok(path) = self.document_path(ENGINE_CONFIG_DOCUMENT) else {
            return PermissionDefaults::Left;
        };
        let Ok(Some(document)) = config_edit::read(&path) else {
            return PermissionDefaults::Left;
        };
        match document.member_is(PERMISSION_MEMBER, &shipped_permission_block()) {
            Ok(true) => PermissionDefaults::Written,
            _ => PermissionDefaults::Left,
        }
    }
}
