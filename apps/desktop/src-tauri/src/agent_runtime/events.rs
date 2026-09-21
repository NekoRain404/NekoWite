//! The host's own vocabulary for what the engine did.
//!
//! The protocol's frames are not the app's event contract — §6.2 says so in its
//! first line, and that is the section's real point. Ids on the wire are
//! per-connection, the engine has no host-wide ordering, and a `SessionUpdate`
//! variant is a protocol detail no Vue component should ever match on. This
//! module is the one place that translation happens, so a change on the wire
//! lands here and nowhere else.
//!
//! The discriminator is matched as a typed enum rather than as a JSON string:
//! `agent-client-protocol` already owns those shapes, including the
//! `_meta`/unknown-field tolerance the schema carries, and re-deriving them
//! from raw JSON here would be the second implementation this task exists to
//! avoid.
//!
//! It is also where a failure is described: [`TransportError`] and the way it
//! maps onto [`AgentFailureCode`] sit next to the codes themselves, because the
//! mapping and the codes are one decision — P0 §2.4 measured a failure that had
//! no code, and the two had to change together.
//!
//! The TypeScript side of the envelope is written in parallel (T1) against the
//! plan's field list — the list here is that contract, kept in step by hand,
//! and NOT an import.

//! **Split by what makes each part change, not by arithmetic.** `docs/dev.md` §5.4.2 puts the
//! criterion on the number of reasons a file changes rather than on its line count, and this file
//! had five — and they are five, not one, because the vocabulary is a *contract* while the mapping
//! is an implementation of it. Each is now a child module whose header argues why it is the one
//! that moves when its subject does:
//!
//! - `kinds` — the two closed vocabularies (`AgentEventKind`, `AgentFailureCode`) and the prose that
//!   argues what may be a kind. It changes when a kind is added or its spelling changes, and the
//!   window's parity pin reads *that* file rather than this one for exactly that reason.
//! - `transport` — the reading of a failure at the seam: `TransportError`, the code and the sentence
//!   it becomes, and the matcher that recognises the one measured condition (P0 §2.4). It changes
//!   when a failure mode or its code changes.
//! - `normalize` — one `session/update` into the host's kind and payload, with the per-frame readers
//!   that mapping needs. It changes when the engine's frame shapes change.
//! - `envelope` — the identity of §6.1 and the sequence the window orders by: what is stamped on
//!   every event, whatever the event says.
//! - `tests` — the moved test module, which asserts against the surface below rather than against
//!   one child.
//!
//! Every name a caller reached through `events::` before the split still resolves here: the children
//! are private, and the re-exports below are the module's public surface, which `session.rs`,
//! `runs.rs`, `permissions.rs`, `acp_transport/*`, `commands/*`, `mod.rs` and the integration tests
//! that address the runtime by path all still name exactly as they did.

mod envelope;
mod kinds;
mod normalize;
mod transport;

#[cfg(test)]
mod tests;

pub use envelope::{AgentEventEnvelope, AgentIdentity};
pub use kinds::{AgentEventKind, AgentFailureCode};
pub use normalize::normalize_update;
pub use transport::TransportError;

// `classify` keeps the reach it had: `agent_runtime` and below, which is what `pub(super)` meant
// when the function was declared here. It is declared `pub` in the child and narrowed by this
// re-export, because E0364 refuses a re-export wider than the item it names — the same pair
// `process.rs` uses for `EngineExit`. The callers (`acp_transport`, `acp_transport::calls`,
// `usage`'s tests) are unchanged.
pub(super) use transport::classify;

// Test-only, and private: `certificate_failure` is the matcher the reworded sentence rests on, and
// `tests.rs` reaches it through `use super::*`. It is not re-exported, because nothing outside this
// module may classify on a phrase rather than on a frame.
#[cfg(test)]
use transport::certificate_failure;
