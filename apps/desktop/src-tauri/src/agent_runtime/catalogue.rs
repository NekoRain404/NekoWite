//! The ACP agent catalogue: what the public registry publishes, read as data and never as an
//! instruction.
//!
//! The registry is how a client supports many engines without shipping a list of them. Its
//! aggregate is one JSON document (`registry.json`) of agent entries, and its shape is published
//! rather than guessed: `registry.schema.json` and `agent.schema.json` in
//! `github.com/agentclientprotocol/registry`, both of which name
//! `https://cdn.agentclientprotocol.com/registry/v1/latest/…` as their own `$id`. This module is
//! that schema, and nothing else.
//!
//! **A catalogue entry describes a process, never a capability.** Every field below is a fact the
//! publisher wrote about an artifact — an id, a version, a URL, an argument list. None of it is a
//! measurement of an engine, because nothing here has run. What an engine can do is established by
//! a handshake and a session negotiation, which is [`super::capabilities`]'s subject and the reason
//! no function in this module can answer [`super::adapters::HostFeature`]: the type that could
//! answer one deliberately does not exist here. A page that rendered a capability row from a
//! catalogue entry would be offering a button for something nothing has confirmed.
//!
//! **Nothing here downloads and nothing here runs.** [`parse`] reads bytes that are already in
//! hand. [`Standing`] says what a distribution *is*, not how to obtain it — and for the three kinds
//! the schema defines the answers differ in a way that matters, which is [`InstallGate`]'s subject.
//!
//! Files in this module's world: the schema's three distribution kinds are `binary`, `npx` and
//! `uvx` (`agent.schema.json`'s `distribution` object, `additionalProperties: false`). Zed reads
//! two of them — its `RegistryDistribution` has `binary` and `npx` only
//! (`zed-main/crates/project/src/agent_registry_store.rs:658-664`) and its builder drops an entry
//! that has neither (`:445-456`), so a `uvx`-only agent is invisible in Zed's registry page. This
//! module keeps all three, because the schema is the contract and a distribution kind this host
//! cannot use is a thing to *report* rather than a thing to make disappear.
//!
//! **The file is now a list of modules.** It stood at 1174 lines, over the 600-line budget
//! `docs/dev.md:286` puts on a business source file, and the split is by what makes each piece
//! change rather than by arithmetic — the criterion that line states. Each child owns one subject,
//! and each header states what makes it move:
//!
//! - [`manifest`] — one entry's manifest (`agent.schema.json`) and the rules the schema states
//!   about it. Changes when the published manifest changes.
//! - [`distribution`] — the distribution kinds an entry may publish, and the archive formats the
//!   schema names. Changes when that shape does.
//! - [`platform`] — the six target keys the schema names, and which one this build runs on.
//! - [`standing`] — what this host can say about one distribution, and which it would prefer.
//! - [`install_gate`] — §3.3's install checks and which of them transfer to a registry entry.
//! - [`refusal`] — what is refused, per entry or per document, and the sentence shown for it.
//! - [`document`] — reading `registry.json` as a whole: [`parse`], the version gate and the rows.
//!
//! Every name a caller outside this module reached before is re-exported below, so the split moved
//! the code and not the surface: `commands::agent_catalogue` still names `catalogue::parse`,
//! `catalogue::Catalogue`, `catalogue::Entry`, `catalogue::EntryDefect`, `catalogue::InstallGate`,
//! `catalogue::Standing` and `catalogue::PackageManager` through this path, and the unit tests
//! (now `tests.rs`, which reads the same surface a caller does) still name every one of them.
mod distribution;
mod document;
mod install_gate;
mod manifest;
mod platform;
mod refusal;
mod standing;

#[cfg(test)]
mod tests;

pub use distribution::{BinaryTarget, Distribution, Package, Preview, PreviewDistribution};
pub use document::{parse, Catalogue, CatalogueDocument, CatalogueRow, SUPPORTED_REGISTRY_MAJOR};
pub use install_gate::InstallGate;
pub use manifest::Entry;
pub use platform::Platform;
pub use refusal::{DocumentError, EntryDefect};
pub use standing::{PackageManager, Standing};
