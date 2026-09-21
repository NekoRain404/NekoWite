//! The reading of a failure at the transport seam: what went wrong, and what to tell the user.
//!
//! Its own module because the two questions here move for reasons the frame mapping next door does
//! not: `classify` changes when a failure arrives in a shape the transport has not classified
//! before, and the sentence changes when a measured failure needs words the engine's own message
//! cannot give (P0 §2.4's certificate case). The codes it answers with are in `super::kinds`, and
//! that is deliberate — a code and the condition that maps onto it are one decision — but they are
//! not one edit: the vocabulary exists before anything recognises it, and `certificate_failure` is
//! the measurement that joins the two.

use super::super::process::{FRAME_TOO_LARGE_MARKER, MAX_FRAME_BYTES};
use super::kinds::AgentFailureCode;

/// Everything that can go wrong between issuing a request and reading its
/// answer.
#[derive(Debug, Clone)]
pub enum TransportError {
    /// No answer within the caller's bound.
    Timeout { method: String },
    /// The connection is over: the engine exited, or its side of the transport
    /// closed. Every request still outstanding fails with this.
    ///
    /// `detail` is the host's own sentence, and the transport appends the engine's last
    /// lines of stderr after it when it has any (`process::EngineStderr::tail`, which
    /// waits for the engine's end of the pipe to close before it reads): an engine
    /// that is gone has no other way left to say why. The appended text has been through
    /// `redact` before it is attached — it is read out of the log the pump filled, not
    /// off the pipe — so a failure sentence is still a place a credential cannot appear.
    Disconnected { detail: String },
    /// The engine negotiated a protocol this host does not implement.
    ProtocolIncompatible { found: u16 },
    /// The engine answered with a JSON-RPC error.
    Engine { message: String },
}

impl TransportError {
    /// The condition, as the contract names it.
    pub fn failure_code(&self) -> AgentFailureCode {
        match self {
            TransportError::Timeout { .. } => AgentFailureCode::Timeout,
            TransportError::Disconnected { .. } => AgentFailureCode::ProcessExited,
            TransportError::ProtocolIncompatible { .. } => AgentFailureCode::ProtocolIncompatible,
            TransportError::Engine { message } if certificate_failure(message) => {
                AgentFailureCode::CertificateUntrusted
            }
            // Engine-side codes beyond the measured one are not mapped: P0 §4
            // lists permissions and authentication as unverified, so guessing
            // which failure means "authentication required" would be inventing
            // the mapping T3/T7 are meant to measure.
            TransportError::Engine { .. } => AgentFailureCode::InvalidResponse,
        }
    }

    /// The sentence the user sees.
    ///
    /// Only the certificate case is reworded, and P0 §2.4 requires it: the
    /// engine's own text for it names neither the host nor the remedy, and
    /// §2.4 forbids passing that string on. Every other engine message is kept
    /// as it is — it is the engine's own words about its own failure, and this
    /// layer has nothing better to say.
    ///
    /// The certificate sentence claims nothing the evidence cannot support, and
    /// the measurement that forced that is the live run's §5: the condition
    /// arrived once from a transient network fault, on a machine whose `curl`
    /// and `openssl` verified cleanly against the same CA bundle immediately
    /// before and after, and the two identical runs around it succeeded. The
    /// engine gives the transient case no code to tell it apart from a missing
    /// CA store — the same `-32603`/"unknown certificate verification error" is
    /// the whole of the evidence (see `certificate_failure` below) — so the
    /// sentence names the retry first, offers the CA cause as a likelihood
    /// *if the failure repeats*, and names the variable that addresses it. A
    /// confident diagnosis would send a user to change a CA configuration that
    /// was never wrong, which is a worse outcome than the opaque original.
    pub fn failure_message(&self) -> String {
        if self.failure_code() == AgentFailureCode::CertificateUntrusted {
            return "the engine could not verify the server's certificate. That is not proof of \
                    a CA problem: a transient network or TLS failure reports the same thing, so \
                    a retry is a reasonable first step. If it repeats, the likely cause is a \
                    chain the engine's CA store does not know — an internal or brand-new root, \
                    or a system store that is missing or out of date. NODE_EXTRA_CA_CERTS names \
                    an extra bundle the engine trusts; the app already passes the system store \
                    through it, so anything set there should include it. The connection was not \
                    attempted insecurely."
                .to_string();
        }
        match self {
            TransportError::Timeout { method } => {
                format!("the engine did not answer {method} in time")
            }
            TransportError::Disconnected { detail } => {
                format!("the engine connection closed: {detail}")
            }
            TransportError::ProtocolIncompatible { found } => {
                format!("the engine speaks ACP protocol version {found}, which this app does not")
            }
            TransportError::Engine { message } => message.clone(),
        }
    }
}

/// Turns an SDK error into this crate's vocabulary.
///
/// `pub` here and narrowed by the re-export in the parent, which is the one spelling rustc accepts
/// for the reach `classify` had as `pub(super)` in `events.rs`: E0364 refuses a re-export wider than
/// the item it names, and the parent re-exports this one as `pub(super)` — so
/// `agent_runtime::events::classify` is reachable from `agent_runtime` and no further, exactly as
/// before. `process::EngineExit` is declared and re-exported the same way.
pub fn classify(error: agent_client_protocol::Error) -> TransportError {
    // The bound reports itself through the reader's error text, and it deserves
    // its own sentence: "the connection closed" would send the reader looking
    // for a crash that did not happen.
    if error.to_string().contains(FRAME_TOO_LARGE_MARKER) {
        return TransportError::Engine {
            message: format!(
                "the engine sent a frame larger than the {MAX_FRAME_BYTES}-byte limit, so the run \
                 was stopped rather than buffered"
            ),
        };
    }
    if agent_client_protocol::is_incoming_transport_closed(&error) {
        return TransportError::Disconnected {
            detail: error.to_string(),
        };
    }
    TransportError::Engine {
        message: error.to_string(),
    }
}

/// Whether an engine error is the certificate condition of P0 §2.4.
///
/// The engine gives it no code of its own — it arrives as the generic `-32603
/// Internal error` — so the message is the only evidence there is. The match is
/// kept narrow for that reason: it must contain `certificate` and one of the
/// phrasings the TLS libraries actually use, so that an unrelated internal
/// error is not relabelled as a trust problem and sent down the wrong advice.
///
/// What is recognised is the *condition* — an engine that could not verify a
/// certificate — and deliberately not its cause, which this frame cannot
/// establish: the live run's §5 measured a transient network fault producing
/// the same sentence, on a healthy store, and nothing in the frame separates
/// the two. The matcher is unchanged by that finding and unchanged by the
/// wording work in [`TransportError::failure_message`]; what changed is the
/// claim the reworded sentence makes about the cause.
///
/// `pub(super)`, and it was private before the split: a child module's private item is not reachable
/// from the module it was split out of (E0603), and `tests.rs` asserts this matcher's boundary
/// through the parent's `use`. `pub(super)` is `events` and its descendants — the reach a private
/// item of `events.rs` had — so nothing outside this module can classify on a phrase.
pub(super) fn certificate_failure(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("certificate")
        && [
            "unknown certificate verification error",
            "unable to verify",
            "self-signed",
            "self signed",
            "certificate has expired",
            "unable to get local issuer",
            "depth lookup",
        ]
        .iter()
        .any(|phrase| message.contains(phrase))
}
